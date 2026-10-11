// Signs (does not send) a testnet payment from the gateway wallet, to hand to a tester:
//   node --env-file=.env scripts/pay-to.mjs 0xRecipient 1
import { privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, http, erc20Abi } from 'viem'
import { createPayment, encodePayment, verifyPayment } from '../core/arcdrop.js'

const payer = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY)
const [to, amount = '1'] = process.argv.slice(2)
const p = await createPayment({ account: payer, to, amount, chainId: 5042002 })
const packet = encodePayment(p)
const client = createPublicClient({ transport: http('https://rpc.testnet.arc.io') })
const balance = await client.readContract({ address: '0x3600000000000000000000000000000000000000', abi: erc20Abi, functionName: 'balanceOf', args: [payer.address] })
console.error('payer', payer.address, 'balance', Number(balance) / 1e6, 'USDC (test), signature ok:', (await verifyPayment(p)).ok ?? JSON.stringify(await verifyPayment(p), (k, x) => typeof x === 'bigint' ? `${x}` : x))
console.log(packet)
console.log(`arcdrop://pay#p=${packet}`)
console.log(`https://arcdrop-pink.vercel.app/?net=testnet#p=${packet}`)
