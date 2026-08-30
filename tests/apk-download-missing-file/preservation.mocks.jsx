export function useAuth() {
  return { user: { fullName: 'Synthetic User', email: 'user@example.invalid', avatar: 'S' }, logout() {} }
}

export function useSubscription() {
  return {
    subscription: { planId: 'elite' },
    active: true,
    isAdmin: false,
    hasPlan: () => true,
  }
}

export function useAlerts() {
  return { alerts: [] }
}

export function useTheme() {
  return { theme: 'dark', toggleTheme() {} }
}

export function useCurrency() {
  return { currency: 'USD', toggleCurrency() {}, exchangeRate: 83.25 }
}
