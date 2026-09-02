import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const directory = path.dirname(fileURLToPath(import.meta.url))
const fixturePath = '/tests/complimentary-admin/complimentaryAdmin.fixture.html'
const contextMock = path.join(directory, 'mockContexts.js')
const billingMock = path.join(directory, 'mockBillingService.js')
const firebaseMock = path.join(directory, 'mockFirebase.js')
const downloadMock = path.join(directory, 'mockUseAndroidApkDownload.js')
const lucideMock = path.join(directory, 'mockLucideReact.jsx')
const mockedContexts = new Set(['AuthContext', 'AlertContext', 'ThemeContext', 'CurrencyContext'])

export default defineConfig({
  cacheDir: path.join(directory, '.vite-cache'),
  optimizeDeps: { entries: [path.join(directory, 'complimentaryAdmin.fixture.html')] },
  plugins: [
    {
      name: 'complimentary-admin-boundaries',
      enforce: 'pre',
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          const requestUrl = new URL(request.url, 'http://complimentary-admin.test')
          if (['/', '/probe', '/admin/complimentary-subscriptions', '/admin/plans', '/admin/coupons'].includes(requestUrl.pathname)) {
            request.url = `${fixturePath}${requestUrl.search}`
          }
          next()
        })
      },
      resolveId(source) {
        const contextName = source.match(/(?:^|\/)([^/]+?)(?:\.jsx)?$/)?.[1]
        if (mockedContexts.has(contextName)) return contextMock
        if (/(?:^|\/)services\/billingService(?:\.js)?$/.test(source)) return billingMock
        if (/(?:^|\/)firebase\.js$/.test(source)) return firebaseMock
        if (/(?:^|\/)useAndroidApkDownload\.js$/.test(source)) return downloadMock
        if (source === 'lucide-react') return lucideMock
        return null
      },
    },
    react(),
  ],
})
