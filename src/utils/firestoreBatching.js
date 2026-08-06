export const FIRESTORE_BATCH_LIMIT = 490

export function chunkForFirestore(items, batchLimit = FIRESTORE_BATCH_LIMIT) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array')
  if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > 500) {
    throw new RangeError('batchLimit must be an integer between 1 and 500')
  }

  const chunks = []
  for (let start = 0; start < items.length; start += batchLimit) {
    chunks.push(items.slice(start, start + batchLimit))
  }
  return chunks
}

export async function processFirestoreBatches(items, processBatch, batchLimit = FIRESTORE_BATCH_LIMIT) {
  if (typeof processBatch !== 'function') throw new TypeError('processBatch must be a function')

  const chunks = chunkForFirestore(items, batchLimit)
  const completedItems = []

  for (const chunk of chunks) {
    try {
      await processBatch(chunk)
      completedItems.push(...chunk)
    } catch (cause) {
      const error = new Error(`Firestore batch processing stopped after ${completedItems.length} of ${items.length} items`)
      error.name = 'FirestoreBatchProcessingError'
      error.completedCount = completedItems.length
      error.totalCount = items.length
      error.completedItems = completedItems
      error.cause = cause
      throw error
    }
  }

  return completedItems.length
}
