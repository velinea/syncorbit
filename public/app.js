import { drawGraph } from './graph.js';

// -------- DOM ELEMENTS --------

// Manual align elements
const searchBox = document.getElementById('searchBox');
const resultsDiv = document.getElementById('results');
const refPathInput = document.getElementById('refPath');
const targetPathInput = document.getElementById('targetPath');
const alignBtn = document.getElementById('alignBtn');
const manualSummaryPre = document.getElementById('manualSummary');
const manualCanvas = document.getElementById('graphCanvas');
const refSelect = document.getElementById('refSelect');
const targetSelect = document.getElementById('targetSelect');

// Library elements
const loadLibraryBtn = document.getElementById('loadLibraryBtn');
const libraryTableBody = document.getElementById('libraryTable').querySelector('tbody');
const libNote = document.getElementById('libNote');
const librarySearchInput = document.getElementById('librarySearch');
const libraryStatusSelect = document.getElementById('libraryStatus');
const libraryLimitSelect = document.getElementById('libraryLimit');
const librarySummaryPre = document.getElementById('librarySummary');
const libraryCanvas = document.getElementById('libraryGraph');
const autoCorrectBtn = document.getElementById('autoCorrectBtn');
const autoCorrectResult = document.getElementById('autoCorrectResult');
const downloadBtn = document.getElementById('downloadBtn');
const bulkBtn = document.getElementById('bulkActionsBtn');
const tvBulkBtn = document.getElementById('tvBulkActionsBtn');
const bulkBtns = [bulkBtn, tvBulkBtn].filter(Boolean);
const bulkResultBox = document.getElementById('bulkResultBox');
const bulkResultPre = document.getElementById('bulkResultPre');
const bulkModal = document.getElementById('bulkModal');

// TV library elements
const tvTableBody = document.getElementById('tvTable').querySelector('tbody');
const tvNote = document.getElementById('tvNote');
const tvSearchInput = document.getElementById('tvSearch');
const tvStatusSelect = document.getElementById('tvStatus');
const tvLimitSelect = document.getElementById('tvLimit');
const tvSummaryPre = document.getElementById('tvSummary');
const tvCanvas = document.getElementById('tvGraph');
const tvAutoCorrectBtn = document.getElementById('tvAutoCorrectBtn');
const tvAutoCorrectResult = document.getElementById('tvAutoCorrectResult');
const tvPosterPreview = document.getElementById('tvPosterPreview');
const tvRunBatchScanBtn = document.getElementById('tvRunBatchScanBtn');
const tvLoadBtn = document.getElementById('tvLoadBtn');

// Tabs
const tabButtons = document.querySelectorAll('#tabs button');
const tabViews = document.querySelectorAll('.tab');

// State
let searchTimer = null;
let libraryRows = [];
let librarySortKey = 'fi_mtime';
let librarySortDir = 'desc';
let currentLibraryAnalysis = null;
let currentBulkSelection = [];
let currentBulkKind = 'movie';

// TV state
let tvRows = [];
let tvSortKey = 'title';
let tvSortDir = 'asc';
let currentTvAnalysis = null;
let tvLoaded = false;

// -------- TAB SWITCHING --------

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    // buttons
    tabButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // views
    const target = btn.dataset.tab;
    tabViews.forEach(v => v.classList.remove('active'));
    document.getElementById(`tab-${target}`).classList.add('active');

    // Lazy-load library on first show
    if (target === 'library' && libraryRows.length === 0) {
      loadLibrary();
      loadLibraryStats();
    }
    if (target === 'tv' && !tvLoaded) {
      tvLoaded = true;
      loadTv();
      loadTvStats();
    }
  });
});

// -------- GENERIC HELPERS --------

function showSpinner() {
  document.getElementById('globalSpinner').style.display = 'flex';
}

function hideSpinner() {
  document.getElementById('globalSpinner').style.display = 'none';
}

function disableBulkUI() {
  document.getElementById('bulkRunBtn').disabled = true;
  for (const btn of bulkBtns) btn.disabled = true;
}

function enableBulkUI() {
  document.getElementById('bulkRunBtn').disabled = false;
  for (const btn of bulkBtns) btn.disabled = false;
}

function clearCanvas(c) {
  if (!c) return;
  const ctx = c.getContext('2d');
  const W = (c.width = c.clientWidth || 600);
  const H = (c.height = c.clientHeight || 220);
  ctx.fillStyle = '#020617';
  ctx.fillRect(0, 0, W, H);
}

// Manual & library clears
function clearManualGraph() {
  clearCanvas(manualCanvas);
}

function clearLibraryGraph() {
  clearCanvas(libraryCanvas);
}

function clearTvGraph() {
  clearCanvas(tvCanvas);
}

function safe(v) {
  if (typeof v !== 'number' || isNaN(v)) return '–';

  const abs = Math.abs(v);

  // >= 1000 → integer, no decimals
  if (abs >= 1000) {
    return Math.round(v).toString();
  }

  // Determine decimals needed to reach 3 digits
  if (abs >= 100) {
    return v.toFixed(0); // 123
  }
  if (abs >= 10) {
    return v.toFixed(1); // 64.0
  }
  return v.toFixed(2); // 9.00, 0.10, 0.00
}

function shortTitle(t) {
  return t.length > 30 ? t.slice(0, 27) + '…' : t;
}

function shortStatus(s) {
  if (s === 'synced') return '<div id="status-synced"></div>';
  if (s === 'needs_adjustment') return '<div id="status-adjust"></div>';
  return '<div id="status-bad"></div>';
}

