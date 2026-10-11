// Creates the gateway's gas wallet in .env (never printed). Prints only its address.
import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const env = existsSync('.env') ? readFileSync('.env', 'utf8') : ''
let key = env.match(/^RELAYER_PRIVATE_KEY=(0x[0-9a-fA-F]{64})$/m)?.[1]
if (!key) {
  key = generatePrivateKey()
  appendFileSync('.env', `RELAYER_PRIVATE_KEY=${key}\n`, { mode: 0o600 })
}
console.log(privateKeyToAccount(key).address)
