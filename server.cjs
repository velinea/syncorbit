// server.cjs (CommonJS mode)
// All require() calls now legal and ExecJS-compatible

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { exec } = require('child_process');

const app = express();
const PY = '/app/.venv/bin/python3';
const MEDIA_ROOT = '/app/media';
const DATA_ROOT = '/app/data';
const WHISPER_ROOT = path.join(DATA_ROOT, 'ref');
const IGNORE_FILE = path.join(
  process.env.SYNCORBIT_DATA || '/app/data',
  'ignore_list.json'
);
// Ensure PATH & EXECJS runtime preference are correct for ffsubsync + PyExecJS
process.env.EXECJS_RUNTIME = 'Node';
// Force system node (CJS) to appear first in PATH
process.env.PATH = '/usr/bin:/usr/local/bin:/app/.venv/bin:' + process.env.PATH;

console.log('Using PATH:', process.env.PATH);
console.log('EXECJS_RUNTIME:', process.env.EXECJS_RUNTIME);

app.use(express.json());
app.use(express.static('public'));

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

app.post('/api/bulk/touch', express.json(), (req, res) => {
  const movies = req.body.movies;
  if (!Array.isArray(movies)) return res.json({ error: 'Invalid request' });

  const results = [];

  movies.forEach(movie => {
    try {
      const movieDir = path.join(MEDIA_ROOT, movie);

      if (!fs.existsSync(movieDir)) {
        results.push({ movie, error: 'Movie folder not found' });
        return;
      }

      // Write harmless metadata to /app/data/touch/<movie>.touch
      const touchPath = path.join(DATA_ROOT, 'touch', `${movie}.touch`);
      fs.mkdirSync(path.dirname(touchPath), { recursive: true });
      fs.writeFileSync(touchPath, Date.now().toString());

      results.push({ movie, ok: true });
    } catch (e) {
      results.push({ movie, error: e.message });
    }
  });

  res.json({ ok: true, results });
});

app.post('/api/bulk/delete_ref', express.json(), (req, res) => {
  const movies = req.body.movies;
  if (!Array.isArray(movies)) return res.json({ error: 'Invalid request' });

  const results = [];

  movies.forEach(movie => {
    try {
      const refFile = path.join(DATA_ROOT, 'ref', movie, 'ref.srt');

      if (fs.existsSync(refFile)) {
        fs.unlinkSync(refFile);
        results.push({ movie, ok: true });
      } else {
        results.push({ movie, skipped: 'no ref.srt' });
      }
    } catch (e) {
      results.push({ movie, error: e.message });
    }
  });

  res.json({ ok: true, results });
});

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

app.get('/api/library', (req, res) => {
  const dataDir = process.env.SYNCORBIT_DATA || '/app/data';
  const csvPath = path.join(dataDir, 'syncorbit_library_summary.csv');

  if (!fs.existsSync(csvPath)) {
    return res.json({ error: 'no_summary_file' });
  }

  const analysisDir = path.join(dataDir, 'analysis');
  const refDir = path.join(dataDir, 'ref');
  const resyncDir = path.join(dataDir, 'resync');

  function parseCSVLine(line) {
    const result = [];
    let current = '';
    let insideQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        insideQuotes = !insideQuotes;
        continue;
      }
      if (c === ',' && !insideQuotes) {
        result.push(current);
        current = '';
        continue;
      }
      current += c;
    }
    result.push(current);
    return result;
  }

  const rows = raw
    .map(line => {
      const parts = parseCSVLine(line);
      const movie = (parts[0] || '').replace(/^"|"$/g, '').trim();
      if (!movie || movie.toLowerCase() === 'movie') return null;

      const anchor_count = Number(parts[1]);
      const avg_offset = Number(parts[2]);
      const drift_span = Number(parts[3]);
      const decision = (parts[4] || 'unknown').trim().toLowerCase();

      const syncinfoPath = path.join(analysisDir, movie, 'analysis.syncinfo');
      const whisperRefPath = path.join(refDir, movie, 'ref.srt');
      const ffsubsyncPath = path.join(resyncDir, movie);

      // --- NEW: read best_reference + reference_path from analysis.syncinfo ---
      let best_reference = null;
      let reference_path = null;

      try {
        if (fs.existsSync(syncinfoPath)) {
          const info = JSON.parse(fs.readFileSync(syncinfoPath, 'utf8'));
          best_reference = info.best_reference || null;
          reference_path = info.reference_path || null;
        }
      } catch (e) {
        console.error(`Failed to read syncinfo for ${movie}:`, e);
      }

      return {
        movie,
        anchor_count,
        avg_offset,
        drift_span,
        decision,

        // existing fields
        syncinfo_path: fs.existsSync(syncinfoPath) ? syncinfoPath : null,
        whisper_ref: fs.existsSync(whisperRefPath),
        whisper_ref_path: fs.existsSync(whisperRefPath) ? whisperRefPath : null,
        ffsubsyncPath: fs.existsSync(ffsubsyncPath) ? ffsubsyncPath : null,

        // --- NEW fields used by UI badges ---
        best_reference,
        reference_path,
      };
    })
    .filter(Boolean);
  res.json({ rows });
});

app.get('/api/analysis/:movie', (req, res) => {
  const movie = req.params.movie;
  const dataDir = process.env.SYNCORBIT_DATA || '/app/data';
  const syncinfoPath = path.join(dataDir, 'analysis', movie, 'analysis.syncinfo');

  if (!fs.existsSync(syncinfoPath)) {
    return res.status(404).json({ error: 'syncinfo_not_found', movie });
  }

  try {
    const json = fs.readFileSync(syncinfoPath, 'utf8');
    res.json(JSON.parse(json));
  } catch (e) {
    res.status(500).json({ error: 'bad_json', detail: String(e) });
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

app.listen(5010, '0.0.0.0', () => console.log('SyncOrbit API running on :5010'));
