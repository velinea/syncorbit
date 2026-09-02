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
import re
import sys
import time
import subprocess
import base64
from pathlib import Path

# ----------------------------
# Root paths
# ----------------------------
MEDIA_ROOT = Path("/app/media")  # read-only mount
MEDIA_ROOT_TV = Path(os.environ.get("SYNCORBIT_MEDIA_TV", "/app/media_tv"))
TV_EP_ID = "tv"  # region flag for progress
DATA_ROOT = Path(os.environ.get("SYNCORBIT_DATA", "/app/data"))
DB_PATH = DATA_ROOT / "syncorbit.db"

ANALYSIS_ROOT = DATA_ROOT / "analysis"
REF_ROOT = DATA_ROOT / "ref"
RESYNC_ROOT = DATA_ROOT / "resync"
SUMMARY_CSV = DATA_ROOT / "syncorbit_library_export.csv"
IGNORE_FILE = DATA_ROOT / "ignore_list.json"
PROGRESS_FILE = DATA_ROOT / "batch_progress.json"

PY = os.environ.get("SYNCORBIT_PY", "/app/.venv/bin/python3")
ALIGN_PY = os.environ.get("SYNCORBIT_ALIGN", "/app/python/align.py")

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
            fi_mtime, last_analyzed, ignored,
            state
          ) VALUES (
            :movie, :anchor_count, :avg_offset, :drift_span, :decision,
            :best_reference, :reference_path,
            :has_whisper, :has_ffsubsync,
            :fi_mtime, :last_analyzed, :ignored,
            :state
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
            ignored=excluded.ignored,
            state=excluded.state
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


def normalize_movie_row(row: dict) -> dict:
    defaults = {
        "anchor_count": None,
        "avg_offset": None,
        "drift_span": None,
        "decision": None,
        "best_reference": None,
        "reference_path": None,
        "has_whisper": 0,
        "has_ffsubsync": 0,
        "fi_mtime": None,
        "last_analyzed": None,
        "ignored": 0,
        "state": "ok",
    }

    return {**defaults, **row}


def b64url_encode(s: str) -> str:
    return base64.urlsafe_b64encode(s.encode("utf-8")).decode("ascii").rstrip("=")


def b64url_decode(s: str) -> str:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode((s + pad).encode("ascii")).decode("utf-8")


def upsert_tv_row(row: dict):
    con = sqlite3.connect(DB_PATH)
    ensure_column(con, "tv_episodes", "rel_path", "rel_path TEXT")
    ensure_column(con, "tv_episodes", "show_name", "show_name TEXT")
    ensure_column(con, "tv_episodes", "season", "season INTEGER")

    try:
        con.execute(
            """
          CREATE TABLE IF NOT EXISTS tv_episodes (
            episode_id TEXT PRIMARY KEY,
            show_name TEXT,
            season INTEGER,
            episode_no INTEGER,
            title TEXT,
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
            state TEXT DEFAULT 'ok',
            rel_path TEXT
          )
        """
        )

        con.execute(
            """
          INSERT INTO tv_episodes (
            episode_id, show_name, season, episode_no, title,
            anchor_count, avg_offset, drift_span, decision,
            best_reference, reference_path,
            has_whisper, has_ffsubsync,
            fi_mtime, last_analyzed, ignored,
            state, rel_path
          ) VALUES (
            :episode_id, :show_name, :season, :episode_no, :title,
            :anchor_count, :avg_offset, :drift_span, :decision,
            :best_reference, :reference_path,
            :has_whisper, :has_ffsubsync,
            :fi_mtime, :last_analyzed, :ignored,
            :state, :rel_path
          )
          ON CONFLICT(episode_id) DO UPDATE SET
            show_name=excluded.show_name,
            season=excluded.season,
            episode_no=excluded.episode_no,
            title=excluded.title,
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
            ignored=excluded.ignored,
            state=excluded.state,
            rel_path=excluded.rel_path
        """,
            row,
        )

        con.commit()
    finally:
        con.close()


_EP_RE = re.compile(r"S(\d+)E(\d+)", re.IGNORECASE)
_SEASON_RE = re.compile(r"season\s*(\d+)", re.IGNORECASE)


def parse_episode(rel_path: str):
    """Split a tv episode relpath into (show, season, ep_no, title).
    Returns None if the path is not Show/Season N/episode."""
    parts = Path(rel_path).parts
    if len(parts) < 3:
        return None
    show = parts[0]
    season_dir = parts[1]
    fname = parts[-1]
    m = _SEASON_RE.search(season_dir)
    if not m:
        return None
    season = int(m.group(1))
    ep = _EP_RE.search(fname)
    ep_no = int(ep.group(2)) if ep else None
    title = f"{show} - S{season:02d}E{ep_no:02d}" if ep_no else show
    return show, season, ep_no, title


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


def find_all_fi_subs(season_folder):
    """Return every FI (.fi/.fin) subtitle in a season folder, one per episode."""
    result = []
    for srt in season_folder.glob("*.srt"):
        name = srt.stem.lower()
        if name.endswith(("fi", "fin")) or "finn" in name or "finnish" in name:
            result.append(srt)
    return result


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


def update_progress(movie, index, total, kind="movie"):
    try:
        with open(PROGRESS_FILE, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "current_movie": movie,
                    "index": index,
                    "total": total,
                    "kind": kind,
                },
                f,
            )
    except:
        pass


