#!/usr/bin/env python3
"""
Generate a YouTube thumbnail in the "Data Races" style (see reference screenshot):
  - a frame grabbed from the rendered video as the background
  - a bold blue rectangle in the center carrying the title lines in white
  - a circular "Data Races" badge on the right

Usage:
  python3 tools/make-thumbnail.py \
    --video projects/<id>/renders/<id>-final.mp4 \
    --title "Top 10 Countries" --subtitle "1960 - 2019" --kicker "GDP PER CAPITA" \
    --out projects/<id>/renders/<id>-thumbnail.jpg \
    [--at 0.35]            # fraction of video duration to grab the frame from
    [--brand "Data Races"]  # badge text
"""
import argparse
import math
import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 720
BLUE = (13, 71, 161)       # deep blue box
BLUE_DARK = (8, 48, 110)
WHITE = (255, 255, 255)


def find_font(bold: bool = True) -> str:
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    raise RuntimeError("no usable TTF font found")


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


def fit_font(draw: ImageDraw.ImageDraw, text: str, font_path: str, max_w: int, start: int) -> ImageFont.FreeTypeFont:
    size = start
    while size > 10:
        f = ImageFont.truetype(font_path, size)
        if draw.textlength(text, font=f) <= max_w:
            return f
        size -= 2
    return ImageFont.truetype(font_path, 10)


def draw_badge(draw: ImageDraw.ImageDraw, cx: int, cy: int, r: int, brand: str, font_bold: str) -> None:
    # blue circle with white ring
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=BLUE)
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=WHITE, width=max(3, r // 28))
    # little "bars" glyph above the text (like the reference logo)
    bw = r * 0.62
    for i, hfrac in enumerate((0.35, 0.6, 0.45, 0.8)):
        bx0 = cx - bw / 2 + i * (bw / 4)
        bx1 = bx0 + bw / 4 * 0.62
        bh = r * 0.34 * hfrac
        by1 = cy - r * 0.12
        draw.rectangle([bx0, by1 - bh, bx1, by1], fill=WHITE)
    f = fit_font(draw, brand, font_bold, int(r * 1.5), max(14, r // 4))
    tw = draw.textlength(brand, font=f)
    draw.text((cx - tw / 2, cy + r * 0.06), brand, font=f, fill=WHITE)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--title", required=True, help='e.g. "Top 10 Countries"')
    ap.add_argument("--subtitle", default="", help='e.g. "1960 - 2019"')
    ap.add_argument("--kicker", default="", help='e.g. "GDP PER CAPITA"')
    ap.add_argument("--out", required=True)
    ap.add_argument("--at", type=float, default=0.35)
    ap.add_argument("--brand", default="Data Races")
    args = ap.parse_args()

    with tempfile.TemporaryDirectory() as td:
        frame_path = os.path.join(td, "frame.png")
        grab_frame(args.video, args.at, frame_path)
        img = Image.open(frame_path).convert("RGB").resize((W, H))

    draw = ImageDraw.Draw(img, "RGBA")
    font_bold = find_font(True)

    # Slight dark vignette so the blue box pops on any frame.
    draw.rectangle([0, 0, W, H], fill=(0, 0, 0, 36))

    lines = [t for t in (args.title, args.subtitle, args.kicker) if t]
    box_w = int(W * 0.52)
    box_h = int(H * 0.52)
    box_x0 = int(W * 0.24)
    box_y0 = int((H - box_h) / 2)
    # blue box with subtle darker border
    draw.rectangle([box_x0, box_y0, box_x0 + box_w, box_y0 + box_h], fill=BLUE + (255,))
    draw.rectangle([box_x0, box_y0, box_x0 + box_w, box_y0 + box_h], outline=BLUE_DARK, width=6)

    # Stack the title lines centered in the box.
    inner_w = box_w - 60
    sizes = [84, 72, 96]  # title, subtitle, kicker (kicker biggest, like the reference)
    gap = 14
    fonts, heights = [], []
    for i, line in enumerate(lines):
        f = fit_font(draw, line, font_bold, inner_w, sizes[min(i, len(sizes) - 1)])
        fonts.append(f)
        heights.append(draw.textbbox((0, 0), line, font=f)[3])
    total = sum(heights) + gap * (len(lines) - 1)
    y = box_y0 + (box_h - total) / 2
    for line, f, hh in zip(lines, fonts, heights):
        tw = draw.textlength(line, font=f)
        draw.text((box_x0 + (box_w - tw) / 2, y), line, font=f, fill=WHITE)
        y += hh + gap

    # Brand badge on the right, vertically centered.
    draw_badge(draw, int(W * 0.83), H // 2, int(H * 0.21), args.brand, font_bold)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    img.save(args.out, "JPEG", quality=92)
    print(f"thumbnail written: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
