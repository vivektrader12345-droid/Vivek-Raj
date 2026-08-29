import React, { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { BarChart3, Edit3, Loader2, Plus, Power, RotateCcw, Tag } from 'lucide-react'
import { billingService } from '../services/billingService'

const emptyForm = {
  code: '', type: 'percentage', value: '', minimumAmountInr: '0', maxDiscountInr: '',
  startsAt: '', expiresAt: '', globalUsageLimit: '', perUserUsageLimit: '',
  active: true, planIds: [], firstTimeOnly: false,
}
const localDate = value => value ? new Date(value).toISOString().slice(0, 16) : ''
const optionalInt = value => value === '' ? null : Number.parseInt(value, 10)
const optionalNumber = value => value === '' ? null : Number(value)
const isoDate = value => value ? new Date(value).toISOString() : null
const money = value => `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function AdminCoupons() {
  const [plans, setPlans] = useState([])
  const [coupons, setCoupons] = useState([])
  const [usages, setUsages] = useState([])
  const [analytics, setAnalytics] = useState({})
  const [form, setForm] = useState(emptyForm)
  const [editingCode, setEditingCode] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [planResponse, couponResponse, usageResponse, analyticsResponse] = await Promise.all([
        billingService.getAdminPlans(), billingService.getCoupons(), billingService.getCouponUsages(), billingService.getAnalytics(),
      ])
      setPlans(planResponse.plans || [])
      setCoupons(couponResponse.coupons || [])
      setUsages(usageResponse.usages || [])
      setAnalytics(analyticsResponse.analytics || {})
    } catch (loadError) {
      setError(loadError.message || 'Unable to load coupon administration.')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const usageByCoupon = useMemo(() => usages.reduce((result, usage) => {
    const key = usage.couponCode
    result[key] ||= { count: 0, discount: 0 }
    result[key].count += 1
    result[key].discount += Number(usage.discountInr || 0)
    return result
  }, {}), [usages])

  const update = (field, value) => setForm(previous => ({ ...previous, [field]: value }))
  const reset = () => { setForm(emptyForm); setEditingCode('') }
  const edit = coupon => {
    setEditingCode(coupon.code)
    setForm({
      code: coupon.code,
      type: coupon.type,
      value: String(coupon.value ?? ''),
      minimumAmountInr: String(coupon.minimumAmountInr ?? 0),
      maxDiscountInr: coupon.maxDiscountInr == null ? '' : String(coupon.maxDiscountInr),
      startsAt: localDate(coupon.startsAt),
      expiresAt: localDate(coupon.expiresAt),
      globalUsageLimit: coupon.globalUsageLimit == null ? '' : String(coupon.globalUsageLimit),
      perUserUsageLimit: coupon.perUserUsageLimit == null ? '' : String(coupon.perUserUsageLimit),
      active: Boolean(coupon.active),
      planIds: coupon.planIds || [],
      firstTimeOnly: Boolean(coupon.firstTimeOnly),
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const payload = () => ({
    code: form.code.trim().toUpperCase(),
    type: form.type,
    value: Number(form.value),
    minimumAmountInr: Number(form.minimumAmountInr || 0),
    maxDiscountInr: form.type === 'percentage' ? optionalNumber(form.maxDiscountInr) : null,
    startsAt: isoDate(form.startsAt),
    expiresAt: isoDate(form.expiresAt),
    globalUsageLimit: optionalInt(form.globalUsageLimit),
    perUserUsageLimit: optionalInt(form.perUserUsageLimit),
    active: form.active,
    planIds: form.planIds,
    firstTimeOnly: form.firstTimeOnly,
  })

  const submit = async event => {
    event.preventDefault()
    setSaving(true)
    try {
      if (editingCode) await billingService.updateCoupon(editingCode, payload())
      else await billingService.createCoupon(payload())
      toast.success(editingCode ? 'Coupon updated' : 'Coupon created')
      reset()
      await load()
    } catch (saveError) {
      toast.error(saveError.message || 'Coupon could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  const deactivate = async code => {
    if (!window.confirm(`Deactivate coupon ${code}? Existing successful payments are not affected.`)) return
    try {
      await billingService.deactivateCoupon(code)
      toast.success('Coupon deactivated')
      await load()
    } catch (deactivateError) {
      toast.error(deactivateError.message || 'Coupon could not be deactivated.')
    }
  }

  const togglePlan = planId => update('planIds', form.planIds.includes(planId)
    ? form.planIds.filter(value => value !== planId)
    : [...form.planIds, planId])

  const cards = [
    ['Total Coupons', analytics.totalCoupons || 0],
    ['Active Coupons', analytics.activeCoupons || 0],
    ['Expired Coupons', analytics.expiredCoupons || 0],
    ['Total Coupon Uses', analytics.totalCouponUses || 0],
    ['Total Discount Given', money(analytics.totalDiscountGivenInr)],
  ]

  return (
    <div className="mx-auto max-w-7xl space-y-7">
      <div><h1 className="flex items-center gap-3 text-2xl font-bold text-white sm:text-3xl"><Tag className="text-[#e94560]" /> Coupon Management</h1><p className="mt-2 text-gray-400">Create, control and audit server-validated discounts.</p></div>
      {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">{error}</div>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">{cards.map(([label, value]) => <div key={label} className="glass-card p-4"><p className="text-xl font-bold text-white sm:text-2xl">{value}</p><p className="mt-1 text-xs uppercase tracking-wide text-gray-500">{label}</p></div>)}</div>

      <form onSubmit={submit} className="glass-card p-5 sm:p-6">
        <div className="mb-5 flex items-center justify-between"><h2 className="flex items-center gap-2 text-lg font-semibold text-white">{editingCode ? <Edit3 size={19} /> : <Plus size={19} />}{editingCode ? `Edit ${editingCode}` : 'Create Coupon'}</h2>{editingCode && <button type="button" onClick={reset} className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-white"><RotateCcw size={15} /> Reset</button>}</div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-sm text-gray-400">Coupon Code<input required disabled={Boolean(editingCode)} maxLength={32} value={form.code} onChange={event => update('code', event.target.value.toUpperCase())} className="input-field mt-1 uppercase disabled:opacity-60" /></label>
          <label className="text-sm text-gray-400">Discount Type<select value={form.type} onChange={event => update('type', event.target.value)} className="input-field mt-1"><option value="percentage">Percentage (%)</option><option value="fixed">Fixed Amount (₹)</option></select></label>
          <label className="text-sm text-gray-400">Discount Value<input required type="number" min="0.01" max={form.type === 'percentage' ? '100' : undefined} step="0.01" value={form.value} onChange={event => update('value', event.target.value)} className="input-field mt-1" /></label>
          <label className="text-sm text-gray-400">Minimum Order (₹)<input required type="number" min="0" step="0.01" value={form.minimumAmountInr} onChange={event => update('minimumAmountInr', event.target.value)} className="input-field mt-1" /></label>
          <label className="text-sm text-gray-400">Maximum Discount (₹)<input disabled={form.type !== 'percentage'} type="number" min="0" step="0.01" value={form.maxDiscountInr} onChange={event => update('maxDiscountInr', event.target.value)} className="input-field mt-1 disabled:opacity-50" /></label>
          <label className="text-sm text-gray-400">Start Date<input type="datetime-local" value={form.startsAt} onChange={event => update('startsAt', event.target.value)} className="input-field mt-1" /></label>
          <label className="text-sm text-gray-400">Expiry Date<input type="datetime-local" value={form.expiresAt} onChange={event => update('expiresAt', event.target.value)} className="input-field mt-1" /></label>
          <label className="text-sm text-gray-400">Maximum Usage<input type="number" min="1" step="1" value={form.globalUsageLimit} onChange={event => update('globalUsageLimit', event.target.value)} className="input-field mt-1" /></label>
          <label className="text-sm text-gray-400">Per User Limit<input type="number" min="1" step="1" value={form.perUserUsageLimit} onChange={event => update('perUserUsageLimit', event.target.value)} className="input-field mt-1" /></label>
        </div>
        <fieldset className="mt-5"><legend className="text-sm text-gray-400">Applicable Plans <span className="text-gray-600">(none selected = all)</span></legend><div className="mt-2 flex flex-wrap gap-2">{plans.map(plan => <label key={plan.id} className={`cursor-pointer rounded-lg border px-3 py-2 text-sm ${form.planIds.includes(plan.id) ? 'border-[#e94560] bg-[#e94560]/10 text-[#e94560]' : 'border-[#2a2a5a] text-gray-400'}`}><input type="checkbox" className="sr-only" checked={form.planIds.includes(plan.id)} onChange={() => togglePlan(plan.id)} />{plan.name}</label>)}</div></fieldset>
        <div className="mt-5 flex flex-wrap gap-5"><label className="flex items-center gap-2 text-sm text-gray-300"><input type="checkbox" checked={form.active} onChange={event => update('active', event.target.checked)} /> Active</label><label className="flex items-center gap-2 text-sm text-gray-300"><input type="checkbox" checked={form.firstTimeOnly} onChange={event => update('firstTimeOnly', event.target.checked)} /> First-time users only</label></div>
        <button type="submit" disabled={saving} className="btn-primary mt-6 max-w-xs disabled:opacity-60">{saving ? 'Saving…' : editingCode ? 'Update Coupon' : 'Create Coupon'}</button>
      </form>

      <section className="glass-card overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#2a2a5a]/50 p-5"><h2 className="text-lg font-semibold text-white">Coupons</h2>{loading && <Loader2 className="animate-spin text-gray-400" size={19} />}</div>
        <div className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">{coupons.map(coupon => {
          const usage = usageByCoupon[coupon.code] || { count: 0, discount: 0 }
          const expired = coupon.expiresAt && new Date(coupon.expiresAt) <= new Date()
          return <article key={coupon.code} className="rounded-xl border border-[#2a2a5a]/50 bg-[#0a0a1f]/60 p-4">
            <div className="flex items-start justify-between gap-3"><div><p className="font-mono text-lg font-bold text-white">{coupon.code}</p><p className="mt-1 text-sm text-[#f5a623]">{coupon.type === 'percentage' ? `${coupon.value}%` : money(coupon.value)} off</p></div><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${coupon.active && !expired ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>{expired ? 'Expired' : coupon.active ? 'Active' : 'Inactive'}</span></div>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-xs"><div><dt className="text-gray-500">Uses</dt><dd className="mt-0.5 text-gray-200">{coupon.usedCount}{coupon.globalUsageLimit ? ` / ${coupon.globalUsageLimit}` : ''}</dd></div><div><dt className="text-gray-500">Discount Given</dt><dd className="mt-0.5 text-gray-200">{money(usage.discount)}</dd></div><div><dt className="text-gray-500">Per User</dt><dd className="mt-0.5 text-gray-200">{coupon.perUserUsageLimit || 'Unlimited'}</dd></div><div><dt className="text-gray-500">Plans</dt><dd className="mt-0.5 capitalize text-gray-200">{coupon.planIds?.length ? coupon.planIds.join(', ') : 'All'}</dd></div></dl>
            <div className="mt-4 flex gap-2"><button onClick={() => edit(coupon)} className="btn-secondary flex flex-1 items-center justify-center gap-1.5 text-xs"><Edit3 size={14} /> Edit</button>{coupon.active && <button onClick={() => deactivate(coupon.code)} className="btn-secondary flex flex-1 items-center justify-center gap-1.5 text-xs text-red-400"><Power size={14} /> Deactivate</button>}</div>
          </article>
        })}{!loading && coupons.length === 0 && <p className="p-4 text-sm text-gray-500">No coupons created.</p>}</div>
      </section>

      <section className="glass-card overflow-hidden"><div className="flex items-center gap-2 border-b border-[#2a2a5a]/50 p-5"><BarChart3 size={19} className="text-[#f5a623]" /><h2 className="text-lg font-semibold text-white">Recent Coupon Usage</h2></div><div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left text-sm"><thead className="text-xs uppercase text-gray-500"><tr><th className="px-5 py-3">Date</th><th className="px-5 py-3">Coupon</th><th className="px-5 py-3">User</th><th className="px-5 py-3">Payment</th><th className="px-5 py-3">Discount</th></tr></thead><tbody className="divide-y divide-[#2a2a5a]/30">{usages.map(usage => <tr key={usage.id || `${usage.providerPaymentId}-${usage.couponCode}`}><td className="px-5 py-3 text-gray-400">{new Date(usage.createdAt).toLocaleString('en-IN')}</td><td className="px-5 py-3 font-mono text-white">{usage.couponCode}</td><td className="max-w-[150px] truncate px-5 py-3 text-gray-400">{usage.userId}</td><td className="max-w-[150px] truncate px-5 py-3 font-mono text-xs text-gray-500">{usage.providerPaymentId}</td><td className="px-5 py-3 text-emerald-400">{money(usage.discountInr)}</td></tr>)}</tbody></table></div></section>
    </div>
  )
}
