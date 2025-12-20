// server.cjs (CommonJS mode)
// All require() calls now legal and ExecJS-compatible

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { exec } = require('child_process');
const { db, initDb } = require('./db.cjs');
initDb();

const app = express();
const PY = '/app/.venv/bin/python3';
const MEDIA_ROOT = '/app/media';
const DATA_ROOT = '/app/data';
const WHISPER_ROOT = path.join(DATA_ROOT, 'ref');
const IGNORE_FILE = path.join(
  process.env.SYNCORBIT_DATA || '/app/data',
  'ignore_list.json'
);

// Prepared statements
const upsertMovieStmt = db.prepare(`
  INSERT INTO movies (
    movie, anchor_count, avg_offset, drift_span, decision,
    best_reference, reference_path,
    has_whisper, has_ffsubsync,
    fi_mtime, last_analyzed, ignored
  ) VALUES (
    @movie, @anchor_count, @avg_offset, @drift_span, @decision,
    @best_reference, @reference_path,
    @has_whisper, @has_ffsubsync,
    @fi_mtime, @last_analyzed, @ignored
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
`);

const getMovieStmt = db.prepare(`SELECT * FROM movies WHERE movie = ?`);

// Ensure PATH & EXECJS runtime preference are correct for ffsubsync + PyExecJS
process.env.EXECJS_RUNTIME = 'Node';
// Force system node (CJS) to appear first in PATH
process.env.PATH = '/usr/bin:/usr/local/bin:/app/.venv/bin:' + process.env.PATH;

console.log('Using PATH:', process.env.PATH);
console.log('EXECJS_RUNTIME:', process.env.EXECJS_RUNTIME);

app.use(express.json());
app.use(express.static('public'));

// --------------------------
// Helper functions
// -------------------------

function findFiSubtitleMtime(movieDir) {
  try {
    const files = fs.readdirSync(movieDir);
    for (const f of files) {
      const lc = f.toLowerCase();
      if (lc.endsWith('.fi.srt') || lc.endsWith('.fin.srt')) {
        return Math.floor(fs.statSync(path.join(movieDir, f)).mtimeMs / 1000);
      }
    }
  } catch {}
  return null;
}

function hasFfsubsync(movie) {
  try {
    const dir = path.join(DATA_ROOT, 'resync', movie);
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).some(f => f.toLowerCase().endsWith('.synced.srt'))
      ? 1
      : 0;
  } catch {
    return 0;
  }
}

function hasWhisper(movie) {
  try {
    const p = path.join(DATA_ROOT, 'ref', movie, 'ref.srt');
    return fs.existsSync(p) ? 1 : 0;
  } catch {
    return 0;
  }
}

