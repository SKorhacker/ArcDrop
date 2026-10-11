// Live proof (Arc testnet) that a payer cannot fake a settlement by burning the nonce:
// they hand over a payment, then spend the same nonce on a payment to themselves.
// The nonce is "used" on-chain, yet ArcDrop must report the original payment as NOT paid.
//   node --env-file=.env scripts/attack-e2e.mjs
import assert from 'node:assert/strict'
import { createWalletClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { CHAINS, createPayment, encodePayment, decodePayment, checkPayment, confirmSettlement, settlePayment } from '../core/arcdrop.js'

const chainId = 5042002
const attacker = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY)
const merchant = privateKeyToAccount(generatePrivateKey()).address

// 1. The attacker hands the merchant a real, verifiable payment.
const handed = await createPayment({ account: attacker, to: merchant, amount: '0.05', chainId })
const packet = encodePayment(handed)

// 2. Before the merchant gets online, the attacker spends the same nonce on himself.
const burn = { ...(await createPayment({ account: attacker, to: attacker.address, amount: '0.01', chainId })), nonce: handed.nonce }
const signed = await attacker.signTypedData({
  domain: { name: 'USDC', version: '2', chainId, verifyingContract: '0x3600000000000000000000000000000000000000' },
  types: { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
  primaryType: 'TransferWithAuthorization',
  message: { from: burn.from, to: burn.to, value: burn.value, validAfter: 0n, validBefore: burn.validBefore, nonce: burn.nonce },
})
const res = await settlePayment({ ...burn, signature: signed }, { relayerAccount: attacker })
console.log('attacker burnt the nonce:', res.url)

// 3. The merchant's app comes online.
const p = decodePayment(packet)
assert.equal((await checkPayment(p)).settled, true, 'nonce is used on-chain')
const verdict = await confirmSettlement(p)
console.log('ArcDrop verdict for the handed payment:', verdict)
assert.equal(verdict.paid, false)
console.log('✓ burnt-nonce attack detected: shown as NOT paid')
