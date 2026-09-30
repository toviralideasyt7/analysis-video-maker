#!/usr/bin/env python3
"""
Generate a YouTube thumbnail for data-race videos.

Design (per user spec, matching their reference example):
  - Left ~58%: a real frame from the rendered video (the race itself),
    full height.
  - Right ~42%: white panel with the topic title in big bold Eczar, the
    year range on a yellow highlight bar, a red rising arrow, and a small
    bar chart at the bottom.
  - Output: 3840x2160 JPEG, highest quality that stays under YouTube's 2MB
    thumbnail limit.

Usage:
  python3 tools/make-thumbnail.py \
    --video projects/<id>/renders/<id>-final.mp4 \
    --topic "Most popular websites, 1995-2023" \
    --years "1995 - 2023" \
    --out projects/<id>/renders/<id>-thumbnail.jpg
"""
import argparse
import os
import re
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

W, H = 3840, 2160  # YouTube's max thumbnail resolution (its upload cap is 2MB)
WHITE = (255, 255, 255)
BLACK = (17, 24, 39)
GRAY = (107, 114, 128)
YELLOW = (250, 204, 21)
RED = (225, 29, 46)
YT_THUMB_MAX_BYTES = 1_900_000  # stay safely under YouTube's 2MB thumbnail limit

# Right-hand text panel geometry.
PANEL_X = 2240
PANEL_W = W - PANEL_X  # 1600


def find_font() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    eczar = os.path.join(here, "fonts", "Eczar.ttf")
    if os.path.exists(eczar):
        return eczar
    return "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def load_font(path: str, size: int, weight: int = 800) -> ImageFont.FreeTypeFont:
    """Load Eczar at a variable-font weight (falls back gracefully)."""
    f = ImageFont.truetype(path, size)
    try:
        # Eczar is a variable font with a wght axis.
        f.set_variation_by_axes([weight])
    except Exception:
        pass
    return f


def grab_frame(video: str, at: float, out_path: str) -> None:
    dur = float(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", video,
    ]).decode().strip())
    ts = max(0.5, dur * at)
    # Grab at a late-race moment (bars are at their most dramatic).
    # CRITICAL: Crop to the LEFT 62% of the video frame BEFORE scaling.
    # The video's own info panel lives on the right side of the frame;
    # by taking only the left 62% we guarantee no info-panel bleed-through
    # into the thumbnail's text panel, regardless of renderer layout changes.
    subprocess.check_call([
        "ffmpeg", "-y", "-v", "error", "-ss", f"{ts:.2f}", "-i", video,
        "-frames:v", "1",
        "-vf", f"crop=iw*0.62:ih:0:0,"
               f"scale={PANEL_X}:{H}:force_original_aspect_ratio=increase:flags=lanczos,"
               f"crop={PANEL_X}:{H}",
        out_path,
    ])


def save_under_limit(img: Image.Image, out_path: str) -> None:
    """Save as JPEG at the highest quality that stays under YouTube's 2MB limit."""
    quality = 96
    while quality >= 70:
        img.save(out_path, "JPEG", quality=quality, optimize=True)
        if os.path.getsize(out_path) <= YT_THUMB_MAX_BYTES:
            return
        quality -= 5
    # Last resort: even at 70 the frame was too busy -- keep the smallest.
    print("WARNING: thumbnail still >2MB at quality 70; keeping it anyway",
          file=sys.stderr)


def clean_topic(title: str) -> str:
    """Build a punchy all-caps title from the video spec title."""
    t = title or ""
    t = re.sub(r"^Top \d+\s*", "", t, flags=re.I)
    t = re.sub(r"\s+by annual.*$", "", t, flags=re.I)
    t = re.sub(r"^bar chart race of (the )?", "", t, flags=re.I)
    t = re.sub(r",?\s*\d{4}\s*[-\u2013\u2014]\s*\d{4}\.?$", "", t)
    t = re.sub(r"\s+from\s+\d+.*$", "", t, flags=re.I)
    # Remove trailing "based on ..." fragments (e.g. "based on Tranco rank")
    # which look broken when truncated
    t = re.sub(r"\s+based\s+on.*$", "", t, flags=re.I)
    t = t.strip().rstrip(".")
    return t.upper() or "DATA RACE"


def wrap_lines(d, text, font, max_w, max_lines=4):
    words = text.split()
    lines, cur = [], ""
    for w_ in words:
        trial = (cur + " " + w_).strip()
        if d.textlength(trial, font=font) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w_
            if len(lines) >= max_lines:
                break
    if cur and len(lines) < max_lines:
        lines.append(cur)
    return lines


