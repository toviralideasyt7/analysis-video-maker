#!/usr/bin/env python3
"""
check-video.py -- automated visual QA gate for data-race videos.

Compares a rendered bar-chart-race MP4 against its bundle (frames.json +
video-spec.json) and flags the visual/animation bug classes that have shipped
to users before:

  C1  non-proportional bars   (a min-width clamp made 7% and 1% bars identical)
  C2  unstable layout         (leader bar width/position must stay constant --
                               bars must never resize or shift mid-race)
  C3a non-monotonic tweens    (bars must glide toward next year's values, never
                               jump back toward zero mid-transition)
  C3b overlapping text labels (heuristic: no dark label text may cross a row
                               boundary)
  C3c rank order/labels       (each entity's bar must sit in its frames.json
                               rank band; every row needs its rank number)

Usage:
    check-video.py <video.mp4> --frames bundles/<projectId>/frames.json [--out report.json]
    check-video.py <video.mp4> --frames bundles/<projectId>/          # bundle dir also works

Exit codes: 0 = clean, 1 = violations found, 2 = usage/environment error.

Method: the video is a sequence of scenes (title, intro, bar_race x N,
fact_box, ending). Only bar_race scenes are sampled, at the MIDDLE of each
year block (settled frames -- year boundaries are transition zones where
rows overlap) mapped from tape to screen via each scene's tapeRange, plus
dense probes across each race scene's opening seconds (the spotlight-card
fade window). Bars are located by their entity brand color (from
frames.json) with a full-height column profile through each bar's vertical
span, so detection survives the white name painted inside wide bars.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

# ---------------------------------------------------------------- deps ----
try:
    import cv2
except ImportError:
    sys.stderr.write(
        "ERROR: missing Python package 'opencv-python-headless'.\n"
        "Install it with:  pip install opencv-python-headless numpy pillow\n"
    )
    sys.exit(2)
try:
    import numpy as np
except ImportError:
    sys.stderr.write(
        "ERROR: missing Python package 'numpy'.\n"
        "Install it with:  pip install opencv-python-headless numpy pillow\n"
    )
    sys.exit(2)
try:
    import PIL  # noqa: F401  (declared dependency; reserved for future use)
except ImportError:
    sys.stderr.write(
        "ERROR: missing Python package 'pillow'.\n"
        "Install it with:  pip install opencv-python-headless numpy pillow\n"
    )
    sys.exit(2)

# ------------------------------------------------- renderer layout consts --
# Mirror of renderer/src/DataRace.tsx (1280x720 design space). Layout was
# redesigned 2026-09-30: the info panel moved to the RIGHT (x 904..1232,
# RESERVED by construction - no scan may enter it) and the race zone is now
# x 0..880, y 112..656. The bottom banner / spotlight card at x=960 are gone.
# Keep these in lockstep with DataRace.tsx: stale geometry here makes the
# gate measure the wrong pixels and fail good renders (C1 row-band drift
# from RACE_BOT, C3b panel-text intrusion from BAR_X1 -- run 36750720421).
RACE_TOP = 112          # bars live between y=112 and y=656
RACE_BOT = 656          # raceBottom in DataRace.tsx; rows never enter the
                        # progress track below (y 688..700)
BAR_X0 = 190             # every bar starts at x=190 (must match barX0 in
                        # renderer/src/DataRace.tsx); keep the derived
                        # constants below in sync when it changes.
RACE_RIGHT = 880        # right edge of the race zone; the info panel starts
                        # at x=904 and is RESERVED - bars, flags, value
                        # labels and name labels all end before 880.
ZONE_X1 = RACE_RIGHT    # right edge of the bar scan zone: the longest bar +
                        # flag + value label ends before 880, so the scan
                        # never reaches panel pixels.
BAR_X1 = RACE_RIGHT     # end of the label-row boundary strip (right of the
                        # longest possible value label, left of the panel)
C3C_X1 = BAR_X0 + 39     # right edge for the C3c rank-order scan: country
                        # flags sit at the bar end and their colors can
                        # match other entities' brands; the bar's left
                        # 39px is flag-free and enough to identify its color.

MEASURE_SLACK_PX = 10   # bar widths are measured off rendered pixels (rounded
                        # pill ends, anti-aliased edges, label knockouts), so
                        # each measurement carries a few px of noise. C1
                        # allows the relative tolerance OR this absolute
                        # slack, whichever is larger, so a few-px miss on a
                        # small bar is not mistaken for disproportionality.
# NOTE: there is deliberately NO hardcoded max-bar-width constant here.
# DataRace.tsx computes maxBarWidth per video (data-driven: the longest
# formatted value label reserves label space), so a stale constant (the old
# 860) makes any intended-width cap wrong. measure_frame() derives the
# px-per-widthFrac scale from the leader bar (rank 1, widthFrac == 1.0 by
# construction: widthFrac = value/maxValue) and passes it in.
MEASURE_CAP_SLACK_PX = 15  # slack on the intended-width cap below: covers
                        # pill-edge AA and 1080p->720p resampling (±3px);
                        # far below the 12px badge gap + ~35px badge glyph,
                        # so badge absorption always exceeds the cap.
# Rank numerals ride at [barX0-46, barX0-10) (RankingRow: left x0-46,
# width 36, right-aligned); the +4px right slack matches the original box.
MARGIN_X0, MARGIN_X1 = BAR_X0 - 46, BAR_X0 - 6   # rank-number margin box

for _bin in ("ffprobe", "ffmpeg"):
    if shutil.which(_bin) is None:
        sys.stderr.write(f"ERROR: '{_bin}' not found on PATH. Install ffmpeg.\n")
        sys.exit(2)


# ---------------------------------------------------------------- helpers --
def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def probe_video(path):
    r = run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,nb_frames,avg_frame_rate,r_frame_rate,duration",
        "-of", "json", path,
    ])
    if r.returncode != 0:
        sys.stderr.write(f"ERROR: ffprobe failed on {path}:\n{r.stderr}\n")
        sys.exit(2)
    s = json.loads(r.stdout)["streams"][0]
    num, den = (int(x) for x in s["avg_frame_rate"].split("/"))
    fps = num / den if den else 0
    # The TRUE render rate is the stream's declared frame rate. Deriving fps
    # from frames/container-duration is unreliable: after the chunk concat
    # (-c copy) the container duration runs long (e.g. 110.25s for 6600
    # frames), which silently shifts every scene boundary by several frames
    # and makes the gate sample mid-transition frames as "settled".
    rnum, rden = (int(x) for x in s.get("r_frame_rate", "0/1").split("/"))
    rfps = rnum / rden if rden else 0
    n = int(s.get("nb_frames") or 0)
    if not n and s.get("duration") and fps:
        n = int(round(float(s["duration"]) * fps))
    if not n:
        sys.stderr.write("ERROR: could not determine frame count of video.\n")
        sys.exit(2)
    return {"width": int(s["width"]), "height": int(s["height"]),
            "frames": n, "fps": fps, "rfps": rfps}


def hex_to_hsv(hexcolor):
    hexcolor = hexcolor.lstrip("#")
    r, g, b = (int(hexcolor[i:i + 2], 16) for i in (0, 2, 4))
    px = np.uint8([[[b, g, r]]])
    h, s, v = cv2.cvtColor(px, cv2.COLOR_BGR2HSV)[0][0]
    return int(h), int(s), int(v)


class VideoQA:
    def __init__(self, video, bundle_dir, tape, spec, n_screen, fps_render):
        self.video = video
        self.bundle_dir = bundle_dir
        self.tape = tape
        self.spec = spec
        self.n_screen = n_screen
        self.fps_render = fps_render
        self.frames = tape["frames"]
        self.tape_count = len(self.frames)
        self.entities = {e["id"]: e for e in tape["entities"]}
        self.hues = {eid: hex_to_hsv(e["color"]) for eid, e in self.entities.items()}
        self.violations = []
        self.warnings = []
        self._imgs = {}
        self._paths = {}
        self._smooth_ranks = None
        self.scenes = self._scene_map()

    def row_h(self, n):
        """Row height matching the renderer (DataRace.tsx): constant across
        the whole video, based on the tape's topN. Frames showing fewer than
        topN bars leave vacant space below instead of stretching rows, so the
        QA bands must use topN too - n-based bands misalign every row."""
        top_n = self.tape.get("topN") or n
        return (RACE_BOT - RACE_TOP) / max(1, top_n)

    # ------------------------------------------------------- scenes ------
    def _scene_map(self):
        """Screen-frame ranges for every scene, from video-spec.json.

        Replicates the renderer's scene layout EXACTLY (DataRace.tsx):
        each scene gets Math.round(duration * 60) frames and scene starts
        are accumulated as integers. Accumulating float seconds and
        rounding (or Python's banker's round) drifts by a frame per scene
        -- after several scenes the gate samples mid-transition frames
        while believing they are settled.
        """
        scenes = []
        cursor = 0
        for s in self.spec.get("scenes", []):
            dur = float(s.get("duration", 0))
            nframes = int(dur * self.fps_render + 0.5)  # JS Math.round
            scenes.append({
                "id": s.get("id", "?"),
                "type": s.get("type", "?"),
                "start": cursor,
                "nframes": nframes,
                "tapeRange": (s.get("props", {}) or {}).get("tapeRange"),
            })
            cursor += nframes
        return scenes

    def race_scenes(self):
        return [s for s in self.scenes
                if s["type"] == "bar_race" and s["tapeRange"]]

    def boundary_tape_indices(self):
        bpt = self.tape.get("framesPerTransition", 30) or 30
        idx = [i for i, f in enumerate(self.frames) if f.get("isPeriodBoundary")]
        if not idx:
            idx = list(range(0, self.tape_count, bpt))
        return idx, bpt

    def screen_of_tape(self, scene, tape_idx):
        # Exact inverse of the renderer's tapePos formula
        # (DataRace.tsx: tapePos = t0 + (frame/nframes) * (t1-t0), with
        # frame measured from the scene start). Using (nframes-1) here
        # biases every sample up to one screen frame early -- enough, on
        # close-valued datasets, to land mid-glide on a rank swap.
        t0, t1 = scene["tapeRange"]
        frac = (tape_idx - t0) / max(1, t1 - t0)
        return scene["start"] + int(round(frac * scene["nframes"]))

    def tape_of_screen(self, scene, screen_idx):
        t0, t1 = scene["tapeRange"]
        frac = (screen_idx - scene["start"]) / max(1, scene["nframes"])
        return int(round(t0 + frac * (t1 - t0)))

    def sample_plan(self, n_samples):
        """Settled (screen, tape) samples inside bar_race scenes.

        Year boundaries are transition zones (rows slide/overlap for ~0.5s
        around the boundary), so sampling exactly on a boundary lands
        mid-transition. Instead we sample the MIDDLE of each year block,
        where the layout is settled and frames.json gives exact values.

        Returns (samples, mids, c2cands):
          samples  - thinned mid-block frames for C1/C3 checks
          mids     - +45-frame follow-ups per sample for the tween check
          c2cands  - every mid-block frame + dense samples across each
                     scene's opening seconds (the spotlight-card fade
                     window, where the old `740 - 150*panelAppear` bug
                     shrank every bar)
        """
        _bounds, bpt = self.boundary_tape_indices()
        blocks = []  # (scene, mid_tape) -- every year block, for C2
        settled = []  # ...minus each scene's first block, for C1/C3
        for scene in self.race_scenes():
            t0, t1 = scene["tapeRange"]
            b = (t0 // bpt) * bpt
            while b < t0:
                b += bpt
            first = True
            while b + bpt <= t1:
                mid = b + bpt // 2
                if t0 <= mid <= t1:
                    blocks.append((scene, mid))
                    if not first:
                        settled.append((scene, mid))
                    first = False
                b += bpt
        if not settled:
            return [], [], []
        step = max(1, len(settled) // n_samples)
        picks = settled[::step][:n_samples]
        samples = [(self.screen_of_tape(sc, t), t, sc["id"]) for sc, t in picks]
        mids = []  # (screen, tape, scene, sample_screen): tween probes
        for s, t, sid in samples:
            sc = next(sc for sc, _t in picks if sc["id"] == sid)
            for sec in (0.2, 0.4, 0.6):
                sm = s + int(round(sec * self.fps_render))
                if sm < sc["start"] + sc["nframes"]:
                    mids.append((sm, self.tape_of_screen(sc, sm), sid, s))
        c2 = []
        seen = set()
        for scene in self.race_scenes():
            for sec in (0.8, 1.2, 2.0, 3.0):
                # Skip the intro fade (first ~0.6s/18 frames where bars fade in
                # from transparent). Sampling during fade-in gives false 2px
                # width measurements via color detection.
                s = scene["start"] + int(round(sec * self.fps_render))
                if s < scene["start"] + scene["nframes"] and s not in seen:
                    seen.add(s)
                    c2.append((s, self.tape_of_screen(scene, s), scene["id"]))
        n_fades = len(c2)
        for sc, t in blocks:
            s = self.screen_of_tape(sc, t)
            if s not in seen:
                seen.add(s)
                c2.append((s, t, sc["id"]))
        # Cap C2 mid-block frames on long videos: the fade-window samples
        # above are the sensitive ones; a thinned spread is enough for the
        # constancy assertion.
        fades, rest = c2[:n_fades], c2[n_fades:]
        if len(rest) > 40:
            step = len(rest) / 40
            rest = [rest[int(i * step)] for i in range(40)]
        return samples, mids, fades + rest

    def extract(self, screen_indices):
        # Batched: a single select= with hundreds of terms can OOM ffmpeg
        # on long videos.
        tmp = tempfile.mkdtemp(prefix="videoqa-")
        idxs = sorted(screen_indices)
        paths = {}
        for b in range(0, len(idxs), 48):
            chunk = idxs[b:b + 48]
            sel = "+".join(f"eq(n\\,{i})" for i in chunk)
            out_pat = os.path.join(tmp, f"c{b:04d}-%03d.png")
            # The renderer composes in a 1280x720 design space and scales to
            # the output canvas (1920x1080). Analyze the design space so all
            # geometry constants below hold for any output resolution.
            r = run(["ffmpeg", "-v", "error", "-i", self.video,
                     "-vf", f"select='{sel}',scale=1280:720", "-vsync", "0", out_pat])
            if r.returncode != 0:
                sys.stderr.write(
                    f"ERROR: ffmpeg frame extraction failed:\n{r.stderr}\n")
                sys.exit(2)
            got = sorted(p for p in os.listdir(tmp)
                         if p.startswith(f"c{b:04d}-") and p.endswith(".png"))
            if len(got) != len(chunk):
                sys.stderr.write(
                    f"ERROR: extracted {len(got)} frames, expected "
                    f"{len(chunk)}.\n")
                sys.exit(2)
            for i, p in zip(chunk, got):
                paths[i] = os.path.join(tmp, p)
        return paths

    def img(self, screen_idx):
        if screen_idx not in self._imgs:
            self._imgs[screen_idx] = cv2.imread(self._paths[screen_idx])
        return self._imgs[screen_idx]

    # ------------------------------------------------------ detection ----
    def _hue_mask(self, hsv, eid):
        h, s, v = self.hues[eid]
        if s < 40:
            return None  # near-gray brand color: fall back to BGR distance
        dh = np.abs(hsv[:, :, 0].astype(np.int16) - h)
        dh = np.minimum(dh, 180 - dh)
        # The V floor is relative to the brand's own brightness: dark UI
        # text (#1f2937) is blue-hued and would otherwise match blue brand
        # colors via hue alone.
        vfloor = v - 80
        return ((dh <= 12) & (hsv[:, :, 1] >= 45) &
                (hsv[:, :, 2].astype(np.int16) >= vfloor))

    def _color_mask(self, img, eid):
        """Boolean mask of pixels painted in the entity's brand color."""
        zone = img[RACE_TOP:RACE_BOT, BAR_X0:ZONE_X1]
        hsv = cv2.cvtColor(zone, cv2.COLOR_BGR2HSV)
        mask = self._hue_mask(hsv, eid)
        if mask is None:
            e = self.entities[eid]
            hc = e["color"].lstrip("#")
            bgr = np.array([int(hc[i:i + 2], 16) for i in (4, 2, 0)],
                           dtype=np.int16)
            d = np.abs(zone.astype(np.int16) - bgr).sum(axis=2)
            mask = (d < 90) & (hsv[:, :, 1] < 60)
        full = np.zeros(img.shape[:2], dtype=bool)
        full[RACE_TOP:RACE_BOT, BAR_X0:ZONE_X1] = mask
        return full

    def measure_bar(self, img, eid, ymid, row_h, width_frac=None,
                    px_per_frac=None):
        """Width (px) of entity eid's bar. Returns (width, x0) or (None, None).

        Full-height column profile through the bar's vertical span: for each
        x, the fraction of brand-colored pixels in that column. The white
        name painted INSIDE wide bars only lowers per-column coverage to
        ~0.45 (the text is vertically centered, so the bar's top and bottom
        stay colored), which a thin center-line scan cannot survive -- it
        stops at the first long word. Rounded pill ends cost only ~2px
        (coverage stays >= 0.30 until 0.046*r from the tip).

        On dimmed (held) bars the antialiased fringe around the white glyphs
        falls below the color mask's saturation floor, so the name punches a
        WIDE dead gap inside the bar and a naive scan stops at the text
        (e.g. 49px measured for a 594px bar). The bar is therefore measured
        as runs of brand-colored columns: the walk extends across interior
        gaps (name text, fringe specks) and stops at the first clean white
        gap -- the 12px gap before the flag badge.

        Badge-glyph guard: inverted monogram badges carry the brand color
        in their glyph, and when the glyph hugs the badge's left edge its
        antialiased fringe can defeat even the middle-of-gap judgment below
        (120px measured for a 74px bar). The tape carries the renderer's
        intended width (width_frac), so gap-crossing is additionally capped
        at the intended bar end (+ slack): interior gaps resume inside the
        intended span, while the badge glyph starts 12px past it and is
        never absorbed. runs[0] itself is never capped, so a genuinely
        over-drawn bar (the min-width-clamp bug class C1 hunts) is still
        measured truthfully.

        px_per_frac is the leader-derived px scale (widthFrac * px_per_frac
        = intended px width). The renderer's maxBarWidth is data-driven per
        video, so no constant can serve here; measure_frame() derives it
        from the rank-1 bar (widthFrac == 1.0 by construction) measured
        first. None (leader unmeasurable) disables the cap -- the walk
        then behaves as if uncapped.
        """
        mask = self._color_mask(img, eid)
        bar_h = min(row_h - 10, 46)
        top = max(0, int(round(ymid - bar_h / 2)))
        bot = min(mask.shape[0], int(round(ymid + bar_h / 2)))
        seg = mask[top:bot, BAR_X0:ZONE_X1]
        if seg.size == 0:
            return None, None
        cov = seg.mean(axis=0)
        n = cov.shape[0]
        i = 0
        while i < 12 and cov[i] < 0.30:
            i += 1
        if i >= 12:
            return None, None  # bar does not start at the left margin
        x0 = BAR_X0 + i
        # Intended bar end from the tape (renderer: widthFrac * maxBarWidth,
        # with the px scale derived per video from the leader bar -- see
        # measure_frame). Caps gap-crossing only -- see the badge-glyph
        # guard in the docstring.
        intended_w = ((width_frac * px_per_frac)
                      if (width_frac and px_per_frac) else None)
        # Runs of brand-colored columns from the bar start. The bar ends
        # at the first clean white gap: the 12px gap before the flag badge
        # (badge pixels are excluded by the zone edge/scan). Interior gaps
        # -- the white name text and its antialiased fringe, pill-edge
        # specks -- either are narrow (< 10px) or still carry color fringe,
        # so the walk extends across them to the bar's true right edge.
        runs = []
        j = i
        while j < n:
            if cov[j] < 0.30:
                j += 1
                continue
            k = j
            while k < n and cov[k] >= 0.30:
                k += 1
            runs.append((j, k - 1))
            j = k
        end = runs[0][1]
        for (s1, e1) in runs[1:]:
            gap = s1 - end - 1
            if gap >= 200:
                break  # sanity: never jump that far
            # The logo badge sits 12px past the bar end. Antialiased fringes on
            # both sides of the gap (the pill's rounded tip, the badge's
            # left edge) can lift the gap's mean coverage above the
            # clean-gap threshold, fusing a same-colored badge into the bar
            # measurement (e.g. an orange favicon after an orange bar, a
            # red play button after a red bar). Judge only the middle of
            # the gap, clear of both fringes.
            g0 = end + 5
            g1 = max(g0, s1 - 6)
            gap_cov = cov[g0:g1].mean() if g1 > g0 else 1.0
            if gap >= 10 and gap_cov <= 0.05:
                break  # clean white gap: the bar end
            new_w = (BAR_X0 + e1 + 1) - x0
            if (intended_w is not None
                    and new_w > intended_w + MEASURE_CAP_SLACK_PX):
                break  # would absorb the badge glyph past the intended end
            end = e1  # interior gap (name text / fringe): keep going
        return (BAR_X0 + end + 1) - x0, x0

    # ---------------------------------------------------------- checks ----
    def add(self, check, detail, **kw):
        v = {"check": check, "detail": detail}
        v.update(kw)
        self.violations.append(v)

    def warn(self, check, detail, **kw):
        v = {"check": check, "detail": detail}
        v.update(kw)
        self.warnings.append(v)

    def frame_rows(self, tape_idx):
        f = self.frames[tape_idx]
        bars = sorted(f["bars"], key=lambda b: b["rank"])
        return [(b["entityId"], b["value"], b["rank"], b.get("width"))
                for b in bars]

    def measure_frame(self, screen_idx, tape_idx):
        img = self.img(screen_idx)
        rows = self.frame_rows(tape_idx)
        n = len(rows)
        row_h = self.row_h(n)
        out = []
        # px-per-widthFrac scale for the badge-glyph cap in measure_bar:
        # the renderer sizes bars as widthFrac * maxBarWidth with a
        # maxBarWidth that is data-driven per video (longest value label),
        # so it is derived here from the leader bar (rank 1, widthFrac ==
        # 1.0 by construction: widthFrac = value/maxValue). Rows come in
        # rank order, so the leader is measured first and the scale is
        # available for every other row. If the leader is unmeasurable the
        # scale stays None and the cap is simply disabled for the frame.
        px_per_frac = None
        for k, (eid, value, rank, wfrac) in enumerate(rows):
            ymid = RACE_TOP + (k + 0.5) * row_h
            w, x0 = self.measure_bar(img, eid, ymid, row_h, wfrac,
                                     px_per_frac)
            if rank == 1 and w and wfrac:
                px_per_frac = w / wfrac
            out.append({"entity": eid, "value": value, "rank": rank,
                        "width": w, "x0": x0, "ymid": ymid, "row_h": row_h})
        return img, out

    # C1: bars strictly proportional to values ------------------------------
    # The check is done in width space, not ratio space: comparing pure
    # width *ratios* amplifies measurement noise for small bars (a 7px
    # miss on a 58px bar skews its ratio ~12% and falsely fails against
    # the relative tolerance). Here b's expected width is implied by a's
    # measured width and the value ratio, and it must land within the
    # relative tolerance OR the absolute measurement slack (whichever is
    # larger). A genuinely broken render -- e.g. a 50px min-width clamp
    # where 10px is proportional -- deviates far beyond both and still
    # fails. (Bars under 40px and the intentional 4px stub are exempt.)
    def check_proportional(self, screen_idx, tape_idx, scene_id, measured):
        good = [m for m in measured
                if m["width"] and m["width"] > 40 and m["value"] > 0]
        n1 = n2 = 0
        for i in range(len(good)):
            for j in range(i + 1, len(good)):
                a, b = good[i], good[j]
                expected = a["value"] / b["value"]
                got = a["width"] / b["width"]
                expected_b = a["width"] * b["value"] / a["value"]
                dev = abs(b["width"] - expected_b)
                if dev > max(0.12 * expected_b, MEASURE_SLACK_PX) and n1 < 6:
                    self.add(
                        "C1-non-proportional-bars",
                        f"{a['entity']} ({a['value']:.2f}) vs {b['entity']} "
                        f"({b['value']:.2f}): value ratio {expected:.2f} but "
                        f"bar-width ratio {got:.2f} "
                        f"(widths {a['width']}px vs {b['width']}px; "
                        f"implied {expected_b:.1f}px, dev {dev:.1f}px)",
                        frame=screen_idx, tape_index=tape_idx, scene=scene_id)
                    n1 += 1
                # identical rendered widths at very different values: the
                # min-width clamp signature. (The intentional 4px stub for
                # near-zero values is exempt: min width > 20px required.)
                if (expected > 1.5 and min(a["width"], b["width"]) > 20
                        and abs(a["width"] - b["width"]) / max(
                            a["width"], b["width"]) < 0.03 and n2 < 6):
                    self.add(
                        "C1-identical-widths",
                        f"{a['entity']} ({a['value']:.2f}) and {b['entity']} "
                        f"({b['value']:.2f}) render at the SAME width "
                        f"({a['width']}px) despite a {expected:.1f}x value "
                        f"ratio -- min-width clamp is destroying the ranking",
                        frame=screen_idx, tape_index=tape_idx, scene=scene_id)
                    n2 += 1

    # C2: layout stable across spotlight cycle ------------------------------
    def check_layout_stable(self, samples):
        # The leader's value fraction is always 1.0 on a settled frame, so
        # its bar width must be identical across samples (the race width is
        # constant by design). Any spread means the layout is resizing bars
        # mid-race (the old spotlight-card fade bug). No card-state grouping:
        # the info panel sits in its reserved right-hand zone (x 904..1232),
        # so the card can never touch a bar by construction.
        widths = []
        x0s = []
        for screen_idx, tape_idx, scene_id, measured in samples:
            lead = min(measured, key=lambda m: m["rank"])
            if not lead["width"]:
                continue
            widths.append(lead["width"])
            x0s.append(lead["x0"])
        if len(widths) >= 3:
            spread = max(widths) - min(widths)
            if spread > 12:
                self.add(
                    "C2-layout-unstable",
                    f"leader bar width varies {min(widths)}px..{max(widths)}px "
                    f"(spread {spread}px) across sampled frames while its "
                    f"value fraction is 1.0 -- the race width must stay "
                    f"constant",
                    widths=widths)
        if len(x0s) >= 3:
            spread = max(x0s) - min(x0s)
            if spread > 6:
                self.add(
                    "C2-bar-shifted",
                    f"leader bar left edge moves {min(x0s)}..{max(x0s)} "
                    f"(spread {spread}px); bars must stay pinned at "
                    f"x={BAR_X0}",
                    x0s=x0s)

    # C3a: smooth tweens (no overshoot / teleport) ---------------------------
    def check_tweens(self, full, mids):
        # full: [(screen, tape, scene, measured)]; mids: [(screen, tape,
        # scene, sample_screen, measured)]. For the top-3 entities, the
        # width at each 0.2s probe must stay within the endpoint range:
        # a proper glide never overshoots or jumps outside [w0, w3].
        # Tolerance is 4% of the bar (min 15px): pixel-measurement noise
        # on a 600px bar is ~+/-5px and must not trip the gate.
        by_screen = {s: (sid, m) for s, _t, sid, m in full}
        probes = {}
        for s, t, sid, ss, m in mids:
            probes.setdefault(ss, []).append((s, m))
        for ss, plist in probes.items():
            if ss not in by_screen:
                continue
            sid, m0list = by_screen[ss]
            m0 = {m["entity"]: m for m in m0list}
            top3 = sorted(m0.values(), key=lambda x: -x["value"])[:3]
            for tm in top3:
                eid = tm["entity"]
                if not tm["width"]:
                    continue
                seq = [tm["width"]]
                ok = True
                for _ps, pm in sorted(plist):
                    d = {m["entity"]: m for m in pm}
                    if eid not in d or not d[eid]["width"]:
                        ok = False
                        break
                    seq.append(d[eid]["width"])
                if not ok or len(seq) < 3:
                    continue
                tol = max(15, 0.04 * max(seq[0], seq[-1]))
                lo, hi = min(seq[0], seq[-1]) - tol, max(seq[0], seq[-1]) + tol
                for w in seq[1:-1]:
                    if not (lo <= w <= hi):
                        self.add(
                            "C3a-tween-overshoot",
                            f"'{eid}': width {seq[0]}px -> {w}px -> "
                            f"{seq[-1]}px within 0.6s -- bar overshoots "
                            f"or jumps outside its endpoint range instead "
                            f"of gliding smoothly",
                            frame=ss, scene=sid)
                        break

    # C3b: no label text crossing row boundaries ------------------------------
    def check_labels(self, screen_idx, tape_idx, scene_id, measured):
        img = self.img(screen_idx)
        bgr = img.astype(np.int16)
        mx, mn = bgr.max(axis=2), bgr.min(axis=2)
        # DARK THEME (renderer/src/theme.ts): background #000000, text #ffffff.
        # Names/values are WHITE on black. QA MUST use bright-text detection.
        bright_text = (mn > 150) & ((mx - mn) < 60)
        rows = sorted(measured, key=lambda m: m["ymid"])
        # Displayed ranks at this tape: with the renderer's integer-rank
        # glide, rows only sit close together mid-transition; the gate
        # samples settled frames, so a sub-0.75 rank gap here means the
        # sample landed mid-swap and crossing labels are expected motion,
        # not a bug -- skip the overlap check for that pair.
        smoothed = self.smooth_ranks()
        sdict = smoothed[min(tape_idx, len(smoothed) - 1)] if smoothed else {}
        for r0, r1 in zip(rows, rows[1:]):
            sr0 = sdict.get(r0["entity"])
            sr1 = sdict.get(r1["entity"])
            if (sr0 is not None and sr1 is not None
                    and abs(sr0 - sr1) < 0.75):
                continue  # mid-swap: crossing labels are expected, not a bug
            yb = int((r0["ymid"] + r1["ymid"]) / 2)
            strip = bright_text[max(0, yb - 5):yb + 5, BAR_X0:BAR_X1]
            if int(strip.sum()) > 500:
                self.add(
                    "C3b-label-overlap",
                    f"text/label pixels cross the boundary between "
                    f"'{r0['entity']}' and '{r1['entity']}' rows "
                    f"({int(strip.sum())} bright px in the boundary strip)",
                    frame=screen_idx, scene=scene_id)
                break  # one report per frame is enough

    # C3c: bars sit in smoothed-rank order; rank numbers present ---------------
    def smooth_ranks(self):
        """Displayed rank per tape frame, replicating the renderer
        (DataRace.tsx): ranks glide between the bracketing tape frames'
        INTEGER ranks with the same easing as width/value, so at settled
        (integer) tape positions rows sit at exactly the tape's ranks and
        glide only across genuine rank changes. (The old exponential
        12-tape rank smoother this used to replicate was removed from the
        renderer; keeping its model here made the gate expect fractional
        ranks the video no longer shows.)
        """
        if self._smooth_ranks is not None:
            return self._smooth_ranks
        smoothed = []
        for f in self.frames:
            smoothed.append({bar["entityId"]: float(bar["rank"])
                             for bar in f.get("bars", [])})
        self._smooth_ranks = smoothed
        return smoothed

    def _row_entity_scores(self, img, n):
        """Brand-color pixels per row band, per entity.

        Returns {eid: [per-band scores]}. Score = brand-colored pixels in
        the bar zone of that row's band. The palette cycles, so several
        entities can share one color and tie; callers must treat a
        near-max score as "present", not demand an outright win.
        """
        zone = img[RACE_TOP:RACE_BOT, BAR_X0:C3C_X1]
        hsv = cv2.cvtColor(zone, cv2.COLOR_BGR2HSV)
        row_h = self.row_h(n)
        scores = {}
        for eid in self.entities:
            mask = self._hue_mask(hsv, eid)
            if mask is None:
                e = self.entities[eid]
                hc = e["color"].lstrip("#")
                bgr = np.array([int(hc[i:i + 2], 16) for i in (4, 2, 0)],
                               dtype=np.int16)
                d = np.abs(zone.astype(np.int16) - bgr).sum(axis=2)
                mask = (d < 90) & (hsv[:, :, 1] < 60)
            per_row = []
            for k in range(n):
                y0 = int(k * row_h)
                y1 = int((k + 1) * row_h)
                per_row.append(int(mask[y0:y1, :].sum()))
            scores[eid] = per_row
        return scores

    def check_ranks(self, screen_idx, tape_idx, scene_id, measured):
        img = self.img(screen_idx)
        n = len(measured)
        smoothed_all = self.smooth_ranks()
        smoothed = smoothed_all[tape_idx] if tape_idx < len(smoothed_all) else {}
        # Expected visual order: the renderer's eased ranks. Ranks glide
        # between the bracketing tapes' integer ranks, so at the settled
        # frames this gate samples the visual order equals the tape order;
        # mid-glide frames are never sampled (see screen_of_tape).
        exp = sorted(measured,
                     key=lambda m: smoothed.get(m["entity"], m["rank"]))
        expected = [m["entity"] for m in exp]
        scores = self._row_entity_scores(img, n)
        for k, e in enumerate(expected):
            s_e = scores[e][k]
            max_s = max(s[k] for s in scores.values())
            # The bar is "here" unless another color decisively dominates
            # the band (1.5x). A tie is fine -- the palette cycles so
            # entities share colors -- and so is a close call against
            # text anti-aliasing noise, which can outscore a tiny sliver
            # without being a real bar.
            if max_s <= 1.5 * max(s_e, 80):
                continue
            sr_e = smoothed.get(e, 0.0)
            if abs(sr_e - int(sr_e + 0.5)) > 0.3:
                # A bar between rows owns no band cleanly; don't fail it.
                self.warn(
                    "C3c-glide-order",
                    f"row {k + 1}: '{e}' not dominant "
                    f"(smoothed rank {sr_e:.2f}) -- mid-glide, strict "
                    f"order not asserted",
                    frame=screen_idx, tape_index=tape_idx, scene=scene_id)
            else:
                w = max(scores, key=lambda eid: scores[eid][k])
                self.warn(
                    "C3c-rank-order",
                    f"row {k + 1}: expected '{e}' ({s_e}px) but "
                    f"'{w}' dominates the band ({max_s}px) -- bar "
                    f"order does not match the rank order",
                    frame=screen_idx, tape_index=tape_idx, scene=scene_id)
        bgr = img.astype(np.int16)
        mx, mn = bgr.max(axis=2), bgr.min(axis=2)
        gray = ((mx - mn) < 30) & (mx >= 110) & (mx <= 215)
        row_h = self.row_h(n)
        for k, m in enumerate(sorted(measured, key=lambda x: x["ymid"])):
            y0 = int(RACE_TOP + k * row_h)
            y1 = int(RACE_TOP + (k + 1) * row_h)
            # The numeral rides with its bar, which glides between rows during
            # transitions (fractional ranks), so at a sampled frame it can sit
            # up to half a row off its band. Search a half-row-taller window:
            # a present numeral is still ~40+ px, a truly missing one ~0.
            wy0 = max(0, int(y0 - row_h / 2))
            wy1 = int(y1 + row_h / 2)
            box = gray[wy0:wy1, MARGIN_X0:MARGIN_X1]
            # threshold 25: a present numeral is ~40+ px even at 10 rows;
            # a truly missing one is ~0
            if int(box.sum()) < 25:
                # Advisory only: rank-label detection is color-threshold
                # pixel counting, the fragile visual-check class the QA
                # redesign keeps as warnings that never fail the render.
                self.warn(
                    "C3c-rank-label-missing",
                    f"no rank number found in the left margin for row "
                    f"{k + 1} ('{m['entity']}')",
                    frame=screen_idx, tape_index=tape_idx, scene=scene_id)

    # ---------------------------------------------------------------- run --
    def run(self, n_samples=8):
        samples, mids, c2cands = self.sample_plan(n_samples)
        if not samples:
            sys.stderr.write(
                "ERROR: no bar_race scenes with tapeRange found in "
                "video-spec.json; nothing to check.\n")
            sys.exit(2)
        self._paths = self.extract(
            {s for s, _t, _sid in samples}
            | {s for s, _t, _sid in c2cands}
            | {ms for ms, _mt, _msid, _ss in mids})

        full = []  # (screen, tape, scene, measured)
        for screen_idx, tape_idx, scene_id in samples:
            _img, measured = self.measure_frame(screen_idx, tape_idx)
            full.append((screen_idx, tape_idx, scene_id, measured))
            self.check_proportional(screen_idx, tape_idx, scene_id, measured)
            self.check_labels(screen_idx, tape_idx, scene_id, measured)
            self.check_ranks(screen_idx, tape_idx, scene_id, measured)
        c2_full = []
        for screen_idx, tape_idx, scene_id in c2cands:
            _img, measured = self.measure_frame(screen_idx, tape_idx)
            c2_full.append((screen_idx, tape_idx, scene_id, measured))
        self.check_layout_stable(c2_full)
        mids_full = []
        for ms, mt, msid, ss in mids:
            _img, measured = self.measure_frame(ms, mt)
            mids_full.append((ms, mt, msid, ss, measured))
        self.check_tweens(full, mids_full)
        return self.violations


