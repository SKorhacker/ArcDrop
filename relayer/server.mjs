// Gateway node: serves the web app and settles payments carried in by any
// transport (QR, AirDrop link, bitchat mesh). It pays the gas, so a recipient
// with an empty wallet can still cash in.
//
//   RELAYER_PRIVATE_KEY=0x… PORT=8787 node relayer/server.mjs
//
// Without RELAYER_PRIVATE_KEY it only verifies and simulates.

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { privateKeyToAccount } from 'viem/accounts'
import { decodePayment, verifyPayment, checkPayment, simulatePayment, settlePayment, formatUsdc } from '../core/arcdrop.js'

const PORT = Number(process.env.PORT ?? 8787)
const RPC_URL = process.env.ARC_RPC_URL
const relayer = process.env.RELAYER_PRIVATE_KEY ? privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY) : null
const WEB = fileURLToPath(new URL('../web/dist/', import.meta.url))
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.css': 'text/css' }

const inflight = new Map()

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' })
  res.end(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))
}

async function body(req) {
  let data = ''
  for await (const chunk of req) {
    data += chunk
    if (data.length > 10_000) throw new Error('payload too large')
  }
  return data
}

export async function relay(text) {
  let p
  try { p = decodePayment(text) } catch (e) { return { code: 400, body: { ok: false, error: e.message } } }
  const check = await verifyPayment(p)
  if (!check.ok) return { code: 400, body: { ok: false, error: check.reason } }

  const status = await checkPayment(p, { rpcUrl: RPC_URL })
  if (status.settled) return { code: 200, body: { ok: true, alreadySettled: true } }
  if (!status.funded) return { code: 402, body: { ok: false, error: `payer has ${formatUsdc(status.payerBalance)} USDC, needs ${formatUsdc(p.value)}` } }

  if (!relayer) {
    await simulatePayment(p, { rpcUrl: RPC_URL })
    return { code: 200, body: { ok: true, simulated: true, note: 'no RELAYER_PRIVATE_KEY set; payment is valid but was not submitted' } }
  }

  // The same packet often arrives through several mesh paths at once.
  const key = `${p.from}:${p.nonce}`
  if (!inflight.has(key)) {
    const started = Date.now()
    inflight.set(key, settlePayment(p, { relayerAccount: relayer, rpcUrl: RPC_URL })
      .then((r) => ({ ...r, settleMs: Date.now() - started }))
      .finally(() => setTimeout(() => inflight.delete(key), 60_000).unref()))
  }
  const result = await inflight.get(key)
  console.log(`settled ${formatUsdc(p.value)} USDC ${p.from} -> ${p.to} in ${result.settleMs}ms ${result.url}`)
  return { code: 200, body: { ok: result.status === 'success', ...result } }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return json(res, 204, {})
    if (req.method === 'POST' && req.url === '/api/relay') {
      const { packet } = JSON.parse(await body(req))
      const { code, body: out } = await relay(packet)
      return json(res, code, out)
    }
    if (req.method === 'GET' && req.url === '/api/info') {
      return json(res, 200, { relayer: relayer?.address ?? null })
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })

    const path = normalize(decodeURIComponent(req.url.split(/[?#]/)[0])).replace(/^(\.\.[/\\])+/, '')
    const file = join(WEB, path.endsWith('/') ? 'index.html' : path)
    if (!file.startsWith(WEB)) return json(res, 403, { error: 'forbidden' })
    const data = await readFile(file).catch(() => readFile(join(WEB, 'index.html')))
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'text/html' })
    res.end(data)
  } catch (e) {
    json(res, 500, { ok: false, error: e.shortMessage ?? e.message })
  }
})

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`ArcDrop gateway on http://localhost:${PORT} (relayer: ${relayer?.address ?? 'simulate only'})`))
}
