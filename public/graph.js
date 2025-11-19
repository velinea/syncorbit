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
    ctx.arc(x, y, 3, 0, Math.PI * 2)
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
