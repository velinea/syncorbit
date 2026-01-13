#!/usr/bin/env python3
"""
Batch scanner for SyncOrbit.

Creates:
    /app/data/analysis/<movie>/analysis.syncinfo
    /app/data/syncorbit_library_export.csv

Prefers newest reference in:
    /app/data/ref/<movie>/ref.srt (whisper)
    /app/data/resync/<movie>/<movie>.en.synced.srt (ffsubsync)
    /app/media/<movie>/<movie>.en.srt
"""

import sqlite3
import csv
import json
import os
import time
import subprocess
from pathlib import Path

# ----------------------------
# Root paths
# ----------------------------
MEDIA_ROOT = Path("/app/media")  # read-only mount
DATA_ROOT = Path(os.environ.get("SYNCORBIT_DATA", "/app/data"))
DB_PATH = DATA_ROOT / "syncorbit.db"

ANALYSIS_ROOT = DATA_ROOT / "analysis"
REF_ROOT = DATA_ROOT / "ref"
RESYNC_ROOT = DATA_ROOT / "resync"
SUMMARY_CSV = DATA_ROOT / "syncorbit_library_export.csv"
IGNORE_FILE = DATA_ROOT / "ignore_list.json"
PROGRESS_FILE = DATA_ROOT / "batch_progress.json"

PY = "/app/.venv/bin/python3"
ALIGN_PY = "/app/python/align.py"

CSV_FIELDS = [
    "movie",
    "anchor_count",
    "avg_offset",
    "drift_span",
    "decision",
    "best_reference",
    "reference_path",
    "has_whisper",
    "has_ffsubsync",
    "fi_mtime",
    "last_analyzed",
    "ignored",
]

# ----------------------------
# Helpers
# ----------------------------


def upsert_movie_row(row: dict):
    con = sqlite3.connect(DB_PATH)
    ensure_column(con, "movies", "state", "state TEXT DEFAULT 'ok'")

    try:
        con.execute(
            """
          CREATE TABLE IF NOT EXISTS movies (
            movie TEXT PRIMARY KEY,
            anchor_count INTEGER,
            avg_offset REAL,
            drift_span REAL,
            decision TEXT,
            best_reference TEXT,
            reference_path TEXT,
            has_whisper INTEGER DEFAULT 0,
            has_ffsubsync INTEGER DEFAULT 0,
            fi_mtime INTEGER,
            last_analyzed INTEGER,
            ignored INTEGER DEFAULT 0,
            state TEXT DEFAULT 'ok'
          )
        """
        )

        con.execute(
            """
          INSERT INTO movies (
            movie, anchor_count, avg_offset, drift_span, decision,
            best_reference, reference_path,
            has_whisper, has_ffsubsync,
            fi_mtime, last_analyzed, ignored
          ) VALUES (
            :movie, :anchor_count, :avg_offset, :drift_span, :decision,
            :best_reference, :reference_path,
            :has_whisper, :has_ffsubsync,
            :fi_mtime, :last_analyzed, :ignored
          )
          ON CONFLICT(movie) DO UPDATE SET
            anchor_count=excluded.anchor_count,
            avg_offset=excluded.avg_offset,
            drift_span=excluded.drift_span,
            decision=excluded.decision,
            best_reference=excluded.best_reference,
            reference_path=excluded.reference_path,
            has_whisper=excluded.has_whisper,
            has_ffsubsync=excluded.has_ffsubsync,
            fi_mtime=excluded.fi_mtime,
            last_analyzed=excluded.last_analyzed,
            ignored=excluded.ignored
        """,
            row,
        )

        con.commit()
    finally:
        con.close()


def ensure_column(con, table, column, ddl):
    cols = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
    if column not in cols:
        con.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")
        con.commit()


def load_ignore_list():
    if IGNORE_FILE.exists():
        try:
            return set(json.load(open(IGNORE_FILE)))
        except:
            return set()
    return set()


ignored = load_ignore_list()
print(f"Ignored movies: {len(ignored)}")


