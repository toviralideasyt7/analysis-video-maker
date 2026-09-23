#!/usr/bin/env python3
"""
check-video.py -- automated visual QA gate for data-race videos.

Compares a rendered bar-chart-race MP4 against its bundle (frames.json +
video-spec.json) and flags the visual/animation bug classes that have shipped
to users before:

  C1  non-proportional bars   (a min-width clamp made 7% and 1% bars identical)
  C2  unstable layout         (leader bar width/position must not move when the
                               spotlight card fades in/out)
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
RACE_TOP = 112          # bars live between y=112 and y=648
RACE_BOT = 648
BAR_X0 = 96             # every bar starts at x=96
ZONE_X1 = 955           # right edge of the bar scan zone: the EraPanel
                        # (fact box) starts at x=960 and spotlights the top-2
                        # entities in their brand colors -- scanning to x=1000
                        # let panel pixels outvote tiny bars in the bottom rows
C3C_X1 = 135            # right edge for the C3c rank-order scan: country
                        # flags sit at the bar end (x~140+) and their colors
                        # can match other entities' brands; the bar's left
                        # 39px is flag-free and enough to identify its color.
BAR_X1 = 960            # bars/labels must stay left of the spotlight card
MARGIN_X0, MARGIN_X1 = 50, 90   # rank-number margin box

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
        "-show_entries", "stream=width,height,nb_frames,avg_frame_rate,duration",
        "-of", "json", path,
    ])
    if r.returncode != 0:
        sys.stderr.write(f"ERROR: ffprobe failed on {path}:\n{r.stderr}\n")
        sys.exit(2)
    s = json.loads(r.stdout)["streams"][0]
    num, den = (int(x) for x in s["avg_frame_rate"].split("/"))
    fps = num / den if den else 0
    n = int(s.get("nb_frames") or 0)
    if not n and s.get("duration") and fps:
        n = int(round(float(s["duration"]) * fps))
    if not n:
        sys.stderr.write("ERROR: could not determine frame count of video.\n")
        sys.exit(2)
    return {"width": int(s["width"]), "height": int(s["height"]),
            "frames": n, "fps": fps}


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
        """Screen-frame ranges for every scene, from video-spec.json."""
        scenes = []
        cursor = 0.0
        for s in self.spec.get("scenes", []):
            dur = float(s.get("duration", 0))
            nframes = int(round(dur * self.fps_render))
            scenes.append({
                "id": s.get("id", "?"),
                "type": s.get("type", "?"),
                "start": int(round(cursor * self.fps_render)),
                "nframes": nframes,
                "tapeRange": (s.get("props", {}) or {}).get("tapeRange"),
            })
            cursor += dur
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
        t0, t1 = scene["tapeRange"]
        frac = (tape_idx - t0) / max(1, t1 - t0)
        return scene["start"] + int(round(frac * (scene["nframes"] - 1)))

    def tape_of_screen(self, scene, screen_idx):
        t0, t1 = scene["tapeRange"]
        frac = (screen_idx - scene["start"]) / max(1, scene["nframes"] - 1)
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
            for sec in (0.15, 0.3, 0.5, 0.8, 1.2, 2.0):
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
            r = run(["ffmpeg", "-v", "error", "-i", self.video,
                     "-vf", f"select='{sel}'", "-vsync", "0", out_pat])
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

    def measure_bar(self, img, eid, ymid, row_h):
        """Width (px) of entity eid's bar. Returns (width, x0) or (None, None).

        Full-height column profile through the bar's vertical span: for each
        x, the fraction of brand-colored pixels in that column. The white
        name painted INSIDE wide bars only lowers per-column coverage to
        ~0.45 (the text is vertically centered, so the bar's top and bottom
        stay colored), which a thin center-line scan cannot survive -- it
        stops at the first long word. Rounded pill ends cost only ~2px
        (coverage stays >= 0.30 until 0.046*r from the tip).
        """
        mask = self._color_mask(img, eid)
        bar_h = row_h - 16
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
        last = i
        gap = 0
        for j in range(i, n):
            if cov[j] >= 0.30:
                last = j
                gap = 0
            else:
                gap += 1
                if gap >= 6 and cov[j] < 0.15:
                    break
        return (BAR_X0 + last + 1) - x0, x0

    def card_present(self, img):
        """Is the spotlight card visible? Its accent edge is a saturated
        vertical strip at x~963, y 180..360 (accent = leader's color)."""
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        col = (hsv[180:360, 955:975, 1] > 80).sum(axis=0)
        return bool(col.max() > 100)

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
        return [(b["entityId"], b["value"], b["rank"]) for b in bars]

    def measure_frame(self, screen_idx, tape_idx):
        img = self.img(screen_idx)
        rows = self.frame_rows(tape_idx)
        n = len(rows)
        row_h = self.row_h(n)
        out = []
        for k, (eid, value, rank) in enumerate(rows):
            ymid = RACE_TOP + (k + 0.5) * row_h
            w, x0 = self.measure_bar(img, eid, ymid, row_h)
            out.append({"entity": eid, "value": value, "rank": rank,
                        "width": w, "x0": x0, "ymid": ymid, "row_h": row_h})
        return img, out

    # C1: bars strictly proportional to values ------------------------------
    def check_proportional(self, screen_idx, tape_idx, scene_id, measured):
        good = [m for m in measured
                if m["width"] and m["width"] > 40 and m["value"] > 0]
        n1 = n2 = 0
        for i in range(len(good)):
            for j in range(i + 1, len(good)):
                a, b = good[i], good[j]
                expected = a["value"] / b["value"]
                got = a["width"] / b["width"]
                rel = abs(got - expected) / expected
                if rel > 0.12 and n1 < 6:
                    self.add(
                        "C1-non-proportional-bars",
                        f"{a['entity']} ({a['value']:.2f}) vs {b['entity']} "
                        f"({b['value']:.2f}): value ratio {expected:.2f} but "
                        f"bar-width ratio {got:.2f} "
                        f"(widths {a['width']}px vs {b['width']}px)",
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
        # Group leader widths by spotlight-card state: the card must never
        # change any bar's geometry. Compare both within and across states.
        by_card = {True: [], False: []}
        x0s = []
        for screen_idx, tape_idx, scene_id, measured in samples:
            lead = min(measured, key=lambda m: m["rank"])
            if not lead["width"]:
                continue
            card = self.card_present(self.img(screen_idx))
            by_card[card].append((screen_idx, lead["width"]))
            x0s.append(lead["x0"])
        widths = [w for grp in by_card.values() for _, w in grp]
        both_states = len(by_card[True]) >= 1 and len(by_card[False]) >= 1
        enough = len(widths) >= 3 or (both_states and len(widths) >= 2)
        fired = False
        if enough:
            spread = max(widths) - min(widths)
            if spread > 12:
                fired = True
                shown = [w for _, w in by_card[True]]
                hidden = [w for _, w in by_card[False]]
                self.add(
                    "C2-layout-unstable",
                    f"leader bar width varies {min(widths)}px..{max(widths)}px "
                    f"(spread {spread}px) across sampled frames while its "
                    f"value fraction is 1.0 -- the race width must stay "
                    f"constant; the spotlight card's fade must not resize "
                    f"any bar (card shown widths: "
                    f"{min(shown) if shown else 'n/a'}.."
                    f"{max(shown) if shown else 'n/a'}px; card hidden: "
                    f"{min(hidden) if hidden else 'n/a'}.."
                    f"{max(hidden) if hidden else 'n/a'}px)",
                    widths=widths)
        if not fired and not both_states and len(widths) >= 2:
            self.warn(
                "C2-inconclusive",
                f"spotlight card was {'shown' if by_card[True] else 'hidden'} "
                f"in all {len(widths)} sampled frames -- could not observe "
                f"both card states, layout-vs-card comparison skipped",
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
    def check_labels(self, screen_idx, scene_id, measured):
        img = self.img(screen_idx)
        bgr = img.astype(np.int16)
        mx, mn = bgr.max(axis=2), bgr.min(axis=2)
        dark_text = (mx < 90) & ((mx - mn) < 40)
        rows = sorted(measured, key=lambda m: m["ymid"])
        for r0, r1 in zip(rows, rows[1:]):
            yb = int((r0["ymid"] + r1["ymid"]) / 2)
            strip = dark_text[max(0, yb - 5):yb + 5, BAR_X0:BAR_X1]
            if int(strip.sum()) > 500:
                self.add(
                    "C3b-label-overlap",
                    f"text/label pixels cross the boundary between "
                    f"'{r0['entity']}' and '{r1['entity']}' rows "
                    f"({int(strip.sum())} dark px in the boundary strip)",
                    frame=screen_idx, scene=scene_id)
                break  # one report per frame is enough

    # C3c: bars sit in smoothed-rank order; rank numbers present ---------------
    def smooth_ranks(self):
        """Replicate the renderer's buildSmoothRanks (DataRace.tsx): the
        displayed rank eases toward its target over 12 tapes (cubic ease),
        so the visual row order lags frames.json's discrete ranks for
        several tapes after any swap. The gate must compare against the
        smoothed order -- comparing against raw ranks flags correct
        mid-glide frames as violations."""
        if self._smooth_ranks is not None:
            return self._smooth_ranks
        blend = 12
        displayed = {}
        smoothed = []
        for index, f in enumerate(self.frames):
            for bar in f.get("bars", []):
                eid = bar["entityId"]
                ex = displayed.get(eid)
                if ex is None:
                    displayed[eid] = {"value": float(bar["rank"]),
                                      "target": bar["rank"],
                                      "since": index}
                    continue
                if ex["target"] != bar["rank"]:
                    ex["target"] = bar["rank"]
                    ex["since"] = index
                progress = min(1.0, (index - ex["since"]) / max(1, blend))
                eased = 1 - (1 - progress) ** 3
                ex["value"] = ex["value"] + (ex["target"] - ex["value"]) * eased
            smoothed.append({eid: v["value"]
                             for eid, v in displayed.items()})
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
        # Expected visual order: the renderer's eased ranks, not the raw
        # frames.json ranks. The displayed rank glides toward its target
        # over 12 tapes, so for several tapes after a swap the visual order
        # legitimately lags the discrete data.
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
                self.add(
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
                self.add(
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
            self.check_labels(screen_idx, scene_id, measured)
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
    if info["width"] != 1280 or info["height"] != 720:
        sys.stderr.write(
            f"WARNING: expected 1280x720, got "
            f"{info['width']}x{info['height']} -- layout checks may be off.\n")

    with open(frames_path) as fh:
        tape = json.load(fh)
    if "frames" not in tape or "entities" not in tape:
        sys.stderr.write("ERROR: frames.json lacks 'frames'/'entities'.\n")
        return 2
    with open(spec_path) as fh:
        spec = json.load(fh)

    fps_render = info["frames"] / float(
        json.loads(run(["ffprobe", "-v", "error", "-show_entries",
                        "format=duration", "-of", "json",
                        a.video]).stdout)["format"]["duration"])
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
