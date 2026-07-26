/**
 * Technical Indicator Calculations
 * All functions take candle arrays and return series data for lightweight-charts
 * Optimized for performance with large datasets (100k+ candles)
 */

/**
 * Exponential Moving Average (EMA)
 * @param {Array} candles - Array of {time, open, high, low, close}
 * @param {number} period
 * @returns {Array} - [{time, value}]
 */
export function calcEMA(candles, period) {
  if (candles.length < period) return []
  
  const multiplier = 2 / (period + 1)
  const result = []
  
  // Initial SMA for first EMA point
  let sum = 0
  for (let i = 0; i < period; i++) {
    sum += candles[i].close
  }
  let ema = sum / period
  result.push({ time: candles[period - 1].time, value: ema })
  
  // Calculate EMA for rest
  for (let i = period; i < candles.length; i++) {
    ema = (candles[i].close - ema) * multiplier + ema
    result.push({ time: candles[i].time, value: ema })
  }
  
  return result
}

/**
 * Volume Weighted Average Price (VWAP)
 * Resets daily for intraday timeframes
 * @param {Array} candles
 * @returns {Array} - [{time, value}]
 */
export function calcVWAP(candles) {
  if (candles.length === 0) return []
  
  const result = []
  let cumulativeTPV = 0 // Typical Price × Volume
  let cumulativeVolume = 0
  let lastDay = null
  
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const date = new Date(c.time * 1000)
    const day = date.toDateString()
    
    // Reset on new day
    if (day !== lastDay) {
      cumulativeTPV = 0
      cumulativeVolume = 0
      lastDay = day
    }
    
    const typicalPrice = (c.high + c.low + c.close) / 3
    cumulativeTPV += typicalPrice * (c.volume || 1)
    cumulativeVolume += c.volume || 1
    
    const vwap = cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : c.close
    result.push({ time: c.time, value: vwap })
  }
  
  return result
}

/**
 * Relative Strength Index (RSI)
 * @param {Array} candles
 * @param {number} period - default 14
 * @returns {Array} - [{time, value}]
 */
export function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return []
  
  const result = []
  const gains = []
  const losses = []
  
  // Calculate price changes
  for (let i = 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close
    gains.push(change > 0 ? change : 0)
    losses.push(change < 0 ? Math.abs(change) : 0)
  }
  
  // Initial average
  let avgGain = 0
  let avgLoss = 0
  for (let i = 0; i < period; i++) {
    avgGain += gains[i]
    avgLoss += losses[i]
  }
  avgGain /= period
  avgLoss /= period
  
  // First RSI
  let rs = avgLoss === 0 ? 100 : avgGain / avgLoss
  let rsi = 100 - (100 / (1 + rs))
  result.push({ time: candles[period].time, value: rsi })
  
  // Smoothed RSI
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period
    rs = avgLoss === 0 ? 100 : avgGain / avgLoss
    rsi = 100 - (100 / (1 + rs))
    result.push({ time: candles[i + 1].time, value: rsi })
  }
  
  return result
}

/**
 * MACD (Moving Average Convergence Divergence)
 * @param {Array} candles
 * @param {number} fast - default 12
 * @param {number} slow - default 26
 * @param {number} signal - default 9
 * @returns {object} - {macdLine: [], signalLine: [], histogram: []}
 */
export function calcMACD(candles, fast = 12, slow = 26, signal = 9) {
  if (candles.length < slow + signal) return { macdLine: [], signalLine: [], histogram: [] }
  
  const fastEMA = calcEMAValues(candles.map(c => c.close), fast)
  const slowEMA = calcEMAValues(candles.map(c => c.close), slow)
  
  // MACD Line = Fast EMA - Slow EMA
  const macdValues = []
  const startIdx = slow - 1
  
  for (let i = startIdx; i < candles.length; i++) {
    const fastIdx = i - (fast - 1)
    const slowIdx = i - (slow - 1)
    if (fastIdx >= 0 && slowIdx >= 0 && fastIdx < fastEMA.length && slowIdx < slowEMA.length) {
      macdValues.push(fastEMA[fastIdx] - slowEMA[slowIdx])
    }
  }
  
  // Signal Line = EMA of MACD
  const signalEMA = calcEMAValues(macdValues, signal)
  
  const macdLine = []
  const signalLine = []
  const histogram = []
  
  const resultStart = slow - 1 + signal - 1
  
  for (let i = 0; i < signalEMA.length; i++) {
    const candleIdx = resultStart + i
    if (candleIdx >= candles.length) break
    
    const macdVal = macdValues[signal - 1 + i]
    const sigVal = signalEMA[i]
    const histVal = macdVal - sigVal
    
    macdLine.push({ time: candles[candleIdx].time, value: macdVal })
    signalLine.push({ time: candles[candleIdx].time, value: sigVal })
    histogram.push({
      time: candles[candleIdx].time,
      value: histVal,
      color: histVal >= 0 ? 'rgba(38, 166, 154, 0.7)' : 'rgba(239, 83, 80, 0.7)',
    })
  }
  
  return { macdLine, signalLine, histogram }
}

