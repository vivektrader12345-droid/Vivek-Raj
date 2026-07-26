import React, { useState } from 'react'

/**
 * A select dropdown with "Add Custom..." option at the bottom.
 * Stores custom options in localStorage under the given storageKey.
 */
function CustomSelect({ name, value, onChange, options, placeholder, storageKey, className = '' }) {
  const [customOptions, setCustomOptions] = useState(() => {
    const saved = localStorage.getItem(storageKey)
    return saved ? JSON.parse(saved) : []
  })

  const handleChange = (e) => {
    if (e.target.value === '__add_custom__') {
      const custom = prompt('Enter custom option:')
      if (custom && custom.trim()) {
        const trimmed = custom.trim()
        if (!customOptions.includes(trimmed)) {
          const updated = [...customOptions, trimmed]
          setCustomOptions(updated)
          localStorage.setItem(storageKey, JSON.stringify(updated))
        }
        // Create a synthetic event
        onChange({ target: { name, value: trimmed } })
      }
    } else {
      onChange(e)
    }
  }

  return (
    <select name={name} value={value} onChange={handleChange} className={`input-field ${className}`}>
      <option value="">{placeholder || 'Select'}</option>
      {options.map(opt => {
        if (typeof opt === 'object') {
          return <option key={opt.value} value={opt.value}>{opt.label}</option>
        }
        return <option key={opt} value={opt}>{opt}</option>
      })}
      {customOptions
        .filter(c => !options.includes(c) && !options.find(o => (typeof o === 'object' ? o.value : o) === c))
        .map(c => <option key={`custom-${c}`} value={c}>⭐ {c}</option>)
      }
      <option value="__add_custom__">➕ Add Custom...</option>
    </select>
  )
}

export default CustomSelect
