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
let librarySortKey = 'fi_mtime';
let librarySortDir = 'desc';
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
      loadLibraryStats();
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
function renderSummary(d, targetEl = summaryPre) {
  const anchors = d.anchor_count ?? 0;
  const avg = Number(d.avg_offset_sec ?? d.avg_offset ?? 0);
  const span = Number(d.drift_span_sec ?? d.drift_span ?? 0);
  const min = Number(d.min_offset_sec ?? d.min_offset ?? 0);
  const max = Number(d.max_offset_sec ?? d.max_offset ?? 0);
  const decision = d.decision ?? 'unknown';

  targetEl.textContent =
    `Ref:        ${d.reference_path || d.reference || ''}\n` +
    `Target:     ${d.target_path || d.target || ''}\n\n` +
    `Ref lines:  ${d.ref_count ?? '-'}\n` +
    `Tgt lines:  ${d.target_count ?? '-'}\n` +
    `Anchors:    ${anchors}\n` +
    `Avg offset: ${avg.toFixed(3)} s\n` +
    `Drift span: ${span.toFixed(3)} s\n` +
    `Min / Max:  ${min.toFixed(3)} s  /  ${max.toFixed(3)} s\n` +
    `Decision:   ${decision}`;
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
  const res = await fetch('/api/batch_progress');
  const p = await res.json();

  if (p.running) {
    document.getElementById(
      'batchStatus'
    ).textContent = `Scanning folders ${p.index}/${p.total}: ${p.current_movie}`;
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

    tr.innerHTML = `
      <td><input type="checkbox"
      class="row-check"
      data-movie="${r.movie}" onclick="event.stopPropagation()"></td>
      <td class="recent-col" title="${
        r.fi_mtime ? new Date(r.fi_mtime * 1000).toLocaleString() : 'No FI subtitle'
      }">
      ${formatDaysAgo(r.fi_mtime)}
      </td>
      <td>${shortTitle(r.movie)}</td>
      <td>${renderStateBadge(r)} ${refBadge}</td>
      <td>${r.state !== 'ok' ? '-' : r.anchor_count}</td>
      <td>${r.state !== 'ok' ? '-' : safe(r.avg_offset)}</td>
      <td>${r.state !== 'ok' ? '-' : safe(r.drift_span)}</td>
      <td>${r.state !== 'ok' ? '-' : shortStatus(r.decision)}
        <span class="reanalyze-status" data-movie="${r.movie}"></span>
      </td>
      <td><button class="reanalyze-btn" data-movie="${
        r.movie
      }" title="Re-analyze this movie">
      &#128472;</button>
      </td>
    `;

    tr.addEventListener('click', e => {
      // Ignore clicks on controls inside the row
      if (e.target.closest('.reanalyze-btn')) return;
      if (e.target.closest('.row-check')) return;
      if (e.target.closest('button')) return;

      openLibraryAnalysis(r);
    });

    // Poster preview on hover
    tr.addEventListener('mouseenter', () => {
      const url = `/api/poster/${encodeURIComponent(r.movie)}`;
      posterPreview.style.backgroundImage = `url("${url}")`;
      posterPreview.classList.add('show');
    });

    tr.addEventListener('mouseleave', () => {
      posterPreview.classList.remove('show');
    });

    libraryTableBody.appendChild(tr);
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
      currentLibraryRow = null;
      currentLibraryAnalysis = null;
      if (autoCorrectBtn) autoCorrectBtn.disabled = true;
      return;
    } else {
      currentLibraryAnalysis = json.data;
      const backdropUrl = `/api/artwork/${encodeURIComponent(row.movie)}`;
      const panel = document.getElementById('librarySummary');

      if (backdropUrl) {
        panel.style.backgroundImage = `
          linear-gradient(
            to bottom,
            rgba(2, 6, 23, 0.70),
            rgba(2, 6, 23, 0.92)
          ),
          url("${backdropUrl}")
        `;
      } else {
        panel.style.backgroundImage = `
          linear-gradient(
            to bottom,
            rgba(2, 6, 23, 0.70),
            rgba(2, 6, 23, 0.92)
          )
        `;
      }

      // Render summary + graph
      renderSummary(json.data, librarySummaryPre);
      drawGraph(libraryCanvas, json.data.clean_offsets || json.data.offsets || []);
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

async function loadLibraryStats() {
  try {
    const res = await fetch('/api/db/stats');
    const json = await res.json();
    if (!json.ok) return;

    const s = json.stats;

    document.getElementById('libraryStats').textContent =
      `${s.total} movies analyzed · ` +
      `${s.decisions.synced} synced · ` +
      `${s.decisions.needs_adjustment} poor ` +
      `${s.decisions.whisper_required} bad · ` +
      `${s.decisions.missing_subtitles} missing FI subtitles · ` +
      `${s.ignored} ignored`;
  } catch {}
}

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

document.addEventListener('click', async e => {
  const btn = e.target.closest('.reanalyze-btn');
  if (!btn) return;

  const movie = btn.dataset.movie;
  const tr = btn.closest('tr');
  const spinner = tr.querySelector('.reanalyze-status');

  // Guard
  if (!movie || !tr) return;

  // Show spinner
  spinner.innerHTML = `<span class="reanalyze-spinner"></span>`;
  btn.disabled = true;

  try {
    const res = await fetch(`/api/reanalyze/${encodeURIComponent(movie)}`, {
      method: 'POST',
    });
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
    ffsubsync: '/api/bulk/ffsubsync',
  }[action.value];

  // --------------------------------------------------
  // 🔥 WHISPER: FIRE-AND-FORGET
  // --------------------------------------------------
  if (action.value === 'touch_whisper') {
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ movies: currentBulkSelection }),
    }).catch(err => {
      console.error('Whisper request failed:', err);
    });

    hideSpinner();
    enableBulkUI();

    alert(
      'Whisper requested.\n\nTranscription is running in the background.\nYou can continue using SyncOrbit.'
    );

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
      body: JSON.stringify({ movies: currentBulkSelection }),
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
    loadLibrary();
    loadLibraryStats();
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

document.querySelectorAll('.whisper-btn').forEach(btn => {
  btn.onclick = async e => {
    e.stopPropagation();

    const movie = btn.dataset.movie;
    const statusEl = btn.nextElementSibling;

    btn.disabled = true;
    statusEl.textContent = 'Starting…';

    const res = await fetch(`/api/whisper/${encodeURIComponent(movie)}`, {
      method: 'POST',
    });
    const json = await res.json();

    if (!json.ok) {
      statusEl.textContent = json.error;
      btn.disabled = false;
      return;
    }

    statusEl.textContent = 'Queued';

    // Poll
    const poll = setInterval(async () => {
      const r = await fetch(`/api/whisper/status/${encodeURIComponent(movie)}`);
      const s = await r.json();

      if (!s.ok) return;

      statusEl.textContent = `${s.state} ${Math.round((s.progress || 0) * 100)}%`;

      if (s.state === 'done') {
        clearInterval(poll);
        statusEl.textContent = 'Done';
        btn.disabled = false;
        loadLibrary(); // refresh row
      }

      if (s.state === 'error') {
        clearInterval(poll);
        statusEl.textContent = 'Error';
        btn.disabled = false;
      }
    }, 3000);
  };
});

// -------- INITIAL SETUP --------

// Clear both graphs initially
clearManualGraph();
clearLibraryGraph();

// Optionally load library immediately on first load (library tab is default)
loadLibrary();
loadLibraryStats();
