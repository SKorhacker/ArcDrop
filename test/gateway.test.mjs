// Gateway hardening: runs with a throwaway, unfunded relayer key, so nothing can be sent.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
process.env.RELAYER_PRIVATE_KEY = generatePrivateKey()
const { relay, fund, corsHeaders, _rateLimitedForTests: limit } = await import('../relayer/server.mjs')
const { createPayment, encodePayment } = await import('../core/arcdrop.js')

const a = privateKeyToAccount(generatePrivateKey()), b = privateKeyToAccount(generatePrivateKey())

// self-payments and dust never reach the chain (they would burn the gateway's gas for free)
const self = encodePayment(await createPayment({ account: a, to: a.address, amount: '1', chainId: 5042002 }))
assert.equal((await relay(self)).body.error, 'payer and recipient are the same')
const dust = encodePayment(await createPayment({ account: a, to: b.address, amount: '0.009', chainId: 5042002 }))
assert.match((await relay(dust)).body.error, /minimum/)
console.log('✓ self-payments and dust refused')

// malformed input: clean 400s, no internals leaked
for (const bad of [undefined, null, 42, {}, 'x'.repeat(5000), 'arcdrop:1:' + 'A'.repeat(300)]) {
  const r = await relay(bad)
  assert.equal(r.code, 400); assert.equal(r.body.error, 'invalid packet')
}
for (const bad of [null, 'x', {}, { chainId: '__proto__' }, { chainId: 5042002, value: '1e9' },
  { chainId: 5042002, token: 'toString', value: '1' }, { chainId: 5042002, from: 'nope', value: '20000', validAfter: '0', validBefore: '1', nonce: '0x00', signature: '0x00' }]) {
  const r = await fund(bad)
  assert.equal(r.code, 400); assert.doesNotMatch(r.body.error, /Cannot|undefined|BigInt|TypeError/)
}
console.log('✓ malformed relay / tab-funding input refused with neutral errors')

// rate limits: per wallet and per IP
const w = privateKeyToAccount(generatePrivateKey()).address
const verdicts = Array.from({ length: 5 }, () => limit({ payer: w }))
assert.deepEqual(verdicts.slice(0, 3), [null, null, null]); assert.match(verdicts[3], /too many/)
const ipVerdicts = Array.from({ length: 35 }, () => limit({ ip: '203.0.113.7' }))
assert.equal(ipVerdicts.filter((v) => v === null).length, 30)
console.log('✓ per-wallet and per-IP rate limits')

// spraying many keys must not reset the limits of a targeted wallet
const victim = privateKeyToAccount(generatePrivateKey()).address
for (let i = 0; i < 3; i++) limit({ payer: victim })
for (let i = 0; i < 25_000; i++) limit({ payer: `spray-${i}` })
assert.match(limit({ payer: victim }) ?? '', /too many|busy/)
console.log('✓ key spraying does not wipe other wallets\' limits')

// a forged tab funding request must not consume the named payer's quota (griefing)
{
  const { createTabFunding } = await import('../core/arcdrop.js')
  const payer = privateKeyToAccount(generatePrivateKey()), friend = privateKeyToAccount(generatePrivateKey())
  const real = await createTabFunding({ account: payer, to: friend.address, amount: '1', chainId: 5042002 })
  const forger = privateKeyToAccount(generatePrivateKey())
  const forged = await createTabFunding({ account: forger, to: friend.address, amount: '1', chainId: 5042002 })
  for (let i = 0; i < 30; i++) {
    const r = await fund({ ...forged, from: payer.address }, { ip: `198.51.100.${i}` })
    assert.equal(r.body.error, 'bad signature')
  }
  // the real payer still has their whole quota (the request then fails later only for lack of funds)
  const r = await fund(JSON.parse(JSON.stringify(real, (_, v) => (typeof v === 'bigint' ? v.toString() : v))), { ip: '198.51.100.250' })
  assert.doesNotMatch(String(r.body.error), /this wallet/, 'payer quota untouched by forgeries')
  console.log('✓ forged tab fundings cannot exhaust a payer\'s quota')
}

// CORS: only the app's own origins
assert.equal(corsHeaders('https://arcdrop-pink.vercel.app')['access-control-allow-origin'], 'https://arcdrop-pink.vercel.app')
assert.equal(corsHeaders('null')['access-control-allow-origin'], 'null')
assert.equal(corsHeaders('https://evil.example')['access-control-allow-origin'], undefined)
console.log('✓ CORS restricted to the app')

// HTTP server: path traversal, bad URLs, oversized bodies
const port = 8799
const srv = spawn(process.execPath, ['relayer/server.mjs'], { env: { ...process.env, PORT: String(port), RELAYER_PRIVATE_KEY: '' }, stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 1200))
try {
  const get = (path) => fetch(`http://localhost:${port}${path}`).then(async (r) => ({ status: r.status, text: await r.text() }))
  for (const path of ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/..%5c..%5cetc/passwd', '/%00']) {
    const r = await get(path)
    assert.ok(!/root:.*:0:0:/.test(r.text) && r.text.includes('ArcDrop'), `traversal via ${path}`)
  }
  assert.equal((await get('/%')).status, 400)
  const big = await fetch(`http://localhost:${port}/api/relay`, { method: 'POST', body: JSON.stringify({ packet: 'a'.repeat(10_000) }) })
  assert.equal(big.status, 413)
  console.log('✓ static server: no traversal, bad URLs and oversized bodies refused')
} finally { srv.kill() }
console.log('all gateway tests passed')
