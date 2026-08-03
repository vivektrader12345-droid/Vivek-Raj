import React from 'react'
import { formatPrice } from '../types'
import { QuoteStatus } from '../paperOrderDraft'

const STATUS_LABELS = {
  [QuoteStatus.CURRENT]: 'Current',
  [QuoteStatus.STALE]: 'Stale',
  [QuoteStatus.UNAVAILABLE]: 'Unavailable',
}

const displayedPrice = value => Number.isFinite(value) && value > 0 ? formatPrice(value) : '—'

function PaperQuoteBox({ quote, symbol, tileId, onOpenPaperOrderDraft }) {
  const statusLabel = STATUS_LABELS[quote.status] || STATUS_LABELS[QuoteStatus.UNAVAILABLE]
  const openDraft = side => {
    const sidePrice = side === 'sell' ? quote.bid : quote.ask
    onOpenPaperOrderDraft({
      tileId,
      symbol,
      side,
      price: quote.status === QuoteStatus.CURRENT ? sidePrice : undefined,
      quoteStatus: quote.status,
    })
  }

  return <div
    className="quick-quote"
    data-paper-quote
    data-quote-status={quote.status}
    role="group"
    aria-label={`Paper trading quote, ${statusLabel.toLowerCase()}`}
  >
    <button
      type="button"
      data-paper-quote-action="sell"
      onClick={() => openDraft('sell')}
      className="quick-quote__side quick-quote__side--sell"
      aria-label={`Open Paper SELL draft${quote.status === QuoteStatus.CURRENT ? ` at bid ${displayedPrice(quote.bid)}` : `, quote ${statusLabel.toLowerCase()}`}`}
    >
      <span>Paper SELL</span>
      <strong><small>BID</small>{displayedPrice(quote.bid)}</strong>
    </button>
    <div className="quick-quote__spread">
      <span>SPREAD</span>
      <strong>{displayedPrice(quote.spread)}</strong>
      <em className={`quick-quote__status quick-quote__status--${quote.status}`} role="status">{statusLabel}</em>
    </div>
    <button
      type="button"
      data-paper-quote-action="buy"
      onClick={() => openDraft('buy')}
      className="quick-quote__side quick-quote__side--buy"
      aria-label={`Open Paper BUY draft${quote.status === QuoteStatus.CURRENT ? ` at ask ${displayedPrice(quote.ask)}` : `, quote ${statusLabel.toLowerCase()}`}`}
    >
      <span>Paper BUY</span>
      <strong><small>ASK</small>{displayedPrice(quote.ask)}</strong>
    </button>
  </div>
}

export default React.memo(PaperQuoteBox)
