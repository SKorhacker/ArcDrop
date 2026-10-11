// Gateway node: serves the web app and settles payments carried in by any
// transport (QR, AirDrop link, Bluetooth mesh). It pays the gas, so a recipient
// with an empty wallet can still cash in.
//
//   RELAYER_PRIVATE_KEY=0x… PORT=8787 node relayer/server.mjs
//
// Without RELAYER_PRIVATE_KEY it only verifies and simulates.
//
// The gas wallet is the asset to protect: every relay/funding costs it a fraction
// of a cent, so it refuses self-payments, dust, malformed input and floods, and it
// simulates every call (free) before sending anything.

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { privateKeyToAccount } from 'viem/accounts'
import { createWalletClient, http as viemHttp, nonceManager, isAddress, getAddress, recoverTypedDataAddress } from 'viem'
import {
  decodePayment, verifyPayment, checkPayment, simulatePayment, settlePayment, formatUsdc, symbol,
  fundCall, publicClient, CHAINS, tabsAddress, domain, PAYMENT_TTL, tabFundingNonce,
} from '../core/arcdrop.js'

const PORT = Number(process.env.PORT ?? 8787)
const RPC_URL = process.env.ARC_RPC_URL
const MIN_VALUE = 10_000n // 0.01 USDC
// nonceManager + a serial queue: concurrent requests never collide on the relayer's nonce.
const relayer = process.env.RELAYER_PRIVATE_KEY ? privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY, { nonceManager }) : null
const WEB = fileURLToPath(new URL('../web/dist/', import.meta.url))
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.css': 'text/css' }
const MAX_BODY = 4_000

// Browsers may only call the gateway from the app itself (the iOS app's local page has origin "null").
// This does not stop scripts, hence the rate limits below.
const ALLOWED_ORIGINS = new Set(['https://arcdrop-pink.vercel.app', 'null', 'http://localhost:8787'])
export const corsHeaders = (origin) => (ALLOWED_ORIGINS.has(origin)
  ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type', vary: 'origin' }
  : { vary: 'origin' })

// ---------- rate limits (per process; on Vercel, per warm instance) ----------
// Bounded maps with oldest-first eviction: spraying keys can't wipe the other counters.
class Windows {
  constructor(max) { this.max = max; this.map = new Map() }
  allowed(key, limit, ms) {
    const now = Date.now()
    const hits = (this.map.get(key) ?? []).filter((t) => now - t < ms)
    this.map.delete(key) // re-insert = most recent
    if (hits.length >= limit) { this.map.set(key, hits); return false }
    hits.push(now)
    this.map.set(key, hits)
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value)
    return true
  }
}
const ipWindows = new Windows(5_000)
const walletWindows = new Windows(20_000)
let globalHits = []
const ipKey = (ip) => (ip && ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip) // IPv6: per /64

// Cheap gate, before any RPC call: costs us nothing to refuse.
function ipLimited(ip) {
  if (!ip) return null
  const k = ipKey(ip)
  return ipWindows.allowed(`m:${k}`, 30, 60_000) && ipWindows.allowed(`h:${k}`, 300, 3_600_000) ? null : 'too many requests from this address'
}
// Gas-spending gate, once we know who the request really is for.
function rateLimited({ ip, payer }) {
  if (ip && ipLimited(ip)) return 'too many requests from this address'
  if (payer && (!walletWindows.allowed(`m:${payer}`, 3, 60_000) || !walletWindows.allowed(`h:${payer}`, 20, 3_600_000))) return 'too many payments from this wallet, retry later'
  const now = Date.now()
  globalHits = globalHits.filter((t) => now - t < 3_600_000)
  if (globalHits.length >= 300) return 'gateway busy, retry later'
  globalHits.push(now)
  return null
}

// Anti-loop: money the gateway just delivered to a wallet is not re-sponsored from that wallet
// for an hour (A→B→A or W1→W2→… would otherwise recycle the same cents through our gas).
const recentlyFunded = new Map()
const RECYCLE_MS = 3_600_000
function justReceived(addr) {
  const t = recentlyFunded.get(addr)
  return t !== undefined && Date.now() - t < RECYCLE_MS
}
function markReceived(addr) {
  recentlyFunded.delete(addr)
  recentlyFunded.set(addr, Date.now())
  while (recentlyFunded.size > 50_000) recentlyFunded.delete(recentlyFunded.keys().next().value)
}

export const _rateLimitedForTests = rateLimited

let queue = Promise.resolve()
function serial(task) {
  const run = queue.then(task, task)
  queue = run.catch(() => {})
  return run
}

const fail = (code, error) => ({ code, body: { ok: false, error } })

