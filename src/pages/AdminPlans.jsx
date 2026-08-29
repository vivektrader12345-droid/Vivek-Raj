import React, { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { ArrowDown, ArrowUp, Crown, Edit3, Loader2, Plus, Power, RotateCcw } from 'lucide-react'
import { billingService } from '../services/billingService'
import { useSubscription } from '../context/SubscriptionContext'

const emptyForm = {
  id: '', name: '', priceInr: '', durationDays: '30', featuresText: '',
  entitlementTier: 'basic', active: true, revision: 0,
}

const money = paise => `₹${(Number(paise || 0) / 100).toLocaleString('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})}`

function inrToPaise(value) {
  const normalized = String(value || '').trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error('Price must be a valid INR amount with at most two decimals.')
  const [whole, fraction = ''] = normalized.split('.')
  const amount = (Number(whole) * 100) + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Price must be greater than zero.')
  return amount
}

export default function AdminPlans() {
  const { refresh } = useSubscription()
  const [plans, setPlans] = useState([])
  const [form, setForm] = useState(emptyForm)
  const [editingId, setEditingId] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [reordering, setReordering] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await billingService.getAdminPlans()
      setPlans(response.plans || [])
    } catch (loadError) {
      setError(loadError.message || 'Unable to load subscription plans.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const update = (field, value) => setForm(previous => ({ ...previous, [field]: value }))
  const reset = () => { setForm(emptyForm); setEditingId('') }
  const edit = plan => {
    setEditingId(plan.id)
    setForm({
      id: plan.id,
      name: plan.name,
      priceInr: (Number(plan.amountPaise) / 100).toFixed(2),
      durationDays: String(plan.durationDays),
      featuresText: (plan.features || []).join('\n'),
      entitlementTier: plan.entitlementTier || plan.id || 'basic',
      active: Boolean(plan.active),
      revision: Number(plan.revision || 0),
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const formPayload = () => {
    const id = form.id.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(id)) throw new Error('Plan ID must be 2-32 lowercase letters, numbers, underscores, or hyphens.')
    const durationDays = Number(form.durationDays)
    if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650) throw new Error('Duration must be between 1 and 3650 days.')
    const features = form.featuresText.split('\n').map(value => value.trim()).filter(Boolean)
    if (!features.length) throw new Error('Add at least one plan feature.')
    return {
      id,
      name: form.name.trim(),
      amountPaise: inrToPaise(form.priceInr),
      durationDays,
      features,
      entitlementTier: form.entitlementTier,
      active: form.active,
    }
  }

  const submit = async event => {
    event.preventDefault()
    setSaving(true)
    try {
      const payload = formPayload()
      if (editingId) {
        const { id: _immutableId, ...changes } = payload
        await billingService.updatePlan(editingId, { ...changes, revision: form.revision })
        toast.success('Plan updated')
      } else {
        await billingService.createPlan(payload)
        toast.success('Plan created')
      }
      reset()
      await Promise.all([load(), refresh({ silent: true })])
    } catch (saveError) {
      toast.error(saveError.message || 'Plan could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  const deactivate = async plan => {
    if (!window.confirm(`Deactivate ${plan.name}? Existing orders and subscriptions will remain valid.`)) return
    try {
      await billingService.deactivatePlan(plan.id)
      toast.success('Plan deactivated')
      await Promise.all([load(), refresh({ silent: true })])
    } catch (deactivateError) {
      toast.error(deactivateError.message || 'Plan could not be deactivated.')
    }
  }

  const move = async (index, offset) => {
    const target = index + offset
    if (target < 0 || target >= plans.length || reordering) return
    const reordered = [...plans]
    const [plan] = reordered.splice(index, 1)
    reordered.splice(target, 0, plan)
    setPlans(reordered)
    setReordering(true)
    try {
      const response = await billingService.reorderPlans(reordered.map(value => value.id))
      setPlans(response.plans || reordered)
      await refresh({ silent: true })
    } catch (reorderError) {
      toast.error(reorderError.message || 'Plan order could not be changed.')
      await load()
    } finally {
      setReordering(false)
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-7">
      <div>
        <h1 className="flex items-center gap-3 text-2xl font-bold text-white sm:text-3xl"><Crown className="text-[#f5a623]" /> Plan Management</h1>
        <p className="mt-2 text-gray-400">Manage server-owned prices, duration, features, access tier and checkout availability.</p>
      </div>

      {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">{error}</div>}

      <form onSubmit={submit} className="glass-card p-5 sm:p-6">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white">{editingId ? <Edit3 size={19} /> : <Plus size={19} />}{editingId ? `Edit ${editingId}` : 'Create Plan'}</h2>
          {editingId && <button type="button" onClick={reset} className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-white"><RotateCcw size={15} /> Reset</button>}
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-sm text-gray-400">Plan ID<input required disabled={Boolean(editingId)} maxLength={32} pattern="[a-z0-9][a-z0-9_-]{1,31}" value={form.id} onChange={event => update('id', event.target.value.toLowerCase())} className="input-field mt-1 lowercase disabled:opacity-60" placeholder="pro-monthly" /></label>
          <label className="text-sm text-gray-400">Plan Name<input required maxLength={80} value={form.name} onChange={event => update('name', event.target.value)} className="input-field mt-1" placeholder="Pro Monthly" /></label>
          <label className="text-sm text-gray-400">Price (₹)<input required inputMode="decimal" value={form.priceInr} onChange={event => update('priceInr', event.target.value)} className="input-field mt-1" placeholder="999.00" /></label>
          <label className="text-sm text-gray-400">Duration (days)<input required type="number" min="1" max="3650" step="1" value={form.durationDays} onChange={event => update('durationDays', event.target.value)} className="input-field mt-1" /></label>
          <label className="text-sm text-gray-400">Access Tier<select value={form.entitlementTier} onChange={event => update('entitlementTier', event.target.value)} className="input-field mt-1"><option value="basic">Basic</option><option value="pro">Pro</option><option value="elite">Elite</option></select></label>
          <label className="flex items-center gap-2 self-end pb-3 text-sm text-gray-300"><input type="checkbox" checked={form.active} onChange={event => update('active', event.target.checked)} /> Available for checkout</label>
        </div>

        <label className="mt-4 block text-sm text-gray-400">Features (one per line)<textarea required rows={5} maxLength={3400} value={form.featuresText} onChange={event => update('featuresText', event.target.value)} className="input-field mt-1 resize-y" placeholder={'Advanced analytics\nAlgo trading\nPriority support'} /></label>
        <p className="mt-3 text-xs text-gray-500">Plan IDs are permanent. Price and duration changes apply only to new orders; historical payments keep their original snapshot.</p>
        <button type="submit" disabled={saving} className="btn-primary mt-6 max-w-xs disabled:opacity-60">{saving ? 'Saving…' : editingId ? 'Update Plan' : 'Create Plan'}</button>
      </form>

      <section className="glass-card overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#2a2a5a]/50 p-5"><div><h2 className="text-lg font-semibold text-white">Plans</h2><p className="mt-1 text-xs text-gray-500">Use arrows to change the order shown on the Subscription page.</p></div>{(loading || reordering) && <Loader2 className="animate-spin text-gray-400" size={19} />}</div>
        <div className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
          {plans.map((plan, index) => (
            <article key={plan.id} className="rounded-xl border border-[#2a2a5a]/50 bg-[#0a0a1f]/60 p-4">
              <div className="flex items-start justify-between gap-3"><div><p className="font-mono text-xs uppercase text-gray-500">{plan.id}</p><h3 className="mt-1 text-lg font-bold text-white">{plan.name}</h3></div><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${plan.active ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>{plan.active ? 'Active' : 'Inactive'}</span></div>
              <p className="mt-4 text-2xl font-bold gradient-text">{money(plan.amountPaise)} <span className="text-xs font-normal text-gray-500">/ {plan.durationDays} days</span></p>
              <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-[#f5a623]">{plan.entitlementTier} access</p>
              <ul className="mt-3 space-y-1 text-sm text-gray-400">{(plan.features || []).map(feature => <li key={feature}>• {feature}</li>)}</ul>
              <div className="mt-5 flex flex-wrap gap-2">
                <button type="button" onClick={() => move(index, -1)} disabled={index === 0 || reordering} className="btn-secondary p-2 disabled:opacity-30" aria-label={`Move ${plan.name} up`}><ArrowUp size={15} /></button>
                <button type="button" onClick={() => move(index, 1)} disabled={index === plans.length - 1 || reordering} className="btn-secondary p-2 disabled:opacity-30" aria-label={`Move ${plan.name} down`}><ArrowDown size={15} /></button>
                <button type="button" onClick={() => edit(plan)} className="btn-secondary flex flex-1 items-center justify-center gap-1.5 text-xs"><Edit3 size={14} /> Edit</button>
                {plan.active && <button type="button" onClick={() => deactivate(plan)} className="btn-secondary flex flex-1 items-center justify-center gap-1.5 text-xs text-red-400"><Power size={14} /> Deactivate</button>}
              </div>
            </article>
          ))}
          {!loading && plans.length === 0 && <p className="p-4 text-sm text-gray-500">No plans configured.</p>}
        </div>
      </section>
    </div>
  )
}
