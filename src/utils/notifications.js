/**
 * Browser Push Notifications
 */

export const requestNotificationPermission = async () => {
  if (!('Notification' in window)) {
    console.log('Browser does not support notifications')
    return false
  }
  const permission = await Notification.requestPermission()
  return permission === 'granted'
}

export const sendNotification = (title, options = {}) => {
  if (Notification.permission === 'granted') {
    const notification = new Notification(title, {
      icon: '/vite.svg',
      badge: '/vite.svg',
      vibrate: [200, 100, 200],
      ...options
    })
    notification.onclick = () => {
      window.focus()
      notification.close()
    }
    return notification
  }
}

export const notifyTradeSignal = (type, pair, price) => {
  sendNotification(`${type} Signal: ${pair}`, {
    body: `Price: $${price}\nClick to view`,
    tag: 'trade-signal'
  })
}

export const notifyTradeExecuted = (side, pair, pnl) => {
  sendNotification(`Trade ${side.toUpperCase()}: ${pair}`, {
    body: `P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`,
    tag: 'trade-executed'
  })
}

export const notifyAlert = (message) => {
  sendNotification('📢 Alert', {
    body: message,
    tag: 'alert'
  })
}
