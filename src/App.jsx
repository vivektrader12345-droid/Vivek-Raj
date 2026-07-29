import React from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { AuthProvider, useAuth } from './context/AuthContext'
import { TradeProvider } from './context/TradeContext'
import { AlertProvider } from './context/AlertContext'
import { ThemeProvider } from './context/ThemeContext'
import { CurrencyProvider } from './context/CurrencyContext'
import Signup from './pages/Signup'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import AddTrade from './pages/AddTrade'
import TradeHistory from './pages/TradeHistory'
import Analytics from './pages/Analytics'
import Portfolio from './pages/Portfolio'
import Settings from './pages/Settings'
import Alerts from './pages/Alerts'
import Calendar from './pages/Calendar'
import AlgoTrading from './pages/AlgoTrading'
import WebhookIntelligence from './pages/WebhookIntelligence'
import ProTrading from './trading/ProTrading'
import Layout from './components/Layout'

function ProtectedRoute({ children }) {
  const { user } = useAuth()
  if (!user) return <Navigate to="/signup" />
  return children
}

function PublicRoute({ children }) {
  const { user } = useAuth()
  if (user) return <Navigate to="/" />
  return children
}

function App() {
  return (
    <ThemeProvider>
    <CurrencyProvider>
    <AuthProvider>
      <TradeProvider>
        <AlertProvider>
          <Router>
            <Toaster
              position="top-right"
              toastOptions={{
                style: {
                  background: '#1a1a2e',
                  color: '#fff',
                  border: '1px solid #0f3460',
                },
                success: { iconTheme: { primary: '#00c853', secondary: '#fff' } },
                error: { iconTheme: { primary: '#ff1744', secondary: '#fff' } },
              }}
            />
            <Routes>
              <Route path="/signup" element={<PublicRoute><Signup /></PublicRoute>} />
              <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
              <Route path="/pro-trading" element={<ProtectedRoute><ProTrading /></ProtectedRoute>} />
              <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
                <Route index element={<Dashboard />} />
                <Route path="add-trade" element={<AddTrade />} />
                <Route path="edit-trade/:id" element={<AddTrade />} />
                <Route path="history" element={<TradeHistory />} />
                <Route path="analytics" element={<Analytics />} />
                <Route path="portfolio" element={<Portfolio />} />
                <Route path="alerts" element={<Alerts />} />
                <Route path="calendar" element={<Calendar />} />
                <Route path="algo-trading" element={<AlgoTrading />} />
                <Route path="webhook-intelligence" element={<WebhookIntelligence />} />
                <Route path="settings" element={<Settings />} />
              </Route>
              <Route path="*" element={<Navigate to="/" />} />
            </Routes>
          </Router>
        </AlertProvider>
      </TradeProvider>
    </AuthProvider>
    </CurrencyProvider>
    </ThemeProvider>
  )
}

export default App
