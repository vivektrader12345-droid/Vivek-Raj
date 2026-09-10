import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const iconDirectory = path.join(root, 'public', 'icons')

function pngDimensions(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) {
    throw new Error('Brand asset is not a valid PNG')
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

const requiredAssets = new Map([
  ['favicon-48.png', 48],
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-maskable-192.png', 192],
  ['icon-maskable-512.png', 512],
])

await access(path.join(iconDirectory, 'vmt-logo-source.jpg'))
for (const [name, expectedSize] of requiredAssets) {
  const bytes = await readFile(path.join(iconDirectory, name))
  const dimensions = pngDimensions(bytes)
  if (dimensions.width !== expectedSize || dimensions.height !== expectedSize) {
    throw new Error(`${name} must be ${expectedSize}x${expectedSize}, received ${dimensions.width}x${dimensions.height}`)
  }
}

console.log(`Verified ${requiredAssets.size} Vivek Marco Trader branding assets`)
