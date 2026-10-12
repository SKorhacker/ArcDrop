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
  assert.equal(decodeRequest(encodeRequest({ chainId: 5042002, to: payee.address, value: 20_000n }).replace('arcdrop-req:1:', 'arcdrop-req:1:x')), null)
  assert.equal(decodeRequest(encodeRequest({ chainId: 5042002, to: payee.address, value: 1n })), null, 'dust request refused')
  const forged = Buffer.alloc(33); forged.writeUInt32BE(4294967295, 0)
  assert.equal(decodeRequest('arcdrop-req:1:' + b64(forged)), null)
  const r = decodeRequest(encodeRequest({ chainId: 5042002, to: payee.address, value: 20_000n, label: '\u202Egnp.exe\u0007\u061C\u200B\u2060\uFEFF\u2028\u034F' + 'é'.repeat(40) }))
  assert.ok(!/[\u202E\u0007\u061C\u200B\u2060\uFEFF\u2028\u034F]/.test(r.label), 'control / bidi / invisible characters stripped')
  assert.ok(new TextEncoder().encode(r.label).length <= 40 && !r.label.includes('�'), 'label capped without broken characters')
  console.log('✓ hostile requests neutralised')
}

// 8. USDC has exactly one encoding: a v2 packet with token byte 0 is refused.
{
  const raw = bytesOf(packet)
  assert.throws(() => decodePayment(`arcdrop:2:${b64(Buffer.concat([Buffer.from([0]), raw]))}`), /unknown token/)
  console.log('✓ no second encoding of USDC payments')
}

// 9. Tab voucher identities differ across token, payer and chain.
{
  const { createTabPayment } = await import('../core/arcdrop.js')
  const other = privateKeyToAccount(generatePrivateKey())
  const base = { to: payee.address, cumulative: 100_000n, epoch: 0, chainId: 5042002 }
  const a = await createTabPayment({ ...base, account: payer, token: 0 })
  const b = await createTabPayment({ ...base, account: payer, token: 1 })
  const c = await createTabPayment({ ...base, account: other, token: 0 })
  assert.equal(new Set([a.nonce, b.nonce, c.nonce]).size, 3)
  console.log('✓ tab voucher identities are unique per token / payer')
}

// 10. One transfer can't pay for two packets: the transfer must follow its own authorization.
{
  const { _receiptPaysForTests: pays } = await import('../core/arcdrop.js')
  const { encodeEventTopics, encodeAbiParameters, parseAbiItem } = await import('viem')
  const USDC = '0x3600000000000000000000000000000000000000'
  const used = (nonce, i) => ({ address: USDC, logIndex: i, data: '0x', topics: encodeEventTopics({ abi: [parseAbiItem('event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)')], args: { authorizer: payer.address, nonce } }) })
  const moved = (to, value, i) => ({ address: USDC, logIndex: i, data: encodeAbiParameters([{ type: 'uint256' }], [value]), topics: encodeEventTopics({ abi: [parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')], args: { from: payer.address, to } }) })
  const p1 = await createPayment({ account: payer, to: payee.address, amount: '1', chainId: 5042002 })
  const p2 = await createPayment({ account: payer, to: payee.address, amount: '1', chainId: 5042002 })
  // one tx: burn p1's nonce with a 1-unit self-transfer, then settle p2
  const receipt = { status: 'success', logs: [used(p1.nonce, 0), moved(payer.address, 1n, 1), used(p2.nonce, 2), moved(payee.address, 1_000_000n, 3)] }
  assert.equal(pays(receipt, p2), true)
  assert.equal(pays(receipt, p1), false, 'p1 must not borrow p2\'s transfer')
  console.log('✓ a single transfer cannot settle two packets')
}

// 11. Payment links survive extraction exactly (no truncation games).
assert.equal(extractPacket(`https://x/#p=${packet}&junk`), packet)
// 12. A signature with r = 0 or r >= n is refused (it used to make verification throw).
for (const r of [0n, N, N + 1n]) {
  const bytes = bytesOf(packet)
  const sigAt = bytes.length - 65
  Buffer.from(r.toString(16).padStart(64, '0').slice(-64), 'hex').copy(bytes, sigAt)
  const forged = `arcdrop:1:${b64(bytes)}`
  let refused = false
  try { refused = !(await verifyPayment(decodePayment(forged))).ok } catch (e) { refused = /non-canonical/.test(e.message) }
  assert.ok(refused, `r = ${r} must be refused, not crash`)
}

console.log('all attack tests passed')
