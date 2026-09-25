#!/usr/bin/env python3
"""Generate yearly cumulative console sales from lifetime totals.

Methodology (transparent): Lifetime totals are from Wikipedia's
"List of best-selling game consoles" (single snapshot, accessed 2026-09-25).
Yearly progression is MODELED with a logistic adoption curve from launch year
to discontinuation year (or 2026 for ongoing consoles): fast ramp after
launch, peak mid-life, flattening toward end-of-life. The final ranking
matches the true lifetime ranking; year-by-year shapes are illustrative.
"""
import json
import math

# (console_id, launch_year, end_year, lifetime_millions)
# end_year = discontinuation, or 2026 if still selling.
CONSOLES = [
    ("nes", 1983, 1995, 61.91),
    ("game-boy", 1989, 2003, 118.69),
    ("snes", 1990, 2003, 49.10),
    ("ps1", 1994, 2006, 102.49),
    ("n64", 1996, 2003, 32.93),
    ("ps2", 2000, 2013, 160.00),
    ("gba", 2001, 2010, 81.51),
    ("xbox-360", 2005, 2016, 84.00),
    ("nintendo-ds", 2004, 2013, 154.02),
    ("psp", 2004, 2014, 80.00),
    ("wii", 2006, 2013, 101.63),
    ("ps3", 2006, 2017, 87.40),
    ("nintendo-3ds", 2011, 2020, 75.94),
    ("ps4", 2013, 2026, 117.20),
    ("xbox-one", 2013, 2020, 58.00),
    ("nintendo-switch", 2017, 2026, 156.59),
    ("ps5", 2020, 2026, 95.30),
]


def logistic_sales(total, launch, end, year):
    """Cumulative sales at a given year via logistic adoption curve."""
    if year < launch:
        return 0.0
    if year >= end:
        return total
    # Normalized time 0..1 across the selling lifespan
    u = (year - launch) / max(1, end - launch)
    # S-curve steepest at u=0.35 (strong early adoption, long tail)
    def sig(x):
        return 1.0 / (1.0 + math.exp(-10 * (x - 0.35)))
    g = (sig(u) - sig(0)) / (sig(1) - sig(0))
    return round(total * g, 2)


def main():
    out = {}
    for cid, launch, end, total in CONSOLES:
        yearly = {}
        for y in range(launch, 2027):
            v = logistic_sales(total, launch, end, y)
            if v > 0:
                yearly[str(y)] = v
        out[cid] = yearly
    with open("/tmp/console-sales.json", "w") as f:
        json.dump(out, f, indent=1)
    # Print summary table for verification
    print(f"{'console':<16} {'launch':<7} {'end':<5} {'lifetime':<9} {'2026 (model)'}")
    for cid, launch, end, total in CONSOLES:
        print(f"{cid:<16} {launch:<7} {end:<5} {total:<9} {out[cid].get('2026', 0)}")
    print("\nWrote /tmp/console-sales.json")


if __name__ == "__main__":
    main()
