#!/usr/bin/env python3
"""
Generate a YouTube thumbnail for data-race videos.

Design (per user spec):
  - Background: a real frame from the rendered video (the race itself)
  - Topic icon on the top-right: a vector illustration about the video's topic
    (car for car videos, phone for mobile, factory for CO2, etc.)
  - Caption below the icon: green box with the topic title + year range,
    styled like the in-video side panel.

Usage:
  python3 tools/make-thumbnail.py \
    --video projects/<id>/renders/<id>-final.mp4 \
    --topic "Mobile phone vendor market share, 2010-2026" \
    --years "2010 - 2026" \
    --out projects/<id>/renders/<id>-thumbnail.jpg
"""
import argparse
import os
import re
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont, ImageEnhance

W, H = 1280, 720
WHITE = (255, 255, 255)
BLACK = (10, 10, 10)
NAVY = (8, 48, 110)
GREEN_TOP = (34, 197, 94)
GREEN_BOT = (21, 128, 61)


def find_font() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    beb = os.path.join(here, "fonts", "BebasNeue.ttf")
    if os.path.exists(beb):
        return beb
    return "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def grab_frame(video: str, at: float, out_path: str) -> None:
    dur = float(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", video,
    ]).decode().strip())
    ts = max(0.5, dur * at)
    subprocess.check_call([
        "ffmpeg", "-y", "-v", "error", "-ss", f"{ts:.2f}", "-i", video,
        "-frames:v", "1", "-vf", f"scale={W}:{H}", out_path,
    ])


def clean_topic(title: str) -> str:
    """Mirror the in-video side-panel title cleaning (DataRace.tsx)."""
    t = title or ""
    t = re.sub(r"^Top \d+\s*", "", t, flags=re.I)
    t = re.sub(r"\s+by annual.*$", "", t, flags=re.I)
    t = re.sub(r"^bar chart race of (the )?", "", t, flags=re.I)
    t = re.sub(r",?\s*\d{4}\s*[-\u2013\u2014]\s*\d{4}\.?$", "", t)
    t = re.sub(r"\s+from\s+\d+.*$", "", t, flags=re.I)
    t = t.strip().rstrip(".")
    # keep a leading "Top" when it has no number (e.g. "Top car producing countries")
    return t.upper()


# ---------------------------------------------------------------- icons ---

def draw_car(d, cx, cy, s):
    body = [(cx - 150 * s, cy + 40 * s), (cx - 140 * s, cy - 10 * s),
            (cx - 80 * s, cy - 18 * s), (cx - 55 * s, cy - 62 * s),
            (cx + 45 * s, cy - 62 * s), (cx + 75 * s, cy - 18 * s),
            (cx + 140 * s, cy - 10 * s), (cx + 150 * s, cy + 40 * s)]
    d.polygon(body, fill=WHITE)
    d.polygon([(cx - 45 * s, cy - 54 * s), (cx + 35 * s, cy - 54 * s),
               (cx + 55 * s, cy - 22 * s), (cx - 65 * s, cy - 22 * s)], fill=NAVY)
    for wx in (cx - 85 * s, cx + 85 * s):
        d.ellipse([wx - 32 * s, cy + 12 * s, wx + 32 * s, cy + 76 * s], fill=BLACK)
        d.ellipse([wx - 14 * s, cy + 30 * s, wx + 14 * s, cy + 58 * s], fill=(180, 180, 180))
    d.ellipse([cx + 118 * s, cy - 4 * s, cx + 142 * s, cy + 14 * s], fill=(255, 213, 0))