function loadIgnoreList() {
  try {
    return JSON.parse(fs.readFileSync(IGNORE_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveIgnoreList(list) {
  fs.writeFileSync(IGNORE_FILE, JSON.stringify(list, null, 2));
}

function updateSyncInfoWithFfsync(movie, ffsyncData) {
  const analysisDir = path.join(DATA_ROOT, 'analysis', movie);
  const syncPath = path.join(analysisDir, 'analysis.syncinfo');

  let info = {};
  try {
    if (fs.existsSync(syncPath)) {
      info = JSON.parse(fs.readFileSync(syncPath, 'utf8'));
    }
  } catch (err) {
    console.error('Failed reading syncinfo:', err);
  }

  // Ensure containers exist
  if (!info.ref_candidates) info.ref_candidates = {};

  info.ref_candidates.ffsubsync_en = {
    path: ffsyncData.outSub,
    raw_score: ffsyncData.rawScore,
    normalized_score: ffsyncData.normalizedScore,
    offset_seconds: ffsyncData.offsetSeconds,
  };

  fs.mkdirSync(analysisDir, { recursive: true });

  try {
    fs.writeFileSync(syncPath, JSON.stringify(info, null, 2));
  } catch (err) {
    console.error('Failed writing syncinfo:', err);
  }
}

app.post('/api/bulk/ignore', express.json(), async (req, res) => {
  const movies = req.body.movies || [];
  let ignoreList = loadIgnoreList();

  for (const m of movies) {
    if (!ignoreList.includes(m)) {
      ignoreList.push(m);
    }
  }

  saveIgnoreList(ignoreList);

  res.json({ ok: true, total: ignoreList.length });
});

app.post('/api/bulk/touch_whisper', express.json(), (req, res) => {
  const movies = req.body.movies || [];
  const results = [];
  const errors = [];

  for (const movie of movies) {
    try {
      const refPath = path.join(DATA_ROOT, 'ref', movie, 'ref.srt');

      if (!fs.existsSync(refPath)) {
        errors.push({ movie, error: 'Whisper reference missing' });
        continue;
      }

      const now = new Date();
      fs.utimesSync(refPath, now, now); // update atime + mtime

      results.push({ movie, ok: true, updated: refPath });
    } catch (err) {
      errors.push({ movie, error: String(err) });
    }
  }
  res.json({ ok: true, results, errors });
});

app.post('/api/bulk/ffsubsync', express.json(), async (req, res) => {
  const movies = req.body.movies || [];
  const results = [];
  const errors = [];

  function countLines(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return content.split(/\r?\n/).filter(x => x.trim().length > 0).length;
    } catch {
      return null;
    }
  }

  for (const movie of movies) {
    try {
      const movieDir = path.join(MEDIA_ROOT, movie);

      // ----------------------------
      // Locate video
      // ----------------------------
      const video = fs.readdirSync(movieDir).find(f => /\.(mp4|mkv|avi|mov)$/i.test(f));
      if (!video) {
        errors.push({ movie, error: 'No video file found' });
        continue;
      }
      const inVideo = path.join(movieDir, video);

      // ----------------------------
      // Locate EN subtitle
      // ----------------------------
      const sub = fs
        .readdirSync(movieDir)
        .find(f => /\.en\.srt$/i.test(f) || /\.eng\.srt$/i.test(f));
      if (!sub) {
        errors.push({ movie, error: 'No EN subtitle found' });
        continue;
      }
      const inSub = path.join(movieDir, sub);

      // ----------------------------
      // Output path
      // ----------------------------
      const outDir = path.join(DATA_ROOT, 'resync', movie);
      fs.mkdirSync(outDir, { recursive: true });

      const base = path.basename(inSub).replace(/\.srt$/i, '');
      const outSub = path.join(outDir, base + '.synced.srt');

      console.log('Running ffsubsync:', { inVideo, inSub });

      // ----------------------------
      // Spawn ffsubsync
      // ----------------------------
      const ffbin = '/app/.venv/bin/ffsubsync';
      const result = spawnSync(ffbin, [inVideo, '-i', inSub, '-o', outSub], {
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
        },
      });

      if (result.error) {
        errors.push({ movie, error: result.error.message });
        continue;
      }

      if (result.status !== 0) {
        errors.push({
          movie,
          error: result.stderr || result.stdout || 'ffsubsync failed',
        });
        continue;
      }

      // ----------------------------
      // Extract raw score (stderr!)
      // ----------------------------
      const stderr = result.stderr || '';
      const scoreMatch = stderr.match(/score:\s*([0-9.]+)/i);

      const rawScore = scoreMatch ? parseFloat(scoreMatch[1]) : null;
      const lineCount = countLines(inSub);
      const normScore = rawScore && lineCount ? rawScore / lineCount : null;
      // Extract offset, framerate, etc
      const offsetMatch = stderr.match(/offset seconds:\s*([0-9.\-]+)/i);
      const frMatch = stderr.match(/framerate scale factor:\s*([0-9.\-]+)/i);

      const offsetSeconds = offsetMatch ? parseFloat(offsetMatch[1]) : null;
      const framerateFactor = frMatch ? parseFloat(frMatch[1]) : null;

      results.push({
        movie,
        inSub,
        outSub,
        rawScore,
        normalizedScore: normScore,
        offsetSeconds,
        framerateFactor,
        log: stderr,
      });
      updateSyncInfoWithFfsync(movie, {
        outSub,
        rawScore,
        normalizedScore,
        offsetSeconds,
      });
    } catch (err) {
      errors.push({ movie, error: err.message });
    }
  }
  res.json({ ok: true, results, errors });
});

app.get('/api/batch_progress', (req, res) => {
  const progressPath = path.join(DATA_ROOT, 'batch_progress.json');

  if (!fs.existsSync(progressPath)) {
    return res.json({ running: false });
  }

  try {
    const data = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
    return res.json({ running: true, ...data });
  } catch (e) {
    return res.json({ running: false });
  }
});

app.post('/api/analyze', (req, res) => {
  const file = req.body.path;
  if (!file) return res.status(400).json({ error: 'no file' });

  const py = spawn(PY, ['/app/python/analyze.py', file]);
  let out = '',
    err = '';

  py.stdout.on('data', d => (out += d.toString()));
  py.stderr.on('data', d => (err += d.toString()));
  py.on('close', code => {
    if (code === 0) {
      try {
        res.json(JSON.parse(out));
      } catch (e) {
        res.status(500).json({ error: 'bad json', detail: e.toString() });
      }
    } else {
      res.status(500).json({ error: 'python failed', detail: err });
    }
  });
});

app.post('/api/compare', (req, res) => {
  const { base, ref } = req.body;
  if (!base || !ref) return res.status(400).json({ error: 'missing paths' });

  const py = spawn(PY, ['/app/python/analyze_pair.py', base, ref]);
  let out = '',
    err = '';
  py.stdout.on('data', d => (out += d.toString()));
  py.stderr.on('data', d => (err += d.toString()));
  py.on('close', code => {
    if (code === 0) {
      try {
        res.json(JSON.parse(out));
      } catch (e) {
        res.status(500).json({ error: 'bad json', detail: e.toString() });
      }
    } else {
      res.status(500).json({ error: err || `python exit ${code}` });
    }
  });
});

app.post('/api/align', (req, res) => {
  const { reference, target } = req.body;
  if (!reference || !target) {
    return res.status(400).json({ error: 'reference and target paths required' });
  }
  const py = spawn(PY, ['/app/python/align.py', reference, target]);

  let out = '';
  let errBuf = '';

  py.stdout.on('data', d => (out += d.toString()));
  py.stderr.on('data', d => (errBuf += d.toString()));

  py.on('close', code => {
    if (code === 0) {
      try {
        const data = JSON.parse(out);
        res.json(data);
      } catch (e) {
        res.status(500).json({
          error: 'bad JSON from align.py',
          detail: String(e),
          raw: out,
        });
      }
    } else {
      res
        .status(500)
        .json({ error: 'align.py failed', detail: errBuf || `exit ${code}` });
    }
  });
});

app.get('/api/searchsubs', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  if (q.length < 2) return res.json([]);

  const cmd = `find ${MEDIA_ROOT} -type f -iname '*.srt' -print`;

  exec(cmd, (err, stdout) => {
    if (err) return res.json([]);

    const all = stdout.split('\n').filter(Boolean);
    const filtered = all.filter(p => p.toLowerCase().includes(q));

    const groups = {};
    for (const p of filtered) {
      const name = path.basename(p);
      const base = name.replace(/\.(en|eng|fi|fin)?\.srt$/i, '');
      const langMatch = name.match(/\.(en|eng|fi|fin)\.srt$/i);
      const lang = langMatch ? langMatch[1].toLowerCase() : 'unknown';

      if (!groups[base]) groups[base] = { base, en: null, fi: null, others: [] };

      if (lang.startsWith('en')) groups[base].en = p;
      else if (lang.startsWith('fi')) groups[base].fi = p;
      else groups[base].others.push(p);
    }

    res.json(Object.values(groups).slice(0, 80));
  });
});

app.post('/api/run-batch-scan', (req, res) => {
  const py = spawn(PY, ['/app/python/batch_scan.py'], {
    cwd: '/app',
  });

  let out = '';
  let err = '';

  py.stdout.on('data', d => (out += d.toString()));
  py.stderr.on('data', d => (err += d.toString()));

  py.on('close', code => {
    if (code === 0) {
      res.json({ status: 'ok', output: out });
    } else {
      res.status(500).json({
        status: 'error',
        detail: err || `batch_scan exited with ${code}`,
      });
    }
  });
});

app.post('/api/reanalyze/:movie', async (req, res) => {
  const movie = req.params.movie;
  const movieDir = path.join(MEDIA_ROOT, movie);

  if (!fs.existsSync(movieDir)) {
    return res.json({ ok: false, error: 'movie_not_found' });
  }

  // --- Ignore list ---
  const ignoreFile = path.join(DATA_ROOT, 'ignore_list.json');
  try {
    if (fs.existsSync(ignoreFile)) {
      const ignored = JSON.parse(fs.readFileSync(ignoreFile, 'utf8'));
      if (ignored.includes(movie)) {
        return res.json({ ok: false, error: 'ignored' });
      }
    }
  } catch {}

  // --- Reference selection ---
  const whisperRef = path.join(DATA_ROOT, 'ref', movie, 'ref.srt');
  const resyncDir = path.join(DATA_ROOT, 'resync', movie);

  let ref = null;
  let tgt = null;
  let refType = null;

  // Whisper
  if (fs.existsSync(whisperRef)) {
    ref = whisperRef;
    refType = 'whisper';
  }

  // ffsubsync
  if (!ref && fs.existsSync(resyncDir)) {
    const ffsyncCandidates = fs
      .readdirSync(resyncDir)
      .filter(f => f.endsWith('.synced.srt'));
    if (ffsyncCandidates.length > 0) {
      ref = path.join(resyncDir, ffsyncCandidates[0]);
      refType = 'ffsync';
    }
  }

  // EN fallback
  if (!ref) {
    const list = fs.readdirSync(movieDir);
    const en = list.find(
      f => f.toLowerCase().endsWith('.en.srt') || f.toLowerCase().endsWith('.eng.srt')
    );

    if (!en) {
      return res.json({ ok: false, error: 'no_english_reference' });
    }

    ref = path.join(movieDir, en);
    refType = 'en';
  }

  // --- FI target ---
  const list = fs.readdirSync(movieDir);
  const fi = list.find(
    f => f.toLowerCase().endsWith('.fi.srt') || f.toLowerCase().endsWith('.fin.srt')
  );

  if (!fi) {
    return res.json({ ok: false, error: 'missing_finnish_subtitle' });
  }

  tgt = path.join(movieDir, fi);

  // -------------------------------------------------------
  //  NOW CALL EXISTING /api/align INSTEAD OF RUNNING PYTHON
  // -------------------------------------------------------
  try {
    const alignRes = await fetch('http://localhost:5010/api/align', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference: ref, target: tgt }),
    });

    const data = await alignRes.json();

    if (!alignRes.ok || data.error) {
      return res.json({ ok: false, error: data.error || 'align_failed' });
    }

    // Add metadata & write syncinfo
    data.best_reference = refType;
    data.reference_path = ref;

    const syncDir = path.join(DATA_ROOT, 'analysis', movie);
    const syncFile = path.join(syncDir, 'analysis.syncinfo');

    fs.mkdirSync(syncDir, { recursive: true });
    fs.writeFileSync(syncFile, JSON.stringify(data, null, 2));

    // -------------------------------------------------------
    //  WRITE RESULT INTO SQLITE (CANONICAL STATE)
    // -------------------------------------------------------
    const now = Math.floor(Date.now() / 1000);

    const fiMtime = findFiSubtitleMtime(movieDir);

    // Preserve ignored flag if already present
    let ignoredFlag = 0;
    try {
      const row = getMovieStmt.get(movie);
      if (row && row.ignored) ignoredFlag = 1;
    } catch {}

    const row = {
      movie,

      anchor_count: data.anchor_count ?? data.raw_anchor_count ?? 0,
      avg_offset: data.median_offset_sec ?? data.avg_offset_sec ?? 0,
      drift_span:
        data.robust_drift_span_sec ??
        data.drift_span_sec ??
        data.raw_drift_span_sec ??
        0,

      decision: data.decision ?? 'unknown',

      best_reference: refType,
      reference_path: ref,

      has_whisper: hasWhisper(movie),
      has_ffsubsync: hasFfsubsync(movie),

      fi_mtime: fiMtime,
      last_analyzed: now,
      ignored: ignoredFlag,
    };

    upsertMovieStmt.run(row);

    // Read back normalized row for UI
    const stored = getMovieStmt.get(movie);
    if (stored) {
      stored.has_whisper = !!stored.has_whisper;
      stored.has_ffsubsync = !!stored.has_ffsubsync;
      stored.ignored = !!stored.ignored;
    }

    // -------------------------------------------------------
    //  RETURN UPDATED ROW TO UI
    // -------------------------------------------------------
    return res.json({
      ok: true,
      movie,
      row: stored || row,
    });
  } catch (err) {
    return res.json({ ok: false, error: err.toString() });
  }
});

