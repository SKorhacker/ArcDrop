// Real end-to-end test of the offline vault on Arc testnet, using the gateway wallet from .env:
// deposit -> offline voucher -> carried as text -> relayed -> redeemed; replay, forgery,
// overdraft and withdrawal notice must all be refused or behave as designed.
import assert from 'node:assert/strict'
import { createWalletClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  CHAINS, publicClient, createDeposit, depositCall, createPayment, encodePayment, decodePayment,
  verifyPayment, simulatePayment, vaultState, vaultAddress, tokenAddress, VAULT_ABI, formatUsdc,
} from '../core/arcdrop.js'
import { relay } from '../relayer/server.mjs'

const chainId = 5042002
const me = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY)
const wallet = createWalletClient({ account: me, chain: CHAINS[chainId], transport: http() })
const client = publicClient(chainId)
const show = async (label) => { const v = await vaultState(chainId, 0, me.address); console.log(`${label}: vault ${formatUsdc(v.balance)} USDC`); return v }

const before = await show('before')

// 1. Lock 1 USDC in the vault (EIP-3009 signature, submitted by anyone).
const d = await createDeposit({ account: me, amount: '1', chainId })
const h1 = await wallet.writeContract(depositCall(d))
await client.waitForTransactionReceipt({ hash: h1 })
const afterDeposit = await show('after deposit')
assert.equal(afterDeposit.balance - before.balance, 1_000_000n)

// 2. Pay 0.2 USDC offline from the vault, carry the voucher as text, relay it.
const friend = privateKeyToAccount(generatePrivateKey()).address
const v = await createPayment({ account: me, to: friend, amount: '0.2', chainId, vault: true })
const text = encodePayment(v)
assert.ok(text.startsWith('arcdrop:3:'))
assert.deepEqual(await verifyPayment(decodePayment(`💸 ${text}`)), { ok: true })
const r1 = await relay(text)
console.log('relay voucher ->', r1.code, r1.body.url ?? r1.body)
assert.equal(r1.body.ok, true)
const friendBal = await client.readContract({ address: tokenAddress(chainId, 0), abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [friend] })
assert.equal(friendBal, 200_000n)
await show('after voucher')

// 3. Replay, forgery and overdraft are refused.
assert.equal((await relay(text)).body.alreadySettled, true)
const forged = { ...decodePayment(text), to: me.address }
assert.equal((await verifyPayment(forged)).reason, 'bad signature')
await assert.rejects(simulatePayment(forged, { relayer: me.address }))
const tooMuch = await createPayment({ account: me, to: friend, amount: '1000', chainId, vault: true })
await assert.rejects(simulatePayment(tooMuch, { relayer: me.address }), /InsufficientVault|revert/)
console.log('replay, forgery and overdraft refused')

// 4. Withdrawal needs 24 h notice: requesting it works, withdrawing now does not.
const h2 = await wallet.writeContract({ address: vaultAddress(chainId), abi: VAULT_ABI, functionName: 'requestWithdraw', args: [tokenAddress(chainId, 0), 100_000n] })
await client.waitForTransactionReceipt({ hash: h2 })
const w = await show('after withdraw request')
console.log(`withdrawal of ${formatUsdc(w.withdrawing)} USDC unlocks at ${new Date(w.unlocksAt * 1000).toISOString()}`)
await assert.rejects(client.simulateContract({ address: vaultAddress(chainId), abi: VAULT_ABI, functionName: 'withdraw', args: [tokenAddress(chainId, 0)], account: me.address }))
console.log('early withdrawal refused')
