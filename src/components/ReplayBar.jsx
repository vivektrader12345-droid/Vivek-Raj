import React, { useState, useEffect, useRef } from 'react'

/**
 * Replay Bar - Like TradingView's Replay feature
 * Replays historical candles one by one with play/pause/speed controls
 */
function ReplayBar({ allCandles = [], onReplayUpdate, onBuy, onSell }) {
  const [isReplaying, setIsReplaying] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [replayCandles, setReplayCandles] = useState([])
  const intervalRef = useRef(null)

  const speeds = [0.5, 1, 2, 3, 5, 10]
  const timeframes = ['1m', '5m', '15m', '30m', '1h']

  // Start replay from a specific point
  const startReplay = () => {
    if (allCandles.length === 0) return
    setIsReplaying(true)
    setCurrentIndex(Math.max(0, allCandles.length - 50)) // Start from 50 candles back
    setReplayCandles(allCandles.slice(0, allCandles.length - 50))
  }

  // Stop replay
  const stopReplay = () => {
    setIsReplaying(false)
    setIsPlaying(false)
    if (intervalRef.current) clearInterval(intervalRef.current)
    onReplayUpdate(allCandles) // Restore all candles
  }

  // Play/Pause
  const togglePlay = () => {
    setIsPlaying(prev => !prev)
  }

  // Step forward one candle
  const stepForward = () => {
    if (currentIndex < allCandles.length) {
      const newIndex = currentIndex + 1
      setCurrentIndex(newIndex)
      const newCandles = allCandles.slice(0, newIndex)
      setReplayCandles(newCandles)
      onReplayUpdate(newCandles)
    }
  }

  // Skip to end
  const skipToEnd = () => {
    setCurrentIndex(allCandles.length)
    setReplayCandles(allCandles)
    onReplayUpdate(allCandles)
    setIsPlaying(false)
  }

  // Skip to start
  const skipToStart = () => {
    const startIdx = Math.max(0, 10)
    setCurrentIndex(startIdx)
    setReplayCandles(allCandles.slice(0, startIdx))
    onReplayUpdate(allCandles.slice(0, startIdx))
  }

  // Auto-play effect
  useEffect(() => {
    if (isPlaying && isReplaying) {
      intervalRef.current = setInterval(() => {
        setCurrentIndex(prev => {
          if (prev >= allCandles.length) {
            setIsPlaying(false)
            return prev
          }
          const newIdx = prev + 1
          const newCandles = allCandles.slice(0, newIdx)
          setReplayCandles(newCandles)
          onReplayUpdate(newCandles)
          return newIdx
        })
      }, 1000 / speed)
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [isPlaying, speed, isReplaying])

  if (!isReplaying) {
    return (
      <div className="flex items-center justify-center py-2">
        <button onClick={startReplay}
          className="flex items-center gap-2 px-4 py-2 bg-[#2a2a5a]/50 hover:bg-[#e94560]/20 text-gray-300 hover:text-[#e94560] rounded-xl text-sm font-medium transition-all border border-[#2a2a5a]/50 hover:border-[#e94560]/30">
          ◁◁ Replay
        </button>
      </div>
    )
  }

  return (
    <div className="border-t border-[#2a2a5a]/30 bg-[#0a0a1f]/80 p-3 space-y-2">
      {/* Trade buttons row */}
      <div className="flex items-center justify-center gap-2">
        <button onClick={onSell}
          className="px-4 py-1.5 border border-red-500/40 text-red-400 rounded-lg text-sm font-medium hover:bg-red-500/10 transition-all">
          Sell
        </button>
        <span className="px-3 py-1.5 bg-[#2a2a5a]/50 text-white rounded-lg text-sm font-mono">1</span>
        <button onClick={onBuy}
          className="px-4 py-1.5 border border-emerald-500/40 text-emerald-400 rounded-lg text-sm font-medium hover:bg-emerald-500/10 transition-all">
          Buy
        </button>
        <button onClick={stopReplay}
          className="px-4 py-1.5 border border-gray-500/40 text-gray-400 rounded-lg text-sm font-medium hover:bg-gray-500/10 transition-all">
          Flatten
        </button>
      </div>

      {/* Playback controls row */}
      <div className="flex items-center justify-center gap-3">
        {/* Skip to start */}
        <button onClick={skipToStart} className="text-gray-400 hover:text-white text-lg transition-colors">⏮</button>

        {/* Step back */}
        <button onClick={() => {
          if (currentIndex > 10) {
            setCurrentIndex(prev => prev - 1)
            onReplayUpdate(allCandles.slice(0, currentIndex - 1))
          }
        }} className="text-gray-400 hover:text-white text-lg transition-colors">◁</button>

        {/* Play/Pause */}
        <button onClick={togglePlay}
          className={`w-8 h-8 rounded-full flex items-center justify-center text-sm transition-all ${isPlaying ? 'bg-[#e94560] text-white' : 'bg-[#2a2a5a] text-white hover:bg-[#e94560]'}`}>
          {isPlaying ? '⏸' : '▶'}
        </button>

        {/* Step forward */}
        <button onClick={stepForward} className="text-gray-400 hover:text-white text-lg transition-colors">▷</button>

        {/* Skip to end */}
        <button onClick={skipToEnd} className="text-gray-400 hover:text-white text-lg transition-colors">⏭</button>

        {/* Speed */}
        <select value={speed} onChange={(e) => setSpeed(parseFloat(e.target.value))}
          className="bg-[#2a2a5a] text-white text-xs rounded px-2 py-1 border border-[#2a2a5a]">
          {speeds.map(s => <option key={s} value={s}>{s}x</option>)}
        </select>

        {/* Progress */}
        <span className="text-gray-400 text-xs font-mono">
          {currentIndex}/{allCandles.length}
        </span>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-[#2a2a5a] rounded-full h-1">
        <div className="bg-[#e94560] h-1 rounded-full transition-all" style={{ width: `${allCandles.length > 0 ? (currentIndex / allCandles.length * 100) : 0}%` }}></div>
      </div>

      {/* Date info */}
      <div className="flex items-center justify-between text-[10px] text-gray-500">
        <span>Date Range</span>
        <span>{new Date().toLocaleTimeString()} UTC+5:30</span>
      </div>
    </div>
  )
}

export default ReplayBar