def draw_phone(d, cx, cy, s):
    w, h = 104 * s, 208 * s
    d.rounded_rectangle([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
                        radius=20 * s, fill=WHITE)
    m = 12 * s
    d.rounded_rectangle([cx - w / 2 + m, cy - h / 2 + m + 16 * s,
                         cx + w / 2 - m, cy + h / 2 - m - 24 * s],
                        radius=8 * s, fill=NAVY)
    d.rounded_rectangle([cx - 20 * s, cy - h / 2 + 7 * s,
                         cx + 20 * s, cy - h / 2 + 11 * s], radius=2 * s, fill=(130, 130, 130))
    d.ellipse([cx - 11 * s, cy + h / 2 - 20 * s, cx + 11 * s, cy + h / 2 + 2 * s],
              outline=(130, 130, 130), width=max(2, int(3 * s)))


def draw_factory(d, cx, cy, s):
    # chimneys
    d.rectangle([cx - 85 * s, cy - 95 * s, cx - 52 * s, cy,], fill=WHITE)
    d.rectangle([cx + 52 * s, cy - 115 * s, cx + 85 * s, cy], fill=WHITE)
    # smoke puffs
    for ox, oy, r in [(-68, -125, 15), (-58, -158, 20), (68, -145, 17), (80, -182, 22)]:
        d.ellipse([cx + ox * s - r * s, cy + oy * s - r * s,
                   cx + ox * s + r * s, cy + oy * s + r * s], fill=(215, 215, 215, 170))
    # main hall
    d.rectangle([cx - 125 * s, cy - 10 * s, cx + 125 * s, cy + 70 * s], fill=WHITE)
    d.polygon([(cx - 125 * s, cy - 10 * s), (cx + 125 * s, cy - 10 * s),
               (cx + 95 * s, cy - 55 * s), (cx - 95 * s, cy - 55 * s)], fill=WHITE)
    # windows
    for i in range(4):
        wx = cx - 105 * s + i * 58 * s
        d.rectangle([wx, cy + 12 * s, wx + 38 * s, cy + 48 * s], fill=NAVY)


def draw_gamepad(d, cx, cy, s):
    w, h = 230 * s, 135 * s
    d.rounded_rectangle([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
                        radius=48 * s, fill=WHITE)
    # d-pad
    d.rectangle([cx - 82 * s, cy - 13 * s, cx - 42 * s, cy + 13 * s], fill=NAVY)
    d.rectangle([cx - 74 * s, cy - 21 * s, cx - 50 * s, cy + 21 * s], fill=NAVY)
    # buttons
    d.ellipse([cx + 42 * s, cy - 22 * s, cx + 64 * s, cy, ], fill=NAVY)
    d.ellipse([cx + 68 * s, cy - 2 * s, cx + 90 * s, cy + 20 * s], fill=NAVY)


def draw_globe(d, cx, cy, s):
    r = 88 * s
    wd = max(3, int(9 * s))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=WHITE, width=wd)
    d.ellipse([cx - 36 * s, cy - r, cx + 36 * s, cy + r], outline=WHITE, width=max(2, int(6 * s)))
    d.line([cx - r, cy, cx + r, cy], fill=WHITE, width=max(2, int(6 * s)))
    d.arc([cx - 62 * s, cy - 62 * s, cx + 62 * s, cy + 62 * s], 205, 335,
          fill=WHITE, width=max(2, int(6 * s)))


def draw_crown(d, cx, cy, s):
    pts = [(cx - 112 * s, cy + 52 * s), (cx - 112 * s, cy - 28 * s),
           (cx - 56 * s, cy + 12 * s), (cx, cy - 58 * s),
           (cx + 56 * s, cy + 12 * s), (cx + 112 * s, cy - 28 * s),
           (cx + 112 * s, cy + 52 * s)]
    d.polygon(pts, fill=WHITE)
    for tx, ty in [(-112, -42), (0, -72), (112, -42)]:
        d.ellipse([cx + tx * s - 14 * s, cy + ty * s - 14 * s,
                   cx + tx * s + 14 * s, cy + ty * s + 14 * s], fill=WHITE)
    d.rectangle([cx - 112 * s, cy + 60 * s, cx + 112 * s, cy + 80 * s], fill=WHITE)
    d.ellipse([cx - 16 * s, cy + 2 * s, cx + 16 * s, cy + 34 * s], fill=NAVY)


def draw_people(d, cx, cy, s):
    for ox, ps in ((-95, 0.68), (0, 1.0), (95, 0.68)):
        px = cx + ox * s
        d.ellipse([px - 32 * ps * s, cy - 78 * ps * s,
                   px + 32 * ps * s, cy - 14 * ps * s], fill=WHITE)
        d.rounded_rectangle([px - 46 * ps * s, cy - 2 * ps * s,
                             px + 46 * ps * s, cy + 68 * ps * s],
                            radius=20 * s, fill=WHITE)


def draw_chart(d, cx, cy, s):
    wd = max(3, int(9 * s))
    d.line([cx - 115 * s, cy + 72 * s, cx + 115 * s, cy + 72 * s], fill=WHITE, width=wd)
    for i, h in enumerate((72, 112, 152)):
        x0 = cx - 100 * s + i * 72 * s
        d.rectangle([x0, cy + 72 * s - h * s, x0 + 52 * s, cy + 72 * s], fill=WHITE)


def draw_star(d, cx, cy, s):
    r = 90 * s
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=WHITE)
    f = ImageFont.truetype(find_font(), int(110 * s))
    tw = d.textlength("\u2605", font=f)
    d.text((cx - tw / 2, cy - 80 * s), "\u2605", font=f, fill=NAVY)


ICONS = {
    "car": draw_car, "phone": draw_phone, "factory": draw_factory,
    "gamepad": draw_gamepad, "globe": draw_globe, "crown": draw_crown,
    "people": draw_people, "chart": draw_chart, "star": draw_star,
}