export async function relay(text, { ip } = {}) {
  const gate = ipLimited(ip)
  if (gate) return fail(429, gate)
  if (typeof text !== 'string' || text.length > 2_000) return fail(400, 'invalid packet')
  let p
  try { p = decodePayment(text) } catch { return fail(400, 'invalid packet') }
  const check = await verifyPayment(p)
  if (!check.ok) return fail(400, check.reason)
  // Free money-go-round: paying yourself would let anyone burn our gas.
  if (relayer && p.from === p.to) return fail(400, 'payer and recipient are the same')
  if (!p.tab && p.validBefore > BigInt(Math.floor(Date.now() / 1000) + PAYMENT_TTL + 86_400)) return fail(400, 'expiry too far in the future')
  if (relayer && !p.tab && justReceived(p.from)) return fail(429, 'this wallet just received a sponsored payment; settle it yourself or retry in an hour')
  if (relayer && !p.tab && p.value < MIN_VALUE) return fail(400, `minimum ${formatUsdc(MIN_VALUE)} ${symbol(p.token)}`)

  let status
  try { status = await checkPayment(p, { rpcUrl: RPC_URL }) } catch { return fail(503, 'Arc RPC unavailable') }
  if (status.settled) return { code: 200, body: { ok: true, alreadySettled: true } }
  if (p.tab) {
    // Tabs pay the difference with what was already paid: refuse dust redemptions too.
    const t = status.tab
    const owed = (BigInt(p.cumulative) < t.locked ? BigInt(p.cumulative) : t.locked) - t.paid
    if (!status.funded) return fail(402, 'tab expired, closed or empty')
    if (relayer && owed < MIN_VALUE) return fail(400, `minimum ${formatUsdc(MIN_VALUE)} ${symbol(p.token)}`)
  } else if (!status.funded) return fail(402, `payer has ${formatUsdc(status.payerBalance)} ${symbol(p.token)}, needs ${formatUsdc(p.value)}`)

  if (!relayer) {
    try { await simulatePayment(p, { rpcUrl: RPC_URL }) } catch { return fail(422, 'payment would fail on Arc') }
    return { code: 200, body: { ok: true, simulated: true, note: 'no RELAYER_PRIVATE_KEY set; payment is valid but was not submitted' } }
  }

  // The same packet often arrives through several mesh paths at once.
  const key = `${p.chainId}:${p.token}:${p.tab ? 't' : 'a'}:${p.from}:${p.nonce}`
  if (!inflight.has(key)) {
    // Tab vouchers are throttled per recipient: a payer must not be able to block their own
    // recipient's redemptions by exhausting a quota tied to the payer's address.
    const limited = rateLimited({ ip, payer: p.tab ? `to:${p.to}` : p.from })
    if (limited) return fail(429, limited)
    const started = Date.now()
    const job = serial(async () => {
      await simulatePayment(p, { rpcUrl: RPC_URL, relayer: relayer.address }) // reverts cost nothing here
      return settlePayment(p, { relayerAccount: relayer, rpcUrl: RPC_URL })
    }).then((r) => { if (!p.tab) markReceived(p.to); return { ...r, settleMs: Date.now() - started } })
    inflight.set(key, job)
    // Keep successes briefly for duplicates; forget failures at once so honest retries work.
    job.then(() => setTimeout(() => inflight.delete(key), 60_000).unref(), () => inflight.delete(key))
  }
  let result
  try { result = await inflight.get(key) } catch {
    const again = await checkPayment(p, { rpcUrl: RPC_URL }).catch(() => null)
    return again?.settled ? { code: 200, body: { ok: true, alreadySettled: true } } : fail(422, 'payment would fail on Arc')
  }
  console.log(`settled ${formatUsdc(p.value)} ${symbol(p.token)} ${p.from} -> ${p.to} in ${result.settleMs}ms ${result.url}`)
  return { code: 200, body: { ok: result.status === 'success', hash: result.hash, url: result.url, settleMs: result.settleMs } }
}

const inflight = new Map()
const DIGITS = /^\d{1,30}$/
const HEX32 = /^0x[0-9a-fA-F]{64}$/
const SIG = /^0x[0-9a-fA-F]{130}$/

