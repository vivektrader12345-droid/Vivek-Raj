import React, { useState, useEffect } from 'react'

/**
 * Standalone Countdown Timer Component
 * Shows remaining time until current candle closes.
 * Updates every second independently.
 */
function CountdownTimer({ timeframe = '1' }) {
  const [time, setTime] = useState('00:00')

  useEffect(() => {
    const getMs = () => {
      const map = {
        '1': 60000, '1m': 60000,
        '3': 180000, '3m': 180000,
        '5': 300000, '5m': 300000,
        '15': 900000, '15m': 900000,
        '30': 1800000, '30m': 1800000,
        '60': 3600000, '1h': 3600000,
        '240': 14400000, '4h': 14400000,
        'D': 86400000, '1d': 86400000, '1D': 86400000,
      }
      return map[timeframe] || 60000
    }

    const update = () => {
      const tfMs = getMs()
      const now = Date.now()
      const remaining = tfMs - (now % tfMs)
      const h = Math.floor(remaining / 3600000)
      const m = Math.floor((remaining % 3600000) / 60000)
      const s = Math.floor((remaining % 60000) / 1000)
      if (h > 0) {
        setTime(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`)
      } else {
        setTime(`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`)
      }
    }

    update() // Run immediately
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [timeframe])

  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#e94560] text-white text-xs font-mono font-bold shadow-lg shadow-[#e94560]/30">
      ⏱ {time}
    </span>
  )
}

export default CountdownTimer
