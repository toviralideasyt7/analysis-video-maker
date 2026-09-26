#!/usr/bin/env python3
"""
Generate a high-CTR YouTube thumbnail for data-race videos.

Design (per thumbnail-ctr best practices):
  - Video frame as background, darkened for contrast
  - HUGE topic emoji as the visual anchor (car for car videos, etc.)
  - 2-3 punchy CLICKBAIT words about the video (never generic "Data Race")
  - Year range pill
  - Small Data Races brand badge

Usage:
  python3 tools/make-thumbnail.py \
    --video projects/<id>/renders/<id>-final.mp4 \
    --hook "CHINA CRUSHES ALL" \
    --years "1950 - 2025" \
    --emoji "🚗" \
    --out projects/<id>/renders/<id>-thumbnail.jpg
"""
import argparse
import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 720
BLUE = (13, 71, 161)
BLUE_DARK = (8, 48, 110)
WHITE = (255, 255, 255)
YELLOW = (255, 213, 0)      # punchy accent for hook text
BLACK = (10, 10, 10)

# (icon map defined below with draw_icon)


def find_font(bold: bool = True) -> str:
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    raise RuntimeError("no usable TTF font found")


def emoji_font(size: int) -> ImageFont.FreeTypeFont:
    # We draw vector icons instead of emoji (PIL cannot render color-emoji
    # fonts reliably, and CI runners may not have them). Kept for fallback.
    return ImageFont.truetype(find_font(True), size)


def draw_car(draw: ImageDraw.ImageDraw, cx: int, cy: int, s: float) -> None:
    """Side-view car silhouette, drawn in white with dark details. s = scale."""
    # Body
    body = [
        (cx - 150 * s, cy + 40 * s),
        (cx - 140 * s, cy - 10 * s),
        (cx - 80 * s, cy - 18 * s),
        (cx - 55 * s, cy - 62 * s),
        (cx + 45 * s, cy - 62 * s),
        (cx + 75 * s, cy - 18 * s),
        (cx + 140 * s, cy - 10 * s),
        (cx + 150 * s, cy + 40 * s),
    ]
    draw.polygon(body, fill=WHITE)
    # Cabin windows
    draw.polygon([
        (cx - 45 * s, cy - 54 * s), (cx + 35 * s, cy - 54 * s),
        (cx + 55 * s, cy - 22 * s), (cx - 65 * s, cy - 22 * s),
    ], fill=BLUE_DARK)
    # Wheels
    for wx in (cx - 85 * s, cx + 85 * s):
        draw.ellipse([wx - 32 * s, cy + 12 * s, wx + 32 * s, cy + 76 * s], fill=BLACK)
        draw.ellipse([wx - 14 * s, cy + 30 * s, wx + 14 * s, cy + 58 * s], fill=(180, 180, 180))
    # Headlight
    draw.ellipse([cx + 118 * s, cy - 4 * s, cx + 142 * s, cy + 14 * s], fill=YELLOW)


def draw_icon(draw: ImageDraw.ImageDraw, kind: str, cx: int, cy: int, s: float) -> None:
    """Dispatch to a vector icon. Extend with new topics as needed."""
    if kind == "car":
        draw_car(draw, cx, cy, s)
        return
    # fallback: big trophy-ish star for anything else
    r = 90 * s
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=WHITE)
    f = ImageFont.truetype(find_font(True), int(110 * s))
    tw = draw.textlength("★", font=f)
    draw.text((cx - tw / 2, cy - 78 * s), "★", font=f, fill=BLUE)


# Topic keyword -> icon kind.
ICON_MAP = {
    "car": "car", "vehicle": "car", "automobile": "car", "auto": "car",
}


def pick_icon(topic: str) -> str:
    t = (topic or "").lower()
    for key, icon in ICON_MAP.items():
        if key in t:
            return icon
    return "star"


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


def fit_font(draw, text, font_path, max_w, start):
    size = start
    while size > 10:
        f = ImageFont.truetype(font_path, size)
        if draw.textlength(text, font=f) <= max_w:
            return f
        size -= 4
    return ImageFont.truetype(font_path, 10)


