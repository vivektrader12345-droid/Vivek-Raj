/**
 * BottomSheet - Animated slide-up panel component
 * Similar to TradingView Mobile's order entry sheet
 * Features: smooth animation, drag handle, backdrop, responsive
 */
import React, { useEffect, useRef, useState, useCallback } from 'react'

function BottomSheet({ isOpen, onClose, children, maxHeight = '85vh' }) {
  const sheetRef = useRef(null)
  const [dragging, setDragging] = useState(false)
  const [dragStartY, setDragStartY] = useState(0)
  const [dragOffset, setDragOffset] = useState(0)
  const [isAnimating, setIsAnimating] = useState(false)

  // Handle open/close animation
  useEffect(() => {
    if (isOpen) {
      setIsAnimating(true)
      setDragOffset(0)
      // Small delay to trigger CSS transition
      requestAnimationFrame(() => {
        setIsAnimating(false)
      })
    }
  }, [isOpen])

  // Drag to dismiss
  const handleDragStart = useCallback((e) => {
    const clientY = e.touches ? e.touches[0].clientY : e.clientY
    setDragging(true)
    setDragStartY(clientY)
  }, [])

  const handleDragMove = useCallback((e) => {
    if (!dragging) return
    const clientY = e.touches ? e.touches[0].clientY : e.clientY
    const offset = Math.max(0, clientY - dragStartY)
    setDragOffset(offset)
  }, [dragging, dragStartY])

  const handleDragEnd = useCallback(() => {
    setDragging(false)
    if (dragOffset > 150) {
      onClose()
    }
    setDragOffset(0)
  }, [dragOffset, onClose])

  // Global event listeners for drag
  useEffect(() => {
    if (dragging) {
      window.addEventListener('mousemove', handleDragMove)
      window.addEventListener('mouseup', handleDragEnd)
      window.addEventListener('touchmove', handleDragMove, { passive: false })
      window.addEventListener('touchend', handleDragEnd)
      return () => {
        window.removeEventListener('mousemove', handleDragMove)
        window.removeEventListener('mouseup', handleDragEnd)
        window.removeEventListener('touchmove', handleDragMove)
        window.removeEventListener('touchend', handleDragEnd)
      }
    }
  }, [dragging, handleDragMove, handleDragEnd])

  // Escape key to close
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape' && isOpen) onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px] transition-opacity duration-300"
        style={{ opacity: isOpen ? 1 - dragOffset / 400 : 0 }}
        onClick={onClose}
      />

      {/* Sheet */}
      <div
        ref={sheetRef}
        className="fixed bottom-0 left-0 right-0 z-50 flex flex-col bg-[#0d0d22] border-t border-[#1e1e3a] rounded-t-2xl shadow-2xl shadow-black/50"
        style={{
          maxHeight,
          transform: `translateY(${dragOffset}px)`,
          transition: dragging ? 'none' : 'transform 0.35s cubic-bezier(0.32, 0.72, 0, 1)',
        }}
      >
        {/* Drag Handle */}
        <div
          className="flex justify-center py-2.5 cursor-grab active:cursor-grabbing shrink-0"
          onMouseDown={handleDragStart}
          onTouchStart={handleDragStart}
        >
          <div className="w-10 h-1 rounded-full bg-[#2a2a5a] hover:bg-[#3a3a7a] transition-colors" />
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto custom-scrollbar px-4 pb-4">
          {children}
        </div>
      </div>
    </>
  )
}

export default BottomSheet