app.get('/api/library', (req, res) => {
  try {
    const rows = db
      .prepare(
        `
        SELECT
          movie,
          anchor_count,
          avg_offset,
          drift_span,
          decision,
          best_reference,
          reference_path,
          has_whisper,
          has_ffsubsync,
          fi_mtime,
          last_analyzed,
          ignored
        FROM movies
        ORDER BY COALESCE(fi_mtime, 0) DESC
      `
      )
      .all()
      .map(r => ({
        ...r,
        has_whisper: !!r.has_whisper,
        has_ffsubsync: !!r.has_ffsubsync,
        ignored: !!r.ignored,
      }));

    res.json({ ok: true, rows });
  } catch (err) {
    console.error('/api/library (sqlite) failed:', err);
    res.json({ ok: false, error: err.toString() });
  }
});

app.get('/api/analysis/:movie', (req, res) => {
  try {
    const movie = req.params.movie;
    const syncinfoPath = path.join(DATA_ROOT, 'analysis', movie, 'analysis.syncinfo');

    if (!fs.existsSync(syncinfoPath)) {
      return res.json({ ok: false, error: 'no_syncinfo' });
    }

    const raw = JSON.parse(fs.readFileSync(syncinfoPath, 'utf8'));

    const normalized = {
      movie,

      decision: raw.decision,
      best_reference: raw.best_reference,
      reference_path: raw.reference_path ?? raw.ref_path ?? null,
      target_path: raw.target_path ?? raw.target ?? null,

      // Canonical counts
      anchor_count: raw.anchor_count ?? raw.raw_anchor_count,
      ref_count: raw.ref_count,
      target_count: raw.target_count,

      // Canonical offsets (seconds)
      avg_offset: raw.median_offset_sec ?? raw.avg_offset_sec,
      max_offset: raw.max_offset_sec,
      min_offset: raw.min_offset_sec,
      drift_span: raw.robust_drift_span_sec ?? raw.drift_span_sec,

      // Graph data
      offsets: raw.clean_offsets ?? raw.offsets,

      // Optional diagnostics (keep for later UI)
      raw: raw,
    };

    res.json({ ok: true, data: normalized });
  } catch (err) {
    console.error('analysis load error:', err);
    res.json({ ok: false, error: err.toString() });
  }
});

