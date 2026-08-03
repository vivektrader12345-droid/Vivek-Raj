import React from 'react'
import { ModalSheet } from './PortalPrimitives'

/**
 * Compatibility wrapper for the existing paper-order flow. ModalSheet now owns
 * portal mounting, focus trapping/restoration, Escape, outside pointer dismissal,
 * and drag-to-dismiss while preserving BottomSheet's public API.
 */
function BottomSheet({ isOpen, onClose, children, maxHeight = '85vh', title, ariaLabel = 'Paper order', contained = false }) {
  return <ModalSheet
    open={isOpen}
    onOpenChange={nextOpen => { if (!nextOpen) onClose() }}
    title={title}
    ariaLabel={ariaLabel}
    maxHeight={maxHeight}
    className="terminal-order-sheet"
    layerClassName={contained ? 'pro-terminal-modal-layer--chart' : ''}
    portal={!contained}
    draggable
  >
    {children}
  </ModalSheet>
}

export default BottomSheet
