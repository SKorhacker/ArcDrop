// Gateway node: serves the web app and settles payments carried in by any
// transport (QR, AirDrop link, Bluetooth mesh). It pays the gas, so a recipient
// with an empty wallet can still cash in.
//
//   RELAYER_PRIVATE_KEY=0x… PORT=8787 node relayer/server.mjs
//
// Without RELAYER_PRIVATE_KEY it only verifies and simulates.
//
// The gas wallet is the asset to protect: every relay/deposit costs it a fraction
// of a cent, so it refuses self-payments, dust, malformed input and floods, and it
// simulates every call (free) before sending anything.

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { privateKeyToAccount } from 'viem/accounts'
import { createWalletClient, http as viemHttp, nonceManager, isAddress, getAddress } from 'viem'
import {
  decodePayment, verifyPayment, checkPayment, simulatePayment, settlePayment, formatUsdc, symbol,
  depositCall, publicClient, CHAINS, vaultAddress,
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
const windows = new Map()
function allowed(key, limit, ms) {
  const now = Date.now()
  const hits = (windows.get(key) ?? []).filter((t) => now - t < ms)
  if (hits.length >= limit) { windows.set(key, hits); return false }
  hits.push(now)
  windows.set(key, hits)
  if (windows.size > 10_000) windows.clear() // memory bound under spray attacks
  return true
}
function rateLimited({ ip, payer }) {
  if (ip && (!allowed(`ip:${ip}`, 20, 60_000) || !allowed(`ip-h:${ip}`, 200, 3_600_000))) return 'too many requests from this address'
  if (payer && (!allowed(`from:${payer}`, 3, 60_000) || !allowed(`from-h:${payer}`, 20, 3_600_000))) return 'too many payments from this wallet, retry later'
  if (!allowed('global', 600, 3_600_000)) return 'gateway busy, retry later'
  return null
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
  if (typeof text !== 'string' || text.length > 2_000) return fail(400, 'invalid packet')
  let p
  try { p = decodePayment(text) } catch { return fail(400, 'invalid packet') }
  const check = await verifyPayment(p)
  if (!check.ok) return fail(400, check.reason)
  if (relayer) {
    // Free money-go-round: paying yourself (or dust) would let anyone burn our gas.
    if (p.from === p.to) return fail(400, 'payer and recipient are the same')
    if (p.value < MIN_VALUE) return fail(400, `minimum ${formatUsdc(MIN_VALUE)} ${symbol(p.token)}`)
  }

  let status
  try { status = await checkPayment(p, { rpcUrl: RPC_URL }) } catch { return fail(503, 'Arc RPC unavailable') }
  if (status.settled) return { code: 200, body: { ok: true, alreadySettled: true } }
  if (!status.funded) return fail(402, `payer has ${formatUsdc(status.payerBalance)} ${symbol(p.token)}, needs ${formatUsdc(p.value)}`)

  if (!relayer) {
    try { await simulatePayment(p, { rpcUrl: RPC_URL }) } catch { return fail(422, 'payment would fail on Arc') }
    return { code: 200, body: { ok: true, simulated: true, note: 'no RELAYER_PRIVATE_KEY set; payment is valid but was not submitted' } }
  }

  // The same packet often arrives through several mesh paths at once.
  const key = `${p.vault ? 'v' : 'a'}:${p.from}:${p.nonce}`
  if (!inflight.has(key)) {
    const limited = rateLimited({ ip, payer: p.from })
    if (limited) return fail(429, limited)
    const started = Date.now()
    const job = serial(async () => {
      await simulatePayment(p, { rpcUrl: RPC_URL, relayer: relayer.address }) // reverts cost nothing here
      return settlePayment(p, { relayerAccount: relayer, rpcUrl: RPC_URL })
    }).then((r) => ({ ...r, settleMs: Date.now() - started }))
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

// Locks funds in the offline vault from the owner's EIP-3009 signature; the gateway pays the gas.
export async function deposit(d, { ip } = {}) {
  if (!d || typeof d !== 'object') return fail(400, 'invalid deposit')
  const chainId = Number(d.chainId), token = Number(d.token ?? 0)
  if (!Number.isSafeInteger(chainId) || !vaultAddress(chainId) || ![0, 1].includes(token)) return fail(400, 'no vault for this chain or token')
  if (![d.value, d.validAfter, d.validBefore].every((x) => DIGITS.test(String(x))) || !isAddress(String(d.from))
    || !HEX32.test(String(d.nonce)) || !SIG.test(String(d.signature))) return fail(400, 'invalid deposit')
  const dep = { chainId, token, from: getAddress(d.from), value: String(d.value), validAfter: String(d.validAfter), validBefore: String(d.validBefore), nonce: d.nonce, signature: d.signature }
  if (BigInt(dep.value) < MIN_VALUE) return fail(400, `minimum ${formatUsdc(MIN_VALUE)} ${symbol(token)}`)

  let call
  try { call = depositCall(dep) } catch { return fail(400, 'invalid deposit') }
  const client = publicClient(chainId, RPC_URL)
  if (!relayer) {
    try { await client.simulateContract({ ...call, account: dep.from }) } catch { return fail(422, 'deposit would fail on Arc') }
    return { code: 200, body: { ok: true, simulated: true } }
  }
  const key = `d:${dep.from}:${dep.nonce}`
  if (!inflight.has(key)) {
    const limited = rateLimited({ ip, payer: dep.from })
    if (limited) return fail(429, limited)
    const wallet = createWalletClient({ account: relayer, chain: CHAINS[chainId], transport: viemHttp(RPC_URL) })
    const job = serial(async () => {
      await client.simulateContract({ ...call, account: relayer }) // bad signature or no funds: fails here, for free
      const hash = await wallet.writeContract(call)
      const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 150 })
      return { hash, status: receipt.status }
    })
    inflight.set(key, job)
    job.then(() => setTimeout(() => inflight.delete(key), 60_000).unref(), () => inflight.delete(key))
  }
  try {
    const r = await inflight.get(key)
    return { code: 200, body: { ok: r.status === 'success', hash: r.hash, url: `${CHAINS[chainId].blockExplorers.default.url}/tx/${r.hash}` } }
  } catch { return fail(422, 'deposit would fail on Arc') }
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
    if (req.method === 'POST' && req.url === '/api/deposit') {
      const { code, body: out } = await deposit((await body(req))?.deposit, { ip })
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
