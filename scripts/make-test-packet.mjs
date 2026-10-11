// Prints a signed payment between two throwaway wallets (unfunded): handy to test
// transports and the gateway without touching real money.
//   node scripts/make-test-packet.mjs 5
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createPayment, encodePayment } from '../core/arcdrop.js'

const payer = privateKeyToAccount(generatePrivateKey())
const payee = privateKeyToAccount(generatePrivateKey())
console.log(encodePayment(await createPayment({ account: payer, to: payee.address, amount: process.argv[2] ?? '5' })))
