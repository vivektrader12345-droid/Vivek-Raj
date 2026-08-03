import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const directory = path.dirname(fileURLToPath(import.meta.url))
const chartRecorder = path.join(directory, 'lightweightChartsRecorder.js')
const tradeContextMock = path.join(directory, 'mockTradeContext.js')
const lucideCompat = path.join(directory, '..', 'geometry', 'mocks', 'lucideReactCompat.js')

export default defineConfig({
  plugins: [
    {
      name: 'preservation-characterization-boundaries',
      enforce: 'pre',
      resolveId(source, importer) {
        if (source === 'lightweight-charts') return chartRecorder
        if (source === 'lucide-react') return lucideCompat
        const normalizedImporter = importer?.replaceAll('\\', '/')
        if (source === '../context/TradeContext' && normalizedImporter?.endsWith('/src/trading/useTradeBridge.js')) {
          return tradeContextMock
        }
        return null
      },
    },
    react(),
  ],
})
