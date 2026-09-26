#!/usr/bin/env python3
"""Export a bundle's dataset.json observations to a plain dataset.csv.

The CSV is the human-readable, reusable copy of the researched data:
    date,entity_id,entity_name,value

Run inside CI before the bundle commit so every researched dataset is saved
to the repo as a CSV alongside dataset.json.

Usage:
    python3 tools/export-dataset-csv.py --in projects/<id>/dataset.json
    python3 tools/export-dataset-csv.py --in bundles/<id>/dataset.json --out bundles/<id>/dataset.csv
"""
import argparse
import csv
import json
import os
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True, help="dataset.json path")
    ap.add_argument("--out", default="", help="dataset.csv path (default: next to input)")
    args = ap.parse_args()

    with open(args.inp, encoding="utf-8") as f:
        dataset = json.load(f)

    observations = dataset.get("observations") or []
    out = args.out or os.path.join(os.path.dirname(os.path.abspath(args.inp)), "dataset.csv")

    rows = []
    for o in observations:
        ent = o.get("entity") or {}
        rows.append({
            "date": o.get("date", ""),
            "entity_id": ent.get("id", ""),
            "entity_name": ent.get("name", ""),
            "value": o.get("value", ""),
        })
    # stable order: date, then entity
    rows.sort(key=lambda r: (str(r["date"]), str(r["entity_id"])))

    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["date", "entity_id", "entity_name", "value"])
        w.writeheader()
        w.writerows(rows)

    meta = (
        f"# dataset: {dataset.get('name', '')}\n"
        f"# metric: {dataset.get('metric', '')} | unit: {dataset.get('unit', '')} | "
        f"frequency: {dataset.get('frequency', '')}\n"
    )
    print(f"wrote {out}: {len(rows)} rows")
    print(meta.strip())
    return 0


if __name__ == "__main__":
    sys.exit(main())
