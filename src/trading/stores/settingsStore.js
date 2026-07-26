/**
 * Settings Store - Zustand
 * Manages UI settings, preferences, and layout
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

const useSettingsStore = create(
  persist(
    (set, get) => ({
      // ==================== STATE ====================
      theme: 'dark',
      chartStyle: 'candles', // 'candles', 'line', 'area'

      // Layout
      showSidebar: true,
      sidebarTab: 'positions', // 'positions', 'orders', 'history', 'account'
      showOrderPanel: true,

      // Chart preferences
      showGrid: true,
      showCrosshair: true,
      showVolume: true,
      showPnlOverlay: true,
      showOrderLines: true,
      showPositionLines: true,
      showLiquidationLine: true,
      showTradeMarkers: true,
      showFloatingPnl: true,

      // Order defaults
      defaultLeverage: 10,
      defaultQty: 1,
      defaultOrderType: 'market',
      showConfirmation: true,

      // Notifications
      soundEnabled: true,
      notifyOnFill: true,
      notifyOnSL: true,
      notifyOnTP: true,
      notifyOnLiquidation: true,

      // ==================== ACTIONS ====================
      setTheme: (theme) => set({ theme }),
      setChartStyle: (style) => set({ chartStyle: style }),
      toggleSidebar: () => set(s => ({ showSidebar: !s.showSidebar })),
      setSidebarTab: (tab) => set({ sidebarTab: tab }),
      toggleOrderPanel: () => set(s => ({ showOrderPanel: !s.showOrderPanel })),
      setDefaultLeverage: (lev) => set({ defaultLeverage: lev }),
      setDefaultQty: (qty) => set({ defaultQty: qty }),

      updateSetting: (key, value) => set({ [key]: value }),
      toggleSetting: (key) => set(s => ({ [key]: !s[key] })),
    }),
    {
      name: 'pro-trading-settings',
    }
  )
)

export default useSettingsStore
