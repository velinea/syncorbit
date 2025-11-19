import express from 'express'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import { exec } from 'child_process'

const app = express()
app.use(express.json())
app.use(express.static('public'))

app.post('/api/analyze', (req, res) => {
  const file = req.body.path
  if (!file) return res.status(400).json({ error: 'no file' })

  const py = spawn('python3', ['python/analyze.py', file])
  let out = '',
    err = ''

  py.stdout.on('data', (d) => (out += d.toString()))
  py.stderr.on('data', (d) => (err += d.toString()))
  py.on('close', (code) => {
    if (code === 0) {
      try {
        res.json(JSON.parse(out))
      } catch (e) {
        res.status(500).json({ error: 'bad json', detail: e.toString() })
      }
    } else {
      res.status(500).json({ error: 'python failed', detail: err })
    }
  })
})

app.post('/api/compare', (req, res) => {
  const { base, ref } = req.body
  if (!base || !ref) return res.status(400).json({ error: 'missing paths' })

  const py = spawn('python3', ['python/analyze_pair.py', base, ref])
  let out = '',
    err = ''
  py.stdout.on('data', (d) => (out += d.toString()))
  py.stderr.on('data', (d) => (err += d.toString()))
  py.on('close', (code) => {
    if (code === 0) {
      try {
        res.json(JSON.parse(out))
      } catch (e) {
        res.status(500).json({ error: 'bad json', detail: e.toString() })
      }
    } else {
      res.status(500).json({ error: err || `python exit ${code}` })
    }
  })
})

app.post('/api/align', (req, res) => {
  const { reference, target } = req.body
  if (!reference || !target) {
    return res
      .status(400)
      .json({ error: 'reference and target paths required' })
  }

  const py = spawn('python3', ['python/align.py', reference, target])

  let out = ''
  let errBuf = ''

  py.stdout.on('data', (d) => (out += d.toString()))
  py.stderr.on('data', (d) => (errBuf += d.toString()))

  py.on('close', (code) => {
    if (code === 0) {
      try {
        const data = JSON.parse(out)
        res.json(data)
      } catch (e) {
        res.status(500).json({
          error: 'bad JSON from align.py',
          detail: String(e),
          raw: out,
        })
      }
    } else {
      res
        .status(500)
        .json({ error: 'align.py failed', detail: errBuf || `exit ${code}` })
    }
  })
})

app.get('/api/searchsubs', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase()
  if (q.length < 2) return res.json([])

  const roots = ['/mnt/media/Media/Movies', './subs']

  // Only look for .srt – much faster, and that’s what you actually use
  const cmd = roots.map((r) => `find '${r}' -type f -iname '*.srt'`).join(' ; ')

  exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
    if (err) {
      console.error('searchsubs find error:', err)
      return res.json([])
    }

    const all = stdout
      .split('\n')
      .filter(Boolean)
      .filter((p) => p.toLowerCase().includes(q))

    // De-duplicate paths
    const files = [...new Set(all)]

    const groups = {}

    for (const p of files) {
      const name = p.split('/').pop() // filename

      // Strip language suffix and extension -> base movie name
      const base = name
        .replace(/\.(en|eng|fi|fin)\.srt$/i, '')
        .replace(/\.srt$/i, '')

      // Detect language
      let lang = 'unknown'
      if (/\.(en|eng)\.srt$/i.test(name)) lang = 'en'
      else if (/\.(fi|fin)\.srt$/i.test(name)) lang = 'fi'

      if (!groups[base]) {
        groups[base] = { base, en: null, fi: null, others: [] }
      }

      if (lang === 'en') groups[base].en = p
      else if (lang === 'fi') groups[base].fi = p
      else groups[base].others.push(p)
    }

    const result = Object.values(groups)
      .sort((a, b) => a.base.localeCompare(b.base))
      .slice(0, 80)

    res.json(result)
  })
})

app.get('/api/library', (req, res) => {
  const CSV = path.join(
    process.cwd(),
    'python',
    'syncorbit_library_summary.csv'
  )

  if (!fs.existsSync(CSV)) {
    return res.json({ error: 'no_summary_file' })
  }

  try {
    const raw = fs.readFileSync(CSV, 'utf8').trim().split('\n').filter(Boolean)

    const rows = raw.map((line) => {
      const parts = line.split(',')
      return {
        movie: parts[0],
        anchor_count: Number(parts[1]),
        avg_offset: Number(parts[2]),
        drift_span: Number(parts[3]),
        decision: parts[4] || 'unknown',
      }
    })
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: 'csv_read_failed', detail: String(e) })
  }
})

app.listen(5010, '0.0.0.0', () => console.log('SyncOrbit API running on :5010'))
