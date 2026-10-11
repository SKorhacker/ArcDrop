// Builds a real signed payment and splits it into ArcMesh Bluetooth frames (hex),
// to inject from a BLE test app (nRF Connect / LightBlue) without the iOS app.
//   node --env-file=.env scripts/ble-frames.mjs <to-address> [amount] [frames]
import { privateKeyToAccount } from 'viem/accounts'
import { createPayment, encodePayment } from '../core/arcdrop.js'

const [to, amount = '0.1', parts = '2'] = process.argv.slice(2)
const payer = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY)
const packet = encodePayment(await createPayment({ account: payer, to, amount, chainId: 5042002 }))
const bytes = Buffer.from(packet.slice('arcdrop:1:'.length), 'base64url')

// frame = msgId u32 | index u8 | count u8 | hops u8 | chunk
const id = Buffer.from(crypto.getRandomValues(new Uint8Array(4)))
const count = Number(parts)
const size = Math.ceil(bytes.length / count)
console.log(`payment: ${amount} USDC ${payer.address} -> ${to}\n${packet}\n`)
for (let i = 0; i < count; i++) {
  const frame = Buffer.concat([id, Buffer.from([i, count, 0]), bytes.subarray(i * size, (i + 1) * size)])
  console.log(`frame ${i + 1}/${count} (${frame.length} bytes):\n${frame.toString('hex').toUpperCase()}\n`)
}
