import React, { Suspense, lazy } from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { AuthProvider, useAuth } from './context/AuthContext'
import { SubscriptionProvider } from './context/SubscriptionContext'
import { TradeProvider } from './context/TradeContext'
import { AlertProvider } from './context/AlertContext'
import { ThemeProvider } from './context/ThemeContext'
import { CurrencyProvider } from './context/CurrencyContext'
import ErrorBoundary from './components/ErrorBoundary'
import PublicDownloadMenu from './components/PublicDownloadMenu'
import SubscriptionRoute from './components/SubscriptionRoute'
import AdminRoute from './components/AdminRoute'

const Signup = lazy(() => import('./pages/Signup'))
const Login = lazy(() => import('./pages/Login'))
const Subscription = lazy(() => import('./pages/Subscription'))
const PaymentSuccess = lazy(() => import('./pages/PaymentSuccess'))
const PaymentPending = lazy(() => import('./pages/PaymentPending'))
const PaymentFailed = lazy(() => import('./pages/PaymentFailed'))
const PaymentHistory = lazy(() => import('./pages/PaymentHistory'))
const AdminPlans = lazy(() => import('./pages/AdminPlans'))
const AdminCoupons = lazy(() => import('./pages/AdminCoupons'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const AddTrade = lazy(() => import('./pages/AddTrade'))
const TradeHistory = lazy(() => import('./pages/TradeHistory'))
const Analytics = lazy(() => import('./pages/Analytics'))
const Portfolio = lazy(() => import('./pages/Portfolio'))
const Settings = lazy(() => import('./pages/Settings'))
const Alerts = lazy(() => import('./pages/Alerts'))
const Calendar = lazy(() => import('./pages/Calendar'))
const AlgoTrading = lazy(() => import('./pages/AlgoTrading'))
const WebhookIntelligence = lazy(() => import('./pages/WebhookIntelligence'))
const ProTrading = lazy(() => import('./trading/ProTrading'))
const Layout = lazy(() => import('./components/Layout'))

function ProtectedRoute({ children }) {
  const { user } = useAuth()
  if (!user) return <Navigate to="/signup" replace />
  return children
}

function PublicRoute({ children }) {
  const { user } = useAuth()
  if (user) return <Navigate to="/subscription" replace />
  return <><PublicDownloadMenu />{children}</>
}

function RouteFallback() {
  return <div className="flex min-h-screen items-center justify-center bg-[#0a0a1f] text-sm text-slate-300" role="status">Loading application…</div>
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <CurrencyProvider>
          <AuthProvider>
            <SubscriptionProvider>
              <TradeProvider>
                <AlertProvider>
                  <Router>
                    <Toaster position="top-right" toastOptions={{
                      style: { background: '#1a1a2e', color: '#fff', border: '1px solid #0f3460' },
                      success: { iconTheme: { primary: '#00c853', secondary: '#fff' } },
                      error: { iconTheme: { primary: '#ff1744', secondary: '#fff' } },
                    }} />
                    <Suspense fallback={<RouteFallback />}>
                      <Routes>
                        <Route path="/signup" element={<PublicRoute><Signup /></PublicRoute>} />
                        <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
                        <Route path="/subscription" element={<ProtectedRoute><Subscription /></ProtectedRoute>} />
                        <Route path="/payment-success" element={<ProtectedRoute><PaymentSuccess /></ProtectedRoute>} />
                        <Route path="/payment-pending" element={<ProtectedRoute><PaymentPending /></ProtectedRoute>} />
                        <Route path="/payment-failed" element={<ProtectedRoute><PaymentFailed /></ProtectedRoute>} />
                        <Route path="/pro-trading" element={<ProtectedRoute><SubscriptionRoute requiredPlan="elite"><ProTrading /></SubscriptionRoute></ProtectedRoute>} />
                        <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
                          <Route index element={<Dashboard />} />
                          <Route path="add-trade" element={<AddTrade />} />
                          <Route path="edit-trade/:id" element={<AddTrade />} />
                          <Route path="history" element={<TradeHistory />} />
                          <Route path="analytics" element={<SubscriptionRoute requiredPlan="pro"><Analytics /></SubscriptionRoute>} />
                          <Route path="portfolio" element={<Portfolio />} />
                          <Route path="alerts" element={<Alerts />} />
                          <Route path="calendar" element={<Calendar />} />
                          <Route path="algo-trading" element={<SubscriptionRoute requiredPlan="pro"><AlgoTrading /></SubscriptionRoute>} />
                          <Route path="webhook-intelligence" element={<SubscriptionRoute requiredPlan="pro"><WebhookIntelligence /></SubscriptionRoute>} />
                          <Route path="payments" element={<PaymentHistory />} />
                          <Route path="admin/plans" element={<AdminRoute><AdminPlans /></AdminRoute>} />
                          <Route path="admin/coupons" element={<AdminRoute><AdminCoupons /></AdminRoute>} />
                          <Route path="settings" element={<Settings />} />
                        </Route>
                        <Route path="*" element={<Navigate to="/" replace />} />
                      </Routes>
                    </Suspense>
                  </Router>
                </AlertProvider>
              </TradeProvider>
            </SubscriptionProvider>
          </AuthProvider>
        </CurrencyProvider>
      </ThemeProvider>
    </ErrorBoundary>
  )
}

export default App