app.get('/api/movieinfo', (req, res) => {
  const file = req.query.file; // absolute path to the .syncinfo file
  if (!file) return res.status(400).json({ error: 'missing file param' });

  fs.readFile(file, 'utf8', (err, data) => {
    if (err) return res.status(500).json({ error: 'cannot read file' });
    try {
      res.json(JSON.parse(data));
    } catch (e) {
      res.status(500).json({ error: 'bad JSON', raw: data });
    }
  });
});

// List movie folders
app.get('/api/movies', (req, res) => {
  const entries = fs.readdirSync(MEDIA_ROOT, { withFileTypes: true });

  const movies = entries
    .filter(e => e.isDirectory())
    .map(e => ({
      name: e.name,
      path: path.join(MEDIA_ROOT, e.name),
    }));

  res.json(movies);
});

app.post('/api/autocorrect', (req, res) => {
  const { target, syncinfo_path } = req.body;

  if (!target || !syncinfo_path) {
    return res.status(400).json({ error: 'target and syncinfo_path required' });
  }

  const py = spawn('python3', ['python/autocorrect.py', target, syncinfo_path]);

  let out = '';
  let errBuf = '';

  py.stdout.on('data', d => (out += d.toString()));
  py.stderr.on('data', d => (errBuf += d.toString()));

  py.on('close', code => {
    if (!out.trim()) {
      return res.status(500).json({
        status: 'error',
        error: 'no_output',
        detail: errBuf || `exit ${code}`,
      });
    }

    try {
      const data = JSON.parse(out);
      res.json(data);
    } catch (e) {
      res.status(500).json({
        status: 'error',
        error: 'bad_json',
        detail: String(e),
        raw: out,
        stderr: errBuf,
      });
    }
  });
});

