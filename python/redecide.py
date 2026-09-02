#!/usr/bin/env python3
"""
redecide.py — recompute analysis decisions from stored metrics.

Re-runs decide_quality() (imported from align.py — single source of truth)
on every analysis.syncinfo using the STORED metrics: no re-alignment, no
embedding, the whole library takes seconds. Updates the syncinfo files and
the movies table in SQLite.

Use after changing decision gates in align.py, or to migrate legacy
decision values (e.g. pre-rename 'whisper_required' rows).

Run inside the container:
    docker exec syncorbit /app/.venv/bin/python3 /app/python/redecide.py
Add --dry-run to preview the effect without writing anything.
"""
import json
import os
import sqlite3
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from align import decide_quality  # noqa: E402

DATA_ROOT = os.environ.get("SYNCORBIT_DATA", "/app/data")
ANALYSIS_ROOT = os.path.join(DATA_ROOT, "analysis")
DB_PATH = os.path.join(DATA_ROOT, "syncorbit.db")


def recompute(data):
    anchor = data.get("anchor_count") or data.get("raw_anchor_count") or 0
    ref = data.get("ref_count") or 0
    avg = data.get("avg_offset_sec")
    if avg is None:
        avg = data.get("median_offset_sec") or 0.0
    binned = data.get("drift_span_sec")
    if binned is None:
        binned = data.get("robust_drift_span_sec") or 0.0
    resid = data.get("residual_drift_span_sec") or 0.0
    robust = data.get("robust_drift_span_sec") or 0.0
    return decide_quality(anchor, ref, avg, binned, resid, robust)


def main():
    dry = "--dry-run" in sys.argv

    if not os.path.isdir(ANALYSIS_ROOT):
        print(f"no analysis dir at {ANALYSIS_ROOT}")
        sys.exit(1)

    con = None
    if not dry and os.path.exists(DB_PATH):
        con = sqlite3.connect(DB_PATH, timeout=10)
        con.execute("PRAGMA journal_mode=WAL")

    before = Counter()
    after = Counter()
    updated_files = 0
    updated_db = 0
    skipped = 0
    legacy = 0

    movies = sorted(os.listdir(ANALYSIS_ROOT))
    for movie in movies:
        p = os.path.join(ANALYSIS_ROOT, movie, "analysis.syncinfo")
        if not os.path.exists(p):
            continue
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            skipped += 1
            continue

        old = data.get("decision")
        if old == "whisper_required":
            legacy += 1
        before[old] += 1

        try:
            new = recompute(data)
        except Exception:
            skipped += 1
            continue
        after[new] += 1

        if new == old:
            continue

        if not dry:
            data["decision"] = new
            with open(p, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            updated_files += 1
            if con is not None:
                cur = con.execute(
                    "UPDATE movies SET decision = ? WHERE movie = ?",
                    (new, movie),
                )
                updated_db += cur.rowcount if cur.rowcount > 0 else 0

    if con is not None:
        con.commit()
        con.close()

    mode = "DRY RUN (nothing written)" if dry else "UPDATED"
    print(f"redecide — {mode}")
    print(f"  movies processed: {sum(after.values())}  (skipped: {skipped})")
    print(f"  legacy 'whisper_required' values seen: {legacy}")
    print(f"  decision changes: {updated_files if not dry else '(dry run)'}")
    print("  before:", dict(before))
    print("  after :", dict(after))


if __name__ == "__main__":
    main()