/**
 * Bollinger Bands
 * @param {Array} candles
 * @param {number} period - default 20
 * @param {number} stdDev - default 2
 * @returns {object} - {upper: [], middle: [], lower: []}
 */
export function calcBollinger(candles, period = 20, stdDev = 2) {
  if (candles.length < period) return { upper: [], middle: [], lower: [] }
  
  const upper = []
  const middle = []
  const lower = []
  
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) {
      sum += candles[j].close
    }
    const sma = sum / period
    
    let sqSum = 0
    for (let j = i - period + 1; j <= i; j++) {
      sqSum += Math.pow(candles[j].close - sma, 2)
    }
    const std = Math.sqrt(sqSum / period)
    
    middle.push({ time: candles[i].time, value: sma })
    upper.push({ time: candles[i].time, value: sma + std * stdDev })
    lower.push({ time: candles[i].time, value: sma - std * stdDev })
  }
  
  return { upper, middle, lower }
}

/**
 * Average True Range (ATR)
 * @param {Array} candles
 * @param {number} period - default 14
 * @returns {Array} - [{time, value}]
 */
export function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return []
  
  const trueRanges = []
  
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high
    const low = candles[i].low
    const prevClose = candles[i - 1].close
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose))
    trueRanges.push(tr)
  }
  
  const result = []
  
  // Initial ATR (SMA of first period TRs)
  let atr = 0
  for (let i = 0; i < period; i++) {
    atr += trueRanges[i]
  }
  atr /= period
  result.push({ time: candles[period].time, value: atr })
  
  // Smoothed ATR
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period
    result.push({ time: candles[i + 1].time, value: atr })
  }
  
  return result
}

/**
 * Supertrend
 * @param {Array} candles
 * @param {number} period - default 10
 * @param {number} multiplier - default 3
 * @returns {Array} - [{time, value, color}] (green = uptrend, red = downtrend)
 */
export function calcSupertrend(candles, period = 10, multiplier = 3) {
  if (candles.length < period + 1) return []
  
  const atrValues = calcATR(candles, period)
  if (atrValues.length === 0) return []
  
  const result = []
  let prevUpperBand = 0
  let prevLowerBand = 0
  let prevSupertrend = 0
  let prevClose = 0
  let trend = 1 // 1 = up, -1 = down
  
  for (let i = 0; i < atrValues.length; i++) {
    const candleIdx = period + i
    if (candleIdx >= candles.length) break
    
    const c = candles[candleIdx]
    const atr = atrValues[i].value
    const hl2 = (c.high + c.low) / 2
    
    let upperBand = hl2 + multiplier * atr
    let lowerBand = hl2 - multiplier * atr
    
    // Adjust bands
    if (i > 0) {
      upperBand = upperBand < prevUpperBand || prevClose > prevUpperBand ? upperBand : prevUpperBand
      lowerBand = lowerBand > prevLowerBand || prevClose < prevLowerBand ? lowerBand : prevLowerBand
    }
    
    // Determine trend
    let supertrend
    if (i === 0) {
      supertrend = c.close > upperBand ? lowerBand : upperBand
      trend = c.close > upperBand ? 1 : -1
    } else {
      if (prevSupertrend === prevUpperBand) {
        trend = c.close > upperBand ? 1 : -1
      } else {
        trend = c.close < lowerBand ? -1 : 1
      }
      supertrend = trend === 1 ? lowerBand : upperBand
    }
    
    result.push({
      time: c.time,
      value: supertrend,
      color: trend === 1 ? '#26a69a' : '#ef5350',
    })
    
    prevUpperBand = upperBand
    prevLowerBand = lowerBand
    prevSupertrend = supertrend
    prevClose = c.close
  }
  
  return result
}

// ==================== HELPER ====================

/**
 * Raw EMA calculation on an array of values
 * @param {number[]} values
 * @param {number} period
 * @returns {number[]}
 */
function calcEMAValues(values, period) {
  if (values.length < period) return []
  
  const multiplier = 2 / (period + 1)
  const result = []
  
  let sum = 0
  for (let i = 0; i < period; i++) {
    sum += values[i]
  }
  let ema = sum / period
  result.push(ema)
  
  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema
    result.push(ema)
  }
  
  return result
}