// Render summary into a target <pre>
function renderSummary(d, targetEl = manualSummaryPre) {
  const anchors = d.anchor_count ?? 0;
  const avg = Number(d.avg_offset_sec ?? d.avg_offset ?? 0);
  const span = Number(d.drift_span_sec ?? d.drift_span ?? 0);
  const min = Number(d.min_offset_sec ?? d.min_offset ?? 0);
  const max = Number(d.max_offset_sec ?? d.max_offset ?? 0);
  const decision = d.decision ?? 'unknown';

  const refCount = d.ref_count ?? '-';
  const anchorRatio =
    typeof d.anchor_ratio === 'number'
      ? d.anchor_ratio
      : refCount !== '-' && refCount > 0
        ? anchors / refCount
        : 0;

  const residual =
    d.residual_span != null
      ? Number(d.residual_span).toFixed(3)
      : d.residual_drift_span_sec != null
        ? Number(d.residual_drift_span_sec).toFixed(3)
        : d.raw && d.raw.residual_drift_span_sec != null
          ? Number(d.raw.residual_drift_span_sec).toFixed(3)
          : '-';

  const robust =
    d.robust_span != null
      ? Number(d.robust_span).toFixed(3)
      : d.robust_drift_span_sec != null
        ? Number(d.robust_drift_span_sec).toFixed(3)
        : d.raw && d.raw.robust_drift_span_sec != null
          ? Number(d.raw.robust_drift_span_sec).toFixed(3)
          : '-';

  const rawSpan =
    d.raw_span != null
      ? Number(d.raw_span).toFixed(3)
      : d.raw_drift_span_sec != null
        ? Number(d.raw_drift_span_sec).toFixed(3)
        : d.raw && d.raw.raw_drift_span_sec != null
          ? Number(d.raw.raw_drift_span_sec).toFixed(3)
          : '-';

  const driftPerHr =
    d.linear_drift_per_hour != null
      ? Number(d.linear_drift_per_hour).toFixed(4)
      : d.raw && d.raw.linear_drift_per_hour != null
        ? Number(d.raw.linear_drift_per_hour).toFixed(4)
        : '-';

  const r2 =
    d.linear_fit_r2 != null
      ? Number(d.linear_fit_r2).toFixed(4)
      : d.raw && d.raw.linear_fit_r2 != null
        ? Number(d.raw.linear_fit_r2).toFixed(4)
        : '-';

  const reason = d.reason || '';

  // Contextual hint for unresolvable pairs (accepts legacy value too)
  let hint = '';
  if (decision === 'unresolvable' || decision === 'whisper_required') {
    hint =
      d.best_reference === 'whisper' || d.has_whisper
        ? '\nHint: even a Whisper reference did not align —\nthe FI subtitle likely needs replacing or re-timing.'
        : '\nHint: the current reference cannot be aligned.\nA WhisperX re-reference may help — or the FI\nsubtitle needs attention.';
  }

  targetEl.textContent =
    `Ref:        ${d.reference_path || d.ref_path || ''}\n` +
    `Target:     ${d.target_path || d.target || ''}\n\n` +
    `Ref lines:  ${refCount}\n` +
    `Tgt lines:  ${d.target_count ?? '-'}\n` +
    `Anchors:    ${anchors}  (${(anchorRatio * 100).toFixed(2)}% of ref)\n` +
    `Avg offset: ${avg.toFixed(3)} s\n` +
    `Min / Max:  ${min.toFixed(3)} s  /  ${max.toFixed(3)} s\n` +
    `Drift span: ${span.toFixed(3)} s   (binned)\n` +
    `Residual:   ${residual} s   (after linear fit)\n` +
    `Robust:     ${robust} s   (4×MAD)\n` +
    `Raw span:   ${rawSpan} s   (min–max)\n` +
    `Linear:     ${driftPerHr} s/h   r²=${r2}\n` +
    `Decision:   ${decision}\n` +
    (reason ? `Why:        ${reason}` : '') +
    hint;
}

function setSummaryBackdrop(el, movieName) {
  el.style.backgroundImage = `linear-gradient(rgba(2,6,23,.7), rgba(2,6,23,.9)),
     url("/api/artwork/${encodeURIComponent(movieName)}")`;
}

function daysAgoFromUnix(ts) {
  if (!ts) return null;
  const nowSec = Date.now() / 1000;
  const days = Math.floor((nowSec - ts) / 86400);
  return days < 0 ? 0 : days;
}

function formatDaysAgo(ts) {
  const days = daysAgoFromUnix(ts);
  if (days == null) return '—';
  if (days === 0) return 'today';
  return `${days}d`;
}

// -------- BATCH PROGRESS POLLING --------
async function pollBatchProgress() {
  try {
    const res = await fetch('/api/batch_progress');
    const p = await res.json();

    const movieStatus = document.getElementById('batchStatus');
    const tvStatus = document.getElementById('tvBatchStatus');

    if (p.running) {
      const label = p.kind === 'tv' ? 'episodes' : 'folders';
      const msg = `Scanning ${label} ${p.index}/${p.total}: ${p.current_movie}`;
      if (p.kind === 'tv') {
        if (tvStatus) tvStatus.textContent = msg;
        if (movieStatus) movieStatus.textContent = 'Idle';
      } else {
        if (movieStatus) movieStatus.textContent = msg;
        if (tvStatus) tvStatus.textContent = 'Idle';
      }
    } else {
      if (movieStatus) movieStatus.textContent = 'Idle';
      if (tvStatus) tvStatus.textContent = 'Idle';
    }
  } catch {
    // polling is best-effort
  }
}

