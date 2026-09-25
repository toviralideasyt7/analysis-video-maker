#!/usr/bin/env python3
"""Build frames.json for the best-selling game consoles bar-chart race.

Input: console sales data (year -> cumulative millions sold per console).
Output: frames.json with entities (logo data URIs) + interpolated frames.
"""
import json
import sys

FPS = 30  # tape frames per year
TOP_N = 10

# Console metadata: id -> (display name, maker for logo, brand color)
CONSOLES = {
    "ps2": ("PlayStation 2", "playstation", "#1a56db"),
    "nintendo-ds": ("Nintendo DS", "nintendo", "#e11d48"),
    "game-boy": ("Game Boy", "nintendo", "#f59e0b"),
    "ps4": ("PlayStation 4", "playstation", "#2563eb"),
    "nintendo-switch": ("Nintendo Switch", "nintendo", "#dc2626"),
    "ps1": ("PlayStation", "playstation", "#7c3aed"),
    "wii": ("Wii", "nintendo", "#06b6d4"),
    "ps3": ("PlayStation 3", "playstation", "#4f46e5"),
    "xbox-360": ("Xbox 360", "xbox", "#16a34a"),
    "gba": ("Game Boy Advance", "nintendo", "#d97706"),
    "psp": ("PlayStation Portable", "playstation", "#0ea5e9"),
    "nintendo-3ds": ("Nintendo 3DS", "nintendo", "#db2777"),
    "nes": ("NES", "nintendo", "#b45309"),
    "xbox-one": ("Xbox One", "xbox", "#15803d"),
    "snes": ("SNES", "nintendo", "#92400e"),
    "ps5": ("PlayStation 5", "playstation", "#3b82f6"),
    "n64": ("Nintendo 64", "nintendo", "#65a30d"),
    "xbox-series": ("Xbox Series X|S", "xbox", "#22c55e"),
}

# Cumulative sales in millions by year. Filled in from research.
# Format: console_id -> {year: cumulative_millions}
SALES = {
    # Populated by research data below
}


def load_logos():
    """Load logo data URIs."""
    logos = {}
    for maker in ("playstation", "nintendo", "xbox"):
        try:
            with open(f"/tmp/console-logos/{maker}.uri.txt") as f:
                logos[maker] = f.read().strip()
        except FileNotFoundError:
            logos[maker] = None
    return logos


def interpolate_sales(sales, year):
    """Get cumulative sales for a year, interpolating between data points."""
    if not sales:
        return 0.0
    years = sorted(sales.keys())
    if year <= years[0]:
        # Before first data point: 0 if before launch, else first value
        return 0.0 if year < years[0] else sales[years[0]]
    if year >= years[-1]:
        return sales[years[-1]]
    # Linear interpolation
    for i in range(len(years) - 1):
        y0, y1 = years[i], years[i + 1]
        if y0 <= year <= y1:
            v0, v1 = sales[y0], sales[y1]
            t = (year - y0) / (y1 - y0)
            return v0 + (v1 - v0) * t
    return sales[years[-1]]


def build_frames(sales_data, start_year, end_year):
    logos = load_logos()
    # Drop consoles with no sales data (e.g. xbox-series placeholder)
    active = [cid for cid in CONSOLES if cid in sales_data]
    entities = []
    for cid in active:
        name, maker, color = CONSOLES[cid]
        e = {"id": cid, "name": name, "color": color}
        if logos.get(maker):
            e["flagDataUri"] = logos[maker]
        entities.append(e)

    frames = []
    idx = 0
    for year in range(start_year, end_year + 1):
        # Values at start and end of this year for interpolation
        for f in range(FPS):
            t = f / FPS
            y = year + t
            # Get value for each console at fractional year
            vals = []
            for cid in active:
                sd = sales_data.get(cid, {})
                v = interpolate_sales(sd, y)
                if v > 0:
                    vals.append((cid, v))
            # Rank by value, take top N
            vals.sort(key=lambda x: -x[1])
            top = vals[:TOP_N]
            if not top:
                continue
            max_v = top[0][1]
            bars = []
            for rank, (cid, v) in enumerate(top, 1):
                bars.append({
                    "entityId": cid,
                    "rank": rank,
                    "previousRank": rank,
                    "rankDelta": 0,
                    "value": round(v, 2),
                    "width": round(v / max_v, 6) if max_v > 0 else 0,
                    "held": False,
                    "isMover": False,
                })
            frames.append({
                "index": idx,
                "label": str(year),
                "fromLabel": str(year),
                "toLabel": str(year + 1) if year < end_year else str(year),
                "t": round(t, 4),
                "isPeriodBoundary": f == 0,
                "maxValue": round(max_v, 2),
                "bars": bars,
            })
            idx += 1

    return {
        "width": 1280,
        "height": 720,
        "fps": FPS,
        "durationInFrames": len(frames),
        "topN": TOP_N,
        "framesPerTransition": FPS,
        "periodLabels": [str(y) for y in range(start_year, end_year + 1)],
        "entities": entities,
        "frames": frames,
        "notes": "Best-selling game consoles by cumulative units sold (millions).",
    }


def main():
    data_file = sys.argv[1] if len(sys.argv) > 1 else None
    out_file = sys.argv[2] if len(sys.argv) > 2 else "frames.json"
    if data_file:
        with open(data_file) as f:
            raw = json.load(f)
            sales_data = {cid: {int(y): v for y, v in sd.items()}
                          for cid, sd in raw.items()}
    else:
        sales_data = SALES
    # Determine year range from data
    all_years = set()
    for sd in sales_data.values():
        all_years.update(sd.keys())
    start_year = min(all_years)
    end_year = max(all_years)
    tape = build_frames(sales_data, start_year, end_year)
    with open(out_file, "w") as f:
        json.dump(tape, f)
    print(f"Wrote {out_file}: {len(tape['frames'])} frames, "
          f"{len(tape['entities'])} entities, {start_year}-{end_year}")


if __name__ == "__main__":
    main()
