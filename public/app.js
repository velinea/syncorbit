let driftChart = null;

document.getElementById("runBtn").addEventListener("click", async () => {
  const reference = document.getElementById("refPath").value.trim();
  const target = document.getElementById("tgtPath").value.trim();
  if (!reference || !target) {
    alert("Please fill both paths");
    return;
  }

  document.getElementById("summary").textContent = "Running analysis...";

  try {
    const res = await fetch("/api/align", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reference, target })
    });

    const data = await res.json();
    if (!res.ok) {
      document.getElementById("summary").textContent =
        "Error:\n" + JSON.stringify(data, null, 2);
      return;
    }

    document.getElementById("summary").textContent =
      JSON.stringify({
        eng_path: data.eng_path,
        fin_path: data.fin_path,
        eng_count: data.eng_count,
        fin_count: data.fin_count,
        anchor_count: data.anchor_count,
        avg_offset_sec: data.avg_offset_sec,
        min_offset_sec: data.min_offset_sec,
        max_offset_sec: data.max_offset_sec,
        drift_span_sec: data.drift_span_sec
      }, null, 2);

    drawDriftChart(data.drift || []);

  } catch (e) {
    document.getElementById("summary").textContent = "Exception: " + e;
  }
});

function drawDriftChart(drift) {
  const ctx = document.getElementById("driftChart").getContext("2d");
  const labels = drift.map(p => p.t);
  const offsets = drift.map(p => p.offset);

  if (driftChart) {
    driftChart.destroy();
  }

  driftChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Offset (sec)",
        data: offsets,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.2
      }]
    },
    options: {
      scales: {
        x: {
          title: { display: true, text: "Reference time (sec)" }
        },
        y: {
          title: { display: true, text: "Target - Reference (sec)" }
        }
      }
    }
  });
}
