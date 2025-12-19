# 🗄️ SyncOrbit SQLite – Common Tasks & Commands

Assumptions:

- DB file: /app/data/syncorbit.db
- Table: movies
- SQLite CLI installed (inside container or host)

## 🔎 1️⃣ Open the database (interactive shell)

Inside the container:

```
sqlite3 /app/data/syncorbit.db
```

You’ll see:

```
SQLite version 3.x.x
sqlite>
```

Useful shell commands:

```
.tables
.schema movies
.headers on
.mode column
```

## 📋 2️⃣ See all movies (quick sanity check)

```
SELECT movie, decision, anchor_count
FROM movies
ORDER BY movie;
```

## 🧮 3️⃣ How many movies are synced / drifted / unknown?

```
SELECT decision, COUNT(*) AS count
FROM movies
GROUP BY decision;
```

This replaces a lot of UI guessing 🙂

## 🕵️ 4️⃣ Inspect one movie in detail

```
SELECT *
FROM movies
WHERE movie = '10 Cloverfield Lane (2016)';
```

Great when debugging badges, refs, or reanalyze behavior.

## 🧭 5️⃣ See which reference was used (very common)

```
SELECT movie, best_reference, reference_path
FROM movies
ORDER BY last_analyzed DESC
LIMIT 20;
```

Answers:

- “Is Whisper actually being used?”
- “Did ffsubsync win?”

## ⏱️ 6️⃣ Find recently touched / analyzed movies

```
SELECT movie,
       datetime(last_analyzed, 'unixepoch') AS analyzed_at
FROM movies
ORDER BY last_analyzed DESC
LIMIT 20;
```

Perfect for verifying:

- reanalyze
- nightly batch_scan
- manual fixes

## 🧹 7️⃣ Find movies missing analysis (important!)

```
SELECT movie
FROM movies
WHERE anchor_count = 0
   OR decision IS NULL;
```

These are your problem cases.

## 🚫 8️⃣ Check ignored movies

```
SELECT movie
FROM movies
WHERE ignored = 1;
```

Or un-ignore one manually:

```
UPDATE movies
SET ignored = 0
WHERE movie = 'Some Movie (Year)';
```

## 🧪 9️⃣ Validate Whisper / ffsubsync coverage

```
SELECT
  SUM(has_whisper) AS whisper_refs,
  SUM(has_ffsubsync) AS ffsubsync_refs,
  COUNT(*) AS total
FROM movies;
```

Instant overview.

## 🧯 10️⃣ Emergency reset (safe operations)

Remove one movie from DB (does not delete files)

```
DELETE FROM movies
WHERE movie = 'Broken Movie (2020)';
```

It will be re-added on next batch_scan or reanalyze.

♻️ Reset analysis state (keep ignore flag)

```
UPDATE movies
SET anchor_count = 0,
    decision = 'unknown'
WHERE movie = 'Test Movie (2021)';
```

## 📤 11️⃣ Export CSV (for WhisperX or debugging)

```
sqlite3 /app/data/syncorbit.db <<'EOF'
.headers on
.mode csv
.output syncorbit_export.csv
SELECT movie, anchor_count, avg_offset, drift_span, decision
FROM movies
ORDER BY fi_mtime DESC;
EOF
```

This recreates your old CSV, but now from the DB.

## 🔍 12️⃣ Debug a UI issue fast

When something looks wrong in UI:

1. Copy movie name
2. Run:

```
SELECT *
FROM movies
WHERE movie LIKE '%Cloverfield%';
```

Compare with what UI shows

- If DB is right → UI bug
- If DB is wrong → batch_scan / reanalyze bug

That separation is huge.

## 🧠 Pro tips (worth remembering)

- SQLite is ACID-safe — no corruption anxiety
- You can safely open it while SyncOrbit runs
- better-sqlite3 is synchronous → fewer race bugs
- Backups are trivial:

```
cp syncorbit.db syncorbit.db.bak
```
