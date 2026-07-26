import React, { createContext, useContext, useState, useEffect } from 'react'

const CurrencyContext = createContext(null)

// Default USD to INR exchange rate
const DEFAULT_RATE = 83.5

export function CurrencyProvider({ children }) {
  const [currency, setCurrency] = useState(() => {
    return localStorage.getItem('vmt_currency') || 'INR'
  })

  const [exchangeRate, setExchangeRate] = useState(() => {
    return parseFloat(localStorage.getItem('vmt_exchange_rate')) || DEFAULT_RATE
  })

  useEffect(() => {
    localStorage.setItem('vmt_currency', currency)
  }, [currency])

  useEffect(() => {
    localStorage.setItem('vmt_exchange_rate', exchangeRate.toString())
  }, [exchangeRate])

  // Try to fetch live rate (optional - falls back to default)
  useEffect(() => {
    const fetchRate = async () => {
      try {
        const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD')
        const data = await res.json()
        if (data && data.rates && data.rates.INR) {
          setExchangeRate(data.rates.INR)
        }
      } catch (e) {
        // Use default rate if fetch fails
        console.log('Using default exchange rate:', DEFAULT_RATE)
      }
    }
    fetchRate()
  }, [])

  const toggleCurrency = () => {
    setCurrency(prev => prev === 'INR' ? 'USD' : 'INR')
  }

  // Format amount based on selected currency
  // All trades are stored in USD, convert to INR when needed
  const formatAmount = (amountInUSD) => {
    const amount = parseFloat(amountInUSD) || 0
    if (currency === 'INR') {
      return `₹${(amount * exchangeRate).toFixed(2)}`
    }
    return `$${amount.toFixed(2)}`
  }

  // Get currency symbol
  const symbol = currency === 'INR' ? '₹' : '$'

  // Convert amount for display
  const convert = (amountInUSD) => {
    const amount = parseFloat(amountInUSD) || 0
    if (currency === 'INR') {
      return parseFloat((amount * exchangeRate).toFixed(2))
    }
    return parseFloat(amount.toFixed(2))
  }

  return (
    <CurrencyContext.Provider value={{ currency, symbol, exchangeRate, toggleCurrency, formatAmount, convert }}>
      {children}
    </CurrencyContext.Provider>
  )
}

export function useCurrency() {
  const context = useContext(CurrencyContext)
  if (!context) throw new Error('useCurrency must be used within CurrencyProvider')
  return context
}
