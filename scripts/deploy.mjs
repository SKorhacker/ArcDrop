// Deploys a compiled contract and records its address in core/<file>.json.
//   node --env-file=.env scripts/deploy.mjs testnet ArcDropTabs
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CHAINS, publicClient } from '../core/arcdrop.js'

const chainId = process.argv[2] === 'mainnet' ? 5042 : 5042002
const NAME = process.argv[3] ?? 'ArcDropVault'
const FILE = { ArcDropVault: 'core/vault.json', ArcDropTabs: 'core/tabs.json' }[NAME]
const { abi, bytecode } = JSON.parse(readFileSync(`contracts/${NAME}.json`, 'utf8'))
const account = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY)
const wallet = createWalletClient({ account, chain: CHAINS[chainId], transport: http() })
const hash = await wallet.deployContract({ abi, bytecode })
const receipt = await publicClient(chainId).waitForTransactionReceipt({ hash })
const vaults = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {}
vaults[chainId] = receipt.contractAddress
writeFileSync(FILE, JSON.stringify(vaults, null, 2) + '\n')
console.log(`${NAME} on chain ${chainId}: ${receipt.contractAddress}\n${CHAINS[chainId].blockExplorers.default.url}/tx/${hash}`)
