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

- `decision` is one of: `synced`, `needs_adjustment`, `unresolvable`
- `state` is one of: `ok`, `missing_subtitles`, `ignored`
- `drift_span` is the smoothed (median-per-time-bin) drift in seconds

## /api/library/tv

Reads the `tv_episodes` table from SQLite (canonical state for TV rows).

    {
    "ok": true,
    "rows": [
        {
        "episode_id": "QnJlYWtpbmcgQmFkL1NlYXNvbiAxL01LZi5maS5zcnQ",
        "title": "Breaking Bad - S01E01",
        "show_name": "Breaking Bad",
        "season": 1,
        "episode_no": 1,
        "state": "ok",
        "anchor_count": 43,
        "avg_offset": 406.68,
        "drift_span": 0.0,
        "decision": "unresolvable",
        "best_reference": "en",
        "has_whisper": false,
        "has_ffsubsync": false,
        "ignored": false
        }
      ]
    }

- `episode_id` is the **base64url-encoded relative path** of the FI subtitle
  (e.g. `Breaking Bad/Season 1/…fi.srt`). It is URL-safe and used as the
  identifier for all TV endpoints instead of a slash-bearing path.
- `decision` is one of: `synced`, `needs_adjustment`, `unresolvable`

## /api/analysis/:movie

Reads the stored `analysis.syncinfo` for one movie.

    {
    "ok": true,
    "data": {
        "movie": "10 Cloverfield Lane (2016)",
        "decision": "synced",
        "anchor_count": 563,
        "ref_count": 1033,
        "avg_offset": -0.087,
        "drift_span": 0.052,
        "best_reference": "en",
        "reference_path": "/app/media/…en.srt",
        "target_path": "/app/media/…fi.srt",
        "anchor_ratio": 0.545,
        "residual_span": 1.234,
        "robust_span": 0.410,
        "raw_span": 8.193,
        "linear_drift_per_hour": 0.0021,
        "linear_fit_r2": 0.31,
        "drift_bins": [ { "ref_t": 190.7, "delta": -0.37 }, … ],
        "reason": "Clean anchors: 563/1033, drift 0.05s, offset -0.09s",
        "offsets": [ ... ]
      }
    }

- `drift_span` is the smoothed (median-per-time-bin) drift in seconds
- `residual_span` is what remains after removing a fitted linear drift —
  large values indicate non-linear drift
- `reason` mirrors the `decide_quality()` gate order in `align.py` and is the
  plain-language explanation shown in the UI (`Why:` line)
- `offsets` are the clean (MAD-filtered) anchors used by the graph
- the full unmodified analysis is also available under `data.raw`

## /api/align

POST `{ "reference": "/path/en.srt", "target": "/path/fi.srt" }`.
Runs `align.py` and returns the full analysis JSON (see `python/align.py`),
plus a computed `reason` field (same logic as `/api/analysis/:movie`).

## /api/autocorrect

POST `{ "target": "/path/fi.srt", "syncinfo_path": "/path/analysis.syncinfo" }`.
Runs `autocorrect.py` and returns `{ status, method, verdict, before, after, shifts, segments }`.

## Bulk actions

Movie rows and TV episodes both use these endpoints. For TV, pass
`kind: "tv"` in the body and use `episode_id` values instead of movie folder
names.

- POST `/api/bulk/ignore`  `{ movies: [...], kind? }`
- POST `/api/bulk/touch_whisper`  `{ movies: [...], kind? }`
- POST `/api/bulk/ffsubsync`  `{ movies: [...], kind? }`

Each returns `{ ok, results, errors }`.

## TV endpoints

- GET `/api/library/tv` → reads the `tv_episodes` table
- GET `/api/analysis/tv/:episode_id` → stored `analysis.syncinfo` for one episode
- POST `/api/reanalyze/tv/:episode_id` → re-align one episode
- GET `/api/poster/tv/:episode_id`, GET `/api/artwork/tv/:episode_id` → `folder.jpg` / `backdrop.jpg`
- GET `/api/db/stats/tv` → episode summary counts
- POST `/api/run-tv-scan` → start a TV library scan (recurses `Show/Season N/`)

`episode_id` is a URL-safe base64url-encoded relative path; decode it to get
the subtitle path under `MEDIA_ROOT_TV`.

## Other endpoints

- GET `/api/db/stats` → library summary counts
- GET `/api/poster/:movie`, GET `/api/artwork/:movie` → `folder.jpg` / `backdrop.jpg`
- GET `/api/listsubs/:movie` → media / whisper / autocorrect / resync subtitle files
- GET `/api/batch_progress` → batch scan progress (includes a `kind` field)
- POST `/api/run-batch-scan` → start a full library scan
- POST `/api/reanalyze/:movie` → re-align one movie against its newest reference
- GET `/api/searchsubs?q=…` → subtitle search

### Legacy (not used by the current UI)

- GET `/api/movieinfo?file=…` → raw `analysis.syncinfo` by absolute path
- GET `/api/movies` → movie folders found under `MEDIA_ROOT`
- POST `/api/analyze` → run `analyze.py` on a single subtitle file
- POST `/api/compare` → run `analyze_pair.py` on two subtitles
- POST `/api/whisper/:movie` → submit a WhisperX job for one movie