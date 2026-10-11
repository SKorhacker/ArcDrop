// Deploys ArcDropVault and records its address in core/vault.json.
//   node --env-file=.env scripts/deploy-vault.mjs testnet
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CHAINS, publicClient } from '../core/arcdrop.js'

const chainId = process.argv[2] === 'mainnet' ? 5042 : 5042002
const { abi, bytecode } = JSON.parse(readFileSync('contracts/ArcDropVault.json', 'utf8'))
const account = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY)
const wallet = createWalletClient({ account, chain: CHAINS[chainId], transport: http() })
const hash = await wallet.deployContract({ abi, bytecode })
const receipt = await publicClient(chainId).waitForTransactionReceipt({ hash })
const vaults = existsSync('core/vault.json') ? JSON.parse(readFileSync('core/vault.json', 'utf8')) : {}
vaults[chainId] = receipt.contractAddress
writeFileSync('core/vault.json', JSON.stringify(vaults, null, 2) + '\n')
console.log(`ArcDropVault on chain ${chainId}: ${receipt.contractAddress}\n${CHAINS[chainId].blockExplorers.default.url}/tx/${hash}`)
