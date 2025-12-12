#!/usr/bin/env python3
"""
Batch scanner for SyncOrbit.

Creates:
    /app/data/analysis/<movie>/analysis.syncinfo
    /app/data/syncorbit_library_summary.csv

Prefers WhisperX reference in:
    /app/data/ref/<movie>/ref.srt

Falls back to EN/FI subtitle pairs inside /app/media.
"""

import csv
import json
import os
import subprocess
from pathlib import Path

# ----------------------------
# Root paths
# ----------------------------
MEDIA_ROOT = Path("/app/media")  # read-only mount
DATA_ROOT = Path(os.environ.get("SYNCORBIT_DATA", "/app/data"))

ANALYSIS_ROOT = DATA_ROOT / "analysis"
REF_ROOT = DATA_ROOT / "ref"
RESYNC_ROOT = DATA_ROOT / "resync"
SUMMARY_CSV = DATA_ROOT / "syncorbit_library_summary.csv"
IGNORE_FILE = DATA_ROOT / "ignore_list.json"
PROGRESS_FILE = DATA_ROOT / "batch_progress.json"

PY = "/app/.venv/bin/python3"
ALIGN_PY = "/app/python/align.py"

# ----------------------------
# Helpers
# ----------------------------


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


def append_summary(movie_name: str, data: dict):
    """
    Append one summary row. No header.
    """
    SUMMARY_CSV.parent.mkdir(parents=True, exist_ok=True)

    with open(SUMMARY_CSV, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(
            [
                movie_name,
                data.get("anchor_count", 0),
                data.get("avg_offset_sec", 0.0),
                data.get("drift_span_sec", 0.0),
                data.get("decision", "unknown"),
            ]
        )


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

    print(f"Scanning library: {MEDIA_ROOT}")
    total = len([d for d in MEDIA_ROOT.iterdir() if d.is_dir()])

    for i, folder in enumerate(sorted(MEDIA_ROOT.iterdir()), 1):
        if not folder.is_dir():
            continue

        movie = folder.name
        if movie in ignored:
            print(f"→ Skipping (ignored): {movie}")
            continue

        syncinfo_path = ANALYSIS_ROOT / movie / "analysis.syncinfo"

        # Mark batch scan as started
        update_progress("Starting...", 0, 0)

        # 1) Collect all candidates
        ref_candidates = collect_reference_candidates(folder, movie)

        if not ref_candidates:
            # print(f"[SKIP] No reference candidates for {movie}")
            continue

        # 2) Choose the newest reference
        ref_type, ref = max(ref_candidates, key=lambda x: x[1].stat().st_mtime)
        # print(f"[INFO] {movie}: selected reference '{ref_type}' → {ref.name}")

        tgt = find_fi_sub(folder)
        if not tgt:
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
        # Case 1: reuse existing syncinfo
        # --------------------------------------------------
        if not analyze:
            try:
                with open(syncinfo_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                append_summary(movie, data)
                continue
            except Exception as e:
                analyze = True

        # --------------------------------------------------
        # Case 2: Need to run aligner
        # --------------------------------------------------

        try:
            data = run_align(ref, tgt)
            data["best_reference"] = ref_type
            data["reference_path"] = str(ref)
        except Exception as e:
            print(f"ERROR:", e)
            continue

        write_syncinfo(movie, data)
        append_summary(movie, data)
        # print(f"✔ Done: {movie} ({data['decision']})")

    print("Batch scan complete.")
    update_progress("Done", total, total)


if __name__ == "__main__":
    main()