# ----------------------------
# TV scanning logic
# ----------------------------


def scan_tv():
    """Scan the TV media root (Show/Season N/episode.srt) into tv_episodes."""
    if not MEDIA_ROOT_TV.exists():
        print(f"TV root not present: {MEDIA_ROOT_TV}")
        update_progress("TV root missing", 0, 0, "tv")
        return

    # Collect every episode FI subtitle strictly under Show/Season N/
    episodes = []  # (rel_path, Path)
    for show_dir in sorted(MEDIA_ROOT_TV.iterdir()):
        if not show_dir.is_dir() or show_dir.name.startswith("."):
            continue
        for season_dir in sorted(show_dir.iterdir()):
            if not season_dir.is_dir() or season_dir.name.startswith("."):
                continue
            if not _SEASON_RE.search(season_dir.name):
                continue
            for fi in find_all_fi_subs(season_dir):
                rel = str(fi.relative_to(MEDIA_ROOT_TV))
                episodes.append((rel, fi))

    if not episodes:
        print("No TV episodes found.")
        update_progress("Done", 0, 0, "tv")
        return

    # Prune tv_episodes rows whose media no longer exists
    con = sqlite3.connect(DB_PATH)
    try:
        con.execute(
            """
          CREATE TABLE IF NOT EXISTS tv_episodes (
            episode_id TEXT PRIMARY KEY,
            show_name TEXT,
            season INTEGER,
            episode_no INTEGER,
            title TEXT,
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
            state TEXT DEFAULT 'ok',
            rel_path TEXT
          )
        """
        )
        known = {r[0] for r in con.execute("SELECT episode_id FROM tv_episodes")}
        still = {b64url_encode(rp) for rp, _ in episodes}
        for stale in known - still:
            con.execute("DELETE FROM tv_episodes WHERE episode_id = ?", (stale,))
        con.commit()
    finally:
        con.close()
    total = len(episodes)
    update_progress("Starting TV scan...", 0, total, "tv")

    for i, (rel, srt) in enumerate(episodes, 1):
        update_progress(rel, i, total, "tv")

        episode_id = b64url_encode(rel)
        parsed = parse_episode(rel)
        if parsed is None:
            print(f"[STATE] Skipping non-seasoned episode: {rel}")
            continue
        show, season, ep_no, title = parsed

        is_ignored = (
            "tv:" + episode_id in ignored
            or "tv:" + rel in ignored
            or rel in ignored
        )

        season_dir = srt.parent
        syncinfo_path = ANALYSIS_ROOT / rel / "analysis.syncinfo"
        syncinfo_path.parent.mkdir(parents=True, exist_ok=True)

        if is_ignored:
            row = {
                "episode_id": episode_id,
                "show_name": show,
                "season": season,
                "episode_no": ep_no,
                "title": title,
                "state": "ignored",
                "rel_path": rel,
                "decision": None,
                "ignored": True,
            }
            upsert_tv_row(row)
            continue

        ref_candidates = collect_reference_candidates(season_dir, rel)
        if not ref_candidates:
            row = {
                "episode_id": episode_id,
                "show_name": show,
                "season": season,
                "episode_no": ep_no,
                "title": title,
                "state": "missing_subtitles",
                "rel_path": rel,
                "decision": None,
            }
            upsert_tv_row(row)
            continue

        resync_dir = RESYNC_ROOT / rel
        has_ffsync = resync_dir.exists() and any(
            p.name.endswith(".synced.srt") for p in resync_dir.iterdir()
        )
        ref_type, ref = max(ref_candidates, key=lambda x: x[1].stat().st_mtime)

        fi_mtime = int(srt.stat().st_mtime)
        now = time.time()

        analyze = False
        if not syncinfo_path.exists():
            analyze = True
        else:
            sync_mtime = syncinfo_path.stat().st_mtime
            if ref.stat().st_mtime > sync_mtime or srt.stat().st_mtime > sync_mtime:
                analyze = True

        if analyze:
            try:
                data = run_align(ref, srt)
                data["best_reference"] = ref_type
                data["reference_path"] = str(ref)
            except Exception as e:
                print(f"ERROR {rel}:", e)
                continue
            write_syncinfo(rel, data)

        try:
            with open(syncinfo_path, "r", encoding="utf-8") as f:
                data = json.load(f)

            whisper_ref_path = REF_ROOT / rel / "ref.srt"
            row = {
                "episode_id": episode_id,
                "show_name": show,
                "season": season,
                "episode_no": ep_no,
                "title": title,
                "anchor_count": data.get("anchor_count"),
                "avg_offset": data.get("avg_offset_sec"),
                "drift_span": data.get("drift_span_sec"),
                "decision": data.get("decision"),
                "best_reference": data.get("best_reference"),
                "reference_path": data.get("reference_path"),
                "has_whisper": whisper_ref_path.exists(),
                "has_ffsubsync": has_ffsync,
                "fi_mtime": fi_mtime,
                "last_analyzed": now,
                "ignored": 1 if is_ignored else 0,
                "state": "ok",
                "rel_path": rel,
            }
            upsert_tv_row(row)
        except Exception:
            print(f"ERROR reading syncinfo for {rel}:", e)
            continue

    print("TV scan complete.")
    update_progress("Done", total, total, "tv")


