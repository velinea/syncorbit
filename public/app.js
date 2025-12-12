import { drawGraph } from './graph.js';

// -------- DOM ELEMENTS --------

// Manual align elements
const searchBox = document.getElementById('searchBox');
const resultsDiv = document.getElementById('results');
const refPathInput = document.getElementById('refPath');
const targetPathInput = document.getElementById('targetPath');
const alignBtn = document.getElementById('alignBtn');
const summaryPre = document.getElementById('summary');
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
const bulkBtn = document.getElementById('bulkActionsBtn');
const bulkResultBox = document.getElementById('bulkResultBox');
const bulkResultPre = document.getElementById('bulkResultPre');
const bulkModal = document.getElementById('bulkModal');

// Tabs
const tabButtons = document.querySelectorAll('#tabs button');
const tabViews = document.querySelectorAll('.tab');

// State
let searchTimer = null;
let libraryRows = [];
let librarySortKey = 'movie';
let librarySortDir = 'asc';
let currentLibraryRow = null;
let currentLibraryAnalysis = null;
let currentBulkSelection = [];

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
  document.getElementById('bulkActionsBtn').disabled = true;
}

function enableBulkUI() {
  document.getElementById('bulkRunBtn').disabled = false;
  document.getElementById('bulkActionsBtn').disabled = false;
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

function safe(v, digits = 2) {
  return typeof v === 'number' && !isNaN(v) ? v.toFixed(digits) : '–';
}

// Render summary into a target <pre>
function renderSummary(d, targetEl = summaryPre) {
  const anchors = d.anchor_count ?? 0;
  const avg = Number(d.avg_offset_sec ?? d.avg_offset ?? 0);
  const span = Number(d.drift_span_sec ?? d.drift_span ?? 0);
  const min = Number(d.min_offset_sec ?? 0);
  const max = Number(d.max_offset_sec ?? 0);
  const decision = d.decision ?? 'unknown';

  targetEl.textContent =
    `Ref:        ${d.ref_path || d.reference || ''}\n` +
    `Target:     ${d.target_path || d.target || ''}\n\n` +
    `Ref lines:  ${d.ref_count ?? '-'}\n` +
    `Tgt lines:  ${d.target_count ?? '-'}\n` +
    `Anchors:    ${anchors}\n` +
    `Avg offset: ${avg.toFixed(3)} s\n` +
    `Drift span: ${span.toFixed(3)} s\n` +
    `Min / Max:  ${min.toFixed(3)} s  /  ${max.toFixed(3)} s\n` +
    `Decision:   ${decision}`;
}

// -------- BATCH PROGRESS POLLING --------
async function pollBatchProgress() {
  const res = await fetch('/api/batch_progress');
  const p = await res.json();

  if (!p.running) {
    document.getElementById('batchStatus').textContent = 'Idle';
    return;
  }

  document.getElementById(
    'batchStatus'
  ).textContent = `Scanning ${p.index}/${p.total}: ${p.current_movie}`;
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
        summaryPre.textContent = `Selected: ${g.base}`;
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
      summaryPre.textContent = 'Missing dropdowns (refSelect/targetSelect)';
      return;
    }

    const reference = refSel.value.trim();
    const target = tgtSel.value.trim();

    if (!reference || !target) {
      summaryPre.textContent = 'Please pick both reference and target subtitles.';
      return;
    }

    summaryPre.textContent = 'Running align.py…';

    try {
      const res = await fetch('/api/align', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference, target }),
      });

      const data = await res.json();
      if (data.error) {
        summaryPre.textContent = `Error: ${data.error}\n${data.detail || ''}`;
        clearManualGraph();
        return;
      }

      renderSummary(data, summaryPre);
      // drawGraph(manualCanvas, data.offsets || []);
      // Use clean_offsets if available
      const baseOffsets =
        data.clean_offsets && data.clean_offsets.length
          ? data.clean_offsets
          : data.offsets || [];

      drawGraph(manualCanvas, baseOffsets);
    } catch (e) {
      summaryPre.textContent = 'Align failed: ' + e.message;
      clearManualGraph();
    }
  });
}

async function loadSubtitleChoices(movieName) {
  const res = await fetch(`/api/listsubs/${encodeURIComponent(movieName)}`);
  const data = await res.json();

  refSelect.innerHTML = '';
  targetSelect.innerHTML = '';

  // Whisper first
  if (data.whisper) {
    refSelect.innerHTML += `<option value="${data.whisper}">Whisper Reference</option>`;
  }

  // Subs
  data.subs.forEach(s => {
    refSelect.innerHTML += `<option value="${s.path}">${s.file}</option>`;
    targetSelect.innerHTML += `<option value="${s.path}">${s.file}</option>`;
  });

  // Enable Align on change
  refSelect.onchange = targetSelect.onchange = () => {
    alignBtn.disabled = !(refSelect.value && targetSelect.value);
  };

  return data; // VERY IMPORTANT
}

// -------- LIBRARY VIEW --------

if (loadLibraryBtn) {
  loadLibraryBtn.addEventListener('click', loadLibrary);
}

