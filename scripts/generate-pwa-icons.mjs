import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = path.join(root, 'public', 'icons')

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let current = value
  for (let bit = 0; bit < 8; bit += 1) current = (current & 1) ? 0xedb88320 ^ (current >>> 1) : current >>> 1
  return current >>> 0
})

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const name = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, checksum])
}

function blendPixel(pixels, size, x, y, color, alpha = 1) {
  const px = Math.round(x)
  const py = Math.round(y)
  if (px < 0 || py < 0 || px >= size || py >= size) return
  const offset = (py * size + px) * 4
  const sourceAlpha = Math.max(0, Math.min(1, alpha))
  pixels[offset] = Math.round(pixels[offset] * (1 - sourceAlpha) + color[0] * sourceAlpha)
  pixels[offset + 1] = Math.round(pixels[offset + 1] * (1 - sourceAlpha) + color[1] * sourceAlpha)
  pixels[offset + 2] = Math.round(pixels[offset + 2] * (1 - sourceAlpha) + color[2] * sourceAlpha)
  pixels[offset + 3] = 255
}

function fillCircle(pixels, size, centerX, centerY, radius, color, alpha = 1) {
  const startX = Math.floor(centerX - radius)
  const endX = Math.ceil(centerX + radius)
  const startY = Math.floor(centerY - radius)
  const endY = Math.ceil(centerY + radius)
  const radiusSquared = radius * radius
  for (let y = startY; y <= endY; y += 1) {
    for (let x = startX; x <= endX; x += 1) {
      const distanceSquared = (x - centerX) ** 2 + (y - centerY) ** 2
      if (distanceSquared <= radiusSquared) blendPixel(pixels, size, x, y, color, alpha)
    }
  }
}

function fillRect(pixels, size, left, top, width, height, color, alpha = 1) {
  for (let y = Math.floor(top); y < Math.ceil(top + height); y += 1) {
    for (let x = Math.floor(left); x < Math.ceil(left + width); x += 1) blendPixel(pixels, size, x, y, color, alpha)
  }
}

function drawLine(pixels, size, start, end, thickness, color) {
  const steps = Math.max(Math.abs(end[0] - start[0]), Math.abs(end[1] - start[1]))
  for (let step = 0; step <= steps; step += 1) {
    const progress = steps === 0 ? 0 : step / steps
    fillCircle(
      pixels,
      size,
      start[0] + (end[0] - start[0]) * progress,
      start[1] + (end[1] - start[1]) * progress,
      thickness / 2,
      color,
    )
  }
}

function createIcon(size) {
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4
      const glow = Math.max(0, 1 - Math.hypot(x - size * 0.32, y - size * 0.18) / (size * 0.9))
      pixels[offset] = Math.round(6 + 20 * glow)
      pixels[offset + 1] = Math.round(6 + 11 * glow)
      pixels[offset + 2] = Math.round(18 + 34 * glow)
      pixels[offset + 3] = 255
    }
  }

  const panelInset = size * 0.12
  fillRect(pixels, size, panelInset, panelInset, size - panelInset * 2, size - panelInset * 2, [15, 52, 96], 0.36)

  const coinX = size * 0.36
  const coinY = size * 0.39
  fillCircle(pixels, size, coinX, coinY, size * 0.205, [233, 69, 96], 0.95)
  fillCircle(pixels, size, coinX, coinY, size * 0.155, [10, 10, 31], 0.9)
  fillCircle(pixels, size, coinX, coinY, size * 0.112, [245, 166, 35], 0.95)
  drawLine(pixels, size, [coinX, size * 0.30], [coinX, size * 0.48], size * 0.025, [255, 244, 220])
  drawLine(pixels, size, [size * 0.31, size * 0.34], [size * 0.41, size * 0.34], size * 0.022, [255, 244, 220])
  drawLine(pixels, size, [size * 0.31, size * 0.44], [size * 0.41, size * 0.44], size * 0.022, [255, 244, 220])

  const bars = [
    [0.55, 0.61, 0.07, 0.16, [233, 69, 96]],
    [0.66, 0.51, 0.07, 0.26, [214, 51, 132]],
    [0.77, 0.37, 0.07, 0.40, [245, 166, 35]],
  ]
  for (const [left, top, width, height, color] of bars) {
    fillRect(pixels, size, size * left, size * top, size * width, size * height, color)
  }

  const chartPoints = [[0.22, 0.73], [0.37, 0.65], [0.50, 0.69], [0.63, 0.55], [0.79, 0.27]]
  for (let index = 1; index < chartPoints.length; index += 1) {
    drawLine(
      pixels,
      size,
      chartPoints[index - 1].map(value => value * size),
      chartPoints[index].map(value => value * size),
      size * 0.025,
      [255, 255, 255],
    )
  }
  const arrow = chartPoints.at(-1).map(value => value * size)
  drawLine(pixels, size, [arrow[0] - size * 0.09, arrow[1]], arrow, size * 0.025, [255, 255, 255])
  drawLine(pixels, size, [arrow[0], arrow[1] + size * 0.09], arrow, size * 0.025, [255, 255, 255])

  const scanlines = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y += 1) {
    const rowOffset = y * (size * 4 + 1)
    scanlines[rowOffset] = 0
    pixels.copy(scanlines, rowOffset + 1, y * size * 4, (y + 1) * size * 4)
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

await mkdir(outputDirectory, { recursive: true })
for (const size of [192, 512]) {
  await writeFile(path.join(outputDirectory, `icon-${size}.png`), createIcon(size))
}
console.log(`Generated PWA icons in ${path.relative(root, outputDirectory)}`)
