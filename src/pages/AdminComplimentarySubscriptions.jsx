import React, { useCallback, useEffect, useMemo, useReducer } from 'react'
import toast from 'react-hot-toast'
import {
  AlertTriangle, ChevronRight, Gift, History, Loader2, RefreshCw, Search, ShieldCheck, X,
} from 'lucide-react'
import { billingService } from '../services/billingService'
import { useSubscription } from '../context/SubscriptionContext'
import {
  buildGrantPayload,
  complimentaryAdminReducer,
  EMPTY_FILTERS,
  entitlementSummary,
  formatGrantValidity,
  formatLocalTimestampWithZone,
  GRANT_STATUSES,
  initialComplimentaryAdminState,
  isAuthorizationDenial,
  MAX_REASON_LENGTH,
  mutationAttempt,
  normalizeReasonInput,
  PRESET_DAYS,
  validityPreview,
} from './adminComplimentarySubscriptionsState.js'

const errorMessage = (error, fallback) => {
  const request = error?.requestId ? ` Request ID: ${error.requestId}.` : ''
  return `${error?.message || fallback}${request}`
}

function StatusBadge({ status }) {
  const styles = {
    active: 'bg-emerald-500/15 text-emerald-300',
    expired: 'bg-amber-500/15 text-amber-300',
    revoked: 'bg-red-500/15 text-red-300',
    superseded: 'bg-violet-500/15 text-violet-300',
  }
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${styles[status] || 'bg-gray-500/15 text-gray-300'}`}>{status || 'unknown'}</span>
}

function ErrorNotice({ message, onRetry, label = 'Retry' }) {
  if (!message) return null
  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200" role="alert">
      <p>{message}</p>
      {onRetry && <button type="button" onClick={onRetry} className="mt-3 inline-flex items-center gap-2 font-semibold text-red-100 hover:text-white"><RefreshCw size={14} /> {label}</button>}
    </div>
  )
}

function Modal({ title, children, onClose, busy = false, labelledBy }) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm" onMouseDown={event => !busy && event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby={labelledBy} className="max-h-[92vh] w-full max-w-2xl overflow-hidden rounded-2xl border border-[#2a2a5a] bg-[#0d0d20] shadow-2xl">
        <header className="flex items-center justify-between border-b border-[#2a2a5a]/60 px-5 py-4">
          <h2 id={labelledBy} className="font-semibold text-white">{title}</h2>
          <button type="button" aria-label="Close dialog" disabled={busy} onClick={onClose} className="rounded-lg p-2 text-gray-400 hover:bg-white/5 hover:text-white disabled:opacity-40"><X size={18} /></button>
        </header>
        <div className="max-h-[calc(92vh-65px)] overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  )
}

function EntitlementCard({ title, entitlement }) {
  return (
    <div className="rounded-xl border border-[#2a2a5a]/50 bg-[#08081a]/70 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</p>
      <p className="mt-2 text-sm font-semibold text-white">{entitlementSummary(entitlement)}</p>
      {entitlement?.expiresAt && <p className="mt-1 text-xs text-gray-400">{formatLocalTimestampWithZone(entitlement.expiresAt)}</p>}
      {entitlement?.lifetime === true && <p className="mt-1 text-xs text-emerald-300">Lifetime</p>}
    </div>
  )
}

function Actor({ value }) {
  if (!value) return <span>—</span>
  return <span>{value.email || 'Unknown email'} <span className="font-mono text-[11px] text-gray-500">({value.uid || 'unknown UID'})</span></span>
}

function GrantDetails({ grant, onRevoke, revoking }) {
  const details = [
    ['Grant ID', grant.id],
    ['Target UID', grant.targetUid],
    ['Target', grant.targetDisplayName ? `${grant.targetEmail} · ${grant.targetDisplayName}` : grant.targetEmail],
    ['Plan', `${grant.planName || 'Unknown'} (${grant.planId || 'unknown'}) · ${grant.entitlementTier || 'unknown'} tier`],
    ['Features', (grant.features || []).join(', ') || '—'],
    ['Validity', formatGrantValidity(grant)],
    ['Activation', formatLocalTimestampWithZone(grant.activationAt)],
    ['Created', formatLocalTimestampWithZone(grant.createdAt)],
    ['Updated', formatLocalTimestampWithZone(grant.updatedAt)],
    ['Created by', <Actor value={grant.createdBy} />],
    ['Reason', grant.reason || '—'],
    ['Ended', formatLocalTimestampWithZone(grant.endedAt)],
    ['End reason', grant.endReason || '—'],
    ['Revoked by', <Actor value={grant.revokedBy} />],
    ['Superseded by', grant.supersededByGrantId || '—'],
    ['Superseding actor', <Actor value={grant.supersededBy} />],
  ]
  return (
    <article className="rounded-xl border border-[#2a2a5a]/50 bg-[#09091d]/70 p-4" data-grant-id={grant.id}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h3 className="font-semibold text-white">{grant.targetEmail || 'Unknown target'}</h3><p className="mt-1 text-sm text-[#f5a623]">{grant.planName || grant.planId} · {grant.entitlementTier} access</p></div>
        <StatusBadge status={grant.status} />
      </div>
      <dl className="mt-4 grid gap-x-5 gap-y-3 text-xs sm:grid-cols-2">
        {details.map(([label, value]) => <div key={label} className={label === 'Reason' || label === 'Features' ? 'sm:col-span-2' : ''}><dt className="text-gray-500">{label}</dt><dd className="mt-0.5 break-words text-gray-200">{value}</dd></div>)}
      </dl>
      {grant.status === 'active' && <button type="button" disabled={revoking} onClick={() => onRevoke(grant)} className="btn-secondary mt-4 w-auto border-red-500/30 text-red-300 disabled:opacity-50">{revoking ? 'Revoking…' : 'Revoke access'}</button>}
    </article>
  )
}

export default function AdminComplimentarySubscriptions() {
  const { refreshAfterMutation } = useSubscription()
  const [state, dispatch] = useReducer(complimentaryAdminReducer, undefined, initialComplimentaryAdminState)

  const activePlans = useMemo(() => state.plans.filter(plan => plan.active !== false), [state.plans])
  const selectedPlan = useMemo(() => activePlans.find(plan => plan.id === state.grantForm.planId) || null, [activePlans, state.grantForm.planId])

  const handleApiError = useCallback((error, fallback, localAction) => {
    const message = errorMessage(error, fallback)
    if (isAuthorizationDenial(error)) dispatch({ type: 'ACCESS_DENIED', error: message })
    else dispatch({ type: localAction, error: message })
    return message
  }, [])

  const loadPlans = useCallback(async () => {
    dispatch({ type: 'PLANS_LOADING' })
    try {
      const response = await billingService.getPlans()
      dispatch({ type: 'PLANS_SUCCESS', plans: (response?.plans || []).filter(plan => plan.active !== false) })
    } catch (error) {
      dispatch({ type: 'PLANS_ERROR', error: errorMessage(error, 'Unable to load canonical plans.') })
    }
  }, [])

  const loadList = useCallback(async ({ filters = state.appliedFilters, cursor = null, append = false } = {}) => {
    dispatch({ type: 'LIST_LOADING' })
    try {
      const response = await billingService.listComplimentaryGrants({ limit: 25, ...filters, ...(cursor ? { cursor } : {}) })
      dispatch({ type: 'LIST_SUCCESS', grants: response?.grants || [], page: response?.page, append })
    } catch (error) {
      handleApiError(error, 'Unable to load complimentary grant history.', 'LIST_ERROR')
    }
  }, [handleApiError, state.appliedFilters])

  useEffect(() => { loadPlans() }, [loadPlans])
  useEffect(() => { loadList({ filters: EMPTY_FILTERS }) }, []) // Independent first load; retries are section-specific.

  const lookup = async event => {
    event.preventDefault()
    dispatch({ type: 'LOOKUP_LOADING' })
    try {
      const payload = await billingService.lookupBillingUser(state.lookupEmail)
      dispatch({ type: 'LOOKUP_SUCCESS', payload })
    } catch (error) {
      handleApiError(error, 'Unable to look up that Firebase Authentication user.', 'LOOKUP_ERROR')
    }
  }

  const reviewGrant = event => {
    event.preventDefault()
    try {
      const payload = buildGrantPayload(state)
      dispatch({
        type: 'OPEN_GRANT_CONFIRMATION',
        summary: {
          payload,
          plan: selectedPlan,
          preview: validityPreview(state.grantForm),
          supersedes: state.lookupEffectiveEntitlement?.source === 'complimentary' && state.lookupEffectiveEntitlement?.status === 'active',
        },
      })
    } catch (error) {
      dispatch({ type: 'CREATE_ERROR', error: error.message })
    }
  }

  const confirmGrant = async () => {
    const payload = state.grantConfirmation?.payload
    if (!payload || state.creating) return
    let attempt
    try {
      attempt = mutationAttempt(state.grantAttempt, payload, undefined, 'grant')
    } catch (error) {
      dispatch({ type: 'CREATE_ERROR', error: error.message })
      return
    }
    dispatch({ type: 'CREATE_STARTED', attempt })
    try {
      const result = await billingService.createComplimentaryGrant({ ...payload, idempotencyKey: attempt.key })
      dispatch({ type: 'CREATE_SUCCESS', result })
      toast.success(result.duplicate ? 'Grant retry confirmed' : 'Complimentary access granted')
      await Promise.allSettled([
        loadList({ filters: state.appliedFilters }),
        refreshAfterMutation(),
      ])
    } catch (error) {
      handleApiError(error, 'Complimentary access could not be granted.', 'CREATE_ERROR')
    }
  }

  const applyFilters = event => {
    event.preventDefault()
    const filters = { ...state.filters }
    dispatch({ type: 'FILTERS_APPLIED' })
    loadList({ filters })
  }

  const resetFilters = () => {
    dispatch({ type: 'FILTERS_RESET' })
    loadList({ filters: EMPTY_FILTERS })
  }

  const confirmRevoke = async () => {
    const grant = state.revokeConfirmation
    if (!grant || state.revokingGrantId) return
    let reason
    let attempt
    try {
      reason = normalizeReasonInput(state.revokeReason)
      const payload = { grantId: grant.id, reason }
      attempt = mutationAttempt(state.revokeAttempt, payload, undefined, 'revoke')
    } catch (error) {
      dispatch({ type: 'REVOKE_ERROR', error: error.message })
      return
    }
    dispatch({ type: 'REVOKE_STARTED', grantId: grant.id, attempt })
    try {
      const result = await billingService.revokeComplimentaryGrant(grant.id, { reason, idempotencyKey: attempt.key })
      dispatch({ type: 'REVOKE_SUCCESS', result })
      toast.success(result.duplicate ? 'Revocation retry confirmed' : 'Complimentary access revoked')
      await Promise.allSettled([
        loadList({ filters: state.appliedFilters }),
        refreshAfterMutation(),
      ])
    } catch (error) {
      handleApiError(error, 'Complimentary access could not be revoked.', 'REVOKE_ERROR')
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-7">
      <header>
        <h1 className="flex items-center gap-3 text-2xl font-bold text-white sm:text-3xl"><Gift className="text-emerald-400" /> Complimentary Subscriptions</h1>
        <p className="mt-2 max-w-3xl text-gray-400">Grant and revoke zero-payment access for existing verified Firebase Authentication users. Plans, identity, time, and entitlement are confirmed by the billing server.</p>
      </header>

      {state.accessDenied && <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100" role="alert"><div className="flex gap-3"><ShieldCheck className="shrink-0" size={20} /><div><p className="font-semibold">Administrative access was denied by the backend</p><p className="mt-1 text-amber-100/80">{state.accessDenied}</p><p className="mt-1 text-xs text-amber-100/60">Protected lookup and grant data has been cleared. Refresh your administrator session before retrying.</p></div></div></div>}

      {state.mutationResult && <section className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4" aria-live="polite"><p className="font-semibold text-emerald-200">{state.mutationResult.operation === 'grant' ? 'Authoritative grant result' : 'Authoritative revoke result'}{state.mutationResult.duplicate ? ' · duplicate retry' : ''}</p><div className="mt-3 grid gap-3 sm:grid-cols-2"><EntitlementCard title="Effective entitlement" entitlement={state.mutationResult.effectiveEntitlement} /><EntitlementCard title="Paid fallback" entitlement={state.mutationResult.paidFallback} /></div></section>}

      <div className="grid gap-7 xl:grid-cols-[minmax(0,1fr)_minmax(300px,0.72fr)]">
        <section className="glass-card p-5 sm:p-6" aria-labelledby="lookup-title">
          <div className="flex items-start justify-between gap-3"><div><h2 id="lookup-title" className="text-lg font-semibold text-white">1. Find an existing user</h2><p className="mt-1 text-xs text-gray-500">Exact email only. Editing the email invalidates the selected target immediately.</p></div>{state.lookupLoading && <Loader2 className="animate-spin text-gray-400" size={19} />}</div>
          <form onSubmit={lookup} className="mt-4 flex flex-col gap-3 sm:flex-row">
            <label className="flex-1 text-sm text-gray-400">Firebase email<input required type="email" maxLength={254} autoComplete="off" value={state.lookupEmail} onChange={event => dispatch({ type: 'LOOKUP_EMAIL_CHANGED', value: event.target.value })} className="input-field mt-1" placeholder="person@example.com" /></label>
            <button type="submit" disabled={state.lookupLoading || !state.lookupEmail.trim()} className="btn-primary mt-auto flex w-auto items-center justify-center gap-2 disabled:opacity-50"><Search size={16} /> {state.lookupLoading ? 'Looking up…' : 'Look up'}</button>
          </form>
          <div className="mt-4"><ErrorNotice message={state.lookupError} /></div>
          {state.selectedUser && <div className={`mt-4 rounded-xl border p-4 ${state.selectedUser.grantEligible ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-amber-500/30 bg-amber-500/5'}`}>
            <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-semibold text-white">{state.selectedUser.email}</p><p className="mt-1 text-sm text-gray-400">{state.selectedUser.displayName || 'No display name'} · <span className="font-mono text-xs">{state.selectedUser.uid}</span></p></div><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${state.selectedUser.grantEligible ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>{state.selectedUser.grantEligible ? 'Eligible' : 'Not eligible'}</span></div>
            <p className="mt-3 text-xs text-gray-400">Email verified: {state.selectedUser.emailVerified ? 'Yes' : 'No'} · Account disabled: {state.selectedUser.disabled ? 'Yes' : 'No'}</p>
            {!state.selectedUser.grantEligible && <p className="mt-2 text-sm text-amber-200">Only enabled accounts with a verified canonical email can receive a grant.</p>}
            <div className="mt-4 grid gap-3 sm:grid-cols-2"><EntitlementCard title="Current effective state" entitlement={state.lookupEffectiveEntitlement} /><EntitlementCard title="Preserved paid fallback" entitlement={state.lookupPaidFallback} /></div>
          </div>}
        </section>

        <section className="glass-card p-5 sm:p-6" aria-labelledby="plans-title">
          <div className="flex items-start justify-between gap-3"><div><h2 id="plans-title" className="text-lg font-semibold text-white">Canonical active plans</h2><p className="mt-1 text-xs text-gray-500">Plan names, tiers, and features come from the server catalog.</p></div>{state.plansLoading && <Loader2 className="animate-spin text-gray-400" size={19} />}</div>
          <div className="mt-4"><ErrorNotice message={state.plansError} onRetry={loadPlans} label="Retry plans" /></div>
          {!state.plansLoading && !state.plansError && activePlans.length === 0 && <p className="mt-4 rounded-xl border border-[#2a2a5a]/50 p-4 text-sm text-gray-400">No active canonical plans are available.</p>}
          <div className="mt-4 space-y-3">{activePlans.map(plan => <article key={plan.id} className="rounded-xl border border-[#2a2a5a]/50 bg-[#09091d]/70 p-3"><div className="flex justify-between gap-3"><div><h3 className="font-semibold text-white">{plan.name}</h3><p className="mt-0.5 font-mono text-xs text-gray-500">{plan.id}</p></div><span className="text-xs font-semibold uppercase text-[#f5a623]">{plan.entitlementTier}</span></div><ul className="mt-2 space-y-1 text-xs text-gray-400">{(plan.features || []).map(feature => <li key={feature}>• {feature}</li>)}</ul></article>)}</div>
        </section>
      </div>

      <form onSubmit={reviewGrant} className="glass-card p-5 sm:p-6" aria-labelledby="grant-form-title">
        <h2 id="grant-form-title" className="text-lg font-semibold text-white">2. Configure complimentary access</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <label className="text-sm text-gray-400">Canonical plan<select required value={state.grantForm.planId} onChange={event => dispatch({ type: 'GRANT_FORM_CHANGED', field: 'planId', value: event.target.value })} className="input-field mt-1"><option value="">Select a plan</option>{activePlans.map(plan => <option key={plan.id} value={plan.id}>{plan.name} · {plan.entitlementTier}</option>)}</select></label>
          <label className="text-sm text-gray-400">Validity type<select value={state.grantForm.validityType} onChange={event => dispatch({ type: 'GRANT_FORM_CHANGED', field: 'validityType', value: event.target.value })} className="input-field mt-1"><option value="preset">Preset duration</option><option value="custom">Custom expiration</option><option value="lifetime">Lifetime</option></select></label>
          {state.grantForm.validityType === 'preset' && <label className="text-sm text-gray-400">Preset days<select value={state.grantForm.presetDays} onChange={event => dispatch({ type: 'GRANT_FORM_CHANGED', field: 'presetDays', value: event.target.value })} className="input-field mt-1">{PRESET_DAYS.map(days => <option key={days} value={days}>{days} days</option>)}</select></label>}
          {state.grantForm.validityType === 'custom' && <label className="text-sm text-gray-400">Custom expiration<input required type="datetime-local" value={state.grantForm.customExpiresAt} onChange={event => dispatch({ type: 'GRANT_FORM_CHANGED', field: 'customExpiresAt', value: event.target.value })} className="input-field mt-1" /></label>}
          {state.grantForm.validityType === 'lifetime' && <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 text-sm text-emerald-200">No expiration will be created. Access continues until revoke or supersession.</div>}
        </div>
        {selectedPlan && <div className="mt-4 rounded-xl border border-[#2a2a5a]/50 bg-[#09091d]/60 p-4"><p className="font-semibold text-white">{selectedPlan.name} · {selectedPlan.entitlementTier} tier</p><p className="mt-1 text-xs text-gray-400">{(selectedPlan.features || []).join(' · ') || 'No features listed'}</p></div>}
        <label className="mt-4 block text-sm text-gray-400">Administrator reason <span className="text-gray-600">(optional, plain text, {MAX_REASON_LENGTH} characters)</span><textarea maxLength={MAX_REASON_LENGTH} rows={3} value={state.grantForm.reason} onChange={event => dispatch({ type: 'GRANT_FORM_CHANGED', field: 'reason', value: event.target.value })} className="input-field mt-1 resize-y" placeholder="Why is this access being granted?" /></label>
        <div className="mt-1 text-right text-xs text-gray-600">{state.grantForm.reason.length}/{MAX_REASON_LENGTH}</div>
        <ErrorNotice message={state.createError} />
        <button type="submit" disabled={state.creating || !state.selectedUser?.grantEligible || !activePlans.length} className="btn-primary mt-5 w-auto disabled:opacity-50">Review grant</button>
      </form>

      <section className="glass-card overflow-hidden" aria-labelledby="history-title">
        <div className="border-b border-[#2a2a5a]/50 p-5 sm:p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="history-title" className="flex items-center gap-2 text-lg font-semibold text-white"><History size={19} /> Grant history</h2><p className="mt-1 text-xs text-gray-500">Server-authoritative status fixed at {state.page.asOf ? formatLocalTimestampWithZone(state.page.asOf) : 'the first page evaluation time'}.</p></div>{state.listLoading && <Loader2 className="animate-spin text-gray-400" size={19} />}</div>
          <form onSubmit={applyFilters} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_0.7fr_0.6fr_auto]">
            <label className="text-xs text-gray-500">Exact email<input type="email" value={state.filters.email} onChange={event => dispatch({ type: 'FILTER_CHANGED', field: 'email', value: event.target.value })} className="input-field mt-1" placeholder="person@example.com" /></label>
            <label className="text-xs text-gray-500">Plan<select value={state.filters.planId} onChange={event => dispatch({ type: 'FILTER_CHANGED', field: 'planId', value: event.target.value })} className="input-field mt-1"><option value="">All plans</option>{state.plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select></label>
            <label className="text-xs text-gray-500">Status<select value={state.filters.status} onChange={event => dispatch({ type: 'FILTER_CHANGED', field: 'status', value: event.target.value })} className="input-field mt-1"><option value="">All statuses</option>{GRANT_STATUSES.map(status => <option key={status} value={status}>{status}</option>)}</select></label>
            <div className="flex items-end gap-2"><button type="submit" disabled={state.listLoading} className="btn-primary w-auto disabled:opacity-50">Apply</button><button type="button" disabled={state.listLoading} onClick={resetFilters} className="btn-secondary w-auto disabled:opacity-50">Reset</button></div>
          </form>
        </div>
        <div className="p-4 sm:p-5"><ErrorNotice message={state.listError} onRetry={() => loadList({ filters: state.appliedFilters })} label="Retry history" />
          {!state.listLoading && !state.listError && state.grants.length === 0 && <div className="rounded-xl border border-dashed border-[#2a2a5a] p-8 text-center"><Gift className="mx-auto text-gray-600" /><p className="mt-3 font-semibold text-gray-300">No complimentary grants match these filters</p><p className="mt-1 text-sm text-gray-500">Change exact filters or create a new grant.</p></div>}
          <div className="space-y-4">{state.grants.map(grant => <GrantDetails key={grant.id} grant={grant} revoking={state.revokingGrantId === grant.id} onRevoke={value => dispatch({ type: 'OPEN_REVOKE_CONFIRMATION', grant: value })} />)}</div>
          {state.page.nextCursor && <button type="button" disabled={state.listLoading} onClick={() => loadList({ filters: state.appliedFilters, cursor: state.page.nextCursor, append: true })} className="btn-secondary mx-auto mt-5 flex w-auto items-center gap-2 disabled:opacity-50">Load next page <ChevronRight size={16} /></button>}
        </div>
      </section>

      {state.grantConfirmation && <Modal title="Confirm complimentary grant" labelledBy="grant-confirm-title" busy={state.creating} onClose={() => dispatch({ type: 'CLOSE_GRANT_CONFIRMATION' })}>
        <div className="space-y-4 text-sm"><div className="rounded-xl border border-[#2a2a5a]/50 p-4"><dl className="grid gap-3 sm:grid-cols-2"><div><dt className="text-gray-500">Target</dt><dd className="mt-1 text-white">{state.selectedUser?.email}</dd></div><div><dt className="text-gray-500">Plan and tier</dt><dd className="mt-1 text-white">{state.grantConfirmation.plan.name} · {state.grantConfirmation.plan.entitlementTier}</dd></div><div className="sm:col-span-2"><dt className="text-gray-500">Features</dt><dd className="mt-1 text-white">{(state.grantConfirmation.plan.features || []).join(', ')}</dd></div><div className="sm:col-span-2"><dt className="text-gray-500">Validity preview in your locale/time zone</dt><dd className="mt-1 text-white">{state.grantConfirmation.preview}</dd></div><div className="sm:col-span-2"><dt className="text-gray-500">Reason</dt><dd className="mt-1 whitespace-pre-wrap text-white">{state.grantConfirmation.payload.reason || 'No reason provided'}</dd></div></dl></div>
          <div className="grid gap-3 sm:grid-cols-2"><EntitlementCard title="Current effective state" entitlement={state.lookupEffectiveEntitlement} /><EntitlementCard title="Paid fallback" entitlement={state.lookupPaidFallback} /></div>
          {state.grantConfirmation.supersedes && <div className="flex gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-amber-100"><AlertTriangle className="shrink-0" size={18} /><span>The currently active complimentary grant will be atomically superseded by this grant.</span></div>}
          <p className="text-xs text-gray-500">The backend will revalidate the user, plan, paid state, and activation time before committing. No payment or invoice will be created.</p>
          <ErrorNotice message={state.createError} />
          <div className="flex justify-end gap-3"><button type="button" disabled={state.creating} onClick={() => dispatch({ type: 'CLOSE_GRANT_CONFIRMATION' })} className="btn-secondary w-auto">Cancel</button><button type="button" disabled={state.creating} onClick={confirmGrant} className="btn-primary flex w-auto items-center gap-2 disabled:opacity-50">{state.creating && <Loader2 className="animate-spin" size={16} />}{state.creating ? 'Granting…' : 'Confirm grant'}</button></div>
        </div>
      </Modal>}

      {state.revokeConfirmation && <Modal title="Confirm access revocation" labelledBy="revoke-confirm-title" busy={Boolean(state.revokingGrantId)} onClose={() => dispatch({ type: 'CLOSE_REVOKE_CONFIRMATION' })}>
        <div className="space-y-4 text-sm"><div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4"><p className="font-semibold text-white">{state.revokeConfirmation.targetEmail}</p><p className="mt-1 text-gray-300">{state.revokeConfirmation.planName} · {state.revokeConfirmation.entitlementTier} tier</p><p className="mt-1 text-gray-400">{formatGrantValidity(state.revokeConfirmation)}</p></div>
          <p className="text-gray-300">This ends complimentary access immediately but retains the grant and audit history. The server will restore a still-active paid fallback or return inactive access.</p>
          <label className="block text-sm text-gray-400">Revocation reason <span className="text-gray-600">(optional)</span><textarea maxLength={MAX_REASON_LENGTH} rows={3} value={state.revokeReason} onChange={event => dispatch({ type: 'REVOKE_REASON_CHANGED', value: event.target.value })} className="input-field mt-1 resize-y" /></label>
          <div className="text-right text-xs text-gray-600">{state.revokeReason.length}/{MAX_REASON_LENGTH}</div><ErrorNotice message={state.revokeError} />
          <div className="flex justify-end gap-3"><button type="button" disabled={Boolean(state.revokingGrantId)} onClick={() => dispatch({ type: 'CLOSE_REVOKE_CONFIRMATION' })} className="btn-secondary w-auto">Cancel</button><button type="button" disabled={Boolean(state.revokingGrantId)} onClick={confirmRevoke} className="btn-primary flex w-auto items-center gap-2 bg-red-500 disabled:opacity-50">{state.revokingGrantId && <Loader2 className="animate-spin" size={16} />}{state.revokingGrantId ? 'Revoking…' : 'Confirm revoke'}</button></div>
        </div>
      </Modal>}
    </div>
  )
}
