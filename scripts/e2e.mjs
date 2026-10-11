// Real end-to-end payment, the same path a phone takes: sign offline -> encode ->
// carry as text -> gateway relay() -> settled on Arc. Uses the gateway wallet from
// .env as the payer too, so a single faucet top-up is enough.
//   node --env-file=.env scripts/e2e.mjs [testnet|mainnet] [amount] [recipient]
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createPayment, encodePayment, checkPayment, decodePayment, formatUsdc, publicClient, USDC, USDC_ABI } from '../core/arcdrop.js'
import { relay } from '../relayer/server.mjs'

const chainId = (process.argv[2] ?? 'testnet') === 'mainnet' ? 5042 : 5042002
const amount = process.argv[3] ?? '0.01'
const payer = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY)
const payee = process.argv[4] ?? privateKeyToAccount(generatePrivateKey()).address

const client = publicClient(chainId)
const balance = await client.readContract({ address: USDC, abi: USDC_ABI, functionName: 'balanceOf', args: [payer.address] })
console.log(`payer ${payer.address} has ${formatUsdc(balance)} USDC on chain ${chainId}`)

const packet = encodePayment(await createPayment({ account: payer, to: payee, amount, chainId }))
console.log(`signed offline: ${amount} USDC -> ${payee}\n${packet}`)

const t0 = Date.now()
const { code, body } = await relay(`💸 ${amount} USDC (ArcDrop)\n${packet}`)
console.log(code, body, `${Date.now() - t0} ms end to end`)

const after = await client.readContract({ address: USDC, abi: USDC_ABI, functionName: 'balanceOf', args: [payee] })
console.log(`payee now holds ${formatUsdc(after)} USDC; settled flag:`, (await checkPayment(decodePayment(packet))).settled)
const again = await relay(packet)
console.log('replay attempt ->', again.code, again.body)
