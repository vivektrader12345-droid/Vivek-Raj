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

function validateIco(bytes) {
  if (bytes.length < 30 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1 || bytes.readUInt16LE(4) !== 1) {
    throw new Error('favicon.ico must be a single-image ICO file')
  }
  if (bytes[6] !== 48 || bytes[7] !== 48 || bytes.readUInt32LE(18) !== 22) {
    throw new Error('favicon.ico must contain the 48x48 brand icon')
  }
  pngDimensions(bytes.subarray(22))
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
const crawlerFavicon = await readFile(path.join(root, 'public', 'favicon-vmt-48.png'))
const crawlerDimensions = pngDimensions(crawlerFavicon)
if (crawlerDimensions.width !== 48 || crawlerDimensions.height !== 48) {
  throw new Error('favicon-vmt-48.png must be 48x48')
}
validateIco(await readFile(path.join(root, 'public', 'favicon.ico')))
for (const [name, expectedSize] of requiredAssets) {
  const bytes = await readFile(path.join(iconDirectory, name))
  const dimensions = pngDimensions(bytes)
  if (dimensions.width !== expectedSize || dimensions.height !== expectedSize) {
    throw new Error(`${name} must be ${expectedSize}x${expectedSize}, received ${dimensions.width}x${dimensions.height}`)
  }
}

console.log(`Verified ${requiredAssets.size} Vivek Marco Trader branding assets`)
