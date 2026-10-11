// Compiles a contract with solc-js into contracts/<Name>.json (abi + bytecode).
//   node scripts/compile-vault.mjs [ArcDropTabs]
import { readFileSync, writeFileSync } from 'node:fs'
import solc from 'solc'

const NAME = process.argv[2] ?? 'ArcDropVault'
const source = readFileSync(`contracts/${NAME}.sol`, 'utf8')
const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: { [`${NAME}.sol`]: { content: source } },
  settings: { optimizer: { enabled: true, runs: 500 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})))
const problems = (out.errors ?? []).filter((e) => e.severity === 'error' || e.type === 'Warning')
for (const e of problems) console.error(e.formattedMessage)
if ((out.errors ?? []).some((e) => e.severity === 'error')) process.exit(1)
const c = out.contracts[`${NAME}.sol`][NAME]
writeFileSync(`contracts/${NAME}.json`, JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2))
console.log(`compiled: ${c.abi.length} ABI entries, ${c.evm.bytecode.object.length / 2} bytes`)
