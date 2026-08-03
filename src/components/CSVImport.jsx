/**
 * CSVImport — Production-ready Trading History CSV Import Component
 *
 * Features:
 * - Drag-and-drop + file-picker upload
 * - Multi-stage progress bar (parse → write → done)
 * - Full ImportSummary: Total / Imported / Updated / Skipped / Failed
 * - Per-row error table with row number and reason
 * - Header-detection warning banner
 * - Auto-dismissable success state
 * - Zero coupling to column order — all mapping is automatic
 * - Real-time Firestore listener in TradeContext auto-refreshes every page
 *   (Dashboard, Analytics, Calendar, History) after the batch commit
 */
import React, { useState, useRef, useCallback } from 'react'
import {
  Upload, FileText, CheckCircle2, AlertTriangle, XCircle,
  RefreshCw, ChevronDown, ChevronUp, X, Info,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { useTrades } from '../context/TradeContext'
import { validateCSVFile, readFileAsText } from '../utils/csvImporter'

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

const STAGES = [
  { key: 'idle',    label: 'Ready'          },
  { key: 'reading', label: 'Reading file…'  },
  { key: 'parsing', label: 'Parsing CSV…'   },
  { key: 'writing', label: 'Saving trades…' },
  { key: 'done',    label: 'Complete'       },
]

// ---------------------------------------------------------------------------
// SUB-COMPONENTS
// ---------------------------------------------------------------------------

/** Single stat tile inside the summary card */
function StatTile({ value, label, color, icon: Icon }) {
  return (
    <div className="flex flex-col items-center gap-0.5 min-w-0">
      <div className={`flex items-center gap-1 text-xl font-bold ${color}`}>
        {Icon && <Icon size={16} />}
        {value}
      </div>
      <p className="text-gray-500 text-[10px] uppercase tracking-wide text-center leading-tight">
        {label}
      </p>
    </div>
  )
}

/** Collapsible row-error table */
function ErrorTable({ rowErrors }) {
  const [open, setOpen] = useState(false)
  const flatErrors = rowErrors
    .filter(e => e.rowIndex >= 0)
    .flatMap(e => e.messages.map(msg => ({ row: e.rowIndex + 2, msg })))

  if (flatErrors.length === 0) return null

  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 transition-colors"
      >
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        {flatErrors.length} row {flatErrors.length === 1 ? 'error' : 'errors'} — click to {open ? 'hide' : 'view'}
      </button>

      {open && (
        <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-red-500/20 bg-red-500/5">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-red-500/20">
                <th className="px-3 py-1.5 text-left text-red-400 font-semibold w-16">Row</th>
                <th className="px-3 py-1.5 text-left text-red-400 font-semibold">Reason</th>
              </tr>
            </thead>
            <tbody>
              {flatErrors.map((e, i) => (
                <tr key={i} className="border-b border-red-500/10 last:border-0">
                  <td className="px-3 py-1.5 text-red-300 font-mono">{e.row}</td>
                  <td className="px-3 py-1.5 text-gray-400 break-all">{e.msg}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** Import result summary card */
function ImportSummary({ result, onDismiss }) {
  const hasErrors  = result.errors.length > 0 || result.rowErrors?.length > 0
  const allSkipped = result.inserted === 0 && result.updated === 0 && result.failed === 0

  const borderColor = result.inserted > 0 || result.updated > 0
    ? 'border-emerald-500/25'
    : allSkipped ? 'border-yellow-500/25' : 'border-red-500/25'

  const bgColor = result.inserted > 0 || result.updated > 0
    ? 'bg-emerald-500/5'
    : allSkipped ? 'bg-yellow-500/5' : 'bg-red-500/5'

  const icon = result.inserted > 0 || result.updated > 0
    ? <CheckCircle2 size={18} className="text-emerald-400" />
    : allSkipped
    ? <Info size={18} className="text-yellow-400" />
    : <XCircle size={18} className="text-red-400" />

  const headline = result.inserted > 0 || result.updated > 0
    ? 'Import Complete'
    : allSkipped ? 'All rows already exist' : 'Import finished with errors'

  return (
    <div className={`rounded-xl border ${borderColor} ${bgColor} p-4`}>
      {/* Header row */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-white font-semibold text-sm">{headline}</span>
        </div>
        <button
          onClick={onDismiss}
          className="text-gray-500 hover:text-gray-300 transition-colors p-0.5 rounded"
          title="Dismiss"
        >
          <X size={14} />
        </button>
      </div>

      {/* Stat grid */}
      <div className="grid grid-cols-5 gap-2 py-2 border-y border-white/5">
        <StatTile value={result.totalRows}  label="Total Rows"  color="text-gray-300" />
        <StatTile value={result.inserted}   label="Imported"    color="text-emerald-400" icon={CheckCircle2} />
        <StatTile value={result.updated}    label="Updated"     color="text-blue-400"    icon={RefreshCw} />
        <StatTile value={result.skipped}    label="Skipped"     color="text-yellow-400"  icon={Info} />
        <StatTile value={result.failed}     label="Failed"      color="text-red-400"     icon={XCircle} />
      </div>

      {/* Header warning */}
      {result.headerWarning && (
        <div className="mt-3 flex items-start gap-2 text-xs text-yellow-300 bg-yellow-500/10 rounded-lg px-3 py-2">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{result.headerWarning}</span>
        </div>
      )}

      {/* Top-level errors (non-row) */}
      {result.errors.filter(e => !e.startsWith('Row ')).length > 0 && (
        <div className="mt-2 space-y-0.5">
          {result.errors
            .filter(e => !e.startsWith('Row '))
            .map((e, i) => (
              <p key={i} className="text-xs text-red-400">• {e}</p>
            ))}
        </div>
      )}

      {/* Per-row errors */}
      {hasErrors && (
        <ErrorTable rowErrors={result.rowErrors ?? []} />
      )}

      {/* Auto-refresh note */}
      {(result.inserted > 0 || result.updated > 0) && (
        <p className="mt-3 text-[10px] text-gray-500">
          ✓ Dashboard, Analytics, Calendar and Trade History have been refreshed automatically.
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// PROGRESS BAR
// ---------------------------------------------------------------------------

function ProgressBar({ stage, progress }) {
  const stageIndex   = STAGES.findIndex(s => s.key === stage)
  const stagePercent = stageIndex >= 0 ? Math.round((stageIndex / (STAGES.length - 1)) * 100) : 0
  const displayPct   = stage === 'writing' ? progress : stagePercent

  return (
    <div className="space-y-2">
      {/* Stage labels */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-400">
          {STAGES.find(s => s.key === stage)?.label ?? ''}
        </span>
        <span className="text-xs font-bold text-[#e94560]">{displayPct}%</span>
      </div>

      {/* Track */}
      <div className="relative w-full h-2.5 bg-[#1e1e3a] rounded-full overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 bg-gradient-to-r from-[#e94560] to-[#f5a623] rounded-full transition-all duration-300 ease-out"
          style={{ width: `${displayPct}%` }}
        />
        {/* Shimmer overlay while active */}
        {stage !== 'idle' && stage !== 'done' && (
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-shimmer" />
        )}
      </div>

      {/* Stage dots */}
      <div className="flex justify-between px-0.5">
        {STAGES.map((s, i) => {
          const reached = i <= stageIndex
          return (
            <div
              key={s.key}
              className={`w-1.5 h-1.5 rounded-full transition-colors duration-300 ${
                reached ? 'bg-[#e94560]' : 'bg-[#2a2a5a]'
              }`}
              title={s.label}
            />
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// DROP ZONE
// ---------------------------------------------------------------------------

function DropZone({ isDragOver, isImporting, fileName, onDragOver, onDragLeave, onDrop, onClick }) {
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onClick()}
      aria-label="Upload CSV file"
      className={`
        relative border-2 border-dashed rounded-2xl p-8 text-center
        cursor-pointer select-none outline-none
        transition-all duration-200
        focus-visible:ring-2 focus-visible:ring-[#e94560]
        ${isDragOver
          ? 'border-[#e94560] bg-[#e94560]/8 scale-[1.01]'
          : 'border-[#2a2a5a] hover:border-[#e94560]/50 hover:bg-[#e94560]/4'
        }
        ${isImporting ? 'pointer-events-none opacity-50' : ''}
      `}
    >
      {/* Icon */}
      <div className={`mx-auto mb-3 w-12 h-12 rounded-xl flex items-center justify-center
        ${isDragOver ? 'bg-[#e94560]/20' : 'bg-[#1e1e3a]'}`}
      >
        {isImporting
          ? <RefreshCw size={22} className="text-[#e94560] animate-spin" />
          : fileName
          ? <FileText size={22} className="text-[#e94560]" />
          : <Upload size={22} className="text-gray-500" />
        }
      </div>

      {/* Primary label */}
      <p className="text-white font-semibold text-sm">
        {isImporting
          ? 'Importing…'
          : isDragOver
          ? 'Drop to import'
          : 'Import Trading History CSV'
        }
      </p>

      {/* Secondary label */}
      <p className="text-gray-500 text-xs mt-1">
        {fileName
          ? <span className="text-[#e94560]">{fileName}</span>
          : 'Drag & drop your .csv file or click to browse'
        }
      </p>

      {/* Hint */}
      {!isImporting && !fileName && (
        <p className="text-gray-600 text-[10px] mt-2.5">
          Supports all column orders · No manual mapping needed · Max 50 MB
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// MAIN COMPONENT
// ---------------------------------------------------------------------------

/**
 * CSVImport
 *
 * @param {function} [onComplete]  - called after a successful import (e.g. close a modal)
 * @param {boolean}  [compact]     - render a narrower, modal-friendly layout
 */
function CSVImport({ onComplete, compact = false }) {
  const { importTrades } = useTrades()

  const [stage,    setStage]    = useState('idle')
  const [progress, setProgress] = useState(0)
  const [fileName, setFileName] = useState('')
  const [result,   setResult]   = useState(null)
  const [dragOver, setDragOver] = useState(false)

  const fileInputRef = useRef(null)
  const isImporting  = stage !== 'idle' && stage !== 'done'

  // ---- Core import handler ----
  const handleImport = useCallback(async (file) => {
    // 1. Validate file
    const validation = validateCSVFile(file)
    if (!validation.valid) {
      toast.error(validation.error)
      return
    }

    setFileName(file.name)
    setResult(null)
    setProgress(0)
    setStage('reading')

    try {
      // 2. Read
      const csvText = await readFileAsText(file)
      setStage('parsing')

      // 3. Parse + write (importTrades drives both stages internally)
      setStage('writing')
      const importResult = await importTrades(csvText, (pct) => {
        setProgress(pct)
        // Transition stage label based on progress
        if (pct >= 20 && pct < 95) setStage('writing')
      })

      setStage('done')
      setResult(importResult)

      // Toast
      if (importResult.inserted > 0 || importResult.updated > 0) {
        const parts = []
        if (importResult.inserted > 0) parts.push(`${importResult.inserted} imported`)
        if (importResult.updated  > 0) parts.push(`${importResult.updated} updated`)
        toast.success(parts.join(', '))
        onComplete?.()
      } else if (importResult.skipped > 0 && importResult.inserted === 0) {
        toast('All rows are already in your journal.', { icon: 'ℹ️' })
      } else if (importResult.failed > 0) {
        toast.error(`${importResult.failed} rows failed — see summary below`)
      }

    } catch (err) {
      setStage('done')
      const errResult = {
        totalRows: 0, inserted: 0, updated: 0, skipped: 0, failed: 1,
        errors: [`Unexpected error: ${err.message}`],
        rowErrors: [], headerWarning: null,
      }
      setResult(errResult)
      toast.error('Import failed: ' + err.message)
    }
  }, [importTrades, onComplete])

  // ---- Event handlers ----
  const handleDragOver  = (e) => { e.preventDefault(); if (!isImporting) setDragOver(true) }
  const handleDragLeave = ()  => setDragOver(false)
  const handleDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    if (!isImporting) {
      const file = e.dataTransfer.files[0]
      if (file) handleImport(file)
    }
  }
  const handleFileSelect = (e) => {
    const file = e.target.files[0]
    if (file) handleImport(file)
    e.target.value = ''
  }
  const handleClick = () => {
    if (!isImporting) fileInputRef.current?.click()
  }
  const handleReset = () => {
    setStage('idle')
    setProgress(0)
    setFileName('')
    setResult(null)
  }

  return (
    <div className={`space-y-4 ${compact ? 'max-w-lg' : ''}`}>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,.txt"
        onChange={handleFileSelect}
        className="hidden"
        aria-hidden="true"
      />

      {/* Drop zone */}
      <DropZone
        isDragOver={dragOver}
        isImporting={isImporting}
        fileName={!isImporting && stage === 'idle' ? fileName : ''}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
      />

      {/* Progress (shown while importing) */}
      {isImporting && (
        <ProgressBar stage={stage} progress={progress} />
      )}

      {/* Summary (shown after import) */}
      {result && stage === 'done' && (
        <ImportSummary result={result} onDismiss={handleReset} />
      )}

      {/* Re-import button (shown after done) */}
      {stage === 'done' && !isImporting && (
        <button
          onClick={handleReset}
          className="w-full flex items-center justify-center gap-2 py-2 text-xs text-gray-400 hover:text-white border border-[#2a2a5a] hover:border-[#e94560]/40 rounded-xl transition-all"
        >
          <Upload size={13} />
          Import another file
        </button>
      )}
    </div>
  )
}

export default CSVImport
