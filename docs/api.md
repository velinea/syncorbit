# UI <-> API contracts

/api/library

    {
    "ok": true,
    "rows": [
        {
        "movie": "10 Cloverfield Lane (2016)",
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

/api/analysis:movie

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
