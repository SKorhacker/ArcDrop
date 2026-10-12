// Builds the Swift mesh checks and runs them with fresh packets (v1, v2 EURC, receipt, v4 tab voucher).
//   node scripts/mesh-check.mjs
import { execFileSync } from 'node:child_process'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createPayment, createTabPayment, encodePayment, createAck } from '../core/arcdrop.js'

const a = privateKeyToAccount(generatePrivateKey()), b = privateKeyToAccount(generatePrivateKey())
const v1 = await createPayment({ account: a, to: b.address, amount: '1', chainId: 5042002 })
const v2 = await createPayment({ account: a, to: b.address, amount: '2', chainId: 5042002, token: 1 })
const v4 = await createTabPayment({ account: a, to: b.address, cumulative: 700_000n, epoch: 0, chainId: 5042002 })
const args = [encodePayment(v1), encodePayment(v2), await createAck(b, v1), encodePayment(v4)]
execFileSync('swiftc', ['-O', '-o', 'mesh/build/mesh-check', 'mesh/ArcMesh.swift', 'ios/ArcDropRelay.swift', 'mesh/check/main.swift'], { stdio: 'inherit' })
execFileSync('mesh/build/mesh-check', args, { stdio: 'inherit' })
