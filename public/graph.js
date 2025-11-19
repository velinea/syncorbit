export function drawGraph(canvas, anchors) {
  const ctx = canvas.getContext('2d')

  const W = (canvas.width = canvas.clientWidth)
  const H = (canvas.height = canvas.clientHeight)

  ctx.clearRect(0, 0, W, H)

  if (!anchors.length) return

  const minOff = Math.min(...anchors.map((a) => a.offset))
  const maxOff = Math.max(...anchors.map((a) => a.offset))

  const span = maxOff - minOff || 1

  ctx.strokeStyle = '#4fc3f7'
  ctx.beginPath()

  anchors.forEach((a, i) => {
    const x = (i / (anchors.length - 1)) * W
    const y = H - ((a.offset - minOff) / span) * H
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })

  ctx.stroke()
}
