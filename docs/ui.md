# UI data flow

    batch_scan.py
    ↓
    SQLite db (syncorbit_library_export.csv)
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
