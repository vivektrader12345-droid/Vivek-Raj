import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createChart, CrosshairMode, LineStyle } from 'lightweight-charts'
import useChartStore from '../stores/chartStore'
import useTradingStore from '../stores/tradingStore'
import useSettingsStore from '../stores/settingsStore'
import PositionProtectionLayer from './PositionProtectionLayer'

const COLORS = {
  bg: '#070b14', grid: 'rgba(71, 85, 105, .10)', text: '#64748b', crosshair: '#64748b',
  border: 'rgba(148, 163, 184, .10)', up: '#22c7a9', down: '#f45b78',
  volumeUp: 'rgba(34, 199, 169, .22)', volumeDown: 'rgba(244, 91, 120, .20)',
}

const heikinAshi = source => {
  let previous = null
  return source.map(candle => {
    const close = (candle.open + candle.high + candle.low + candle.close) / 4
    const open = previous ? (previous.open + previous.close) / 2 : (candle.open + candle.close) / 2
    const item = { ...candle, open, close, high: Math.max(candle.high, open, close), low: Math.min(candle.low, open, close) }
    previous = item
    return item
  })
}

function addPriceSeries(chart, style) {
  if (style === 'line') return chart.addLineSeries({ color: '#38bdf8', lineWidth: 2, crosshairMarkerVisible: true, priceLineVisible: true, lastValueVisible: true })
  if (style === 'area') return chart.addAreaSeries({ lineColor: '#38bdf8', topColor: 'rgba(56,189,248,.32)', bottomColor: 'rgba(56,189,248,.01)', lineWidth: 2, priceLineVisible: true })
  if (style === 'baseline') return chart.addBaselineSeries({ baseValue: { type: 'price', price: 0 }, topLineColor: COLORS.up, topFillColor1: 'rgba(34,199,169,.28)', topFillColor2: 'rgba(34,199,169,.02)', bottomLineColor: COLORS.down, bottomFillColor1: 'rgba(244,91,120,.02)', bottomFillColor2: 'rgba(244,91,120,.28)', lineWidth: 2 })
  if (style === 'hollow') return chart.addCandlestickSeries({ upColor: 'rgba(7,11,20,0)', downColor: COLORS.down, borderVisible: true, borderUpColor: COLORS.up, borderDownColor: COLORS.down, wickUpColor: COLORS.up, wickDownColor: COLORS.down, priceLineVisible: true })
  return chart.addCandlestickSeries({ upColor: COLORS.up, downColor: COLORS.down, borderVisible: false, wickUpColor: COLORS.up, wickDownColor: COLORS.down, priceLineVisible: true, lastValueVisible: true })
}