setInterval(pollBatchProgress, 1000);

// -------- MANUAL SEARCH --------

if (searchBox) {
  searchBox.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = searchBox.value.trim();
    if (q.length < 2) {
      resultsDiv.innerHTML = '';
      return;
    }
    searchTimer = setTimeout(() => runSearch(q), 250);
  });
}

const searchInput = document.getElementById('librarySearch');
const clearBtn = document.getElementById('clearSearch');

searchInput.addEventListener('input', () => {
  clearBtn.style.display = searchInput.value ? 'block' : 'none';
  renderLibraryTable();
});

clearBtn.addEventListener('click', () => {
  searchInput.value = '';
  clearBtn.style.display = 'none';
  renderLibraryTable();
});

async function runSearch(q) {
  resultsDiv.innerHTML = 'Searching…';
  try {
    const res = await fetch(`/api/searchsubs?q=${encodeURIComponent(q)}`);
    const groups = await res.json();

    if (!Array.isArray(groups) || groups.length === 0) {
      resultsDiv.innerHTML = 'No matches.';
      return;
    }

    resultsDiv.innerHTML = '';
    groups.forEach(g => {
      const div = document.createElement('div');
      div.className = 'result-item';
      div.textContent = g.base;

      div.onclick = async () => {
        manualSummaryPre.textContent = `Selected: ${g.base}`;
        clearManualGraph();

        // Determine real movie folder name from any subtitle path
        const subPath = g.en || g.fi || (g.others && g.others[0]);
        if (!subPath) {
          console.error('No subtitle paths found for result:', g);
          return;
        }

        // Extract actual folder name
        const parts = subPath.split('/');
        const movieFolder = parts[parts.length - 2];
        console.log('Using folder:', movieFolder);

        // Set backdrop
        setSummaryBackdrop(manualSummaryPre, movieFolder);

        // Load choices for this actual folder
        const data = await loadSubtitleChoices(movieFolder);

        // Auto-select Whisper > EN > FI
        if (data.whisper) {
          refSelect.value = data.whisper;
        } else {
          const en = data.subs.find(s => s.lang === 'en');
          if (en) refSelect.value = en.path;
        }

        const fi = data.subs.find(s => s.lang === 'fi');
        if (fi) targetSelect.value = fi.path;

        alignBtn.disabled = !(refSelect.value && targetSelect.value);
      };
      resultsDiv.appendChild(div);
    });
  } catch (e) {
    console.error('search error', e);
    resultsDiv.innerHTML = 'Error during search.';
  }
}

// -------- MANUAL ALIGN --------

if (alignBtn) {
  alignBtn.addEventListener('click', async () => {
    const refSel = document.getElementById('refSelect');
    const tgtSel = document.getElementById('targetSelect');

    if (!refSel || !tgtSel) {
      manualSummaryPre.textContent = 'Missing dropdowns (refSelect/targetSelect)';
      return;
    }

    const reference = refSel.value.trim();
    const target = tgtSel.value.trim();

    if (!reference || !target) {
      manualSummaryPre.textContent = 'Please pick both reference and target subtitles.';
      return;
    }

    manualSummaryPre.textContent = 'Aligning…';
    showSpinner();

    try {
      const res = await fetch('/api/align', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference, target }),
      });

      const data = await res.json();
      hideSpinner();
      if (data.error) {
        manualSummaryPre.textContent = `Error: ${data.error}\n${data.detail || ''}`;
        clearManualGraph();
        return;
      }

      renderSummary(data, manualSummaryPre);
      // drawGraph(manualCanvas, data.offsets || []);
      // Use clean_offsets if available
      const baseOffsets =
        data.clean_offsets && data.clean_offsets.length
          ? data.clean_offsets
          : data.offsets || [];

      drawGraph(manualCanvas, baseOffsets, data.drift_bins || []);
    } catch (e) {
      manualSummaryPre.textContent = 'Align failed: ' + e.message;
      clearManualGraph();
    }
  });
}

// Load subtitle choices for a movie
async function loadSubtitleChoices(movieName) {
  const res = await fetch(`/api/listsubs/${encodeURIComponent(movieName)}`);
  const data = await res.json();

  refSelect.innerHTML = '';
  targetSelect.innerHTML = '';

  data.subs.forEach(s => {
    const label = `[${s.kind}] ${s.file}`;
    refSelect.innerHTML += `<option value="${s.path}">${label}</option>`;
    targetSelect.innerHTML += `<option value="${s.path}">${label}</option>`;
  });

  refSelect.onchange = targetSelect.onchange = () => {
    alignBtn.disabled = !(refSelect.value && targetSelect.value);
  };

  return data;
}

// -------- LIBRARY VIEW --------

if (loadLibraryBtn) {
  loadLibraryBtn.addEventListener('click', loadLibrary);
}

async function loadLibrary() {
  libraryTableBody.innerHTML = "<tr><td colspan='5'>Loading…</td></tr>";

  try {
    const res = await fetch('/api/library');
    const json = await res.json();

    if (!json.ok || !Array.isArray(json.rows)) {
      libraryRows = [];
      libraryTableBody.innerHTML = "<tr><td colspan='8'>Unexpected response.</td></tr>";
      return;
    }

    libraryRows = json.rows;
    renderLibraryTable(libraryRows);

    libNote.textContent =
      'Tip: use search / filters, then click any movie row to see its analysis.';
  } catch (e) {
    console.error('library error', e);
    libraryRows = [];
    libraryTableBody.innerHTML = "<tr><td colspan='5'>Error loading summary.</td></tr>";
  }
}