async function loadLibrary() {
  libraryTableBody.innerHTML = "<tr><td colspan='5'>Loading…</td></tr>";

  try {
    const res = await fetch('/api/library');
    const data = await res.json();

    if (data.error === 'no_summary_file') {
      libraryRows = [];
      libraryTableBody.innerHTML =
        "<tr><td colspan='5'>No summary file found.</td></tr>";
      libNote.textContent = '';
      return;
    }

    if (!Array.isArray(data)) {
      libraryRows = [];
      libraryTableBody.innerHTML = "<tr><td colspan='5'>Unexpected response.</td></tr>";
      return;
    }

    libraryRows = data;
    renderLibraryTable();
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

async function onAutoCorrectClick() {
  if (!currentLibraryRow || !currentLibraryAnalysis) {
    autoCorrectResult.textContent = 'Select a movie with analysis first.';
    return;
  }

  const target = currentLibraryAnalysis.target_path;
  const syncinfoPath = currentLibraryRow.syncinfo_path;

  if (!target || !syncinfoPath) {
    autoCorrectResult.textContent =
      'Missing target_path or syncinfo_path, cannot auto-correct.';
    return;
  }

  autoCorrectBtn.disabled = true;
  autoCorrectResult.textContent = 'Running auto-correction…';

  try {
    const res = await fetch('/api/autocorrect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, syncinfo_path: syncinfoPath }),
    });

    const data = await res.json();

    if (data.status === 'ok') {
      const m = data.method;
      const out = data.output_file;
      const meta = data.meta || {};
      let detail = '';

      if (m === 'global_offset') {
        detail = `Global shift: ${meta.shift_sec?.toFixed?.(3)} s`;
      } else if (m === 'stretch_offset') {
        const stretchPct = ((meta.stretch - 1) * 100).toFixed(3);
        detail = `Stretch: ${stretchPct}%  Shift: ${meta.shift_sec?.toFixed?.(3)} s`;
      }

      autoCorrectResult.textContent = `Auto-corrected (${m}). Output: ${out}\n${detail}`;
    } else if (data.status === 'whisper_required') {
      autoCorrectResult.textContent =
        'Cannot auto-correct safely. Marked as whisper_required.';
    } else {
      autoCorrectResult.textContent = `Auto-correct failed: ${
        data.error || data.status
      }`;
    }
  } catch (e) {
    console.error('autocorrect error', e);
    autoCorrectResult.textContent = 'Auto-correct failed: ' + e.message;
  } finally {
    // Re-enable so user can retry
    autoCorrectBtn.disabled = false;
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

function shortTitle(t) {
  return t.length > 30 ? t.slice(0, 27) + '…' : t;
}

function shortStatus(s) {
  if (s === 'synced') return 'ok';
  if (s === 'needs_adjustment') return 'poor';
  return 'bad';
}

function autoFixLabel(r) {
  // Very rough: synced or small drift = ok
  if (r.decision === 'synced') return 'ok';
  if (r.decision === 'needs_adjustment') return 'maybe';
  if (r.decision === 'bad') return 'no';
  return 'no';
}

const runBatchScanBtn = document.getElementById('runBatchScanBtn');

runBatchScanBtn.addEventListener('click', async () => {
  runBatchScanBtn.disabled = true;
  runBatchScanBtn.textContent = 'Scanning… (this may take some time)';

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

  runBatchScanBtn.textContent = 'Run Library Scan';
  runBatchScanBtn.disabled = false;
});

function renderLibraryTable() {
  if (!libraryTableBody) return;

  if (!libraryRows.length) {
    libraryTableBody.innerHTML =
      "<tr><td colspan='5'>No rows loaded. Click “Load summary”.</td></tr>";
    return;
  }

  const searchTerm = librarySearchInput.value.trim().toLowerCase();
  const statusFilter = libraryStatusSelect.value;
  const limit = parseInt(libraryLimitSelect.value, 10) || 100;

  let rows = libraryRows.filter(r => {
    if (searchTerm && !r.movie.toLowerCase().includes(searchTerm)) return false;
    if (statusFilter && r.decision !== statusFilter) return false;
    return true;
  });

  rows.sort((a, b) => {
    let av = a[librarySortKey];
    let bv = b[librarySortKey];

    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();

    if (av < bv) return librarySortDir === 'asc' ? -1 : 1;
    if (av > bv) return librarySortDir === 'asc' ? 1 : -1;
    return 0;
  });

  const limited = rows.slice(0, limit);

  if (!limited.length) {
    libraryTableBody.innerHTML =
      "<tr><td colspan='5'>No matches for current filters.</td></tr>";
    return;
  }

  libraryTableBody.innerHTML = '';

  limited.forEach(r => {
    const tr = document.createElement('tr');

    const statusClass =
      r.decision === 'synced'
        ? 'status-synced'
        : r.decision === 'needs_adjustment'
        ? 'status-adjust'
        : 'status-bad';

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

    tr.innerHTML = `
      <td><input type="checkbox"
      class="row-check"
      data-movie="${r.movie}" onclick="event.stopPropagation()"></td>
      <td>${shortTitle(r.movie)} ${refBadge}</td>
      <td>${safe(r.anchor_count)}</td>
      <td>${safe(r.avg_offset)}</td>
      <td>${safe(r.drift_span)}</td>
      <td class="${statusClass}">${shortStatus(r.decision)}</td>
    `;

    tr.addEventListener('click', () => {
      openLibraryAnalysis(r);
    });

    libraryTableBody.appendChild(tr);
  });
}

async function openLibraryAnalysis(row) {
  // Reset UI state
  librarySummaryPre.textContent = 'Loading analysis…';
  clearLibraryGraph();
  autoCorrectResult.textContent = '';
  if (autoCorrectBtn) autoCorrectBtn.disabled = true;

  // ----------------------------------------------------------
  // CASE 1: No syncinfo_path — this can mean Whisper ref exists
  //         but analysis has not been generated yet.
  // ----------------------------------------------------------
  if (!row.syncinfo_path) {
    if (row.whisper_ref) {
      librarySummaryPre.textContent =
        'Whisper reference exists, but no analysis yet.\nRun batch scan to generate analysis.';
    } else {
      librarySummaryPre.textContent = 'No analysis.syncinfo found for this movie.';
    }

    currentLibraryRow = null;
    currentLibraryAnalysis = null;
    return;
  }

  // ----------------------------------------------------------
  // CASE 2: syncinfo exists — fetch analysis
  // ----------------------------------------------------------
  try {
    const res = await fetch(
      `/api/movieinfo?file=${encodeURIComponent(row.syncinfo_path)}`
    );
    const data = await res.json();

    if (data.error) {
      librarySummaryPre.textContent = `Error: ${data.error}`;
      clearLibraryGraph();
      currentLibraryRow = null;
      currentLibraryAnalysis = null;
      if (autoCorrectBtn) autoCorrectBtn.disabled = true;
      return;
    }

    // Store for autocorrect
    currentLibraryRow = row;
    currentLibraryAnalysis = data;

    // Render summary + graph
    renderSummary(data, librarySummaryPre);
    drawGraph(libraryCanvas, data.clean_offsets || data.offsets || []);

    // ----------------------------------------------------------
    // Auto-correct available when a real target subtitle exists
    if (autoCorrectBtn && data.target_path) {
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
    currentLibraryRow = null;
    currentLibraryAnalysis = null;
    if (autoCorrectBtn) autoCorrectBtn.disabled = true;
  }
}
document.addEventListener('change', e => {
  if (e.target.classList.contains('row-check')) {
    updateSelectionState();
  }
});

function updateSelectionState() {
  const selected = document.querySelectorAll('.row-check:checked').length;

  if (selected > 0) {
    bulkBtn.disabled = false;
    bulkBtn.classList.add('enabled');
  } else {
    bulkBtn.disabled = true;
    bulkBtn.classList.remove('enabled');
  }
}
bulkBtn.addEventListener('click', () => {
  const text = document.getElementById('bulkModalText');

  const selectedMovies = [...document.querySelectorAll('.row-check:checked')].map(
    x => x.dataset.movie
  );

  text.textContent = `Selected movies:\n${selectedMovies.join('\n')}`;

  currentBulkSelection = selectedMovies; // store for “Run” button
  bulkModal.style.display = 'block';
});

document.getElementById('bulkModalClose').onclick = () => {
  bulkModal.style.display = 'none';
  bulkResultBox.style.display = 'none';
  bulkResultPre.style.display = 'none';
  bulkResultPre.textContent = '(no output)';
};

document.getElementById('bulkRunBtn').onclick = async () => {
  disableBulkUI();
  try {
    const action = document.querySelector("input[name='bulkAction']:checked");
    if (!action) {
      enableBulkUI();
      alert('Choose an action first');
      return;
    }
    showSpinner();

    const endpoint = {
      touch_whisper: '/api/bulk/touch_whisper',
      ignore: '/api/bulk/ignore',
      ffsubsync: '/api/bulk/ffsubsync',
    }[action.value];

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ movies: currentBulkSelection }),
    });

    const result = await res.json();
    // -------------------------------
    // Display ffsubsync results
    // -------------------------------
    if (action.value === 'ffsubsync') {
      bulkResultBox.style.display = 'block';
      renderFfsubsyncResults(result.results);
    } else {
      alert('Done:\n' + JSON.stringify(result, null, 2));
      document.getElementById('bulkModal').style.display = 'none';
    }
  } finally {
    enableBulkUI(); // <--- always re-enable afterward
    hideSpinner();
    // Uncheck all selections
    document.querySelectorAll('.row-check:checked').forEach(cb => (cb.checked = false));

    // Reset selection state
    updateSelectionState();

    return; // prevent falling through
  }

  alert('Done:\n' + JSON.stringify(result, null, 2));

  document.getElementById('bulkModal').style.display = 'none';
  updateSelectionState();
  loadLibrary(); // refresh table
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
