# UI <-> API contracts

## /api/library

Reads the movies table from SQLite (canonical state).

    {
    "ok": true,
    "rows": [
        {
        "movie": "10 Cloverfield Lane (2016)",
        "state": "ok",
        "anchor_count": 563,
        "avg_offset": -0.087,
        "drift_span": 0.052,
        "decision": "synced",
        "best_reference": "en",
        "has_whisper": false,
        "has_ffsubsync": false,
        "fi_mtime": 1699999999,
        "last_analyzed": 1699999999,
        "ignored": false
        }
      ]
    }

- `decision` is one of: `synced`, `needs_adjustment`, `whisper_required`
- `state` is one of: `ok`, `missing_subtitles`, `ignored`
- `drift_span` is the smoothed (median-per-time-bin) drift in seconds

## /api/analysis/:movie

Reads the stored `analysis.syncinfo` for one movie.

    {
    "ok": true,
    "data": {
        "movie": "10 Cloverfield Lane (2016)",
        "decision": "synced",
        "anchor_count": 563,
        "avg_offset": -0.087,
        "drift_span": 0.052,
        "best_reference": "en",
        "reference_path": "/app/media/…en.srt",
        "target_path": "/app/media/…fi.srt",
        "offsets": [ ... ]
      }
    }

## /api/align

POST `{ "reference": "/path/en.srt", "target": "/path/fi.srt" }`.
Runs `align.py` and returns the full analysis JSON (see `python/align.py`).

## /api/autocorrect

POST `{ "target": "/path/fi.srt", "syncinfo_path": "/path/analysis.syncinfo" }`.
Runs `autocorrect.py` and returns `{ status, method, verdict, before, after, shifts, segments }`.

## Bulk actions

- POST `/api/bulk/ignore`  `{ movies: [...] }`
- POST `/api/bulk/touch_whisper`  `{ movies: [...] }`
- POST `/api/bulk/ffsubsync`  `{ movies: [...] }`

Each returns `{ ok, results, errors }`.

## Other endpoints

- GET `/api/db/stats` → library summary counts
- GET `/api/poster/:movie`, GET `/api/artwork/:movie` → `folder.jpg` / `backdrop.jpg`
- GET `/api/listsubs/:movie` → media / whisper / autocorrect / resync subtitle files
- GET `/api/batch_progress` → batch scan progress
- POST `/api/run-batch-scan` → start a full library scan
- POST `/api/reanalyze/:movie` → re-align one movie against its newest reference
- GET `/api/searchsubs?q=…` → subtitle search