if (autoCorrectBtn) {
  autoCorrectBtn.addEventListener('click', onAutoCorrectClick);
}

async function loadTv() {
  tvTableBody.innerHTML = "<tr><td colspan='5'>Loading…</td></tr>";

  try {
    const res = await fetch('/api/library/tv');
    const json = await res.json();

    if (!json.ok || !Array.isArray(json.rows)) {
      tvRows = [];
      tvTableBody.innerHTML = "<tr><td colspan='8'>Unexpected response.</td></tr>";
      return;
    }

    tvRows = json.rows;
    renderTvTable();

    tvNote.textContent =
      'Tip: use search / filters, then click any episode row to see its analysis.';
  } catch (e) {
    console.error('tv library error', e);
    tvRows = [];
    tvTableBody.innerHTML = "<tr><td colspan='5'>Error loading summary.</td></tr>";
  }
}

if (tvAutoCorrectBtn) {
  tvAutoCorrectBtn.addEventListener('click', () => onAutoCorrectClick('tv'));
}

async function onAutoCorrectClick(kind = 'movie') {
  const isTv = kind === 'tv';
  const resultEl = isTv ? tvAutoCorrectResult : autoCorrectResult;
  const btn = isTv ? tvAutoCorrectBtn : autoCorrectBtn;
  const methodSel = isTv ? 'tvAutoCorrectMethod' : 'autoCorrectMethod';
  const analysis = isTv ? currentTvAnalysis : currentLibraryAnalysis;

  if (!analysis) {
    resultEl.textContent = 'Select an episode with analysis first.';
    return;
  }

  const target = analysis.target_path;
  const syncinfoPath = analysis.syncinfo_path;
  if (!target || !syncinfoPath) {
    resultEl.textContent =
      'Missing target_path or syncinfo_path, cannot auto-correct.';
    return;
  }

  btn.disabled = true;
  resultEl.textContent = 'Running auto-correction…';
  showSpinner();

  const method = document.getElementById(methodSel)?.value || 'auto';

  try {
    const res = await fetch('/api/autocorrect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, syncinfo_path: syncinfoPath, method }),
    });

    const data = await res.json();

    if (data.status === 'ok') {
      const m = data.method;
      const outfile = data.output_file;
      const verdict = data.verdict || 'review';
      const meta = data.meta || {};
      let detail = '';

      if (m === 'global_offset') {
        detail = `Global shift: ${meta.shift_sec?.toFixed?.(3)} s`;
      } else if (m === 'stretch_offset') {
        const stretchPct = ((meta.stretch - 1) * 100).toFixed(3);
        detail = `Stretch: ${stretchPct}%  Shift: ${meta.shift_sec?.toFixed?.(3)} s`;
      }

      resultEl.textContent = `Auto-corrected (${m}). Output: ${outfile}\n${detail}`;
      const downloadFilename = outfile.substring(outfile.lastIndexOf('/') + 1);
      const url =
        '/api/autocorrect/download?filename=' + encodeURIComponent(downloadFilename);

      const e = data;

      resultEl.innerHTML = `
        <b>Auto-correct evaluation</b>
        <pre>
        Method:        ${e.method}
        Segments:      ${e.segments.count}

        Drift span:    ${e.before.drift_span_sec.toFixed(
          2
        )} s → ${e.after.drift_span_sec.toFixed(2)} s
        Avg offset:   ${e.before.avg_offset_sec.toFixed(
          2
        )} s → ${e.after.avg_offset_sec.toFixed(2)} s
        Anchors:      ${e.before.anchor_count} → ${e.after.anchor_count}

        Shift range:  ${e.shifts.min_sec.toFixed(2)} s … ${e.shifts.max_sec.toFixed(
          2
        )} s
        Median shift: ${e.shifts.median_sec.toFixed(2)} s

        Verdict:      ${e.verdict.toUpperCase()}
        ${e.notes.length ? 'Notes:\n - ' + e.notes.join('\n - ') : ''}
        </pre>
        <div>
          <a class="button" href="/api/autocorrect/download?filename=${encodeURIComponent(
            outfile
          )}">
            Download corrected subtitle
          </a>
        </div>
        <details style="margin-top:6px">
          <summary>Logs</summary>
          <pre style="white-space:pre-wrap">${(e.log || '').replaceAll(
            '<',
            '&lt;'
          )}</pre>
        </details>
      `;
    } else if (data.status === 'unresolvable' || data.status === 'whisper_required') {
      resultEl.textContent =
        'Cannot auto-correct safely. The subtitle pair is unresolvable with the current reference.';
    } else {
      resultEl.textContent = `Auto-correct failed: ${data.error || data.status}`;
    }
  } catch (e) {
    console.error('autocorrect error', e);
    resultEl.textContent = 'Auto-correct failed: ' + e.message;
  } finally {
    btn.disabled = false;
    hideSpinner();
  }
}

// Filters
if (librarySearchInput) {
  librarySearchInput.addEventListener('input', renderLibraryTable);
}
if (libraryStatusSelect) {
  libraryStatusSelect.addEventListener('change', renderLibraryTable);
}
if (libraryLimitSelect) {
  libraryLimitSelect.addEventListener('change', renderLibraryTable);
}

