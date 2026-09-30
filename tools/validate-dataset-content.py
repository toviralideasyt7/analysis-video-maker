#!/usr/bin/env python3
"""Deterministic content sanity checks for a researched dataset.json.

Catches the failure class where the research agent builds a dataset whose
shape contradicts its own metric — e.g. a monetary metric ("Cumulative Box
Office Earnings") labeled unit "count", or entities that are comma-joined
multi-value lists ("Action, Adventure, Thriller") instead of single entities.
The LLM AI-QA gate catches some of these but is non-deterministic; this check
is the deterministic backstop and fails the run BEFORE the bundle is
committed or a render is triggered.

Checks (all must pass):
  1. monetary metric => monetary unit: if the metric text mentions money
     (box office, earnings, revenue, gross, salary, wage, income, price,
     cost, dollar, usd, gdp, market cap...), the unit must not be a
     count-like unit ("count", "number", "quantity", "index", "rank").
  2. single entities: entity names must be single entities, not comma-joined
     lists. Fails when >= 50% of unique entity names contain a comma
     (e.g. "Action, Adventure, Thriller" genre combos standing in for films
     or actors).
  3. non-empty: the dataset must contain at least one observation.

Usage:
    python3 tools/validate-dataset-content.py projects/<id> [projects/<id2> ...]
    (each arg is a project dir containing dataset.json)

Exit 0 when every dataset passes, 1 with a clear message otherwise.
"""
import json
import os
import re
import sys

MONEY_WORDS = re.compile(
    r"box[\s-]?office|earnings?|revenue|gross|salary|salaries|wages?|"
    r"income|price|cost|dollar|usd|\bgdp\b|market[\s-]?cap|boxoffice",
    re.IGNORECASE,
)
COUNT_LIKE_UNITS = {
    "count", "counts", "number", "numbers", "quantity", "quantities",
    "index", "indices", "rank", "ranks",
}


def check_dataset(path):
    """Return a list of violation strings (empty when the dataset is fine)."""
    violations = []
    with open(path, encoding="utf-8") as f:
        dataset = json.load(f)

    metric = str(dataset.get("metric", ""))
    unit = str(dataset.get("unit", "")).strip().lower()
    observations = dataset.get("observations") or []

    if not observations:
        return ["dataset has no observations"]

    # 1. monetary metric must not use a count-like unit
    if MONEY_WORDS.search(metric) and unit in COUNT_LIKE_UNITS:
        violations.append(
            "unit %r contradicts monetary metric %r "
            "(monetary values must use a monetary unit such as usd, "
            "never a count-like unit)" % (dataset.get("unit"), metric)
        )

    # 2. entities must be single entities, not comma-joined lists
    names = {
        str((o.get("entity") or {}).get("name", "")).strip()
        for o in observations
    }
    names.discard("")
    if names:
        comma_names = [n for n in names if "," in n]
        if len(comma_names) >= 0.5 * len(names):
            sample = ", ".join(comma_names[:3])
            violations.append(
                "%d of %d unique entity names contain commas "
                "(e.g. %r) — entities look like multi-value lists "
                "(genre combos, tag lists) instead of single entities; "
                "every entity must be one thing (one actor, one film, "
                "one country, ...)" % (len(comma_names), len(names), sample)
            )

    return violations


def main() -> int:
    dirs = sys.argv[1:]
    if not dirs:
        print("usage: validate-dataset-content.py <project-dir> [...]", file=sys.stderr)
        return 2
    failed = False
    for d in dirs:
        path = os.path.join(d, "dataset.json")
        if not os.path.isfile(path):
            print("SKIP %s: no dataset.json" % d)
            continue
        try:
            violations = check_dataset(path)
        except Exception as e:  # noqa: BLE001 - report and fail, never silently pass
            print("FAIL %s: could not read dataset.json: %s" % (d, e))
            failed = True
            continue
        if violations:
            failed = True
            print("FAIL %s:" % d)
            for v in violations:
                print("  - %s" % v)
        else:
            print("OK %s" % d)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