function ProChart({ height = '100%' }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const mainSeriesRef = useRef(null)
  const volumeSeriesRef = useRef(null)
  const candles = useChartStore(s => s.candles)
  const symbolDisplay = useChartStore(s => s.symbolDisplay)
  const timeframe = useChartStore(s => s.timeframe)
  const setChartRef = useChartStore(s => s.setChartRef)
  const setSeriesRef = useChartStore(s => s.setSeriesRef)
  const setVolumeSeriesRef = useChartStore(s => s.setVolumeSeriesRef)
  const currentPrice = useTradingStore(s => s.currentPrice)
  const showGrid = useSettingsStore(s => s.showGrid)
  const showVolume = useSettingsStore(s => s.showVolume)
  const showCrosshair = useSettingsStore(s => s.showCrosshair)
  const chartStyle = useSettingsStore(s => s.chartStyle)
  const [crosshairData, setCrosshairData] = useState(null)
  const [chartRuntime, setChartRuntime] = useState(null)

  useEffect(() => {
    if (!containerRef.current) return undefined
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth, height: containerRef.current.clientHeight,
      layout: { background: { type: 'solid', color: COLORS.bg }, textColor: COLORS.text, fontSize: 11, fontFamily: "Inter, ui-sans-serif, system-ui" },
      grid: { vertLines: { color: showGrid ? COLORS.grid : 'transparent' }, horzLines: { color: showGrid ? COLORS.grid : 'transparent' } },
      crosshair: { mode: showCrosshair ? CrosshairMode.Normal : CrosshairMode.Hidden, vertLine: { color: COLORS.crosshair, width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#172033' }, horzLine: { color: COLORS.crosshair, width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#172033' } },
      // Price-scale top margin: 0.12 reserves headroom so early candles remain readable beneath the HUD band (legend/OHLC row + quote row ≈ 80px ≈ 10–12% of the chart at 1366×768)
      rightPriceScale: { borderColor: COLORS.border, scaleMargins: { top: .12, bottom: .2 }, autoScale: true, entireTextOnly: true },
      timeScale: { borderColor: COLORS.border, timeVisible: true, secondsVisible: timeframe === '1s', rightOffset: 6, barSpacing: 7, minBarSpacing: .5, fixLeftEdge: false, fixRightEdge: false },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
      kineticScroll: { mouse: true, touch: true },
    })
    const mainSeries = addPriceSeries(chart, chartStyle)
    mainSeries.applyOptions({ priceFormat: { type: 'price', precision: 2, minMove: .01 } })
    const volumeSeries = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false, visible: showVolume })
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: .82, bottom: 0 }, borderVisible: false })
    chartRef.current = chart; mainSeriesRef.current = mainSeries; volumeSeriesRef.current = volumeSeries
    setChartRef(chart); setSeriesRef(mainSeries); setVolumeSeriesRef(volumeSeries)
    setChartRuntime({ chart, series: mainSeries })

    chart.subscribeCrosshairMove(param => {
      if (!param?.time || !param.seriesData) return setCrosshairData(null)
      const data = param.seriesData.get(mainSeries)
      const volume = param.seriesData.get(volumeSeries)
      if (!data) return
      if ('value' in data) setCrosshairData({ close: data.value, open: data.value, high: data.value, low: data.value, volume: volume?.value || 0, isUp: true })
      else setCrosshairData({ ...data, volume: volume?.value || 0, isUp: data.close >= data.open })
    })

    const observer = new ResizeObserver(entries => entries.forEach(entry => chart.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height })))
    observer.observe(containerRef.current)
    return () => { observer.disconnect(); setChartRuntime(null); chart.remove(); chartRef.current = null; mainSeriesRef.current = null; volumeSeriesRef.current = null; setChartRef(null); setSeriesRef(null); setVolumeSeriesRef(null) }
  }, [chartStyle])

  useEffect(() => {
    chartRef.current?.applyOptions({ grid: { vertLines: { color: showGrid ? COLORS.grid : 'transparent' }, horzLines: { color: showGrid ? COLORS.grid : 'transparent' } }, crosshair: { mode: showCrosshair ? CrosshairMode.Normal : CrosshairMode.Hidden } })
  }, [showGrid, showCrosshair])

  useEffect(() => {
    if (!mainSeriesRef.current || !candles.length) return
    const source = chartStyle === 'heikin' ? heikinAshi(candles) : candles
    const lineLike = ['line', 'area', 'baseline'].includes(chartStyle)
    mainSeriesRef.current.setData(lineLike ? source.map(item => ({ time: item.time, value: item.close })) : source.map(item => ({ time: item.time, open: item.open, high: item.high, low: item.low, close: item.close })))
    volumeSeriesRef.current?.setData(source.map(item => ({ time: item.time, value: item.volume, color: item.close >= item.open ? COLORS.volumeUp : COLORS.volumeDown })))
    volumeSeriesRef.current?.applyOptions({ visible: showVolume })
  }, [candles, chartStyle, showVolume])

  useEffect(() => {
    if (!mainSeriesRef.current || !currentPrice || !candles.length) return
    const last = candles.at(-1)
    if (['line', 'area', 'baseline'].includes(chartStyle)) mainSeriesRef.current.update({ time: last.time, value: currentPrice })
    else mainSeriesRef.current.update({ time: last.time, open: last.open, high: Math.max(last.high, currentPrice), low: Math.min(last.low, currentPrice), close: currentPrice })
  }, [currentPrice, chartStyle])

  const stats = useMemo(() => {
    const last = candles.at(-1)
    if (!last) return null
    const first = candles[0]?.open || last.open
    return { high: last.high, low: last.low, open: last.open, close: currentPrice || last.close, volume: last.volume, change: first ? (((currentPrice || last.close) - first) / first) * 100 : 0 }
  }, [candles, currentPrice])
  const shown = crosshairData || stats

  return <div className="relative h-full w-full overflow-hidden" style={{ height }}>
    <div className="pro-chart__legend pointer-events-none absolute left-16 top-3 z-10 flex max-w-[calc(100%-160px)] flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-[#070b14]/55 px-2 py-1 text-[10px] backdrop-blur-sm" data-chart-hud="symbol-ohlc">
      <strong className="text-slate-200">{symbolDisplay}</strong><span className="uppercase text-slate-500">{timeframe}</span>
      {shown && <><span className="text-slate-500">O <b className="text-slate-300">{shown.open?.toFixed(2)}</b></span><span className="text-slate-500">H <b className="text-emerald-300">{shown.high?.toFixed(2)}</b></span><span className="text-slate-500">L <b className="text-rose-300">{shown.low?.toFixed(2)}</b></span><span className="text-slate-500">C <b className={shown.isUp === false ? 'text-rose-300' : 'text-emerald-300'}>{shown.close?.toFixed(2)}</b></span><span className="hidden text-slate-500 md:inline">V <b className="text-slate-300">{Number(shown.volume || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</b></span></>}
    </div>
    <div className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center"><div className="text-center opacity-[.035]"><p className="text-7xl font-black tracking-tight text-white">{symbolDisplay.split('/')[0]}</p><p className="mt-1 text-xs font-bold uppercase tracking-[.5em] text-white">Paper Trading Terminal</p></div></div>
    {stats && <div className="pointer-events-none absolute right-16 top-3 z-10 hidden items-center gap-3 rounded-lg border border-white/[.05] bg-[#070b14]/65 px-2 py-1 text-[9px] backdrop-blur-sm lg:flex"><span className="text-slate-500">High <b className="text-emerald-300">{stats.high.toFixed(2)}</b></span><span className="text-slate-500">Low <b className="text-rose-300">{stats.low.toFixed(2)}</b></span><span className={stats.change >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{stats.change >= 0 ? '+' : ''}{stats.change.toFixed(2)}%</span></div>}
    <div ref={containerRef} className="h-full w-full" onDoubleClick={() => chartRef.current?.timeScale().fitContent()} />
    {chartRuntime && <div className="pro-chart-overlay-lane" data-chart-overlay-lane aria-hidden="true"><PositionProtectionLayer chart={chartRuntime.chart} series={chartRuntime.series} containerRef={containerRef} candles={candles} symbol={useChartStore.getState().symbol} /></div>}
    {!candles.length && <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#070b14]/85"><div className="flex flex-col items-center gap-3"><div className="h-8 w-8 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" /><span className="text-xs text-slate-500">Connecting to Binance market data…</span></div></div>}
  </div>
}

export default React.memo(ProChart)