// Sorting via header click
document.querySelectorAll('#libraryTable thead th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (librarySortKey === key) {
      librarySortDir = librarySortDir === 'asc' ? 'desc' : 'asc';
    } else {
      librarySortKey = key;
      librarySortDir = 'asc';
    }
    renderLibraryTable();
  });
});

// TV filters
if (tvSearchInput) tvSearchInput.addEventListener('input', renderTvTable);
if (tvStatusSelect) tvStatusSelect.addEventListener('change', renderTvTable);
if (tvLimitSelect) tvLimitSelect.addEventListener('change', renderTvTable);

// TV sorting via header click
document.querySelectorAll('#tvTable thead th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (tvSortKey === key) {
      tvSortDir = tvSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      tvSortKey = key;
      tvSortDir = 'asc';
    }
    renderTvTable();
  });
});

if (tvRunBatchScanBtn) {
  tvRunBatchScanBtn.addEventListener('click', async () => {
    tvRunBatchScanBtn.disabled = true;
    tvRunBatchScanBtn.textContent = 'Scanning…';
    try {
      const res = await fetch('/api/run-tv-scan', { method: 'POST' });
      const data = await res.json();
      if (data.status === 'ok') {
        tvNote.textContent = 'Scan complete. Reloading…';
        await loadTv();
        loadTvStats();
      } else {
        tvNote.textContent = 'Scan failed: ' + data.detail;
      }
    } catch (err) {
      tvNote.textContent = 'Error: ' + err.message;
    }
    tvRunBatchScanBtn.textContent = 'Scan TV Shows';
    tvRunBatchScanBtn.disabled = false;
  });
}

if (tvLoadBtn) {
  tvLoadBtn.addEventListener('click', () => {
    loadTv();
    loadTvStats();
  });
}

// TV search clear
const tvClearSearch = document.getElementById('tvClearSearch');
if (tvClearSearch) {
  tvSearchInput.addEventListener('input', () => {
    tvClearSearch.style.display = tvSearchInput.value ? 'block' : 'none';
    renderTvTable();
  });
  tvClearSearch.addEventListener('click', () => {
    tvSearchInput.value = '';
    tvClearSearch.style.display = 'none';
    renderTvTable();
  });
}

const runBatchScanBtn = document.getElementById('runBatchScanBtn');

runBatchScanBtn.addEventListener('click', async () => {
  runBatchScanBtn.disabled = true;
  runBatchScanBtn.textContent = 'Scanning…';

  try {
    const res = await fetch('/api/run-batch-scan', { method: 'POST' });
    const data = await res.json();

    if (data.status === 'ok') {
      libNote.textContent = 'Scan complete. Reloading library…';
      await loadLibrary();
    } else {
      libNote.textContent = 'Scan failed: ' + data.detail;
    }
  } catch (err) {
    libNote.textContent = 'Error: ' + err.message;
  }

  runBatchScanBtn.textContent = 'Scan Library';
  runBatchScanBtn.disabled = false;
});

function renderLibraryTable() {
  renderTable(libraryRows, {
    kind: 'movie',
    body: libraryTableBody,
    note: libNote,
    search: librarySearchInput,
    status: libraryStatusSelect,
    limit: libraryLimitSelect,
    getSortKey: () => librarySortKey,
    getSortDir: () => librarySortDir,
    previewEl: posterPreview,
    label: 'movie',
    openAnalysis: openLibraryAnalysis,
  });
}

function renderTvTable() {
  renderTable(tvRows, {
    kind: 'tv',
    body: tvTableBody,
    note: tvNote,
    search: tvSearchInput,
    status: tvStatusSelect,
    limit: tvLimitSelect,
    getSortKey: () => tvSortKey,
    getSortDir: () => tvSortDir,
    previewEl: tvPosterPreview,
    label: 'episode',
    openAnalysis: openTvAnalysis,
  });
}