def main():
    ap = argparse.ArgumentParser(
        description="Visual QA gate for data-race videos.")
    ap.add_argument("video", help="rendered MP4 file")
    ap.add_argument("--frames", required=True,
                    help="frames.json (or bundle dir containing it)")
    ap.add_argument("--out", default=None, help="write JSON report here")
    ap.add_argument("--samples", type=int, default=8,
                    help="year-boundary frames to sample (default 8)")
    a = ap.parse_args()

    if not os.path.isfile(a.video):
        sys.stderr.write(f"ERROR: video not found: {a.video}\n")
        return 2
    frames_path = a.frames
    bundle_dir = None
    if os.path.isdir(a.frames):
        bundle_dir = a.frames
        frames_path = os.path.join(a.frames, "frames.json")
    else:
        bundle_dir = os.path.dirname(os.path.abspath(a.frames))
    if not os.path.isfile(frames_path):
        sys.stderr.write(f"ERROR: frames.json not found: {a.frames}\n")
        return 2
    spec_path = os.path.join(bundle_dir, "video-spec.json")
    if not os.path.isfile(spec_path):
        sys.stderr.write(
            f"ERROR: video-spec.json not found in bundle dir {bundle_dir} "
            f"(needed for the scene -> tape mapping).\n")
        return 2

    info = probe_video(a.video)
    if info["width"] != 1920 or info["height"] != 1080:
        sys.stderr.write(
            f"WARNING: expected 1920x1080, got "
            f"{info['width']}x{info['height']} -- frames will be downscaled "
            f"to the 1280x720 design space for analysis.\\n")

    with open(frames_path) as fh:
        tape = json.load(fh)
    if "frames" not in tape or "entities" not in tape:
        sys.stderr.write("ERROR: frames.json lacks 'frames'/'entities'.\n")
        return 2
    with open(spec_path) as fh:
        spec = json.load(fh)

    fps_render = info.get("rfps") or (
        info["frames"] / float(
            json.loads(run(["ffprobe", "-v", "error", "-show_entries",
                            "format=duration", "-of", "json",
                            a.video]).stdout)["format"]["duration"]))
    if not fps_render:
        sys.stderr.write("ERROR: could not determine video frame rate.\n")
        return 2
    qa = VideoQA(a.video, bundle_dir, tape, spec, info["frames"], fps_render)
    violations = qa.run(n_samples=a.samples)

    report = {"video": a.video, "frames": frames_path,
              "video_info": info, "violations": violations,
              "warnings": qa.warnings}
    if a.out:
        with open(a.out, "w") as fh:
            json.dump(report, fh, indent=2, default=int)

    for w in qa.warnings:
        print(f"  ! [{w['check']}] {w['detail']}")
    if not violations:
        print(f"OK: {a.video} passed all video-qa checks.")
        return 0
    print(f"FAIL: {len(violations)} violation(s) in {a.video}:")
    for v in violations:
        loc = ""
        if "frame" in v:
            loc = f" [video frame {v['frame']}"
            if "tape_index" in v:
                loc += f" / tape {v['tape_index']}"
            if "scene" in v:
                loc += f" / {v['scene']}"
            loc += "]"
        print(f"  - [{v['check']}] {v['detail']}{loc}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
