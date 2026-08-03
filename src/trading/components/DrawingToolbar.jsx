import React from 'react'
import {
  ArrowUpRight, Brush, Circle, Copy, Crosshair, EyeOff, Link2, Lock, Magnet,
  Minus, MousePointer2, Move, Ruler, Square, Trash2, TrendingUp, Type, ZoomIn,
} from 'lucide-react'
import useChartStore from '../stores/chartStore'

const TOOLS = [
  ['cursor', 'Cursor', MousePointer2], ['crosshair', 'Crosshair', Crosshair],
  ['trendline', 'Trend line', TrendingUp], ['arrow', 'Arrow', ArrowUpRight],
  ['hline', 'Horizontal line', Minus], ['vline', 'Vertical line', Move],
  ['ray', 'Ray', ArrowUpRight], ['channel', 'Parallel channel', TrendingUp],
  ['rect', 'Rectangle', Square], ['circle', 'Circle', Circle], ['brush', 'Brush', Brush],
  ['text', 'Text', Type], ['fib', 'Fibonacci retracement', Ruler],
  ['fibext', 'Fibonacci extension', Ruler], ['pitchfork', 'Pitchfork', TrendingUp],
  ['rr', 'Risk / reward', Ruler], ['measure', 'Measure', Ruler],
  ['magnet', 'Magnet', Magnet], ['zoom', 'Zoom', ZoomIn], ['lock', 'Lock drawings', Lock],
  ['hide', 'Hide drawings', EyeOff], ['clone', 'Clone drawing', Copy], ['link', 'Link tool', Link2],
]

export default function DrawingToolbar({ mode = 'rail' }) {
  const activeDrawingTool = useChartStore(state => state.activeDrawingTool)
  const setActiveDrawingTool = useChartStore(state => state.setActiveDrawingTool)
  const clearDrawings = useChartStore(state => state.clearDrawings)
  const select = id => setActiveDrawingTool(activeDrawingTool === id ? null : id)

  return <div className={`drawing-toolbar drawing-toolbar--${mode}`} aria-label="Drawing tools">
    <div className="drawing-toolbar__tools">
      {TOOLS.map(([id, label, Icon]) => <button
        type="button"
        key={id}
        title={label}
        aria-label={label}
        aria-pressed={activeDrawingTool === id}
        onClick={() => select(id)}
        className={`drawing-tool ${activeDrawingTool === id ? 'drawing-tool--active' : ''}`}
      ><Icon size={15} aria-hidden="true" /><span className="sr-only">{label}</span></button>)}
    </div>
    <div className="drawing-toolbar__footer">
      <button type="button" title="Delete all drawings" aria-label="Delete all drawings" onClick={clearDrawings} className="drawing-tool drawing-tool--danger"><Trash2 size={15} aria-hidden="true" /></button>
    </div>
  </div>
}
