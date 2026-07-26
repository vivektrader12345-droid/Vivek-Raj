/**
 * Export Trade Reports as PDF
 */

export const exportTradeReportPDF = (trades, stats, title = 'Trading Report') => {
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const now = new Date()
  const dateStr = `${now.getDate()} ${monthNames[now.getMonth()]} ${now.getFullYear()}`

  const wins = trades.filter(t => t.pnl > 0).length
  const losses = trades.filter(t => t.pnl < 0).length
  const totalPnL = trades.reduce((s, t) => s + (t.pnl || 0), 0)
  const winRate = trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : '0'

  let html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>${title} - Vivek Marco Trader</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', sans-serif; padding: 40px; color: #1a1a2e; }
        .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #e94560; padding-bottom: 20px; }
        .header h1 { color: #e94560; font-size: 24px; }
        .header p { color: #666; margin-top: 5px; }
        .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-bottom: 30px; }
        .stat-box { background: #f5f7fa; border-radius: 8px; padding: 15px; text-align: center; border: 1px solid #e2e8f0; }
        .stat-box .value { font-size: 20px; font-weight: bold; margin-top: 5px; }
        .stat-box .label { font-size: 11px; color: #718096; text-transform: uppercase; }
        .green { color: #059669; }
        .red { color: #dc2626; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 20px; }
        th { background: #1a1a2e; color: white; padding: 10px 8px; text-align: left; }
        td { padding: 8px; border-bottom: 1px solid #e2e8f0; }
        tr:hover { background: #f7fafc; }
        .footer { margin-top: 30px; text-align: center; color: #999; font-size: 11px; border-top: 1px solid #e2e8f0; padding-top: 15px; }
        @media print { body { padding: 20px; } }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>🐂 Vivek Marco Trader</h1>
        <p>${title} | Generated: ${dateStr}</p>
      </div>

      <div class="stats">
        <div class="stat-box"><div class="label">Total Trades</div><div class="value">${trades.length}</div></div>
        <div class="stat-box"><div class="label">Win Rate</div><div class="value green">${winRate}%</div></div>
        <div class="stat-box"><div class="label">Total P&L</div><div class="value ${totalPnL >= 0 ? 'green' : 'red'}">$${totalPnL.toFixed(2)}</div></div>
        <div class="stat-box"><div class="label">Wins / Losses</div><div class="value">${wins} / ${losses}</div></div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Date</th><th>Pair</th><th>Type</th><th>Entry</th><th>Exit</th>
            <th>Qty</th><th>P&L</th><th>Strategy</th>
          </tr>
        </thead>
        <tbody>
          ${trades.map(t => `
            <tr>
              <td>${t.date || '-'}</td>
              <td><strong>${t.pair || '-'}</strong></td>
              <td>${t.type === 'long' ? '📈 BUY' : '📉 SELL'}</td>
              <td>$${t.entryPrice || '-'}</td>
              <td>$${t.exitPrice || '-'}</td>
              <td>${t.quantity || '-'}</td>
              <td class="${t.pnl >= 0 ? 'green' : 'red'}"><strong>${t.pnl >= 0 ? '+' : ''}$${(t.pnl || 0).toFixed(2)}</strong></td>
              <td>${t.strategy || '-'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>

      <div class="footer">
        Vivek Marco Trader | Auto-generated report | Not financial advice
      </div>
    </body>
    </html>
  `

  const printWindow = window.open('', '_blank')
  printWindow.document.write(html)
  printWindow.document.close()
  setTimeout(() => printWindow.print(), 500)
}

export const exportMonthlyReport = (trades) => {
  const now = new Date()
  const monthTrades = trades.filter(t => {
    const d = new Date(t.date)
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
  })
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December']
  exportTradeReportPDF(monthTrades, null, `Monthly Report - ${monthNames[now.getMonth()]} ${now.getFullYear()}`)
}
