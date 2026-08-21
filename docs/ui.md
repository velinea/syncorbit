# UI data flow

    batch_scan.py                ← writes SQLite (movies) + syncorbit_library_export.csv
    ↓
    SQLite db (syncorbit.db)     ← /api/library reads from here (CSV is a side artifact)
    ↓
    /api/library
    ↓
    loadLibrary()
    ↓
    renderLibraryTable(rows)

    User clicks movie row
    ↓
    /api/analysis/:movie          ← reads analysis/<movie>/analysis.syncinfo
    ↓
    openLibraryAnalysis()
    ↓
    renderSummary()
    ↓
    drawGraph()                   ← clean_offsets / offsets + drift_bins (public/graph.js)

    User clicks "Auto-correct"
    ↓
    /api/autocorrect              ← runs autocorrect.py, writes data/autocorrect/*.corrected.srt
    ↓
    /api/autocorrect/download?filename=…  ← download the corrected subtitle

## Analysis summary panel (`renderSummary`)

When a movie is selected (library tab) or aligned (manual tab), the summary
panel shows the metrics from `analysis.syncinfo` that the decision is based on:

```
Ref:        /app/media/Movie/Movie.en.srt
Target:     /app/media/Movie/Movie.fi.srt

Ref lines:  1033
Tgt lines:  745
Anchors:    563  (54.50% of ref)
Avg offset: -0.087 s
Min / Max:  -5.666 s  /  2.527 s
Drift span: 0.052 s   (binned)
Residual:   1.234 s   (after linear fit)
Robust:     0.410 s   (4×MAD)
Raw span:   8.193 s   (min–max)
Linear:     0.0021 s/h   r²=0.31
Decision:   synced
Why:        Clean anchors: 563/1033, drift 0.05s, offset -0.09s
```

| Field | Meaning |
|---|---|
| `Ref` / `Target` | Reference and target subtitle files that were compared. The reference is the newest valid one (EN / Whisper / ffsubsync). |
| `Ref lines` / `Tgt lines` | Number of subtitle cues in each file. |
| `Anchors` | Matched cue pairs used for alignment, and what fraction of the reference they cover. Low ratio = weak evidence. |
| `Avg offset` | Median time shift of all anchors, in seconds. Positive = target subtitles appear later than the reference. This is the constant shift a single global fix would apply. |
| `Min / Max` | Smallest and largest raw anchor offsets. A wide range means individual cues disagree — jitter or outliers. |
| `Drift span` | **Headline drift metric.** Anchors are split into 12 time bins across the movie; each bin gets the median offset. Span = max − min of those medians. Jitter cancels out, so a large value means *genuine progressive drift* (subtitle slowly slides out of sync during playback). |
| `Residual` | After fitting a straight line through the anchors (time → offset), this is the span of what's left over. Large residual = **non-linear drift** that a constant shift or stretch cannot fix — the main reason previously-"synced" movies get flagged. |
| `Robust` | 4 × MAD (median absolute deviation) of per-cue deltas. An outlier-resistant spread measure; used as the anchor-spread sanity check for `synced`. |
| `Raw span` | max − min of all raw anchor offsets, no cleaning. Diagnostic only — one bad match can blow it up. |
| `Linear` | Fitted drift rate in seconds per hour, plus r² of the fit. High r² = drift is a clean linear stretch (auto-correctable); low r² = chaotic. |
| `Decision` | `synced`, `needs_adjustment`, or `whisper_required`. |
| `Why` | Plain-language reason for the decision (see below). |

### Decision logic (`decide_quality` in align.py)

Gates are checked in order; the first one that trips decides the outcome and
becomes the `Why:` line:

| Order | Gate | Threshold | Result |
|---|---|---|---|
| 1 | Anchor ratio | < 3% of ref lines | `whisper_required` — too few anchors to trust |
| 2 | Drift span (binned) | > 3.5 s | `whisper_required` — progressive drift |
| 3 | Residual after linear fit | > 2.5 s | `whisper_required` — non-linear drift |
| 4 | Avg offset | \|offset\| > 4 s | `whisper_required` — large constant shift |
| 5 | All clean: ratio ≥ 6%, drift ≤ 1.5 s, \|offset\| ≤ 1.5 s, spread ≤ 2.5 s | — | `synced` |
| 6 | Anything else | — | `needs_adjustment` |

The same gate order is implemented server-side in `server.cjs`
(`decisionReason()`), so the UI always explains decisions consistently.

## Analysis graph (`drawGraph`)

- **Blue dots/line** — every individual anchor: x = position in the movie,
  y = offset in seconds. Shows cue-by-cue jitter.
- **Amber line** — the binned-median drift curve (one point per time bin).
  This is the trend the `Drift span` metric measures:
  - flat → synced
  - steadily rising/falling → progressive drift (stretch can fix)
  - wavy/jagged → non-linear drift (residual gate fires)

Hover shows timestamp and offset for the nearest anchor.
