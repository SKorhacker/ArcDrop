// Settle a payment from the terminal: paste a packet, a link, or a bitchat message.
//   node relayer/cli.mjs 'arcdrop:1:…'
import { relay } from './server.mjs'

const input = process.argv.slice(2).join(' ')
if (!input) {
  console.error('usage: node relayer/cli.mjs <packet | link | text containing a packet>')
  process.exit(1)
}
const { code, body } = await relay(input)
console.log(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
process.exit(code < 300 ? 0 : 1)