function renderTable(rows, ctx) {
  if (!ctx.body) return;
  const { body, previewEl } = ctx;

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan='5'>No rows loaded. Click “Load summary”.</td></tr>`;
    return;
  }

  const searchTerm = ctx.search.value.trim().toLowerCase();
  const statusFilter = ctx.status.value;
  const limit = parseInt(ctx.limit.value, 10) || 100;

  let filtered = rows.filter(r => {
    const hay = (r.title || r.movie || '').toLowerCase();
    if (searchTerm && !hay.includes(searchTerm)) return false;
    if (statusFilter && r.decision !== statusFilter) return false;
    return true;
  });

  filtered.sort((a, b) => {
    let av = a[ctx.getSortKey()];
    let bv = b[ctx.getSortKey()];
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return ctx.getSortDir() === 'asc' ? -1 : 1;
    if (av > bv) return ctx.getSortDir() === 'asc' ? 1 : -1;
    return 0;
  });

  const limited = filtered.slice(0, limit);
  if (!limited.length) {
    body.innerHTML = `<tr><td colspan='5'>No matches for current filters.</td></tr>`;
    return;
  }

  body.innerHTML = '';

  limited.forEach(r => {
    const id = r.episode_id || r.movie;
    const tr = document.createElement('tr');
    const dimmed = r.state !== 'ok';
    tr.classList.toggle('dimmed', dimmed);

    let refBadge = '';
    if (r.best_reference === 'whisper') {
      refBadge = `<span class="ref-badge ref-whisper">Whisper</span>`;
    } else if (r.best_reference === 'ffsync') {
      refBadge = `<span class="ref-badge ref-ffsync">ffsync</span>`;
    } else if (r.best_reference === 'en') {
      refBadge = `<span class="ref-badge ref-en">EN</span>`;
    }
    if (r.reference_path) {
      refBadge = `<span class="ref-badge ref-${r.best_reference}"
        title="${r.reference_path}">${r.best_reference}</span>`;
    }

    const title = r.title || r.movie;
    const reanalyzeUrl =
      ctx.kind === 'tv'
        ? `/api/reanalyze/tv/${encodeURIComponent(id)}`
        : `/api/reanalyze/${encodeURIComponent(id)}`;
    const posterUrl =
      ctx.kind === 'tv'
        ? `/api/poster/tv/${encodeURIComponent(id)}`
        : `/api/poster/${encodeURIComponent(id)}`;

    tr.innerHTML = `
      <td><input type="checkbox"
      class="row-check row-check-${ctx.kind}"
      data-id="${id}" data-kind="${ctx.kind}" onclick="event.stopPropagation()"></td>
      <td class="recent-col" title="${
        r.fi_mtime ? new Date(r.fi_mtime * 1000).toLocaleString() : 'No FI subtitle'
      }">
      ${formatDaysAgo(r.fi_mtime)}
      </td>
      <td>${shortTitle(title)}</td>
      <td>${renderStateBadge(r)} ${refBadge}</td>
      <td>${r.state !== 'ok' ? '-' : r.anchor_count}</td>
      <td>${r.state !== 'ok' ? '-' : safe(r.avg_offset)}</td>
      <td>${r.state !== 'ok' ? '-' : safe(r.drift_span)}</td>
      <td>${r.state !== 'ok' ? '-' : shortStatus(r.decision)}
        <span class="reanalyze-status" data-id="${id}"></span>
      </td>
      <td><button class="reanalyze-btn" data-id="${id}"
          data-kind="${ctx.kind}" title="Re-analyze this ${ctx.label}">
      &#128472;</button>
      </td>
    `;

    tr.addEventListener('click', e => {
      if (e.target.closest('.reanalyze-btn')) return;
      if (e.target.closest('.row-check')) return;
      if (e.target.closest('button')) return;
      ctx.openAnalysis(r);
    });

    tr.addEventListener('mouseenter', () => {
      if (!previewEl) return;
      previewEl.style.backgroundImage = `url("${posterUrl}")`;
      previewEl.classList.add('show');
    });
    tr.addEventListener('mouseleave', () => {
      if (previewEl) previewEl.classList.remove('show');
    });

    body.appendChild(tr);
  });
}

function renderStateBadge(r) {
  if (!r.state || r.state === 'ok') return '';

  const labels = {
    missing_subtitles: 'Missing',
    ignored: 'Ignored',
  };

  const titles = {
    missing_subtitles: 'No EN/FI subtitle pair found',
    ignored: 'Movie ignored by user',
  };

  const label = labels[r.state] || r.state;
  const title = titles[r.state] || r.state;

  return `
    <span
      class="state-badge state-${r.state}"
      title="${title}"
    >${label}</span>
  `;
}

function updateLibraryRow(row, data) {
  // Update cells (directly)
  row.querySelector('td:nth-child(5)').textContent = data.anchor_count ?? '';
  row.querySelector('td:nth-child(6)').textContent = safe(data.avg_offset) ?? '';
  row.querySelector('td:nth-child(7)').textContent = safe(data.drift_span) ?? '';

  // Update decision cell
  const decisionCell = row.querySelector('td:nth-child(8)');
  const decision = data.decision || 'unknown';
  decisionCell.innerHTML = shortStatus(decision);

  // Update badges if needed
  const badgeCell = row.querySelector('td:nth-child(4)');
  badgeCell.innerHTML =
    (data.best_reference === 'whisper'
      ? `<span class="ref-badge ref-whisper">whisper</span>`
      : '') +
    (data.best_reference === 'ffsync'
      ? `<span class="ref-badge ref-ffsync">ffsync</span>`
      : '') +
    (data.best_reference === 'en' ? `<span class="ref-badge ref-en">en</span>` : '');
}

async function openLibraryAnalysis(row) {
  // Reset UI state
  librarySummaryPre.textContent = 'Loading analysis…';
  clearLibraryGraph();
  autoCorrectResult.textContent = '';
  if (autoCorrectBtn) autoCorrectBtn.disabled = true;

  try {
    const res = await fetch(`/api/analysis/${encodeURIComponent(row.movie)}`);
    const json = await res.json();
    if (!json.ok) {
      if (row.has_whisper) {
        librarySummaryPre.textContent =
          'Whisper reference exists, but no analysis yet.\nRun batch scan to generate analysis.';
      } else {
        librarySummaryPre.textContent = 'No analysis available for this movie yet.';
      }

      clearLibraryGraph();
      currentLibraryAnalysis = null;
      if (autoCorrectBtn) autoCorrectBtn.disabled = true;
      return;
    } else {
      setSummaryBackdrop(librarySummaryPre, row.movie);

      // Render summary + graph
      currentLibraryAnalysis = json.data;
      renderSummary(json.data, librarySummaryPre);
      drawGraph(
        libraryCanvas,
        json.data.clean_offsets || json.data.offsets || [],
        json.data.raw?.drift_bins || []
      );
    }

    // ----------------------------------------------------------
    // Auto-correct available when a real target subtitle exists
    if (autoCorrectBtn && json.data.target_path) {
      autoCorrectBtn.disabled = false;
      autoCorrectResult.textContent =
        'Ready for auto-correction using current analysis.';
    } else {
    autoCorrectBtn.disabled = true;
    autoCorrectResult.textContent = row.whisper_ref
      ? 'Target subtitle missing — cannot auto-correct.'
      : 'No target subtitle available for auto-correction.';
  }
} catch (err) {
  console.error('movieinfo error', err);
  librarySummaryPre.textContent = 'Failed to load analysis: ' + err.message;
  clearLibraryGraph();
  currentLibraryAnalysis = null;
  if (autoCorrectBtn) autoCorrectBtn.disabled = true;
}
}

async function openTvAnalysis(row) {
  tvSummaryPre.textContent = 'Loading analysis…';
  clearTvGraph();
  tvAutoCorrectResult.textContent = '';
  if (tvAutoCorrectBtn) tvAutoCorrectBtn.disabled = true;

  try {
    const res = await fetch(`/api/analysis/tv/${encodeURIComponent(row.episode_id)}`);
    const json = await res.json();
    if (!json.ok) {
      tvSummaryPre.textContent = 'No analysis available for this episode yet.';
      clearTvGraph();
      currentTvAnalysis = null;
      if (tvAutoCorrectBtn) tvAutoCorrectBtn.disabled = true;
      return;
    } else {
      setSummaryBackdrop(tvSummaryPre, row.show_name || row.title);
      currentTvAnalysis = json.data;
      renderSummary(json.data, tvSummaryPre);
      drawGraph(
        tvCanvas,
        json.data.clean_offsets || json.data.offsets || [],
        json.data.raw?.drift_bins || []
      );
    }

    if (tvAutoCorrectBtn && json.data.target_path) {
      tvAutoCorrectBtn.disabled = false;
      tvAutoCorrectResult.textContent =
        'Ready for auto-correction using current analysis.';
    } else {
      tvAutoCorrectBtn.disabled = true;
      tvAutoCorrectResult.textContent =
        'No target subtitle available for auto-correction.';
    }
  } catch (err) {
    console.error('tv analysis error', err);
    tvSummaryPre.textContent = 'Failed to load analysis: ' + err.message;
    clearTvGraph();
    currentTvAnalysis = null;
    if (tvAutoCorrectBtn) tvAutoCorrectBtn.disabled = true;
  }
}

document.addEventListener('change', e => {
  if (e.target.classList.contains('row-check')) {
    updateSelectionState();
  }
});

async function loadLibraryStats() {
  try {
    const res = await fetch('/api/db/stats');
    const json = await res.json();
    if (!json.ok) return;

    const s = json.stats;

    document.getElementById('libraryStats').textContent =
      `${s.total} movies analyzed · ` +
      `${s.decisions.synced} synced · ` +
      `${s.decisions.needs_adjustment || 0} poor · ` +
      `${(s.decisions.unresolvable ?? s.decisions.whisper_required) || 0} bad · ` +
      `${s.decisions.missing_subtitles} missing subtitles · ` +
      `${s.ignored} ignored`;
  } catch {}
}

function renderStats(el, label, s) {
  el.textContent =
    `${s.total} ${label} analyzed · ` +
    `${s.decisions.synced} synced · ` +
    `${s.decisions.needs_adjustment || 0} poor · ` +
    `${(s.decisions.unresolvable ?? s.decisions.whisper_required) || 0} bad · ` +
    `${s.decisions.missing_subtitles} missing subtitles · ` +
    `${s.ignored} ignored`;
}

async function loadTvStats() {
  try {
    const res = await fetch('/api/db/stats/tv');
    const json = await res.json();
    if (!json.ok) return;
    renderStats(document.getElementById('tvStats'), 'episodes', json.stats);
  } catch {}
}

function updateSelectionState() {
  const selected = document.querySelectorAll('.row-check:checked').length;

  for (const btn of bulkBtns) {
    if (selected > 0) {
      btn.disabled = false;
      btn.classList.add('enabled');
    } else {
      btn.disabled = true;
      btn.classList.remove('enabled');
    }
  }
}
for (const btn of bulkBtns) {
  btn.addEventListener('click', () => {
    const text = document.getElementById('bulkModalText');

    const checked = [...document.querySelectorAll('.row-check:checked')];
    const selectedIds = checked.map(x => x.dataset.id);
    const kinds = new Set(checked.map(x => x.dataset.kind));
    const kind = kinds.size === 1 && kinds.has('tv') ? 'tv' : 'movie';

    // Show readable titles (for TV the id is a base64url-encoded path).
    const labels = checked.map(cb => {
      const row = cb.closest('tr');
      const title = row && row.querySelector('td:nth-child(3)');
      return (title && title.textContent.trim()) || cb.dataset.id;
    });

    const label = kind === 'tv' ? 'episodes' : 'movies';
    text.textContent = `Selected ${label}:\n${labels.join('\n')}`;

    currentBulkSelection = selectedIds; // store for “Run” button
    currentBulkKind = kind;
    bulkModal.style.display = 'block';
  });
}

document.addEventListener('click', async e => {
  const btn = e.target.closest('.reanalyze-btn');
  if (!btn) return;

  const id = btn.dataset.id;
  const kind = btn.dataset.kind === 'tv' ? 'tv' : 'movie';
  const tr = btn.closest('tr');
  const spinner = tr.querySelector('.reanalyze-status');

  // Guard
  if (!id || !tr) return;

  // Show spinner
  spinner.innerHTML = `<span class="reanalyze-spinner"></span>`;
  btn.disabled = true;

  try {
    const url =
      kind === 'tv'
        ? `/api/reanalyze/tv/${encodeURIComponent(id)}`
        : `/api/reanalyze/${encodeURIComponent(id)}`;
    const res = await fetch(url, { method: 'POST' });
    const json = await res.json();

    if (!json.ok) {
      alert('Re-analyze failed: ' + json.error);
      return;
    }

    // ✅ Update this row only
    updateLibraryRow(tr, json.row);
  } catch (err) {
    alert('Re-analyze error: ' + err.message);
  } finally {
    spinner.innerHTML = '';
    btn.disabled = false;
  }
});

document.getElementById('bulkModalClose').onclick = () => {
  bulkModal.style.display = 'none';
  bulkResultBox.style.display = 'none';
  bulkResultPre.style.display = 'none';
  bulkResultPre.textContent = '(no output)';
};

document.getElementById('bulkRunBtn').onclick = async () => {
  disableBulkUI();
  showSpinner();

  const action = document.querySelector("input[name='bulkAction']:checked");
  if (!action) {
    hideSpinner();
    enableBulkUI();
    alert('Choose an action first');
    return;
  }

  const endpoint = {
    touch_whisper: '/api/bulk/touch_whisper',
    ignore: '/api/bulk/ignore',
    unignore: '/api/bulk/unignore',
    ffsubsync: '/api/bulk/ffsubsync',
  }[action.value];

  const body = { movies: currentBulkSelection, kind: currentBulkKind };

  // --------------------------------------------------
  // 🔥 WHISPER: SUBMIT + REPORT
  // --------------------------------------------------
  if (action.value === 'touch_whisper') {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await res.json();

      const notes = [];
      if (result.results && result.results.length) {
        result.results.forEach(r => {
          notes.push(`${r.ok ? '✓' : '✗'} ${r.movie}: ${r.action || r.error}`);
        });
      }
      if (result.errors && result.errors.length) {
        result.errors.forEach(e => notes.push(`✗ ${e.movie}: ${e.error}`));
      }

      alert(
        (notes.length ? notes.join('\n') : 'No items processed.') +
          '\n\nTranscription runs in the background when requested.'
      );
    } catch (err) {
      console.error('Whisper request failed:', err);
      alert('Whisper request failed: ' + err.message);
    }

    hideSpinner();
    enableBulkUI();

    document.getElementById('bulkModal').style.display = 'none';
    document.querySelectorAll('.row-check:checked').forEach(cb => (cb.checked = false));
    updateSelectionState();

    return; // ✅ HARD EXIT
  }

  // --------------------------------------------------
  // ⏳ BLOCKING ACTIONS (ffsubsync, ignore)
  // --------------------------------------------------
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const result = await res.json();

    if (action.value === 'ffsubsync') {
      bulkResultBox.style.display = 'block';
      renderFfsubsyncResults(result.results);
    } else {
      alert('Done:\n' + JSON.stringify(result, null, 2));
      document.getElementById('bulkModal').style.display = 'none';
    }
  } catch (err) {
    console.error(err);
    alert('Bulk action failed: ' + err.message);
  } finally {
    hideSpinner();
    enableBulkUI();
    document.querySelectorAll('.row-check:checked').forEach(cb => (cb.checked = false));
    updateSelectionState();
    if (currentBulkKind === 'tv') {
      loadTv();
      loadTvStats();
    } else {
      loadLibrary();
      loadLibraryStats();
    }
  }
};

function renderFfsubsyncResults(results) {
  bulkResultBox.innerHTML = '';

  results.forEach(r => {
    const scoreColor =
      r.normalizedScore == null
        ? 'text-gray-400'
        : r.normalizedScore < 50
          ? 'text-red-400'
          : r.normalizedScore < 200
            ? 'text-yellow-400'
            : 'text-green-400';

    const shortLog = r.log
      .split('\n')
      .filter(
        line =>
          line.includes('extracting') ||
          line.includes('detected encoding') ||
          line.includes('computing align') ||
          line.includes('done') ||
          line.includes('score:')
      )
      .join('\n');

    bulkResultBox.innerHTML += `
      <div class="p-4 border-b border-gray-700">
        <h3 class="text-lg font-bold mb-2">${r.movie}</h3>

        <div class="text-sm text-gray-300 mb-2">
          <strong>Input subtitle:</strong> ${r.inSub}<br>
          <strong>Output subtitle:</strong> ${r.outSub}
        </div>

        <div class="text-sm mb-2">
          <strong>Raw Score:</strong> <span>${r.rawScore ?? 'N/A'}</span><br>
          <strong>Normalized:</strong> <span class="${scoreColor}">${
            r.normalizedScore ?? 'N/A'
          }</span><br>
          <strong>Offset (sec):</strong> ${r.offsetSeconds ?? 'N/A'}<br>
          <strong>Framerate factor:</strong> ${r.framerateFactor ?? 'N/A'}
        </div>
        <details class="text-xs text-gray-500">
          <summary class="cursor-pointer">Show full log</summary>
          <pre class="bg-gray-900 p-2 mt-1 rounded overflow-x-auto whitespace-pre-wrap">
${r.log}
          </pre>
        </details>
      </div>
    `;
  });
}

// -------- INITIAL SETUP --------

// Clear both graphs initially
clearManualGraph();
clearLibraryGraph();

// Optionally load library immediately on first load (library tab is default)
loadLibrary();
loadLibraryStats();
