import * as actual from '../../node_modules/lightweight-charts/dist/lightweight-charts.production.mjs'

const records = {
  charts: [],
  reset() {
    this.charts.length = 0
  },
}

window.__lightweightChartRecords = records

const clone = value => {
  try { return structuredClone(value) } catch { return JSON.parse(JSON.stringify(value)) }
}

function wrapSeries(series, chartRecord, type, options) {
  const seriesRecord = {
    type,
    options: clone(options || {}),
    appliedOptions: [],
    history: [],
    updates: [],
    markers: [],
    priceLines: [],
    removedPriceLines: 0,
  }
  chartRecord.series.push(seriesRecord)

  return new Proxy(series, {
    get(target, property) {
      if (property === 'setData') return data => {
        seriesRecord.history.push(clone(data))
        return target.setData(data)
      }
      if (property === 'update') return data => {
        seriesRecord.updates.push(clone(data))
        return target.update(data)
      }
      if (property === 'applyOptions') return optionsToApply => {
        seriesRecord.appliedOptions.push(clone(optionsToApply))
        return target.applyOptions(optionsToApply)
      }
      if (property === 'setMarkers') return markers => {
        seriesRecord.markers.push(clone(markers))
        return target.setMarkers(markers)
      }
      if (property === 'createPriceLine') return lineOptions => {
        seriesRecord.priceLines.push(clone(lineOptions))
        return target.createPriceLine(lineOptions)
      }
      if (property === 'removePriceLine') return line => {
        seriesRecord.removedPriceLines += 1
        return target.removePriceLine(line)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function wrapScale(scale, scaleRecord) {
  return new Proxy(scale, {
    get(target, property) {
      if (property === 'applyOptions') return options => {
        scaleRecord.appliedOptions.push(clone(options))
        return target.applyOptions(options)
      }
      if (property === 'fitContent') return () => {
        scaleRecord.fitContent += 1
        return target.fitContent()
      }
      if (property === 'setVisibleLogicalRange') return range => {
        scaleRecord.visibleRanges.push(clone(range))
        return target.setVisibleLogicalRange(range)
      }
      if (property === 'subscribeVisibleLogicalRangeChange') return handler => {
        scaleRecord.visibleRangeSubscriptions += 1
        return target.subscribeVisibleLogicalRangeChange(handler)
      }
      if (property === 'unsubscribeVisibleLogicalRangeChange') return handler => {
        scaleRecord.visibleRangeUnsubscriptions += 1
        return target.unsubscribeVisibleLogicalRangeChange(handler)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export function createChart(container, options) {
  const chart = actual.createChart(container, options)
  const chartRecord = {
    options: clone(options),
    appliedOptions: [],
    series: [],
    removed: false,
    screenshotCount: 0,
    crosshairSubscriptions: 0,
    timeScale: { appliedOptions: [], fitContent: 0, visibleRanges: [], visibleRangeSubscriptions: 0, visibleRangeUnsubscriptions: 0 },
    priceScales: {},
  }
  records.charts.push(chartRecord)
  const seriesByActual = new Map()
  const crosshairHandlers = new Map()

  const addSeries = (method, type, seriesOptions) => {
    const realSeries = chart[method](seriesOptions)
    const wrapped = wrapSeries(realSeries, chartRecord, type, seriesOptions)
    seriesByActual.set(realSeries, wrapped)
    return wrapped
  }

  return new Proxy(chart, {
    get(target, property) {
      if (property === 'addCandlestickSeries') return seriesOptions => addSeries('addCandlestickSeries', 'candlestick', seriesOptions)
      if (property === 'addLineSeries') return seriesOptions => addSeries('addLineSeries', 'line', seriesOptions)
      if (property === 'addAreaSeries') return seriesOptions => addSeries('addAreaSeries', 'area', seriesOptions)
      if (property === 'addBaselineSeries') return seriesOptions => addSeries('addBaselineSeries', 'baseline', seriesOptions)
      if (property === 'addHistogramSeries') return seriesOptions => addSeries('addHistogramSeries', 'histogram', seriesOptions)
      if (property === 'applyOptions') return optionsToApply => {
        chartRecord.appliedOptions.push(clone(optionsToApply))
        return target.applyOptions(optionsToApply)
      }
      if (property === 'subscribeCrosshairMove') return handler => {
        chartRecord.crosshairSubscriptions += 1
        const wrappedHandler = param => {
          if (!param?.seriesData) return handler(param)
          const mapped = new Map()
          param.seriesData.forEach((value, key) => mapped.set(seriesByActual.get(key) || key, value))
          return handler({ ...param, seriesData: mapped })
        }
        crosshairHandlers.set(handler, wrappedHandler)
        return target.subscribeCrosshairMove(wrappedHandler)
      }
      if (property === 'unsubscribeCrosshairMove') return handler => target.unsubscribeCrosshairMove(crosshairHandlers.get(handler) || handler)
      if (property === 'timeScale') return () => wrapScale(target.timeScale(), chartRecord.timeScale)
      if (property === 'priceScale') return id => {
        chartRecord.priceScales[id] ||= { appliedOptions: [], fitContent: 0, visibleRanges: [], visibleRangeSubscriptions: 0, visibleRangeUnsubscriptions: 0 }
        return wrapScale(target.priceScale(id), chartRecord.priceScales[id])
      }
      if (property === 'takeScreenshot') return () => {
        chartRecord.screenshotCount += 1
        return target.takeScreenshot()
      }
      if (property === 'remove') return () => {
        chartRecord.removed = true
        return target.remove()
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export const CrosshairMode = actual.CrosshairMode
export const LineStyle = actual.LineStyle