def main():
    kind = "tv" if "--tv" in sys.argv else "movie"
    if kind == "tv":
        scan_tv()
        return

    ANALYSIS_ROOT.mkdir(parents=True, exist_ok=True)

    # Always rebuild CSV fresh each run
    if SUMMARY_CSV.exists():
        SUMMARY_CSV.unlink()

    # Detect and remove missing movies
    media_movies = {
        p.name
        for p in MEDIA_ROOT.iterdir()
        if p.is_dir() and not p.name.startswith(".")
    }

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

        # Skip hidden/system folders
        if folder.name.startswith("."):
            continue

        movie = folder.name
        if movie in ignored:
            print(f"→ Marking ignored: {movie}")

            row = normalize_movie_row(
                {
                    "movie": movie,
                    "state": "ignored",
                    "ignored": True,
                    "decision": None,
                    "anchor_count": None,
                    "avg_offset": None,
                    "drift_span": None,
                }
            )
            upsert_movie_row(row)
            continue  #

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
            row = normalize_movie_row(row)
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
        now = time.time()

        if tgt and tgt.exists():
            fi_mtime = int(tgt.stat().st_mtime)
        else:
            print(f"[STATE] Missing FI subtitle for {movie}")

            row = normalize_movie_row(
                {
                    "movie": movie,
                    "state": "missing_subtitles",
                    "fi_mtime": None,
                    "last_analyzed": now,
                }
            )
            upsert_movie_row(row)
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
            row = normalize_movie_row(row)
            upsert_movie_row(row)

            continue
        except Exception as e:
            analyze = True

    print("Batch scan complete.")
    update_progress("Done", total, total)


if __name__ == "__main__":
    main()
