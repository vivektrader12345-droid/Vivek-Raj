import React, { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Download, Loader2, FileText } from 'lucide-react'
import { useSubscription } from '../context/SubscriptionContext'
import { billingService } from '../services/billingService'

const money = value => `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function PaymentHistory() {
  const [payments, setPayments] = useState([])
  const [loading, setLoading] = useState(true)
  const [downloading, setDownloading] = useState('')
  const [error, setError] = useState('')
  const { reconcilePending } = useSubscription()

  const loadPayments = useCallback(async ({ initial = false } = {}) => {
    if (initial) setLoading(true)
    setError('')
    try {
      await reconcilePending()
      const result = await billingService.getPayments()
      setPayments(result.payments || [])
    } catch (requestError) {
      setError(requestError.message || 'Unable to load payment history.')
    } finally {
      if (initial) setLoading(false)
    }
  }, [reconcilePending])

  useEffect(() => {
    let active = true
    const load = async options => {
      if (active) await loadPayments(options)
    }
    load({ initial: true })
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    return () => {
      active = false
      window.removeEventListener('focus', onFocus)
    }
  }, [loadPayments])

  const downloadInvoice = async payment => {
    setDownloading(payment.providerOrderId)
    try {
      const html = await billingService.getInvoice(payment.providerOrderId)
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `invoice-${payment.providerOrderId}.html`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (invoiceError) {
      toast.error(invoiceError.message || 'Unable to download invoice.')
    } finally {
      setDownloading('')
    }
  }

  if (loading) return <div className="flex min-h-[50vh] items-center justify-center gap-2 text-gray-400"><Loader2 className="animate-spin" /> Loading payments…</div>

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div><h1 className="flex items-center gap-3 text-2xl font-bold text-white sm:text-3xl"><FileText className="text-[#e94560]" /> Payment History</h1><p className="mt-2 text-gray-400">Verified subscription payments and downloadable invoices.</p></div>
      {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">{error}</div>}
      {!error && payments.length === 0 && <div className="glass-card p-10 text-center text-gray-400">No verified payments yet.</div>}

      <div className="hidden overflow-x-auto rounded-2xl border border-[#2a2a5a]/50 md:block">
        <table className="w-full min-w-[1050px] text-left text-sm">
          <thead className="bg-[#12122a] text-xs uppercase text-gray-400"><tr>{['Date', 'Plan', 'Original', 'Coupon', 'Discount', 'Final', 'Payment ID', 'Status', 'Receipt'].map(label => <th key={label} className="px-4 py-3">{label}</th>)}</tr></thead>
          <tbody className="divide-y divide-[#2a2a5a]/40 bg-[#0a0a1f]/60">
            {payments.map(payment => <tr key={payment.id || payment.providerPaymentId || payment.providerOrderId} className="hover:bg-[#2a2a5a]/10">
              <td className="whitespace-nowrap px-4 py-4 text-gray-300">{new Date(payment.verifiedAt || payment.createdAt).toLocaleString('en-IN')}</td>
              <td className="px-4 py-4 font-medium capitalize text-white">{payment.planSnapshot?.name || payment.planId}</td>
              <td className="px-4 py-4 text-gray-300">{money(payment.originalAmountInr)}</td>
              <td className="px-4 py-4 text-gray-300">{payment.couponCode || '—'}</td>
              <td className="px-4 py-4 text-emerald-400">-{money(payment.discountInr)}</td>
              <td className="px-4 py-4 font-semibold text-white">{money(payment.amountInr)}</td>
              <td className="max-w-[150px] truncate px-4 py-4 font-mono text-xs text-gray-400" title={payment.providerPaymentId}>{payment.providerPaymentId}</td>
              <td className="px-4 py-4"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${payment.status === 'captured' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>{payment.status}</span></td>
              <td className="px-4 py-4">{payment.status === 'captured' ? <button onClick={() => downloadInvoice(payment)} disabled={downloading === payment.providerOrderId} className="flex items-center gap-1.5 text-[#f5a623] hover:underline disabled:opacity-50"><Download size={15} /> Invoice</button> : <span className="text-gray-600">—</span>}</td>
            </tr>)}
          </tbody>
        </table>
      </div>

      <div className="space-y-4 md:hidden">
        {payments.map(payment => <article key={payment.id || payment.providerPaymentId || payment.providerOrderId} className="glass-card p-5">
          <div className="flex items-start justify-between gap-3"><div><p className="font-semibold capitalize text-white">{payment.planSnapshot?.name || payment.planId}</p><p className="mt-1 text-xs text-gray-500">{new Date(payment.verifiedAt || payment.createdAt).toLocaleString('en-IN')}</p></div><span className={`rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${payment.status === 'captured' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>{payment.status}</span></div>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm"><div><dt className="text-gray-500">Original</dt><dd className="text-gray-200">{money(payment.originalAmountInr)}</dd></div><div><dt className="text-gray-500">Discount</dt><dd className="text-emerald-400">-{money(payment.discountInr)}</dd></div><div><dt className="text-gray-500">Coupon</dt><dd className="text-gray-200">{payment.couponCode || '—'}</dd></div><div><dt className="text-gray-500">Final</dt><dd className="font-semibold text-white">{money(payment.amountInr)}</dd></div></dl>
          <p className="mt-4 truncate font-mono text-xs text-gray-500">{payment.providerPaymentId}</p>
          {payment.status === 'captured' && <button onClick={() => downloadInvoice(payment)} disabled={downloading === payment.providerOrderId} className="btn-secondary mt-4 flex w-full items-center justify-center gap-2 text-sm"><Download size={16} /> Download Invoice</button>}
        </article>)}
      </div>
    </div>
  )
}