function findVideoFile(folder) {
  const files = fs.readdirSync(folder);
  const video = files.find(f => f.match(/\.(mkv|mp4|avi|mov)$/i));
  return video ? path.join(folder, video) : null;
}

// -------------------------
// listsubs: return whisper + all .srt files
// -------------------------
app.get('/api/listsubs/:movie', async (req, res) => {
  const movieName = req.params.movie;
  const movieDir = path.join(MEDIA_ROOT, movieName);

  // Validate movie folder
  if (!fs.existsSync(movieDir) || !fs.statSync(movieDir).isDirectory()) {
    return res.json({ whisper: null, subs: [] });
  }

  // Whisper reference
  const whisperDir = path.join(WHISPER_ROOT, movieName);
  let whisperRef = null;

  if (fs.existsSync(whisperDir)) {
    const whisperSrt = path.join(whisperDir, 'ref.srt');
    if (fs.existsSync(whisperSrt)) {
      whisperRef = whisperSrt;
    }
  }

  // List subtitle files inside movie folder
  const files = fs.readdirSync(movieDir);
  const subs = [];

  for (const f of files) {
    if (!f.toLowerCase().endsWith('.srt')) continue;

    const fullPath = path.join(movieDir, f);

    // Extract language tag
    const lower = f.toLowerCase();

    let lang = 'unknown';
    if (lower.includes('.en.')) lang = 'en';
    if (lower.includes('.eng.')) lang = 'en';
    if (lower.includes('.fi.')) lang = 'fi';
    if (lower.includes('.fin.')) lang = 'fi';

    subs.push({
      lang,
      path: fullPath,
      file: f,
    });
  }

  res.json({
    whisper: whisperRef,
    subs,
  });
});

app.get('/api/db/stats', (req, res) => {
  try {
    const total = db
      .prepare(
        `
      SELECT COUNT(*) AS n FROM movies
    `
      )
      .get().n;

    const byDecision = db
      .prepare(
        `
      SELECT decision, COUNT(*) AS n
      FROM movies
      GROUP BY decision
    `
      )
      .all();

    const decisions = {};
    for (const r of byDecision) {
      decisions[r.decision || 'unknown'] = r.n;
    }

    const ignored = db
      .prepare(
        `
      SELECT COUNT(*) AS n FROM movies WHERE ignored = 1
    `
      )
      .get().n;

    const stats = {
      total,
      ignored,
      decisions,
    };

    for (const r of byDecision) {
      if (r.decision in stats.decisions) {
        stats.decisions[r.decision] = r.n;
      }
    }

    res.json({ ok: true, stats });
  } catch (err) {
    console.error('/api/db/stats failed:', err);
    res.json({ ok: false, error: err.toString() });
  }
});

app.listen(5010, '0.0.0.0', () => console.log('SyncOrbit API running on :5010'));
