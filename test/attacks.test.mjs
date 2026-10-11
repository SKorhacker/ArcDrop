// Every attack found by the security review, as a test that must keep failing for the attacker.
import assert from 'node:assert/strict'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  createPayment, encodePayment, decodePayment, verifyPayment, extractPacket,
  createAck, verifyAck, encodeRequest, decodeRequest,
} from '../core/arcdrop.js'

const payer = privateKeyToAccount(generatePrivateKey())
const payee = privateKeyToAccount(generatePrivateKey())
const b64 = (bytes) => Buffer.from(bytes).toString('base64url')
const bytesOf = (packet) => Buffer.from(packet.split(':')[2], 'base64url')
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

const p = await createPayment({ account: payer, to: payee.address, amount: '1', chainId: 5042002 })
const packet = encodePayment(p)

// 1. One payment, one string: flipping the unused low bits of the last base64 char is rejected.
{
  const body = packet.split(':')[2]
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const last = alphabet.indexOf(body.at(-1))
  let variants = 0
  for (let i = 0; i < 64; i++) {
    if (i === last) continue
    const alt = `arcdrop:1:${body.slice(0, -1)}${alphabet[i]}`
    let same = false
    try { same = decodePayment(alt).nonce === p.nonce } catch { /* rejected */ }
    if (same) variants++
  }
  assert.equal(variants, 0, 'alternate encodings of the same payment must be rejected')
  console.log('✓ alternate base64 encodings rejected')
}

// 2. Malleated signature (s -> n - s, v flipped) is rejected offline, as the contracts do.
{
  const raw = bytesOf(packet)
  const sig = raw.subarray(raw.length - 65)
  const s = BigInt('0x' + Buffer.from(sig.subarray(32, 64)).toString('hex'))
  sig.set(Buffer.from((N - s).toString(16).padStart(64, '0'), 'hex'), 32)
  sig[64] = sig[64] === 27 ? 28 : 27
  assert.throws(() => decodePayment(`arcdrop:1:${b64(raw)}`), /non-canonical/)
  const raw2 = bytesOf(packet); raw2[raw2.length - 1] = 0 // v = 0
  assert.throws(() => decodePayment(`arcdrop:1:${b64(raw2)}`), /non-canonical/)
  console.log('✓ malleated / non-canonical signatures rejected')
}

// 3. Postdated payments do not pass the offline check.
{
  const future = { ...p, validAfter: BigInt(Math.floor(Date.now() / 1000) + 3600) }
  assert.equal((await verifyPayment(future)).reason, 'not yet valid')
  console.log('✓ postdated payment rejected')
}

// 4. Unknown chain / token never throw, they are refused.
{
  assert.equal((await verifyPayment({ ...p, token: 7 })).ok, false)
  assert.equal((await verifyPayment({ ...p, chainId: 1 })).ok, false)
  assert.equal((await verifyPayment({ ...p, chainId: '__proto__' })).ok, false)
  console.log('✓ unknown chain / token refused without crashing')
}

// 5. Values that would wrap in the fixed-width packet are refused at signing and encoding.
{
  await assert.rejects(createPayment({ account: payer, to: payee.address, amount: 2n ** 64n + 1n, chainId: 5042002 }), /out of range/)
  await assert.rejects(createPayment({ account: payer, to: payee.address, amount: '1', chainId: 5042002, ttlSeconds: 2 ** 32 }), /out of range/)
  assert.throws(() => encodeRequest({ chainId: 5042002, to: payee.address, value: 2n ** 64n + 5n }), /out of range/)
  console.log('✓ overflowing amounts / expiries refused')
}

// 6. Receipts: bound to the exact payment and signer; not a raw-hash signing oracle.
{
  const ack = await createAck(payee, p)
  assert.equal(await verifyAck(ack, p), true)
  assert.equal(await verifyAck(ack, { ...p, value: 2n }), false)
  assert.equal(await verifyAck(ack, { ...p, to: payer.address }), false)
  assert.equal(await verifyAck('arcdrop-ack:2:' + 'A'.repeat(130), p), false)
  assert.equal(await verifyAck('garbage', p), false)
  console.log('✓ receipts bound to the payment, forgeries refused')
}

// 7. Requests: garbage, unknown chains and hostile labels are neutralised.
{
  assert.equal(decodeRequest('arcdrop-req:1:' + 'A'.repeat(41)), null)
  assert.equal(decodeRequest(encodeRequest({ chainId: 5042002, to: payee.address, value: 1n }).replace('arcdrop-req:1:', 'arcdrop-req:1:x')), null)
  const forged = Buffer.alloc(33); forged.writeUInt32BE(4294967295, 0)
  assert.equal(decodeRequest('arcdrop-req:1:' + b64(forged)), null)
  const r = decodeRequest(encodeRequest({ chainId: 5042002, to: payee.address, value: 1n, label: '‮gnp.exe\u0007' + 'é'.repeat(40) }))
  assert.ok(!/[‮\u0007]/.test(r.label), 'control / bidi characters stripped')
  assert.ok(new TextEncoder().encode(r.label).length <= 40 && !r.label.includes('�'), 'label capped without broken characters')
  console.log('✓ hostile requests neutralised')
}

// 8. Payment links survive extraction exactly (no truncation games).
assert.equal(extractPacket(`https://x/#p=${packet}&junk`), packet)
console.log('all attack tests passed')
