import { drawGraph } from './graph.js'

// -------- DOM ELEMENTS --------

// Manual align elements
const searchBox = document.getElementById('searchBox')
const resultsDiv = document.getElementById('results')
const refPathInput = document.getElementById('refPath')
const targetPathInput = document.getElementById('targetPath')
const alignBtn = document.getElementById('alignBtn')
const summaryPre = document.getElementById('summary')
const manualCanvas = document.getElementById('graphCanvas')

// Library elements
const loadLibraryBtn = document.getElementById('loadLibraryBtn')
const libraryTableBody = document
  .getElementById('libraryTable')
  .querySelector('tbody')
const libNote = document.getElementById('libNote')
const librarySearchInput = document.getElementById('librarySearch')
const libraryStatusSelect = document.getElementById('libraryStatus')
const libraryLimitSelect = document.getElementById('libraryLimit')
const librarySummaryPre = document.getElementById('librarySummary')
const libraryCanvas = document.getElementById('libraryGraph')

// Tabs
const tabButtons = document.querySelectorAll('#tabs button')
const tabViews = document.querySelectorAll('.tab')

// State
let searchTimer = null
let libraryRows = []
let librarySortKey = 'movie'
let librarySortDir = 'asc'

// -------- TAB SWITCHING --------

tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    // buttons
    tabButtons.forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')

    // views
    const target = btn.dataset.tab
    tabViews.forEach((v) => v.classList.remove('active'))
    document.getElementById(`tab-${target}`).classList.add('active')

    // Lazy-load library on first show
    if (target === 'library' && libraryRows.length === 0) {
      loadLibrary()
    }
  })
})

// -------- GENERIC HELPERS --------

function clearCanvas(c) {
  if (!c) return
  const ctx = c.getContext('2d')
  const W = (c.width = c.clientWidth || 600)
  const H = (c.height = c.clientHeight || 220)
  ctx.fillStyle = '#020617'
  ctx.fillRect(0, 0, W, H)
}

// Manual & library clears
function clearManualGraph() {
  clearCanvas(manualCanvas)
}

function clearLibraryGraph() {
  clearCanvas(libraryCanvas)
}

function safe(v, digits = 3) {
  return typeof v === 'number' && !isNaN(v) ? v.toFixed(digits) : '–'
}

// Render summary into a target <pre>
function renderSummary(d, targetEl = summaryPre) {
  const anchors = d.anchor_count ?? 0
  const avg = Number(d.avg_offset_sec ?? d.avg_offset ?? 0)
  const span = Number(d.drift_span_sec ?? d.drift_span ?? 0)
  const min = Number(d.min_offset_sec ?? 0)
  const max = Number(d.max_offset_sec ?? 0)
  const decision = d.decision ?? 'unknown'

  targetEl.textContent =
    `Ref:        ${d.ref_path || d.reference || ''}\n` +
    `Target:     ${d.target_path || d.target || ''}\n\n` +
    `Ref lines:  ${d.ref_count ?? '-'}\n` +
    `Tgt lines:  ${d.target_count ?? '-'}\n` +
    `Anchors:    ${anchors}\n` +
    `Avg offset: ${avg.toFixed(3)} s\n` +
    `Drift span: ${span.toFixed(3)} s\n` +
    `Min / Max:  ${min.toFixed(3)} s  /  ${max.toFixed(3)} s\n` +
    `Decision:   ${decision}`
}

// -------- MANUAL SEARCH --------

if (searchBox) {
  searchBox.addEventListener('input', () => {
    clearTimeout(searchTimer)
    const q = searchBox.value.trim()
    if (q.length < 2) {
      resultsDiv.innerHTML = ''
      return
    }
    searchTimer = setTimeout(() => runSearch(q), 250)
  })
}

async function runSearch(q) {
  resultsDiv.innerHTML = 'Searching…'
  try {
    const res = await fetch(`/api/searchsubs?q=${encodeURIComponent(q)}`)
    const groups = await res.json()

    if (!Array.isArray(groups) || groups.length === 0) {
      resultsDiv.innerHTML = 'No matches.'
      return
    }

    resultsDiv.innerHTML = ''
    groups.forEach((g) => {
      const div = document.createElement('div')
      div.className = 'result-item'
      div.textContent = g.base

      div.onclick = () => {
        // Prefer EN as reference, FI as target
        refPathInput.value = g.en || ''
        targetPathInput.value = g.fi || ''
        alignBtn.disabled = !(refPathInput.value && targetPathInput.value)
        summaryPre.textContent = `Selected: ${g.base}\nEN: ${
          g.en || '-'
        }\nFI: ${g.fi || '-'}`
        clearManualGraph()
      }

      resultsDiv.appendChild(div)
    })
  } catch (e) {
    console.error('search error', e)
    resultsDiv.innerHTML = 'Error during search.'
  }
}

// -------- MANUAL ALIGN --------

