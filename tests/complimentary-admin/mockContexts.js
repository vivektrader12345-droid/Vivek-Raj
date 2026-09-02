export function useAuth() {
  return {
    user: {
      uid: 'admin-uid',
      email: 'admin@example.com',
      fullName: 'Billing Admin',
      avatar: 'B',
    },
    logout: async () => {},
  }
}

export function useAlerts() {
  return { alerts: [] }
}

export function useTheme() {
  return { theme: 'dark', toggleTheme: () => {} }
}

export function useCurrency() {
  return { currency: 'INR', toggleCurrency: () => {}, exchangeRate: 83 }
}