def draw_rising_arrow(d, x0, y0, x1, y1, color, width):
    """A bold rising arrow from (x0, y0) to (x1, y1)."""
    d.line([x0, y0, x1, y1], fill=color, width=width, joint="curve")
    # Arrowhead: two short strokes at the tip, angled back along the shaft.
    import math
    ang = math.atan2(y1 - y0, x1 - x0)
    head_len = width * 3.2
    for delta in (math.pi * 0.82, -math.pi * 0.82):
        a = ang + delta
        d.line([x1, y1, x1 + head_len * math.cos(a), y1 + head_len * math.sin(a)],
               fill=color, width=width, joint="curve")


def fit_title_font(d, topic, font_path, content_w, max_lines=3, start_size=150):
    """Find the largest font size that fits the topic in max_lines."""
    for size in range(start_size, 60, -10):
        font = load_font(font_path, size, weight=900)
        lines = wrap_lines(d, topic, font, content_w, max_lines=max_lines)
        # Check if all words fit within max_lines
        words = topic.split()
        used_words = sum(len(line.split()) for line in lines)
        if used_words >= len(words) and len(lines) <= max_lines:
            return font, lines, size
    # Fallback to smallest
    font = load_font(font_path, 60, weight=900)
    return font, wrap_lines(d, topic, font, content_w, max_lines=max_lines), 60


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--topic", default="", help="video topic / spec title")
    ap.add_argument("--years", default="", help='e.g. "1995 - 2023"')
    ap.add_argument("--out", required=True)
    ap.add_argument("--at", type=float, default=0.72,
                    help="fraction of video duration to grab the background frame")
    args = ap.parse_args()

    topic = clean_topic(args.topic)
    years = " ".join((args.years or "").split())
    font_path = find_font()

    # --- left: real video frame, full height ---
    tmp = args.out + ".frame.png"
    grab_frame(args.video, args.at, tmp)
    frame_img = Image.open(tmp).convert("RGB")
    # Expand the canvas to full thumbnail size; the frame fills the left,
    # the text panel is drawn on the right.
    img = Image.new("RGB", (W, H), WHITE)
    img.paste(frame_img, (0, 0))
    d = ImageDraw.Draw(img)

    # --- right: white text panel ---
    # Draw a SOLID white panel with a slight overlap to ensure no video
    # bleed-through at the boundary
    d.rectangle([PANEL_X - 10, 0, W, H], fill=WHITE)
    # subtle left divider
    d.line([PANEL_X, 0, PANEL_X, H], fill=(229, 231, 235), width=6)

    px = PANEL_X + 120          # panel content left
    content_w = PANEL_W - 240   # panel content width
    y = 200  # start higher to give more room

    # red rising arrow (top of panel, like the reference)
    draw_rising_arrow(d, px, y + 140, px + 500, y - 40, RED, 40)
    y += 240

    # big bold title - dynamically sized to fit
    title_font, title_lines, title_size = fit_title_font(d, topic, font_path, content_w, max_lines=3)
    line_height = int(title_size * 1.15)
    for line in title_lines:
        d.text((px, y), line, font=title_font, fill=BLACK)
        y += line_height
    y += 50

    # year range on a yellow highlight bar
    if years:
        year_font = load_font(font_path, 110, weight=800)
        tw = d.textlength(years, font=year_font)
        # Ensure year badge fits within content width
        if tw + 96 > content_w:
            year_font = load_font(font_path, 90, weight=800)
            tw = d.textlength(years, font=year_font)
        pad_x, pad_y = 44, 24
        badge_h = 110 + pad_y * 2
        # Check if badge would overlap with chart area; if so, skip it
        # (chart starts at H - 560)
        if y + badge_h + 60 < H - 560:
            d.rounded_rectangle(
                [px, y, px + tw + pad_x * 2, y + badge_h],
                radius=18, fill=YELLOW,
            )
            d.text((px + pad_x, y + pad_y - 6), years, font=year_font, fill=BLACK)
            y += badge_h + 60

    # small bar chart at the bottom (ascending, brand blues)
    # Only draw if there's enough space
    chart_top = H - 520
    if y < chart_top - 100:
        chart_colors = [(37, 99, 235), (59, 130, 246), (96, 165, 250), (147, 197, 253), (29, 78, 216)]
        chart_x, chart_y1 = px, H - 180
        n = 5
        gap = 32
        bw = (content_w - gap * (n - 1)) // n
        heights = [140, 190, 165, 230, 290]
        for i in range(n):
            x0 = chart_x + i * (bw + gap)
            hgt = heights[i]
            d.rounded_rectangle([x0, chart_y1 - hgt, x0 + bw, chart_y1],
                                radius=12, fill=chart_colors[i])
        # baseline
        d.line([chart_x, chart_y1, chart_x + content_w, chart_y1], fill=GRAY, width=6)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    save_under_limit(img, args.out)
    try:
        os.remove(tmp)
    except OSError:
        pass
    size = os.path.getsize(args.out)
    print(f"thumbnail written: {args.out} (topic={topic!r} years={years!r} "
          f"{size/1024:.0f}KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
