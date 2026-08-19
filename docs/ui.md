# UI data flow

    batch_scan.py                ← writes SQLite (movies) + syncorbit_library_export.csv
    ↓
    SQLite db (syncorbit.db)     ← /api/library reads from here (CSV is a side artifact)
    ↓
    /api/library
    ↓
    loadLibrary()
    ↓
    renderLibraryTable(rows)

    User clicks movie row
    ↓
    /api/analysis/:movie          ← reads analysis/<movie>/analysis.syncinfo
    ↓
    openLibraryAnalysis()
    ↓
    renderSummary()
    ↓
    drawGraph()                   ← clean_offsets / offsets (public/graph.js)

    User clicks "Auto-correct"
    ↓
    /api/autocorrect              ← runs autocorrect.py, writes data/autocorrect/*.corrected.srt
    ↓
    /api/autocorrect/download?filename=…  ← download the corrected subtitle