def stroke_text(draw, xy, text, font, fill, stroke_w=3):
    # fake stroke: draw text offset in 8 directions in black, then fill
    x, y = xy
    for dx in (-stroke_w, 0, stroke_w):
        for dy in (-stroke_w, 0, stroke_w):
            if dx or dy:
                draw.text((x + dx, y + dy), text, font=font, fill=BLACK)
    draw.text((x, y), text, font=font, fill=fill)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--hook", required=True, help='punchy 2-4 words, e.g. "CHINA CRUSHES ALL"')
    ap.add_argument("--years", default="", help='e.g. "1950 - 2025"')
    ap.add_argument("--emoji", default="", help="deprecated: icon auto-picked from --topic")
    ap.add_argument("--topic", default="", help="video topic, used to auto-pick icon")
    ap.add_argument("--icon", default="", help="force icon kind (car, star)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--at", type=float, default=0.35)
    ap.add_argument("--brand", default="Data Races")
    args = ap.parse_args()

    icon = args.icon or pick_icon(args.topic or args.hook)

    # Premium dark design like top YouTube channels:
    # - Dark navy gradient background (not a washed-out video frame)
    # - Huge bold hook text in yellow/white
    # - Large topic icon illustration
    # - Year range prominent
    img = Image.new("RGB", (W, H), (15, 23, 42))  # dark navy
    draw = ImageDraw.Draw(img, "RGBA")

    # Subtle gradient: lighter at top
    for y in range(H):
        alpha = int(30 * (1 - y / H))
        draw.line([(0, y), (W, y)], fill=(30, 41, 59, alpha))

    # Decorative glow spots
    draw.ellipse([W - 300, -100, W + 100, 300], fill=(225, 29, 46, 30))  # red glow top-right
    draw.ellipse([-100, H - 300, 300, H + 100], fill=(255, 213, 0, 20))  # yellow glow bottom-left

    font_bold = find_font(True)

    # --- Left: giant topic icon in a glowing circle ---
    ecx, ecy = 240, H // 2
    # Glow
    draw.ellipse([ecx - 200, ecy - 200, ecx + 200, ecy + 200], fill=(255, 213, 0, 40))
    # Circle bg
    draw.ellipse([ecx - 170, ecy - 170, ecx + 170, ecy + 170], fill=(30, 41, 59, 255))
    draw.ellipse([ecx - 170, ecy - 170, ecx + 170, ecy + 170], outline=(255, 213, 0, 255), width=6)
    draw_icon(draw, icon, ecx, ecy + 10, 1.2)

    # --- Right: hook words, HUGE, yellow with black stroke ---
    hook = args.hook.upper()
    words = hook.split()
    # split into at most 2 lines for punch
    if len(words) > 2:
        mid = (len(words) + 1) // 2
        lines = [" ".join(words[:mid]), " ".join(words[mid:])]
    else:
        lines = [hook]
    tx0 = 480
    max_w = W - tx0 - 60
    fonts = [fit_font(draw, ln, font_bold, max_w, 170) for ln in lines]  # bigger!
    heights = [draw.textbbox((0, 0), ln, font=f)[3] for ln, f in zip(lines, fonts)]
    total = sum(heights) + 20 * (len(lines) - 1)
    y = (H - total) / 2 - 40
    for ln, f, hh in zip(lines, fonts, heights):
        # Black stroke for pop, yellow fill
        stroke_text(draw, (tx0, y), ln, f, YELLOW, stroke_w=6)
        y += hh + 20

    # --- Year range, big white text under hook ---
    if args.years:
        yf = ImageFont.truetype(font_bold, 56)
        ytw = draw.textlength(args.years, font=yf)
        draw.text((tx0, y + 20), args.years, font=yf, fill=WHITE,
                  stroke_width=3, stroke_fill=(0, 0, 0))

    # --- Small brand badge bottom-right ---
    bf = ImageFont.truetype(font_bold, 28)
    btw = draw.textlength(args.brand, font=bf)
    bx0, by0 = W - btw - 70, H - 76
    draw.rounded_rectangle([bx0 - 16, by0 - 10, bx0 + btw + 16, by0 + 40], radius=20, fill=(0, 0, 0, 120))
    draw.text((bx0, by0), args.brand, font=bf, fill=(148, 163, 184))  # muted gray

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    img.save(args.out, "JPEG", quality=92)
    print(f"thumbnail written: {args.out} (icon={icon} hook={hook!r})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
