export function drawGraph(canvas, anchors) {
  const ctx = canvas.getContext('2d')
  const W = (canvas.width = canvas.clientWidth)
  const H = (canvas.height = canvas.clientHeight)

  ctx.clearRect(0, 0, W, H)

  if (!anchors.length) return

  // Normalize data
  const xs = anchors.map((a) => a.ref_t ?? a.t_ref ?? 0)
  const ys = anchors.map((a) => a.delta ?? a.offset ?? 0)

  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)

  const spanX = maxX - minX || 1
  const spanY = maxY - minY || 1

  const toCanvasX = (t) => ((t - minX) / spanX) * W
  const toCanvasY = (d) => H - ((d - minY) / spanY) * H

  // Draw line
  ctx.strokeStyle = '#4fc3f7'
  ctx.lineWidth = 1.3
  ctx.beginPath()
  xs.forEach((t, i) => {
    const x = toCanvasX(t)
    const y = toCanvasY(ys[i])
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })

  ctx.stroke()

  // Draw points
  ctx.fillStyle = '#93c5fd'
  xs.forEach((t, i) => {
    const x = toCanvasX(t)
    const y = toCanvasY(ys[i])
    ctx.beginPath()
    ctx.arc(x, y, 2, 0, Math.PI * 2)
    ctx.fill()
  })

  // Tooltip
  const tip = document.createElement('div')
  tip.className = 'graph-tooltip'
  tip.style.position = 'fixed'
  tip.style.pointerEvents = 'none'
  tip.style.padding = '4px 8px'
  tip.style.background = 'rgba(0,0,0,0.75)'
  tip.style.borderRadius = '4px'
  tip.style.fontSize = '12px'
  tip.style.color = '#fff'
  tip.style.display = 'none'
  document.body.appendChild(tip)

  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    let closest = -1
    let bestDist = 1e12

    xs.forEach((t, i) => {
      const dx = toCanvasX(t) - mx
      const dy = toCanvasY(ys[i]) - my
      const dist = dx * dx + dy * dy
      if (dist < bestDist) {
        bestDist = dist
        closest = i
      }
    })

    if (closest === -1) return

    const x = toCanvasX(xs[closest])
    const y = toCanvasY(ys[closest])

    const tSeconds = xs[closest]
    const mm = Math.floor(tSeconds / 60)
    const ss = Math.floor(tSeconds % 60)
    const timeStr = `${mm}:${ss.toString().padStart(2, '0')}`

    tip.textContent = `${timeStr}  |  Δ ${ys[closest].toFixed(3)}s`
    tip.style.left = `${rect.left + x + 15}px`
    tip.style.top = `${rect.top + y - 10}px`
    tip.style.display = 'block'
  }

  canvas.onmouseleave = () => {
    tip.style.display = 'none'
  }
}

function cubicSpline(xs, ys) {
  const n = xs.length
  if (n < 3) return { xs, ys } // not enough points to spline

  const a = ys.slice()
  const b = Array(n).fill(0)
  const d = Array(n).fill(0)
  const h = Array(n - 1)

  for (let i = 0; i < n - 1; i++) {
    h[i] = xs[i + 1] - xs[i]
  }

  // Build tridiagonal system
  const alpha = Array(n - 1).fill(0)
  for (let i = 1; i < n - 1; i++) {
    alpha[i] =
      (3 / h[i]) * (a[i + 1] - a[i]) - (3 / h[i - 1]) * (a[i] - a[i - 1])
  }

  const c = Array(n).fill(0)
  const l = Array(n).fill(0)
  const mu = Array(n).fill(0)
  const z = Array(n).fill(0)

  l[0] = 1
  mu[0] = 0
  z[0] = 0

  for (let i = 1; i < n - 1; i++) {
    l[i] = 2 * (xs[i + 1] - xs[i - 1]) - h[i - 1] * mu[i - 1]
    mu[i] = h[i] / l[i]
    z[i] = (alpha[i] - h[i - 1] * z[i - 1]) / l[i]
  }

  l[n - 1] = 1
  z[n - 1] = 0
  c[n - 1] = 0

  for (let j = n - 2; j >= 0; j--) {
    c[j] = z[j] - mu[j] * c[j + 1]
    b[j] = (a[j + 1] - a[j]) / h[j] - (h[j] * (c[j + 1] + 2 * c[j])) / 3
    d[j] = (c[j + 1] - c[j]) / (3 * h[j])
  }

  // Build interpolated curve (dense x points)
  const denseX = []
  const denseY = []

  const STEPS = 6 // samples per interval (smoothness)
  for (let i = 0; i < n - 1; i++) {
    const step = (xs[i + 1] - xs[i]) / STEPS
    for (let k = 0; k < STEPS; k++) {
      const x = xs[i] + k * step
      const dx = x - xs[i]
      const y = a[i] + b[i] * dx + c[i] * dx * dx + d[i] * dx * dx * dx

      denseX.push(x)
      denseY.push(y)
    }
  }

  // Add final point
  denseX.push(xs[n - 1])
  denseY.push(ys[n - 1])

  return { xs: denseX, ys: denseY }
}
