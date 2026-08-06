import test from 'node:test'
import assert from 'node:assert/strict'

import {
  chunkForFirestore,
  FIRESTORE_BATCH_LIMIT,
  processFirestoreBatches,
} from '../src/utils/firestoreBatching.js'

test('large delete sets are split below the Firestore 500-write limit', () => {
  const documents = Array.from({ length: 1201 }, (_, index) => index)
  const chunks = chunkForFirestore(documents)

  assert.equal(FIRESTORE_BATCH_LIMIT, 490)
  assert.deepEqual(chunks.map(chunk => chunk.length), [490, 490, 221])
  assert.deepEqual(chunks.flat(), documents)
  assert.ok(chunks.every(chunk => chunk.length <= 500))
})

test('empty input produces no commits and invalid limits fail closed', () => {
  assert.deepEqual(chunkForFirestore([]), [])
  assert.throws(() => chunkForFirestore([1], 501), /between 1 and 500/)
  assert.throws(() => chunkForFirestore(null), /must be an array/)
})

test('partial batch failures preserve exact committed progress for callers', async () => {
  const processedChunks = []

  await assert.rejects(
    processFirestoreBatches([1, 2, 3, 4, 5], async (chunk) => {
      processedChunks.push(chunk)
      if (processedChunks.length === 2) throw new Error('commit failed')
    }, 2),
    (error) => {
      assert.equal(error.name, 'FirestoreBatchProcessingError')
      assert.equal(error.completedCount, 2)
      assert.equal(error.totalCount, 5)
      assert.deepEqual(error.completedItems, [1, 2])
      assert.equal(error.cause.message, 'commit failed')
      return true
    },
  )

  assert.deepEqual(processedChunks, [[1, 2], [3, 4]])
})