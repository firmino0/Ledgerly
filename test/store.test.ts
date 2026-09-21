import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { LedgerEntry, readAll, record } from '../src/ledger.js'
import { dataPath, memoryBackend, readJson, setBackendForTests, withinRateLimit, withStore, writeJson } from '../src/store.js'

const backend = memoryBackend()
before(() => setBackendForTests(backend))
after(() => setBackendForTests(null))

const entry = (action: string): Omit<LedgerEntry, 'ts'> => ({ module: 'dca', action, verdict: 'allow', executed: true, dryRun: true, reasoning: 'x' })

test('changes made inside a request are saved and visible to the next request', async () => {
  await withStore(async () => writeJson(dataPath('dca.json'), [{ id: 'a' }]), { lock: true })
  const seen = await withStore(async () => readJson<unknown[]>(dataPath('dca.json'), []))
  assert.deepEqual(seen, [{ id: 'a' }])
})

test('state used outside a request is refused rather than silently lost', () => {
  assert.throws(() => readJson(dataPath('state.json'), {}), /outside a request/)
})

test('the ledger appends across requests and keeps order', async () => {
  await withStore(async () => void record(entry('one')), { lock: true })
  await withStore(async () => void record(entry('two')), { lock: true })
  const all = await withStore(async () => readAll())
  assert.deepEqual(all.map(e => e.action), ['one', 'two'])
})

test('concurrent requests never overwrite each other (lock)', async () => {
  const work = (n: number) => withStore(async () => {
    const cur = readJson<number[]>(dataPath('paper.json'), [])
    await new Promise(r => setTimeout(r, 15))
    writeJson(dataPath('paper.json'), [...cur, n])
  }, { lock: true })
  await Promise.all([1, 2, 3, 4].map(work))
  const final = await withStore(async () => readJson<number[]>(dataPath('paper.json'), []))
  assert.deepEqual([...final].sort(), [1, 2, 3, 4])
})

test('two requests at once each see only their own copy until saved', async () => {
  await withStore(async () => writeJson(dataPath('portfolio.json'), { v: 'base' }), { lock: true })
  const a = withStore(async () => {
    writeJson(dataPath('portfolio.json'), { v: 'a' })
    await new Promise(r => setTimeout(r, 20))
    return readJson<{ v: string }>(dataPath('portfolio.json'), { v: '' }).v
  }, { lock: true })
  const b = withStore(async () => readJson<{ v: string }>(dataPath('portfolio.json'), { v: '' }).v)
  assert.equal(await a, 'a')
  assert.equal(await b, 'base')
})

test('an error inside a request still saves the changes made before it', async () => {
  await assert.rejects(withStore(async () => {
    writeJson(dataPath('prepared.json'), { kept: true })
    throw new Error('boom')
  }, { lock: true }), /boom/)
  const seen = await withStore(async () => readJson(dataPath('prepared.json'), {}))
  assert.deepEqual(seen, { kept: true })
})

test('rate limit allows the limit and then refuses', async () => {
  const results: boolean[] = []
  for (let i = 0; i < 5; i++) results.push(await withinRateLimit('ip-1', 3, 60))
  assert.deepEqual(results, [true, true, true, false, false])
  assert.equal(await withinRateLimit('ip-2', 3, 60), true)
})
