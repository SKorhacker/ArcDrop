// Offline tests + one read-only check against Arc mainnet (no funds, no gas).
import assert from 'node:assert/strict'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { hashDomain } from 'viem'
import {
  createPayment, encodePayment, decodePayment, verifyPayment, paymentLink, extractPacket,
  simulatePayment, checkPayment, domain, publicClient, USDC, parseUsdc, formatUsdc,
} from '../core/arcdrop.js'

const payer = privateKeyToAccount(generatePrivateKey())
const payee = privateKeyToAccount(generatePrivateKey())

assert.equal(parseUsdc('5'), 5_000_000n)
assert.equal(parseUsdc('0.01'), 10_000n)
assert.equal(formatUsdc(5_250_000n), '5.25')
assert.throws(() => parseUsdc('1.1234567'))

const p = await createPayment({ account: payer, to: payee.address, amount: '5' })
const packet = encodePayment(p)
console.log('packet', packet.length, 'chars')
const back = decodePayment(packet)
assert.deepEqual(back, { ...p })
assert.deepEqual(await verifyPayment(back), { ok: true })

const link = paymentLink(p, 'https://arcdrop.app/')
assert.equal(extractPacket(link), packet)
assert.equal(extractPacket(`hey here's the money ${packet} thx`), packet)

const tampered = decodePayment(packet)
tampered.to = payer.address
assert.equal((await verifyPayment(tampered)).reason, 'bad signature')

const expired = await createPayment({ account: payer, to: payee.address, amount: '1', ttlSeconds: 10, now: 1000 })
assert.equal((await verifyPayment(expired)).reason, 'expired')
console.log('offline tests ok')

// Our EIP-712 domain must match the deployed USDC contract.
const client = publicClient(5042)
const onchain = await client.readContract({ address: USDC, abi: [{ type: 'function', name: 'DOMAIN_SEPARATOR', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] }], functionName: 'DOMAIN_SEPARATOR' })
const ours = hashDomain({ domain: domain(5042), types: { EIP712Domain: [
  { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] } })
assert.equal(ours, onchain, 'domain separator mismatch')
console.log('domain separator matches Arc mainnet USDC')

// A 0-USDC payment from an empty wallet exercises the full signature path of the
// real contract without moving funds.
const zero = await createPayment({ account: payer, to: payee.address, amount: '0' })
await simulatePayment(zero)
console.log('transferWithAuthorization simulation on Arc mainnet ok')

const bad = { ...zero, to: payer.address }
await assert.rejects(simulatePayment(bad))
console.log('tampered payment rejected by Arc mainnet')

const status = await checkPayment(p)
assert.equal(status.settled, false)
assert.equal(status.funded, false)
console.log('status check ok', status)

// ---------- EURC (v2 packets) ----------
{
  const { createPayment, encodePayment, decodePayment, verifyPayment, simulatePayment, extractPacket } = await import('../core/arcdrop.js')
  const e = await createPayment({ account: payer, to: payee.address, amount: '3.5', chainId: 5042002, token: 1 })
  const text = encodePayment(e)
  assert.ok(text.startsWith('arcdrop:2:'))
  assert.equal(extractPacket(`hey ${text}`), text)
  const back = decodePayment(text)
  assert.equal(back.token, 1)
  assert.deepEqual(back, { ...e })
  assert.deepEqual(await verifyPayment(back), { ok: true })
  // a v2 packet relabeled as USDC must not verify
  assert.equal((await verifyPayment({ ...back, token: 0 })).reason, 'bad signature')
  const zero = await createPayment({ account: payer, to: payee.address, amount: '0', chainId: 5042002, token: 1 })
  await simulatePayment(zero)
  console.log('EURC payment: encode/decode/verify + simulation on Arc testnet ok')
}

// ---------- receipts & requests ----------
{
  const { createPayment, createAck, readAck, encodeRequest, decodeRequest } = await import('../core/arcdrop.js')
  const q = await createPayment({ account: payer, to: payee.address, amount: '1' })
  const ack = await createAck(payee, q)
  const r = await readAck(`✓ ${ack}`)
  assert.equal(r.nonce, q.nonce)
  assert.equal(r.signer, payee.address)
  const req = encodeRequest({ chainId: 5042002, token: 1, to: payee.address, value: 12_500_000n, label: 'Crêpe nutella 🍫' })
  assert.deepEqual(decodeRequest(`scan: ${req}`), { chainId: 5042002, token: 1, to: payee.address, value: 12_500_000n, label: 'Crêpe nutella 🍫' })
  assert.equal(decodeRequest('nothing here'), null)
  console.log('receipts + payment requests ok')
}
