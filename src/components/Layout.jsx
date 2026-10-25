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
  canAccessAdminCapability,
  entitlementSourceLabel,
  formatEntitlementValidity,
} from '../services/subscriptionEntitlements.js'
import {
  LayoutDashboard, PlusCircle, History, BarChart3, Briefcase,
  LogOut, Menu, X, Settings, Bell, ChevronLeft, CalendarDays, Sun, Moon, Bot,
  LineChart as LineChartIcon, RadioTower, Download, RefreshCw, CreditCard, Crown, Gift, Lock, Tags, Headphones
} from 'lucide-react'

function activateDownloadWithSpace(event) {
  if (event.key !== ' ') return
  event.preventDefault()
  event.currentTarget.click()
}

function Layout() {
  const { user, logout } = useAuth()
  const { subscription, active: subscriptionActive, isAdmin, adminCapabilities, hasPlan } = useSubscription()
  const { alerts } = useAlerts()
  const { theme, toggleTheme } = useTheme()
  const { currency, toggleCurrency, exchangeRate } = useCurrency()
  const location = useLocation()
  const navigate = useNavigate()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const download = useAndroidApkDownload()

  const activeAlerts = alerts.filter(a => a.active && !a.triggered).length
  const complimentaryAdminEnabled = canAccessAdminCapability(
    isAdmin,
    adminCapabilities,
    'complimentarySubscriptions',
  )
  const accessSourceLabel = entitlementSourceLabel(subscription)
  const accessValidity = formatEntitlementValidity(subscription)
  const effectivePlanLabel = subscription?.planName || subscription?.planId || subscription?.entitlementTier || 'Premium'

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
    ...(isAdmin === true ? [
      { to: '/admin/plans', icon: Crown, label: 'Plan Admin' },
      { to: '/admin/coupons', icon: Tags, label: 'Coupon Admin' },
    ] : []),
    ...(complimentaryAdminEnabled ? [
      { to: '/admin/complimentary-subscriptions', icon: Gift, label: 'Complimentary Subscriptions' },
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
                  <span
                    className={`mt-1.5 inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${subscriptionActive ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}
                    title={subscriptionActive && accessValidity ? `${accessSourceLabel} · ${accessValidity}` : undefined}
                  >
                    <Crown size={10} /> {subscriptionActive ? `${subscription.source === 'complimentary' ? 'Complimentary' : 'Active'} ${effectivePlanLabel}` : 'Upgrade plan'}
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
            <a
              data-pwa-install
              href={download.manualUrl}
              download="vivek-marco-trader.apk"
              onClick={() => setSidebarOpen(false)}
              onKeyDown={activateDownloadWithSpace}
              title={collapsed ? 'Download App' : undefined}
              className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-gray-400 transition-all duration-200 hover:bg-[#2a2a5a]/20 hover:text-white ${collapsed ? 'justify-center px-3' : ''}`}
            >
              <Download size={20} aria-hidden="true" />
              {!collapsed && <span className="text-sm font-medium">Download App</span>}
            </a>
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
                onKeyDown={activateDownloadWithSpace}
                title={collapsed ? 'Manual download' : undefined}
                className={`mt-1 flex w-full items-center gap-3 rounded-xl px-4 py-3 transition-all duration-200 hover:bg-[#2a2a5a]/20 hover:text-white ${collapsed ? 'justify-center px-3' : ''}`}
              >
                <Download size={20} aria-hidden="true" />
                {!collapsed && <span className="text-sm font-medium">Manual download</span>}
              </a>
              {!collapsed && (
                <button
                  type="button"
                  onClick={() => { void download.retry() }}
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
          {/* Customer Support Section */}
          {!collapsed && (
            <div className="mb-3 px-2">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Customer Support</p>
              <div className="space-y-2">
                {/* Email Support */}
                <a
                  href="mailto:vivekroy3173@gmail.com"
                  className="flex items-center gap-3 px-3 py-2 rounded-lg text-gray-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-all text-sm"
                  onClick={() => setSidebarOpen(false)}
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M2.003 5.884L10 9.882l7.997-3.998A2 2 0 0016 4H4a2 2 0 00-1.997 1.884z" />
                    <path d="M18 8.118l-8 4-8-4V14a2 2 0 002 2h12a2 2 0 002-2V8.118z" />
                  </svg>
                  <span>Email Support</span>
                </a>
                
                {/* WhatsApp Support */}
                <a
                  href="https://wa.me/916201594389"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 px-3 py-2 rounded-lg text-gray-400 hover:text-green-400 hover:bg-green-500/10 transition-all text-sm"
                  onClick={() => setSidebarOpen(false)}
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                  </svg>
                  <span>WhatsApp</span>
                </a>
              </div>
            </div>
          )}
          
          {/* Collapsed Customer Support Icon */}
          {collapsed && (
            <div className="mb-3">
              <a
                href="mailto:vivekroy3173@gmail.com"
                title="Customer Support"
                className="flex items-center justify-center px-3 py-3 rounded-xl text-gray-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-all"
                onClick={() => setSidebarOpen(false)}
              >
                <Headphones size={20} />
              </a>
            </div>
          )}
          
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
