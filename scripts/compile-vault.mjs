// Compiles contracts/ArcDropVault.sol with solc-js into contracts/ArcDropVault.json (abi + bytecode).
import { readFileSync, writeFileSync } from 'node:fs'
import solc from 'solc'

const source = readFileSync('contracts/ArcDropVault.sol', 'utf8')
const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: { 'ArcDropVault.sol': { content: source } },
  settings: { optimizer: { enabled: true, runs: 500 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})))
const problems = (out.errors ?? []).filter((e) => e.severity === 'error' || e.type === 'Warning')
for (const e of problems) console.error(e.formattedMessage)
if ((out.errors ?? []).some((e) => e.severity === 'error')) process.exit(1)
const c = out.contracts['ArcDropVault.sol'].ArcDropVault
writeFileSync('contracts/ArcDropVault.json', JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2))
console.log(`compiled: ${c.abi.length} ABI entries, ${c.evm.bytecode.object.length / 2} bytes`)
