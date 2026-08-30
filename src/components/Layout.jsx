import React, { useState } from 'react'
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useSubscription } from '../context/SubscriptionContext'
import { useAlerts } from '../context/AlertContext'
import { useTheme } from '../context/ThemeContext'
import { useCurrency } from '../context/CurrencyContext'
import ErrorBoundary from './ErrorBoundary'
import useAndroidApkDownload, { APK_DOWNLOAD_UI_PHASES } from './useAndroidApkDownload.js'
import {
  LayoutDashboard, PlusCircle, History, BarChart3, Briefcase,
  LogOut, Menu, X, Settings, Bell, ChevronLeft, CalendarDays, Sun, Moon, Bot,
  LineChart as LineChartIcon, RadioTower, Download, RefreshCw, CreditCard, Crown, Lock, Tags
} from 'lucide-react'

function Layout() {
  const { user, logout } = useAuth()
  const { subscription, active: subscriptionActive, isAdmin, hasPlan } = useSubscription()
  const { alerts } = useAlerts()
  const { theme, toggleTheme } = useTheme()
  const { currency, toggleCurrency, exchangeRate } = useCurrency()
  const location = useLocation()
  const navigate = useNavigate()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const download = useAndroidApkDownload()

  const activeAlerts = alerts.filter(a => a.active && !a.triggered).length

  const handleDownload = async () => {
    const result = await download.requestDownload()
    if (result?.status === 'requested') setSidebarOpen(false)
  }

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  const navItems = [
    { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/subscription', icon: Crown, label: 'Subscription' },
    { to: '/payments', icon: CreditCard, label: 'Payment History' },
    { to: '/add-trade', icon: PlusCircle, label: 'Add Trade' },
    { to: '/history', icon: History, label: 'Trade History' },
    { to: '/analytics', icon: BarChart3, label: 'Analytics', requiredPlan: 'pro' },
    { to: '/calendar', icon: CalendarDays, label: 'Calendar' },
    { to: '/algo-trading', icon: Bot, label: 'Algo Trading', requiredPlan: 'pro' },
    { to: '/webhook-intelligence', icon: RadioTower, label: 'Webhook Intelligence', requiredPlan: 'pro' },
    { to: '/pro-trading', icon: LineChartIcon, label: '⚡ Pro Trading', requiredPlan: 'elite' },
    { to: '/portfolio', icon: Briefcase, label: 'Portfolio' },
    { to: '/alerts', icon: Bell, label: 'Alerts', badge: activeAlerts },
    ...(isAdmin ? [
      { to: '/admin/plans', icon: Crown, label: 'Plan Admin' },
      { to: '/admin/coupons', icon: Tags, label: 'Coupon Admin' },
    ] : []),
    { to: '/settings', icon: Settings, label: 'Settings' },
  ]

  return (
    <div className="min-h-screen bg-[#060612] flex">
      {/* Mobile menu button */}
      <button
        type="button"
        aria-label={sidebarOpen ? 'Close navigation menu' : 'Open navigation menu'}
        aria-expanded={sidebarOpen}
        aria-controls="app-sidebar"
        className="lg:hidden fixed top-4 left-4 z-50 bg-[#1a1a2e] p-2.5 rounded-lg border border-[#0f3460] shadow-lg"
        onClick={() => setSidebarOpen(!sidebarOpen)}
      >
        {sidebarOpen ? <X size={20} className="text-white" /> : <Menu size={20} className="text-white" />}
      </button>

      {/* Sidebar */}
      <aside id="app-sidebar" className={`fixed lg:static inset-y-0 left-0 z-40 ${collapsed ? 'w-20' : 'w-72'} bg-gradient-to-b from-[#0a0a1f] via-[#12122a] to-[#0a0a1f] border-r border-[#2a2a5a]/30 transform transition-all duration-300 flex flex-col ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        {/* Header */}
        <div className={`p-5 border-b border-[#2a2a5a]/30 ${collapsed ? 'px-3' : ''}`}>
          <div className="flex items-center gap-3">
            <span className="text-3xl animate-float">🐂</span>
            {!collapsed && (
              <div>
                <h1 className="text-lg font-bold gradient-text">Vivek Marco</h1>
                <p className="text-xs text-gray-500">Trading Journal</p>
              </div>
            )}
          </div>
        </div>

        {/* User Card */}
        {!collapsed && (
          <div className="p-4">
            <div className="bg-gradient-to-r from-[#0f3460]/50 to-[#0a0a1a]/50 rounded-xl p-3 border border-[#0f3460]/30">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#e94560] via-[#d63384] to-[#f5a623] flex items-center justify-center font-bold text-white text-sm shadow-glow">
                  {user?.avatar || user?.fullName?.charAt(0) || 'U'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white font-medium truncate">{user?.fullName}</p>
                  <p className="text-xs text-gray-400 truncate">{user?.email}</p>
                  <span className={`mt-1.5 inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${subscriptionActive ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
                    <Crown size={10} /> {subscriptionActive ? `${subscription?.planId} active` : 'Upgrade plan'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Navigation */}
        <nav className="flex-1 px-3 py-2 space-y-1 overflow-y-auto">
          {navItems.map(({ to, icon: Icon, label, badge, requiredPlan }) => {
            const locked = requiredPlan && !hasPlan(requiredPlan)
            const target = locked ? '/subscription' : to
            return (
              <NavLink
                key={to}
                to={target}
                end={to === '/'}
                title={locked ? `${label} requires an active subscription` : undefined}
                onClick={() => setSidebarOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 group relative ${
                    isActive && !locked
                      ? 'nav-active'
                      : 'text-gray-400 hover:text-white hover:bg-[#2a2a5a]/20'
                  } ${collapsed ? 'justify-center px-3' : ''}`
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive && !locked && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-[#e94560] rounded-r-full"></div>}
                    <Icon size={20} />
                    {!collapsed && <span className="text-sm font-medium">{label}</span>}
                    {locked && <Lock size={14} className={collapsed ? 'absolute -right-1 -top-1 text-amber-400' : 'ml-auto text-amber-400'} aria-label="Subscription required" />}
                    {badge > 0 && (
                      <span className={`${collapsed ? 'absolute -top-1 -right-1' : 'ml-auto'} bg-[#e94560] text-white text-xs w-5 h-5 rounded-full flex items-center justify-center font-bold`}>
                        {badge}
                      </span>
                    )}
                  </>
                )}
              </NavLink>
            )
          })}
          {download.phase === APK_DOWNLOAD_UI_PHASES.AVAILABLE && (
            <button
              type="button"
              data-pwa-install
              onClick={() => { void handleDownload() }}
              title={collapsed ? 'Download App' : undefined}
              className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-gray-400 transition-all duration-200 hover:bg-[#2a2a5a]/20 hover:text-white ${collapsed ? 'justify-center px-3' : ''}`}
            >
              <Download size={20} aria-hidden="true" />
              {!collapsed && <span className="text-sm font-medium">Download App</span>}
            </button>
          )}
          {[APK_DOWNLOAD_UI_PHASES.IDLE, APK_DOWNLOAD_UI_PHASES.CHECKING, APK_DOWNLOAD_UI_PHASES.REQUESTING].includes(download.phase) && (
            <button
              type="button"
              data-pwa-install
              disabled
              aria-busy="true"
              title={collapsed ? (download.statusMessage || 'Checking app download availability') : undefined}
              className={`flex w-full cursor-wait items-center gap-3 rounded-xl px-4 py-3 text-gray-500 ${collapsed ? 'justify-center px-3' : ''}`}
            >
              <Download size={20} aria-hidden="true" />
              <span role="status" aria-live="polite" className={collapsed ? 'sr-only' : 'text-sm font-medium'}>
                {download.statusMessage || 'Checking app download availability'}
              </span>
            </button>
          )}
          {download.phase === APK_DOWNLOAD_UI_PHASES.UNAVAILABLE && (
            <div className="rounded-xl px-2 py-2 text-gray-400">
              <p role="status" aria-live="polite" className={collapsed ? 'sr-only' : 'px-2 text-xs'}>
                App download unavailable
              </p>
              <button
                type="button"
                data-pwa-install
                onClick={() => { void download.retry() }}
                title={collapsed ? 'Retry app download' : undefined}
                className={`mt-1 flex w-full items-center gap-3 rounded-xl px-4 py-3 transition-all duration-200 hover:bg-[#2a2a5a]/20 hover:text-white ${collapsed ? 'justify-center px-3' : ''}`}
              >
                <RefreshCw size={20} aria-hidden="true" />
                {!collapsed && <span className="text-sm font-medium">Retry</span>}
              </button>
            </div>
          )}
          {download.phase === APK_DOWNLOAD_UI_PHASES.MANUAL && (
            <div className="rounded-xl px-2 py-2 text-gray-400">
              <p role="status" aria-live="polite" className={collapsed ? 'sr-only' : 'px-2 text-xs leading-relaxed'}>
                {download.statusMessage} If nothing happens, retry or open this page in a supported browser.
              </p>
              <a
                data-pwa-install
                href={download.manualUrl}
                download="vivek-marco-trader.apk"
                onClick={download.handleManualDownload}
                title={collapsed ? 'Manual download' : undefined}
                className={`mt-1 flex w-full items-center gap-3 rounded-xl px-4 py-3 transition-all duration-200 hover:bg-[#2a2a5a]/20 hover:text-white ${collapsed ? 'justify-center px-3' : ''}`}
              >
                <Download size={20} aria-hidden="true" />
                {!collapsed && <span className="text-sm font-medium">Manual download</span>}
              </a>
              {!collapsed && (
                <button
                  type="button"
                  onClick={() => { void handleDownload() }}
                  className="mt-1 flex w-full items-center gap-3 rounded-xl px-4 py-2 text-gray-400 transition-all duration-200 hover:bg-[#2a2a5a]/20 hover:text-white"
                >
                  <RefreshCw size={18} aria-hidden="true" />
                  <span className="text-sm font-medium">Retry</span>
                </button>
              )}
            </div>
          )}
        </nav>

        {/* Theme Toggle & Collapse */}
        <div className="hidden lg:block px-3 py-2 border-t border-[#2a2a5a]/30 space-y-1">
          <button
            onClick={toggleTheme}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-gray-400 hover:text-white hover:bg-[#2a2a5a]/20 transition-all w-full ${collapsed ? 'justify-center px-3' : ''}`}
          >
            {theme === 'dark' ? <Sun size={20} className="text-yellow-400" /> : <Moon size={20} className="text-blue-400" />}
            {!collapsed && <span className="text-sm">{theme === 'dark' ? '☀️ Light' : '🌙 Dark'}</span>}
          </button>
          <button
            onClick={() => setCollapsed(!collapsed)}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-gray-400 hover:text-white hover:bg-[#2a2a5a]/20 transition-all w-full ${collapsed ? 'justify-center px-3' : ''}`}
          >
            <ChevronLeft size={20} className={`transition-transform ${collapsed ? 'rotate-180' : ''}`} />
            {!collapsed && <span className="text-sm">Collapse</span>}
          </button>
        </div>

        {/* Logout */}
        <div className="p-3 border-t border-[#0f3460]/30">
          <button
            onClick={handleLogout}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-all w-full ${collapsed ? 'justify-center px-3' : ''}`}
          >
            <LogOut size={20} />
            {!collapsed && <span className="text-sm font-medium">Logout</span>}
          </button>
        </div>
      </aside>

      {/* Overlay for mobile */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-30 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main content */}
      <main className="flex-1 p-4 lg:p-8 overflow-auto min-h-screen">
        <div className="lg:hidden h-14"></div> {/* Spacer for mobile menu button */}
        {/* Top Bar with Currency Toggle */}
        <div className="flex items-center justify-end gap-3 mb-6">
          <button onClick={toggleCurrency}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all border ${
              currency === 'INR'
                ? 'bg-[#f5a623]/10 border-[#f5a623]/40 text-[#f5a623] hover:bg-[#f5a623]/20'
                : 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/20'
            }`}>
            {currency === 'INR' ? '💰 ₹ INR' : '💵 $ USD'}
          </button>
          <span className="text-gray-500 text-xs">1 USD = ₹{exchangeRate.toFixed(2)}</span>
        </div>
        <ErrorBoundary key={`${location.pathname}${location.search}`}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  )
}

export default Layout
