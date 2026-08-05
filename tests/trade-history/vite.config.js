import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const directory = path.dirname(fileURLToPath(import.meta.url))
const fixturePath = '/tests/trade-history/tradeHistory.fixture.html'
const contextMock = path.join(directory, 'mockContexts.js')
const contextModules = new Set([
  'AuthContext',
  'TradeContext',
  'CurrencyContext',
  'AlertContext',
  'ThemeContext',
])

export default defineConfig({
  plugins: [
    {
      name: 'trade-history-context-boundaries',
      enforce: 'pre',
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          const requestUrl = new URL(request.url, 'http://trade-history.test')
          if (requestUrl.pathname === '/history') {
            request.url = `${fixturePath}${requestUrl.search}`
          }
          next()
        })
      },
      resolveId(source) {
        const contextName = source.match(/(?:^|\/)context\/([^/]+?)(?:\.jsx)?$/)?.[1]
        return contextModules.has(contextName) ? contextMock : null
      },
    },
    react(),
  ],
})
