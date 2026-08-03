import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const geometryDirectory = path.dirname(fileURLToPath(import.meta.url))
const bridgeMock = path.join(geometryDirectory, 'mocks', 'useTradeBridge.js')
const lucideCompat = path.join(geometryDirectory, 'mocks', 'lucideReactCompat.js')

export default defineConfig({
  plugins: [
    {
      name: 'terminal-geometry-test-boundaries',
      enforce: 'pre',
      resolveId(source, importer) {
        if (source === 'lucide-react') return lucideCompat
        const normalizedImporter = importer?.replaceAll('\\', '/')
        if (source === './useTradeBridge' && normalizedImporter?.endsWith('/src/trading/ProTrading.jsx')) {
          return bridgeMock
        }
        return null
      },
    },
    react(),
  ],
})
