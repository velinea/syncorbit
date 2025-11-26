import express from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';

const app = express();
const ROOT = '/app/media';

app.use(express.json());
app.use(express.static('public'));

app.post('/api/analyze', (req, res) => {
  const file = req.body.path;
  if (!file) return res.status(400).json({ error: 'no file' });

  const py = spawn('python3', ['python/analyze.py', file]);
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

  const py = spawn('python3', ['python/analyze_pair.py', base, ref]);
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

  const py = spawn('python3', ['python/align.py', reference, target]);

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

  const cmd = `find ${ROOT} -type f -iname '*.srt' -print`;

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
  const py = spawn('python3', ['python/batch_scan.py'], {
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
  const CSV = path.join(process.cwd(), 'python', 'syncorbit_library_summary.csv');
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

  if (!fs.existsSync(CSV)) {
    return res.json({ error: 'no_summary_file' });
  }

  try {
    const raw = fs.readFileSync(CSV, 'utf8').trim().split('\n').filter(Boolean);

    const rows = raw.map(line => {
      const parts = parseCSVLine(line);
      const movie = parts[0].replace(/^"|"$/g, '');
      return {
        movie: parts[0].trim(),
        anchor_count: Number(parts[1]),
        avg_offset: Number(parts[2]),
        drift_span: Number(parts[3]),
        decision: (parts[4] || 'unknown').trim().toLowerCase(),
        syncinfo_path: fs.existsSync(path.join(ROOT, parts[0], 'analysis.syncinfo'))
          ? path.join(ROOT, parts[0], 'analysis.syncinfo')
          : null,
      };
    });

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'csv_read_failed', detail: String(e) });
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
  const entries = fs.readdirSync(ROOT, { withFileTypes: true });

  const movies = entries
    .filter(e => e.isDirectory())
    .map(e => ({
      name: e.name,
      path: path.join(ROOT, e.name),
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

app.post('/api/extract-audio', (req, res) => {
  const { moviePath } = req.body;
  const video = findVideoFile(moviePath);
  if (!video) return res.status(400).json({ error: 'no_video' });

  const audioOut = path.join(moviePath, 'audio.wav');

  const cmd = `ffmpeg -y -i "${video}" -vn -ac 1 -ar 16000 "${audioOut}"`;
  exec(cmd, err => {
    if (err) return res.json({ error: 'ffmpeg_error', detail: err.toString() });
    res.json({ status: 'ok', audio: audioOut });
  });
});

app.post('/api/whisper', (req, res) => {
  const { audio } = req.body;

  const py = spawn('python3', ['python/run_whisper.py', audio]);
  let out = '';
  py.stdout.on('data', d => (out += d.toString()));

  py.on('close', () => {
    try {
      res.json(JSON.parse(out));
    } catch (e) {
      res.json({ error: 'whisper_failed', raw: out });
    }
  });
});

app.listen(5010, '0.0.0.0', () => console.log('SyncOrbit API running on :5010'));
