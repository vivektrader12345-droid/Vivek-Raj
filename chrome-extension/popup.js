(() => {
  const statusElement = document.getElementById('status')
  const detailsElement = document.getElementById('details')
  const pairingCodeElement = document.getElementById('pairingCode')
  const confirmCloseElement = document.getElementById('confirmClose')
  const controls = Array.from(document.querySelectorAll('button'))
  let closePending = false
  let busy = false

  function setBusy(nextBusy) {
    busy = nextBusy
    controls.forEach(control => { control.disabled = busy })
    confirmCloseElement.disabled = busy || !closePending
  }

  function showStatus(message, type = '') {
    statusElement.textContent = message
    statusElement.className = `status ${type}`.trim()
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, response => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
        else resolve(response)
      })
    })
  }

  async function activeTradingViewTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id || !/^https:\/\/([^.]+\.)?tradingview\.com\//i.test(tab.url || '')) {
      throw new Error('Open a TradingView chart in the active tab first.')
    }
    return tab
  }

  function sendTabMessage(tabId, message) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, response => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
        else resolve(response)
      })
    })
  }

  async function readCaptureStatus(tab = null) {
    const currentTab = tab || await activeTradingViewTab()
    const response = await sendTabMessage(currentTab.id, { type: 'GET_CAPTURE_STATUS' })
    if (!response?.ok) throw new Error('TradingView capture script is not ready.')
    closePending = Boolean(response.captureStatus?.closePending)
    confirmCloseElement.disabled = busy || !closePending
    return response.captureStatus || {}
  }

  async function refreshStatus() {
    const result = await sendRuntimeMessage({ type: 'GET_STATUS' })
    let captureStatus = null
    try { captureStatus = await readCaptureStatus() } catch { closePending = false }
    confirmCloseElement.disabled = busy || !closePending
    showStatus(result.connected ? `Connected · ${result.syncStatus}` : 'Not connected', result.syncStatus === 'error' ? 'error' : result.connected ? 'success' : '')
    detailsElement.textContent = JSON.stringify({
      lastSyncTime: result.lastSyncTime || null,
      queued: result.retryCount || 0,
      closePending,
      chart: captureStatus?.chartSymbol || null,
      lastError: captureStatus?.lastError || result.errorLog?.at(-1)?.message || null,
    }, null, 2)
  }

  document.getElementById('connect').addEventListener('click', async () => {
    setBusy(true)
    try {
      const tab = await activeTradingViewTab()
      await readCaptureStatus(tab)
      const pairingCode = pairingCodeElement.value.trim()
      if (!pairingCode) throw new Error('Enter the one-time pairing code from Journal Settings.')

      const result = await sendRuntimeMessage({ type: 'CONNECT_AUTH', pairingCode })
      if (!result?.ok) throw new Error(result?.error || 'Unable to connect Firebase session')

      try {
        await sendTabMessage(tab.id, { type: 'CONNECT' })
      } catch (error) {
        showStatus(`Firebase session connected, but TradingView attachment failed: ${error.message}`, 'error')
        return
      }
      showStatus('Connected with refreshable Firebase session', 'success')
      await refreshStatus()
    } catch (error) {
      showStatus(error.message, 'error')
    } finally {
      pairingCodeElement.value = ''
      setBusy(false)
    }
  })

  document.getElementById('disconnect').addEventListener('click', async () => {
    setBusy(true)
    try {
      await sendRuntimeMessage({ type: 'DISCONNECT_AUTH' })
      try {
        const tab = await activeTradingViewTab()
        await sendTabMessage(tab.id, { type: 'DISCONNECT' })
      } catch { /* disconnect remains valid outside TradingView */ }
      closePending = false
      showStatus('Disconnected')
      await refreshStatus()
    } finally {
      setBusy(false)
    }
  })

  document.getElementById('sync').addEventListener('click', async () => {
    setBusy(true)
    try {
      const tab = await activeTradingViewTab()
      const result = await sendTabMessage(tab.id, { type: 'SYNC_NOW' })
      if (!result?.ok) throw new Error(result?.error || 'Sync failed')
      showStatus('Trade synchronized', 'success')
      detailsElement.textContent = JSON.stringify(result, null, 2)
    } catch (error) {
      showStatus(error.message, 'error')
    } finally {
      setBusy(false)
    }
  })

  document.getElementById('retry').addEventListener('click', async () => {
    setBusy(true)
    try {
      const result = await sendRuntimeMessage({ type: 'RETRY_SYNC', force: true })
      if (!result?.done) throw new Error(result?.error || 'Retry failed')
      showStatus('Queued writes processed', 'success')
      await refreshStatus()
    } catch (error) {
      showStatus(error.message, 'error')
    } finally {
      setBusy(false)
    }
  })

  confirmCloseElement.addEventListener('click', async () => {
    setBusy(true)
    try {
      const tab = await activeTradingViewTab()
      const result = await sendTabMessage(tab.id, { type: 'CONFIRM_CLOSE' })
      if (!result?.ok) throw new Error(result?.error || 'Close confirmation failed')
      closePending = false
      showStatus('Close confirmation queued; exit and P&L remain unknown', 'success')
      await new Promise(resolve => setTimeout(resolve, 250))
      await refreshStatus()
    } catch (error) {
      showStatus(error.message, 'error')
    } finally {
      setBusy(false)
    }
  })

  refreshStatus().catch(error => showStatus(error.message, 'error'))
})()