if (alignBtn) {
  alignBtn.addEventListener('click', async () => {
    const reference = refPathInput.value.trim()
    const target = targetPathInput.value.trim()
    if (!reference || !target) {
      summaryPre.textContent = 'Reference and target required.'
      return
    }

    summaryPre.textContent = 'Running align.py…'

    try {
      const res = await fetch('/api/align', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference, target }),
      })

      const data = await res.json()
      if (data.error) {
        summaryPre.textContent = `Error: ${data.error}\n${data.detail || ''}`
        clearManualGraph()
        return
      }

      renderSummary(data, summaryPre)
      drawGraph(manualCanvas, data.offsets || [])
    } catch (e) {
      console.error('align error', e)
      summaryPre.textContent = 'Align failed: ' + e.message
      clearManualGraph()
    }
  })
}

// -------- LIBRARY VIEW --------

if (loadLibraryBtn) {
  loadLibraryBtn.addEventListener('click', loadLibrary)
}

async function loadLibrary() {
  libraryTableBody.innerHTML = "<tr><td colspan='5'>Loading…</td></tr>"

  try {
    const res = await fetch('/api/library')
    const data = await res.json()

    if (data.error === 'no_summary_file') {
      libraryRows = []
      libraryTableBody.innerHTML =
        "<tr><td colspan='5'>No summary file found.</td></tr>"
      libNote.textContent = ''
      return
    }

    if (!Array.isArray(data)) {
      libraryRows = []
      libraryTableBody.innerHTML =
        "<tr><td colspan='5'>Unexpected response.</td></tr>"
      return
    }

    libraryRows = data
    renderLibraryTable()
    libNote.textContent =
      'Tip: use search / filters, then click any movie row to see its analysis.'
  } catch (e) {
    console.error('library error', e)
    libraryRows = []
    libraryTableBody.innerHTML =
      "<tr><td colspan='5'>Error loading summary.</td></tr>"
  }
}

// Filters
if (librarySearchInput) {
  librarySearchInput.addEventListener('input', renderLibraryTable)
}
if (libraryStatusSelect) {
  libraryStatusSelect.addEventListener('change', renderLibraryTable)
}
if (libraryLimitSelect) {
  libraryLimitSelect.addEventListener('change', renderLibraryTable)
}

// Sorting via header click
document.querySelectorAll('#libraryTable thead th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort
    if (librarySortKey === key) {
      librarySortDir = librarySortDir === 'asc' ? 'desc' : 'asc'
    } else {
      librarySortKey = key
      librarySortDir = 'asc'
    }
    renderLibraryTable()
  })
})

function renderLibraryTable() {
  if (!libraryTableBody) return

  if (!libraryRows.length) {
    libraryTableBody.innerHTML =
      "<tr><td colspan='5'>No rows loaded. Click “Reload summary”.</td></tr>"
    return
  }

  const searchTerm = librarySearchInput.value.trim().toLowerCase()
  const statusFilter = libraryStatusSelect.value
  const limit = parseInt(libraryLimitSelect.value, 10) || 100

  let rows = libraryRows.filter((r) => {
    if (searchTerm && !r.movie.toLowerCase().includes(searchTerm)) return false
    if (statusFilter && r.decision !== statusFilter) return false
    return true
  })

  rows.sort((a, b) => {
    let av = a[librarySortKey]
    let bv = b[librarySortKey]

    if (typeof av === 'string') av = av.toLowerCase()
    if (typeof bv === 'string') bv = bv.toLowerCase()

    if (av < bv) return librarySortDir === 'asc' ? -1 : 1
    if (av > bv) return librarySortDir === 'asc' ? 1 : -1
    return 0
  })

  const limited = rows.slice(0, limit)

  if (!limited.length) {
    libraryTableBody.innerHTML =
      "<tr><td colspan='5'>No matches for current filters.</td></tr>"
    return
  }

  libraryTableBody.innerHTML = ''

  limited.forEach((r) => {
    const tr = document.createElement('tr')

    const statusClass =
      r.decision === 'synced'
        ? 'status-synced'
        : r.decision === 'needs_adjustment'
        ? 'status-adjust'
        : 'status-bad'

    tr.innerHTML = `
      <td>${r.movie}</td>
      <td>${safe(r.anchor_count)}</td>
      <td>${safe(r.avg_offset)}</td>
      <td>${safe(r.drift_span)}</td>
      <td class="${statusClass}">${r.decision}</td>
    `

    tr.addEventListener('click', () => {
      openLibraryAnalysis(r)
    })

    libraryTableBody.appendChild(tr)
  })
}

async function openLibraryAnalysis(row) {
  if (!row.syncinfo_path) {
    librarySummaryPre.textContent =
      'No analysis.syncinfo found for this movie folder.'
    clearLibraryGraph()
    return
  }

  librarySummaryPre.textContent = 'Loading analysis…'

  try {
    const res = await fetch(
      `/api/movieinfo?file=${encodeURIComponent(row.syncinfo_path)}`
    )
    const data = await res.json()

    if (data.error) {
      librarySummaryPre.textContent = 'Error: ' + data.error
      clearLibraryGraph()
      return
    }

    renderSummary(data, librarySummaryPre)
    drawGraph(libraryCanvas, data.offsets || [])
  } catch (e) {
    console.error('movieinfo error', e)
    librarySummaryPre.textContent = 'Failed to load analysis: ' + e.message
    clearLibraryGraph()
  }
}

// -------- INITIAL SETUP --------

// Clear both graphs initially
clearManualGraph()
clearLibraryGraph()

// Optionally load library immediately on first load (library tab is default)
loadLibrary()