def load_scores(movie):
    """Return dictionary with whisper + ffsubsync scores (if available)."""
    analysis_path = ANALYSIS_ROOT / movie / "analysis.syncinfo"
    if not analysis_path.exists():
        return {}

    try:
        with open(analysis_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data.get("ref_candidates", {})
    except:
        return {}


def collect_reference_candidates(movie_folder, movie_name):
    """
    Return a list of (ref_type, Path) for whisper, ffsubsync, or EN references.
    """

    refs = []

    # Whisper reference
    whisper_ref = REF_ROOT / movie_name / "ref.srt"
    if whisper_ref.exists():
        refs.append(("whisper", whisper_ref))

    # ffsubsync references
    resync_dir = RESYNC_ROOT / movie_name
    if resync_dir.exists():
        for srt in resync_dir.glob("*.synced.srt"):
            refs.append(("ffsync", srt))

    # EN references inside the media folder
    for srt in movie_folder.glob("*.srt"):
        stem = srt.stem.lower()
        if stem.endswith(("en", "eng")):
            refs.append(("en", srt))
            break  # only need the first EN

    return refs


def find_fi_sub(movie_folder):
    for srt in movie_folder.glob("*.srt"):
        name = srt.stem.lower()
        if name.endswith(("fi", "fin")) or "finn" in name or "finnish" in name:
            return srt
    return None


def run_align(ref: Path, tgt: Path):
    """Run align.py and parse JSON result."""
    cmd = [PY, ALIGN_PY, str(ref), str(tgt)]
    out = subprocess.run(cmd, capture_output=True, text=True)

    if out.returncode != 0:
        raise RuntimeError(out.stderr or f"align.py failed with code {out.returncode}")

    data = json.loads(out.stdout)
    # Ensure ref/target paths are stored for UI + autocorrect
    data["ref_path"] = str(ref)
    data["target_path"] = str(tgt)
    return data


def write_syncinfo(movie_name: str, data: dict):
    """
    Write analysis JSON to:
        /app/data/analysis/<movie>/analysis.syncinfo
    """
    movie_dir = ANALYSIS_ROOT / movie_name
    movie_dir.mkdir(parents=True, exist_ok=True)

    outpath = movie_dir / "analysis.syncinfo"
    with open(outpath, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

    return outpath


def write_summary_row(row: dict, csv_path: Path):
    exists = csv_path.exists()

    with open(csv_path, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)

        if not exists:
            writer.writeheader()

        writer.writerow(row)


def update_progress(movie, index, total):
    try:
        with open(PROGRESS_FILE, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "current_movie": movie,
                    "index": index,
                    "total": total,
                },
                f,
            )
    except:
        pass


# ----------------------------
# Main scanning logic
# ----------------------------


def main():
    ANALYSIS_ROOT.mkdir(parents=True, exist_ok=True)

    # Always rebuild CSV fresh each run
    if SUMMARY_CSV.exists():
        SUMMARY_CSV.unlink()

    # Detect and remove missing movies
    media_movies = {p.name for p in MEDIA_ROOT.iterdir() if p.is_dir()}

    con = sqlite3.connect(DB_PATH)

    ensure_column(con, "movies", "state", "state TEXT DEFAULT 'ok'")

    def get_known_movies(con):
        rows = con.execute("SELECT movie FROM movies").fetchall()
        return {r[0] for r in rows}

    known_movies = get_known_movies(con)
    missing = known_movies - media_movies

    if len(media_movies) > 0 and missing:
        print(f"Removing {len(missing)} missing movies")

        for movie in missing:
            con.execute("DELETE FROM movies WHERE movie = ?", (movie,))
        con.commit()

    # print(f"Scanning library: {MEDIA_ROOT}")
    # Mark batch scan as started
    update_progress("Starting...", 0, 0)
    total = len(
        [d for d in MEDIA_ROOT.iterdir() if d.is_dir() and not d.name.startswith(".")]
    )

    for i, folder in enumerate(sorted(MEDIA_ROOT.iterdir()), 1):
        if not folder.is_dir():
            continue

        movie = folder.name
        if movie in ignored:
            print(f"→ Skipping (ignored): {movie}")

            upsert_movie_row(
                {
                    "movie": movie,
                    "state": "ignored",
                    "ignored": True,
                }
            )
            continue

        syncinfo_path = ANALYSIS_ROOT / movie / "analysis.syncinfo"

        # 1) Collect all candidates
        ref_candidates = collect_reference_candidates(folder, movie)

        if not ref_candidates:
            row = {
                "movie": movie,
                "state": "missing_subtitles",
                "decision": None,
                "anchor_count": None,
                "avg_offset": None,
                "drift_span": None,
                "ignored": False,
            }
            upsert_movie_row(row)
            continue

        resync_dir = RESYNC_ROOT / movie
        has_ffsync = resync_dir.exists() and any(
            p.name.endswith(".synced.srt") for p in resync_dir.iterdir()
        )

        # 2) Choose the newest reference
        ref_type, ref = max(ref_candidates, key=lambda x: x[1].stat().st_mtime)
        # print(f"[INFO] {movie}: selected reference '{ref_type}' → {ref.name}")

        tgt = find_fi_sub(folder)
        fi_mtime = None
        if tgt and tgt.exists():
            fi_mtime = tgt.stat().st_mtime
        else:
            print(f"[SKIP] No FI subtitle found for {movie}")
            continue

        # --------------------------------------------------
        # Decide whether to reuse analysis or re-align
        # --------------------------------------------------
        analyze = False

        # For progress tracking
        update_progress(movie, i, total)
        # print(f"--- Processing {i}/{total}: {movie} ---")

        if not syncinfo_path.exists():
            analyze = True
        else:
            sync_mtime = syncinfo_path.stat().st_mtime

            if ref.stat().st_mtime > sync_mtime:
                analyze = True
            elif tgt.stat().st_mtime > sync_mtime:
                analyze = True

        # --------------------------------------------------
        # Case 1: Need to run aligner
        # --------------------------------------------------
        if analyze:

            try:
                data = run_align(ref, tgt)
                data["best_reference"] = ref_type
                data["reference_path"] = str(ref)
            except Exception as e:
                print(f"ERROR:", e)
                continue

            write_syncinfo(movie, data)

        # --------------------------------------------------
        # Case 2: reuse existing syncinfo
        # --------------------------------------------------
        try:
            with open(syncinfo_path, "r", encoding="utf-8") as f:
                data = json.load(f)

            now = time.time()
            whisper_ref_path = REF_ROOT / movie / "ref.srt"

            row = {
                "movie": movie,
                "anchor_count": data.get("anchor_count"),
                "avg_offset": data.get("avg_offset_sec"),
                "drift_span": data.get("drift_span_sec"),
                "decision": data.get("decision"),
                "best_reference": data.get("best_reference"),
                "reference_path": data.get("reference_path"),
                "has_whisper": whisper_ref_path.exists(),
                "has_ffsubsync": has_ffsync,  # compute once earlier
                "fi_mtime": fi_mtime,  # compute once earlier
                "last_analyzed": now,
                "ignored": 1 if movie in ignored else 0,
            }
            write_summary_row(row, SUMMARY_CSV)
            upsert_movie_row(row)

            continue
        except Exception as e:
            analyze = True

    print("Batch scan complete.")
    update_progress("Done", total, total)


if __name__ == "__main__":
    main()
