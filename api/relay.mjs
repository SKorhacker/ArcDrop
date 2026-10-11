// Vercel function: same gateway logic as relayer/server.mjs.
import { relay } from '../relayer/server.mjs'

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'content-type')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' })
  try {
    const { packet } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
    const { code, body } = await relay(packet)
    res.status(code).send(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))
  } catch (e) {
    res.status(500).json({ ok: false, error: e.shortMessage ?? e.message })
  }
}
