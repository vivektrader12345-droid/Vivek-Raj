import React, { useState } from 'react'

function ClockPicker({ value, onChange, label }) {
  const [show, setShow] = useState(false)
  const [mode, setMode] = useState('hour') // 'hour' or 'minute'
  const [selectedHour, setSelectedHour] = useState(value ? parseInt(value.split(':')[0]) : 10)
  const [selectedMin, setSelectedMin] = useState(value ? parseInt(value.split(':')[1]) : 0)
  const [ampm, setAmpm] = useState('AM')

  const hours = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  const minutes = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]

  const getPosition = (index, total, radius) => {
    const angle = (index * (360 / total)) - 90
    const rad = (angle * Math.PI) / 180
    const x = 50 + radius * Math.cos(rad)
    const y = 50 + radius * Math.sin(rad)
    return { x, y }
  }

  const handleSet = () => {
    let h = selectedHour
    if (ampm === 'PM' && h !== 12) h += 12
    if (ampm === 'AM' && h === 12) h = 0
    const timeStr = `${String(h).padStart(2, '0')}:${String(selectedMin).padStart(2, '0')}`
    onChange(timeStr)
    setShow(false)
  }

  const handleClear = () => {
    onChange('')
    setShow(false)
  }

  const displayTime = value || '--:--'

  return (
    <div className="relative">
      <label className="block text-gray-400 text-sm mb-1.5">{label}</label>
      <button type="button" onClick={() => setShow(true)}
        className="input-field text-left flex items-center justify-between cursor-pointer">
        <span className={value ? 'text-white' : 'text-gray-500'}>{displayTime}</span>
        <span className="text-gray-400">🕐</span>
      </button>

      {/* Clock Modal */}
      {show && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShow(false)}>
          <div className="bg-[#1a1a2e] border border-[#0f3460] rounded-2xl w-[320px] shadow-2xl" onClick={e => e.stopPropagation()}>
            {/* Header - Time Display */}
            <div className="bg-gradient-to-r from-[#5b21b6] to-[#7c3aed] rounded-t-2xl p-5 text-center">
              <div className="text-4xl font-bold text-white tracking-wider">
                <span onClick={() => setMode('hour')} className={`cursor-pointer ${mode === 'hour' ? 'opacity-100' : 'opacity-50'}`}>
                  {String(selectedHour).padStart(2, '0')}
                </span>
                <span className="mx-1">:</span>
                <span onClick={() => setMode('minute')} className={`cursor-pointer ${mode === 'minute' ? 'opacity-100' : 'opacity-50'}`}>
                  {String(selectedMin).padStart(2, '0')}
                </span>
              </div>
              <div className="flex justify-center gap-3 mt-2">
                <button type="button" onClick={() => setAmpm('AM')}
                  className={`px-3 py-1 rounded text-sm font-medium transition-all ${ampm === 'AM' ? 'bg-white/20 text-white' : 'text-white/50'}`}>AM</button>
                <button type="button" onClick={() => setAmpm('PM')}
                  className={`px-3 py-1 rounded text-sm font-medium transition-all ${ampm === 'PM' ? 'bg-white/20 text-white' : 'text-white/50'}`}>PM</button>
              </div>
            </div>

            {/* Clock Face */}
            <div className="p-6">
              <div className="relative w-[240px] h-[240px] mx-auto rounded-full bg-[#0a0a1a] border border-[#0f3460]">
                {/* Center dot */}
                <div className="absolute top-1/2 left-1/2 w-3 h-3 bg-[#7c3aed] rounded-full -translate-x-1/2 -translate-y-1/2 z-10"></div>

                {mode === 'hour' ? (
                  /* Hour numbers */
                  hours.map((h, i) => {
                    const pos = getPosition(i, 12, 38)
                    const isSelected = selectedHour === h
                    return (
                      <button key={h} type="button"
                        onClick={() => { setSelectedHour(h); setMode('minute') }}
                        className={`absolute w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-all ${
                          isSelected ? 'bg-[#7c3aed] text-white scale-110' : 'text-gray-300 hover:bg-[#0f3460] hover:text-white'
                        }`}
                        style={{ left: `${pos.x}%`, top: `${pos.y}%`, transform: 'translate(-50%, -50%)' }}>
                        {h}
                      </button>
                    )
                  })
                ) : (
                  /* Minute numbers */
                  minutes.map((m, i) => {
                    const pos = getPosition(i, 12, 38)
                    const isSelected = selectedMin === m
                    return (
                      <button key={m} type="button"
                        onClick={() => setSelectedMin(m)}
                        className={`absolute w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-all ${
                          isSelected ? 'bg-[#7c3aed] text-white scale-110' : 'text-gray-300 hover:bg-[#0f3460] hover:text-white'
                        }`}
                        style={{ left: `${pos.x}%`, top: `${pos.y}%`, transform: 'translate(-50%, -50%)' }}>
                        {String(m).padStart(2, '0')}
                      </button>
                    )
                  })
                )}

                {/* Clock hand line */}
                {(() => {
                  const idx = mode === 'hour' ? hours.indexOf(selectedHour) : minutes.indexOf(selectedMin)
                  const pos = getPosition(idx, 12, 30)
                  return (
                    <svg className="absolute inset-0 w-full h-full pointer-events-none">
                      <line x1="50%" y1="50%" x2={`${pos.x}%`} y2={`${pos.y}%`} stroke="#7c3aed" strokeWidth="2" />
                    </svg>
                  )
                })()}
              </div>

              {/* Mode indicator */}
              <div className="text-center mt-3 text-gray-400 text-xs">
                {mode === 'hour' ? 'Select Hour' : 'Select Minutes'}
              </div>
            </div>

            {/* Footer Buttons */}
            <div className="flex items-center justify-between px-5 pb-5">
              <button type="button" onClick={handleClear} className="text-gray-400 hover:text-white text-sm font-medium">Clear</button>
              <div className="flex gap-3">
                <button type="button" onClick={() => setShow(false)} className="text-gray-400 hover:text-white text-sm font-medium">Cancel</button>
                <button type="button" onClick={handleSet} className="text-[#7c3aed] hover:text-[#a855f7] text-sm font-bold">Set</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ClockPicker
