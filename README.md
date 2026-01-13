# <img src="public/logo.png" width=100px> SyncOrbit

SyncOrbit is a self-hosted tool for analyzing, fixing, and managing subtitle synchronization in large movie libraries.

It combines automated alignment, speech-based references, and human-in-the-loop workflows to solve one problem well:

“Which subtitle is correct, and how do I make it stay that way?”

<img src="docs/screenshot2.png" width=800px>

## What SyncOrbit Does

- Scans a movie library and analyzes subtitle sync quality
- Aligns subtitles using multiple reference strategies:
  - Original English subtitles
  - WhisperX-generated speech references
  - FFSubSync-aligned references
- Scores and classifies results (synced / needs adjustment / bad)
- Lets you reanalyze individual movies or run batch jobs
- Keeps state in a database (not fragile CSV glue)
- Designed for large libraries (thousands of movies)

## Design Philosophy

SyncOrbit follows a few strict principles:

- Automation first, but not blindly
- Never delete expensive work (e.g. Whisper references)
- Newest reference wins (simple, intuitive decision model)
- UI should explain decisions, not hide them
- Everything must be inspectable and reversible

It is intentionally not a media manager like Radarr or Bazarr —
SyncOrbit assumes those already exist.

🏗 Architecture Overview

```
┌────────────┐
│   Browser  │
│   (UI)     │
└─────┬──────┘
      │ REST
┌─────▼──────┐
│  SyncOrbit │
│  Node.js   │
│  API + UI  │
└─────┬──────┘
      │
      ├─ SQLite DB  (library state, decisions, timestamps)
      ├─ Python tools
      │    ├─ batch_scan.py
      │    ├─ align.py
      │    └─ ffsubsync
      │
      └─ (optional)
           WhisperX service (separate container)
```

#### Key idea

- SyncOrbit orchestrates
- Python does the heavy lifting
- WhisperX is isolated and optional

## Components

1. SyncOrbit (main container)

- Node.js backend (API)
- HTML / JS frontend
- SQLite database
- Coordinates batch jobs and single-movie actions

2. Python tools

- batch_scan.py – full library analysis
- align.py – subtitle alignment + statistics
- ffsubsync – reference creation from audio

3. WhisperX service (optional)

- Separate container
- Exposes a simple HTTP API
- Generates ref.srt when requested
- Runs asynchronously (does not block UI)

If WhisperX is not running, SyncOrbit continues to work normally.

## Folder Structure (important)

```
/media
  /Movie Name (Year)
    Movie.mkv
    Movie.en.srt
    Movie.fi.srt
    folder.jpg

/app/data
  /analysis
    /Movie Name (Year)
      analysis.syncinfo
  /ref
    /Movie Name (Year)
      ref.srt
  /resync
    /Movie Name (Year)
      *.synced.srt
  ignore_list.json
  syncorbit.db
```

## Decisions & References

Each movie ends up with:

- decision

  - synced
  - needs_adjustment
  - bad

- best_reference

  - en
  - whisper
  - ffsubsync

- reference_path
- alignment statistics (anchors, drift, offsets)

#### Rule:

The newest valid reference wins — unless manually overridden.

## UI Highlights

- Fast library table (DB-backed)
- Hover poster previews (folder.jpg)
- Reference badges (EN / Whisper / FFSync)
- Inline reanalyze buttons with live feedback
- Bulk actions:
  - Ignore movies
  - Run FFSubSync
  - Touch / create Whisper references
- Analysis graphs and statistics per movie

## Batch Workflow

Typical nightly flow:

1. batch_scan.py (cron)
2. Remove missing movies from DB
3. Analyze new or changed subtitles
4. Update decisions & stats
5. UI reflects changes instantly

## Getting Started (high level)

```
clone repo
git clone https://github.com/velinea/syncorbit
cd syncorbit

# build container
docker build -t syncorbit .

# run
docker run \
  -v /media:/media \
  -v /app/data:/app/data \
  -p 5010:5010 \
  syncorbit
```

(Exact setup depends on your environment — Unraid supported.)

## Optional: WhisperX Integration

- Run WhisperX as a separate container
- Same Docker network as SyncOrbit
- SyncOrbit calls it only when needed
- Long jobs run in the background

This avoids:

- UI blocking
- Dependency hell
- GPU coupling

## What SyncOrbit Is Not

- Not a subtitle downloader
- Not a media manager
- Not real-time
- Not cloud-based

It is a library maintenance tool.

## Project Status

- Actively used
- Architecture stabilized
- UX still evolving
- Not yet “one-click install”

Expect iteration.

## License

[MIT](https://github.com/velinea/syncorbit/blob/main/LICENSE)

## Credits & Inspiration

- FFSubSync
- Whisper / WhisperX
- Radarr / Bazarr philosophy
- Plex UX patterns
