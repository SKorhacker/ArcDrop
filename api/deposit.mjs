// Vercel function: same deposit logic as relayer/server.mjs.
import { deposit } from '../relayer/server.mjs'

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'content-type')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' })
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
    const { code, body: out } = await deposit(body.deposit)
    res.status(code).send(JSON.stringify(out))
  } catch (e) {
    res.status(500).json({ ok: false, error: e.shortMessage ?? e.message })
  }
}
