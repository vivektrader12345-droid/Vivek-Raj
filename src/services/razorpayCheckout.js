const CHECKOUT_URL = 'https://checkout.razorpay.com/v1/checkout.js'
let checkoutPromise

export function loadRazorpayCheckout(documentObject = globalThis.document) {
  if (globalThis.Razorpay) return Promise.resolve(globalThis.Razorpay)
  if (!documentObject) return Promise.reject(new Error('Razorpay Checkout requires a browser.'))
  if (checkoutPromise) return checkoutPromise

  checkoutPromise = new Promise((resolve, reject) => {
    const existing = documentObject.querySelector(`script[src="${CHECKOUT_URL}"]`)
    const script = existing || documentObject.createElement('script')
    const complete = () => {
      if (globalThis.Razorpay) resolve(globalThis.Razorpay)
      else reject(new Error('Razorpay Checkout did not initialize.'))
    }
    script.addEventListener('load', complete, { once: true })
    script.addEventListener('error', () => reject(new Error('Unable to load Razorpay Checkout.')), { once: true })
    if (!existing) {
      script.src = CHECKOUT_URL
      script.async = true
      script.referrerPolicy = 'strict-origin-when-cross-origin'
      documentObject.head.appendChild(script)
    }
  }).catch(error => {
    checkoutPromise = null
    throw error
  })

  return checkoutPromise
}