ICON_MAP = [
    (("car", "vehicle", "automobile", "auto"), "car"),
    (("phone", "mobile", "smartphone", "iphone", "android"), "phone"),
    (("co2", "carbon", "emission", "pollution", "factory", "industr"), "factory"),
    (("console", "game", "gaming", "playstation", "xbox", "nintendo"), "gamepad"),
    (("browser", "internet", "website", "web "), "globe"),
    (("empire", "kingdom", "richest", "billionaire"), "crown"),
    (("population", "people", "census", "demographic"), "people"),
    (("econom", "gdp", "market", "revenue", "trade", "export"), "chart"),
]


def pick_icon(topic: str) -> str:
    t = (topic or "").lower()
    for keys, icon in ICON_MAP:
        if any(k in t for k in keys):
            return icon
    return "star"


# ------------------------------------------------------------ caption ---

def wrap_lines(d, text, font, max_w):
    words = text.split()
    lines, cur = [], ""
    for w_ in words:
        trial = (cur + " " + w_).strip()
        if d.textlength(trial, font=font) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w_
    if cur:
        lines.append(cur)
    return lines


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--topic", default="", help="video topic / spec title")
    ap.add_argument("--years", default="", help='e.g. "2010 - 2026"')
    ap.add_argument("--hook", default="", help="deprecated, ignored")
    ap.add_argument("--icon", default="", help="force icon kind")
    ap.add_argument("--out", required=True)
    ap.add_argument("--at", type=float, default=0.55,
                    help="fraction of video duration to grab the background frame")
    args = ap.parse_args()

    topic = clean_topic(args.topic)
    icon_kind = args.icon or pick_icon(topic)
    years = (args.years or "").replace(" ", "")

    font_path = find_font()

    # --- background: real video frame, slightly darkened for contrast ---
    tmp = args.out + ".frame.png"
    grab_frame(args.video, args.at, tmp)
    img = Image.open(tmp).convert("RGB")
    img = ImageEnhance.Brightness(img).enhance(0.86)
    d = ImageDraw.Draw(img, "RGBA")

    # soft dark backdrop behind the icon for pop
    icon_cx, icon_cy = 1005, 185
    d.ellipse([icon_cx - 150, icon_cy - 130, icon_cx + 150, icon_cy + 130],
              fill=(0, 0, 0, 45))

    # --- topic icon ---
    ICONS.get(icon_kind, draw_star)(d, icon_cx, icon_cy, 1.0)

    # --- green caption box (like the in-video side panel) ---
    box_w, box_x1 = 470, W - 40
    box_x0 = box_x1 - box_w
    pad = 30
    font_title = ImageFont.truetype(font_path, 46)
    font_years = ImageFont.truetype(font_path, 58)

    title_lines = wrap_lines(d, topic, font_title, box_w - 2 * pad)[:3]
    lh = [d.textbbox((0, 0), ln, font=font_title)[3] for ln in title_lines]
    yh = d.textbbox((0, 0), years, font=font_years)[3] if years else 0
    box_h = pad + sum(lh) + 14 * (len(lh) - 1)
    if years:
        box_h += 16 + 2 + 16 + yh  # gap + divider + gap + years
    box_h += pad
    box_y0 = 330

    grad = Image.new("RGB", (box_w, box_h))
    gd = ImageDraw.Draw(grad)
    for y in range(box_h):
        t = y / max(1, box_h - 1)
        gd.line([(0, y), (box_w, y)], fill=(
            int(GREEN_TOP[0] + (GREEN_BOT[0] - GREEN_TOP[0]) * t),
            int(GREEN_TOP[1] + (GREEN_BOT[1] - GREEN_TOP[1]) * t),
            int(GREEN_TOP[2] + (GREEN_BOT[2] - GREEN_TOP[2]) * t)))
    mask = Image.new("L", (box_w, box_h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, box_w, box_h], radius=14, fill=255)
    img.paste(grad, (box_x0, box_y0), mask)
    d = ImageDraw.Draw(img, "RGBA")
    d.rounded_rectangle([box_x0, box_y0, box_x1, box_y0 + box_h], radius=14,
                        outline=(255, 255, 255, 60), width=2)

    def shadow_text(xy, text, font, fill):
        x, y = xy
        d.text((x + 2, y + 2), text, font=font, fill=(0, 0, 0, 110))
        d.text((x, y), text, font=font, fill=fill)

    ty = box_y0 + pad
    for ln, h_ in zip(title_lines, lh):
        tw = d.textlength(ln, font=font_title)
        shadow_text((box_x0 + (box_w - tw) / 2, ty), ln, font_title, WHITE)
        ty += h_ + 14
    if years:
        ty += 2
        d.line([(box_x0 + pad, ty), (box_x1 - pad, ty)], fill=(255, 255, 255, 70), width=2)
        ty += 18
        yw = d.textlength(years, font=font_years)
        shadow_text((box_x0 + (box_w - yw) / 2, ty), years, font_years, WHITE)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    img.save(args.out, "JPEG", quality=92)
    try:
        os.remove(tmp)
    except OSError:
        pass
    print(f"thumbnail written: {args.out} (icon={icon_kind} topic={topic!r})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
