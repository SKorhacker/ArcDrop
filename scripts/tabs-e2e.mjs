// Live test of tabs on Arc testnet (gateway wallet from .env as the payer):
// open a tab for a friend, pay offline twice, redeem through the gateway, and check
// every attack: self-redeem, early close, replay, forged amounts, overspending,
// funding front-run to another recipient, wrong epoch.
//   node --env-file=.env scripts/tabs-e2e.mjs
import assert from 'node:assert/strict'
import { createWalletClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  CHAINS, publicClient, createTabFunding, fundCall, createTabPayment, encodePayment, decodePayment,
  verifyPayment, simulatePayment, tabState, tabsAddress, tokenAddress, TABS_ABI, formatUsdc, tabsTo, confirmSettlement,
} from '../core/arcdrop.js'
import { relay } from '../relayer/server.mjs'

const chainId = 5042002
const payer = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY)
const friend = privateKeyToAccount(generatePrivateKey())
const thief = privateKeyToAccount(generatePrivateKey())
const wallet = createWalletClient({ account: payer, chain: CHAINS[chainId], transport: http() })
const client = publicClient(chainId)
const usdc = tokenAddress(chainId, 0)
const balanceOf = (a) => client.readContract({ address: usdc, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [a] })
const reverts = (call, account = payer.address) => assert.rejects(client.simulateContract({ ...call, account }))

// 0. Funding front-run: the same signature cannot open the tab for someone else.
const f = await createTabFunding({ account: payer, to: friend.address, amount: '1', days: 7, chainId })
await reverts(fundCall({ ...f, recipient: thief.address }), thief.address)
await reverts(fundCall({ ...f, expiry: f.expiry + 1n }), thief.address)
console.log('✓ funding signature cannot be redirected to another recipient or expiry')

// 1. Open a 1 USDC tab for the friend (anyone can submit; here the payer does).
const h = await wallet.writeContract(fundCall(f))
await client.waitForTransactionReceipt({ hash: h })
const t0 = await tabState(chainId, 0, payer.address, friend.address)
console.log(`tab open: ${formatUsdc(t0.locked)} USDC locked for the friend until ${new Date(t0.expiry * 1000).toISOString()}`)
assert.ok((await tabsTo(chainId, 0, friend.address)).some((t) => t.from === payer.address), 'friend can discover the tab')

// 2. Two offline payments: 0.2 then 0.3 more (cumulative 0.5).
const v1 = await createTabPayment({ account: payer, to: friend.address, cumulative: 200_000n, epoch: t0.epoch, chainId })
const v2 = await createTabPayment({ account: payer, to: friend.address, cumulative: 500_000n, epoch: t0.epoch, chainId })
assert.deepEqual(await verifyPayment(decodePayment(encodePayment(v2))), { ok: true })

// 3. The friend's app redeems the latest voucher through the gateway: 0.5 USDC arrives.
const r = await relay(encodePayment(v2))
console.log('redeem via gateway ->', r.code, r.body.url ?? r.body)
assert.equal(r.body.ok, true)
assert.equal(await balanceOf(friend.address), 500_000n)
assert.equal((await confirmSettlement(decodePayment(encodePayment(v2)))).paid, true)

// 4. Attacks.
await assert.rejects(simulatePayment(v1, { relayer: payer.address }))            // old voucher: nothing more to pay
await assert.rejects(simulatePayment(v2, { relayer: payer.address }))            // replay
await reverts({ address: tabsAddress(chainId), abi: TABS_ABI, functionName: 'close', args: [usdc, friend.address] }) // early close
const forged = { ...v2, cumulative: 900_000n }
assert.equal((await verifyPayment(forged)).reason, 'bad signature')
await assert.rejects(simulatePayment(forged, { relayer: payer.address }))        // forged amount
const toThief = await createTabPayment({ account: payer, to: thief.address, cumulative: 500_000n, epoch: t0.epoch, chainId })
await assert.rejects(simulatePayment(toThief, { relayer: payer.address }))       // payer "pays" another wallet: no tab there
const wrongEpoch = await createTabPayment({ account: payer, to: friend.address, cumulative: 600_000n, epoch: t0.epoch + 1, chainId })
await assert.rejects(simulatePayment(wrongEpoch, { relayer: payer.address }))    // voucher from another epoch
console.log('✓ replay, early close, forged amount, redirect to another wallet and wrong epoch all refused')

// 5. Overspending: a voucher above the locked amount pays exactly what is locked, never more.
const over = await createTabPayment({ account: payer, to: friend.address, cumulative: 5_000_000n, epoch: t0.epoch, chainId })
const r2 = await relay(encodePayment(over))
assert.equal(r2.body.ok, true)
assert.equal(await balanceOf(friend.address), 1_000_000n)
const t1 = await tabState(chainId, 0, payer.address, friend.address)
assert.equal(t1.paid, t1.locked)
console.log(`✓ overspend capped: friend received exactly the locked ${formatUsdc(t1.locked)} USDC`)

// Only the real USDC/EURC: a fake token can't create "funded" tabs or touch payer lists.
const fake = privateKeyToAccount(generatePrivateKey()).address
await reverts({ address: tabsAddress(chainId), abi: TABS_ABI, functionName: 'redeem', args: [fake, payer.address, friend.address, 1n, 27, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`] })
await reverts({ address: tabsAddress(chainId), abi: TABS_ABI, functionName: 'close', args: [fake, friend.address] })
console.log('✓ unknown tokens refused')
