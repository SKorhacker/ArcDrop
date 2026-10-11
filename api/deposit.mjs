// Vercel function: same deposit logic as relayer/server.mjs (validation, rate limits, CORS allowlist).
import { deposit, corsHeaders } from '../relayer/server.mjs'

export default async function handler(req, res) {
  for (const [k, v] of Object.entries(corsHeaders(req.headers.origin))) res.setHeader(k, v)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' })
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
    const ip = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || undefined
    const { code, body: out } = await deposit(body?.deposit, { ip })
    res.status(code).send(JSON.stringify(out))
  } catch (e) {
    console.error(e)
    res.status(400).json({ ok: false, error: 'invalid request' })
  }
}
