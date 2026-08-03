export function useTrades() {
  if (!window.__tradeBoundary?.addTrade) throw new Error('Preservation trade boundary is not configured')
  return { addTrade: window.__tradeBoundary.addTrade }
}
