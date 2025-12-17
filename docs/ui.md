# UI data flow

    batch_scan.py
    ↓
    syncorbit_library_summary.csv
    ↓
    /api/library
    ↓
    loadLibrary()
    ↓
    renderLibraryTable(rows)

    User clicks movie row
    ↓
    /api/analysis/:movie
    ↓
    openLibraryAnalysis()
    ↓
    renderSummary()
    ↓
    drawGraph()
