import { drawGraph } from './graph.js'

const searchBox = document.getElementById('searchBox')
const resultsDiv = document.getElementById('results')
const refPathInput = document.getElementById('refPath')
const targetPathInput = document.getElementById('targetPath')
const alignBtn = document.getElementById('alignBtn')
const summaryPre = document.getElementById('summary')
const canvas = document.getElementById('graphCanvas')

let searchTimer = null

// ------------- SEARCH -------------

searchBox.addEventListener('input', () => {
  clearTimeout(searchTimer)
  const q = searchBox.value.trim()
  if (q.length < 2) {
    resultsDiv.innerHTML = ''
    return
  }
  searchTimer = setTimeout(() => runSearch(q), 250)
})

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
        clearGraph()
      }

      resultsDiv.appendChild(div)
    })
  } catch (e) {
    console.error('search error', e)
    resultsDiv.innerHTML = 'Error during search.'
  }
}

// ------------- ALIGN -------------

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
      clearGraph()
      return
    }

    renderSummary(data)
    drawGraph(data.offsets || [])
  } catch (e) {
    console.error('align error', e)
    summaryPre.textContent = 'Align failed: ' + e.message
    clearGraph()
  }
})

// ------------- SUMMARY -------------

function renderSummary(d) {
  const anchors = d.anchor_count ?? 0
  const avg = Number(d.avg_offset_sec ?? 0)
  const span = Number(d.drift_span_sec ?? 0)
  const min = Number(d.min_offset_sec ?? 0)
  const max = Number(d.max_offset_sec ?? 0)
  const decision = d.decision ?? 'unknown'

  summaryPre.textContent =
    `Ref:        ${d.ref_path}\n` +
    `Target:     ${d.target_path}\n\n` +
    `Ref lines:  ${d.ref_count}\n` +
    `Tgt lines:  ${d.target_count}\n` +
    `Anchors:    ${anchors}\n` +
    `Avg offset: ${avg.toFixed(3)} s\n` +
    `Drift span: ${span.toFixed(3)} s\n` +
    `Min / Max:  ${min.toFixed(3)} s  /  ${max.toFixed(3)} s\n` +
    `Decision:   ${decision}`
}

// ------------- GRAPH -------------

function clearGraph() {
  const ctx = canvas.getContext('2d')
  const W = (canvas.width = canvas.clientWidth || 600)
  const H = (canvas.height = canvas.clientHeight || 220)
  ctx.fillStyle = '#020617'
  ctx.fillRect(0, 0, W, H)
}

// Initial clear
clearGraph()

function safe(v, digits = 3) {
  return typeof v === 'number' && !isNaN(v) ? v.toFixed(digits) : '–'
}

// ---------------- LIBRARY RESULTS ----------------

const loadLibraryBtn = document.getElementById('loadLibraryBtn')
const libraryTable = document
  .getElementById('libraryTable')
  .querySelector('tbody')
const libNote = document.getElementById('libNote')

loadLibraryBtn.addEventListener('click', loadLibrary)

async function loadLibrary() {
  libraryTable.innerHTML = "<tr><td colspan='5'>Loading…</td></tr>"

  try {
    const res = await fetch('/api/library')
    const rows = await res.json()

    if (rows.error === 'no_summary_file') {
      libraryTable.innerHTML =
        "<tr><td colspan='5'>No summary file found.</td></tr>"
      return
    }
    libraryTable.innerHTML = ''

    rows.forEach((r) => {
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

      // Click to load detailed analysis
      tr.addEventListener('click', async () => {
        if (!r.syncinfo_path) {
          summaryPre.textContent = 'No analysis.syncinfo found for this movie.'
          clearGraph()
          return
        }

        summaryPre.textContent = 'Loading existing analysis…'

        try {
          const res = await fetch(
            `/api/movieinfo?file=${encodeURIComponent(r.syncinfo_path)}`
          )
          const data = await res.json()

          if (data.error) {
            summaryPre.textContent = 'Error: ' + data.error
            clearGraph()
            return
          }

          renderSummary(data)
          drawGraph(canvas, data.offsets || [])
        } catch (e) {
          summaryPre.textContent = 'Failed to load analysis: ' + e.message
          clearGraph()
        }
      })
      libraryTable.appendChild(tr)
    })

    libNote.textContent = 'Click any movie to analyze subtitle pairs in detail.'
  } catch (e) {
    libraryTable.innerHTML =
      "<tr><td colspan='5'>Error loading summary.</td></tr>"
    console.error('library error', e)
  }
}
