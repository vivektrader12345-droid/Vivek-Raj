import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const directory = path.dirname(fileURLToPath(import.meta.url))
const mocks = path.join(directory, 'preservation.mocks.jsx')
const mockedContexts = new Set([
  '../context/AuthContext',
  '../context/SubscriptionContext',
  '../context/AlertContext',
  '../context/ThemeContext',
  '../context/CurrencyContext',
])

export default defineConfig({
  cacheDir: path.join(directory, '.vite-preservation-cache'),
  optimizeDeps: {
    entries: [path.join(directory, 'preservation.fixture.html')],
  },
  plugins: [
    {
      name: 'apk-preservation-contexts',
      enforce: 'pre',
      resolveId(source) {
        return mockedContexts.has(source) ? mocks : null
      },
    },
    react(),
  ],
})