// Opens or tops up a tab from the payer's EIP-3009 signature; the gateway pays the gas.
export async function fund(f, { ip } = {}) {
  const gate = ipLimited(ip)
  if (gate) return fail(429, gate)
  if (!f || typeof f !== 'object' || Array.isArray(f)) return fail(400, 'invalid tab')
  if (!['from', 'recipient', 'salt', 'signature'].every((k) => typeof f[k] === 'string')) return fail(400, 'invalid tab')
  const chainId = Number(f.chainId), token = Number(f.token ?? 0)
  if (!Number.isSafeInteger(chainId) || !tabsAddress(chainId) || ![0, 1].includes(token)) return fail(400, 'no tabs for this chain or token')
  if (![f.value, f.validAfter, f.validBefore, f.expiry].every((x) => DIGITS.test(String(x))) || !isAddress(String(f.from)) || !isAddress(String(f.recipient))
    || !HEX32.test(String(f.salt)) || !SIG.test(String(f.signature))) return fail(400, 'invalid tab')
  const tab = { chainId, token, from: getAddress(f.from), recipient: getAddress(f.recipient), expiry: String(f.expiry), salt: f.salt,
    value: String(f.value), validAfter: String(f.validAfter), validBefore: String(f.validBefore), signature: f.signature }
  if (tab.from === tab.recipient) return fail(400, 'cannot open a tab to yourself')
  if (relayer && justReceived(tab.from)) return fail(429, 'this wallet just received a sponsored payment; retry in an hour')

  let call
  try { call = fundCall(tab) } catch { return fail(400, 'invalid tab') }
  const client = publicClient(chainId, RPC_URL)
  if (!relayer) {
    try { await client.simulateContract({ ...call, account: tab.from }) } catch { return fail(422, 'tab would fail on Arc') }
    return { code: 200, body: { ok: true, simulated: true } }
  }
  // Only a request really signed by `from` may spend `from`'s quota (else anyone could
  // exhaust it and block that payer).
  try {
    const nonce = tabFundingNonce(tab)
    const signer = await recoverTypedDataAddress({
      domain: domain(chainId, token), primaryType: 'ReceiveWithAuthorization',
      types: { ReceiveWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
      message: { from: tab.from, to: tabsAddress(chainId), value: BigInt(tab.value), validAfter: BigInt(tab.validAfter), validBefore: BigInt(tab.validBefore), nonce },
      signature: tab.signature,
    })
    if (signer !== tab.from) return fail(400, 'bad signature')
  } catch { return fail(400, 'bad signature') }

  const key = `f:${tab.from}:${tab.salt}`
  if (!inflight.has(key)) {
    const limited = rateLimited({ ip, payer: tab.from })
    if (limited) return fail(429, limited)
    const wallet = createWalletClient({ account: relayer, chain: CHAINS[chainId], transport: viemHttp(RPC_URL) })
    const job = serial(async () => {
      await client.simulateContract({ ...call, account: relayer }) // bad signature, no funds, bad duration: fails here, for free
      const hash = await wallet.writeContract(call)
      const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 150, timeout: 25_000 })
      return { hash, status: receipt.status }
    })
    inflight.set(key, job)
    job.then(() => setTimeout(() => inflight.delete(key), 60_000).unref(), () => inflight.delete(key))
  }
  try {
    const r = await inflight.get(key)
    return { code: 200, body: { ok: r.status === 'success', hash: r.hash, url: `${CHAINS[chainId].blockExplorers.default.url}/tx/${r.hash}` } }
  } catch { return fail(422, 'tab would fail on Arc') }
}

// ---------- local HTTP server ----------
const json = (res, code, body, origin) => {
  res.writeHead(code, { 'content-type': 'application/json', ...corsHeaders(origin) })
  res.end(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))
}

async function body(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw Object.assign(new Error('payload too large'), { status: 413 })
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }) }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin
  const ip = req.socket.remoteAddress
  try {
    if (req.method === 'OPTIONS') return json(res, 204, {}, origin)
    if (req.method === 'POST' && req.url === '/api/relay') {
      const { code, body: out } = await relay((await body(req))?.packet, { ip })
      return json(res, code, out, origin)
    }
    if (req.method === 'POST' && req.url === '/api/fund') {
      const { code, body: out } = await fund((await body(req))?.tab, { ip })
      return json(res, code, out, origin)
    }
    if (req.method === 'GET' && req.url === '/api/info') return json(res, 200, { relayer: relayer?.address ?? null }, origin)
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' }, origin)

    let path
    try { path = normalize(decodeURIComponent(req.url.split(/[?#]/)[0])).replace(/^(\.\.[/\\])+/, '') } catch { return json(res, 400, { error: 'bad url' }, origin) }
    const file = join(WEB, path.endsWith('/') ? 'index.html' : path)
    if (!file.startsWith(WEB)) return json(res, 403, { error: 'forbidden' }, origin)
    const data = await readFile(file).catch(() => readFile(join(WEB, 'index.html')))
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'text/html' })
    res.end(data)
  } catch (e) {
    if (e.status) return json(res, e.status, { ok: false, error: e.message }, origin)
    console.error(e)
    json(res, 500, { ok: false, error: 'internal error' }, origin)
  }
})

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`ArcDrop gateway on http://localhost:${PORT} (relayer: ${relayer?.address ?? 'simulate only'})`))
}
