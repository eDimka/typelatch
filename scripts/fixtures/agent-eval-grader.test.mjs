import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = process.env.AGENT_EVAL_WORKSPACE
if (!root) throw new Error('AGENT_EVAL_WORKSPACE is required')
const { TTLCache } = await import(pathToFileURL(join(root, 'src/cache.ts')).href)
const { retry, RetryDeadlineError } = await import(pathToFileURL(join(root, 'src/retry.ts')).href)

function clock(initial = 0) {
  let time = initial
  const waits = []
  return { now: () => time, set: value => { time = value }, waits, sleep: async value => { waits.push(value); time += value } }
}

test('cache: expiration includes the exact boundary', () => {
  const time = clock()
  const cache = new TTLCache({ capacity: 2, now: time.now })
  cache.set('invoice', 'ready', 10)
  time.set(9)
  assert.equal(cache.get('invoice'), 'ready')
  time.set(10)
  assert.equal(cache.get('invoice'), undefined)
})

test('cache: size counts only live entries', () => {
  const time = clock()
  const cache = new TTLCache({ capacity: 3, now: time.now })
  cache.set('old', 1, 5)
  cache.set('live', 2, 50)
  time.set(5)
  assert.equal(cache.size, 1)
})

test('cache: expired entries cannot force a live eviction', () => {
  const time = clock()
  const cache = new TTLCache({ capacity: 2, now: time.now })
  cache.set('live', 1, 100)
  cache.set('expired', 2, 5)
  time.set(6)
  cache.set('new', 3, 100)
  assert.equal(cache.get('live'), 1)
  assert.equal(cache.get('new'), 3)
  assert.equal(cache.size, 2)
})

test('cache: successful reads refresh least recent usage', () => {
  const cache = new TTLCache({ capacity: 2, now: () => 0 })
  cache.set('a', 1, 100)
  cache.set('b', 2, 100)
  assert.equal(cache.get('a'), 1)
  cache.set('c', 3, 100)
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a'), 1)
  assert.equal(cache.get('c'), 3)
})

test('cache: replacing a key preserves capacity and refreshes expiration and recency', () => {
  const time = clock()
  const cache = new TTLCache({ capacity: 2, now: time.now })
  cache.set('a', 1, 100)
  cache.set('b', 2, 5)
  time.set(4)
  cache.set('b', 20, 20)
  assert.equal(cache.size, 2)
  time.set(6)
  assert.equal(cache.get('b'), 20)
  cache.set('c', 3, 100)
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.get('b'), 20)
  time.set(24)
  assert.equal(cache.get('b'), undefined)
})

test('cache: zero TTL and invalid input retain their defined behavior', () => {
  const cache = new TTLCache({ capacity: 2, now: () => 0 })
  cache.set('a', 1, 100)
  cache.set('a', 2, 0)
  assert.equal(cache.get('a'), undefined)
  for (const ttl of [-1, Infinity, NaN]) assert.throws(() => cache.set('b', 2, ttl), RangeError)
  for (const capacity of [0, -1, 1.5, NaN]) assert.throws(() => new TTLCache({ capacity }), RangeError)
})

test('retry: maxAttempts includes the first call and preserves the final error', async () => {
  const time = clock()
  const attempts = []
  const failures = []
  await assert.rejects(retry(async attempt => {
    attempts.push(attempt)
    const failure = new Error(`failure ${attempt}`)
    failures.push(failure)
    throw failure
  }, { maxAttempts: 3, delayMs: 4, now: time.now, sleep: time.sleep }), failure => failure === failures.at(-1))
  assert.deepEqual(attempts, [1, 2, 3])
  assert.deepEqual(time.waits, [4, 4])
})

test('retry: a single permitted failed attempt never waits', async () => {
  const time = clock()
  let attempts = 0
  const failure = new Error('upstream failed')
  await assert.rejects(retry(async () => { attempts++; throw failure }, { maxAttempts: 1, delayMs: 10, now: time.now, sleep: time.sleep }), error => error === failure)
  assert.deepEqual(time.waits, [])
  assert.equal(attempts, 1)
})

test('retry: a reached initial deadline rejects before calling the operation', async () => {
  const time = clock(10)
  let attempts = 0
  await assert.rejects(retry(async () => { attempts++; return 'too late' }, { maxAttempts: 3, delayMs: 1, deadlineMs: 10, now: time.now, sleep: time.sleep }), RetryDeadlineError)
  assert.equal(attempts, 0)
  assert.deepEqual(time.waits, [])
})

test('retry: waiting is clipped and the reached deadline prevents another attempt', async () => {
  const time = clock()
  let attempts = 0
  const failure = new Error('first attempt failed')
  await assert.rejects(retry(async () => { attempts++; time.set(time.now() + 2); throw failure }, { maxAttempts: 4, delayMs: 30, deadlineMs: 10, now: time.now, sleep: time.sleep }), error => error === failure)
  assert.deepEqual(time.waits, [8])
  assert.equal(attempts, 1)
  assert.equal(time.now(), 10)
})

test('retry: an operation that consumes the deadline does not trigger a wait', async () => {
  const time = clock()
  const failure = new Error('attempt consumed available time')
  await assert.rejects(retry(async () => { time.set(10); throw failure }, { maxAttempts: 3, delayMs: 5, deadlineMs: 10, now: time.now, sleep: time.sleep }), error => error === failure)
  assert.deepEqual(time.waits, [])
})

test('retry: ordinary retries can still succeed before the deadline', async () => {
  const time = clock()
  const attempts = []
  const result = await retry(async attempt => {
    attempts.push(attempt)
    if (attempt === 1) throw new Error('temporary')
    return { value: 'ready' }
  }, { maxAttempts: 3, delayMs: 4, deadlineMs: 20, now: time.now, sleep: time.sleep })
  assert.deepEqual(result, { value: 'ready' })
  assert.deepEqual(attempts, [1, 2])
  assert.deepEqual(time.waits, [4])
})

test('retry: a timely successful attempt can finish after the deadline', async () => {
  const time = clock()
  const result = await retry(async () => { time.set(20); return 'accepted' }, { maxAttempts: 2, delayMs: 1, deadlineMs: 10, now: time.now, sleep: time.sleep })
  assert.equal(result, 'accepted')
  assert.deepEqual(time.waits, [])
})

test('retry: existing input validation and arbitrary failure identity are preserved', async () => {
  for (const maxAttempts of [0, 1.5, NaN]) await assert.rejects(retry(async () => 1, { maxAttempts, delayMs: 0 }), RangeError)
  for (const delayMs of [-1, Infinity, NaN]) await assert.rejects(retry(async () => 1, { maxAttempts: 1, delayMs }), RangeError)
  await assert.rejects(retry(async () => 1, { maxAttempts: 1, delayMs: 0, deadlineMs: NaN }), RangeError)
  let caught = Symbol('not caught')
  try { await retry(async () => { throw 0 }, { maxAttempts: 1, delayMs: 0, now: () => 0, sleep: async () => {} }) }
  catch (error) { caught = error }
  assert.equal(caught, 0)
})
