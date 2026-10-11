// ArcDrop core: an offline USDC payment is an EIP-3009 `transferWithAuthorization`
// signed by the payer. It needs no network to create, any device can carry it
// (QR, AirDrop, Bluetooth mesh), and anyone online can submit it to Arc.
// The recipient is part of the signature, so whoever relays it cannot redirect funds.

import {
  createPublicClient, createWalletClient, http, defineChain,
  hexToBytes, bytesToHex, recoverTypedDataAddress, parseSignature, getAddress,
} from 'viem'

export const ARC_MAINNET = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' } },
})

export const ARC_TESTNET = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arc Testnet Explorer', url: 'https://explorer.testnet.arc.io' } },
  testnet: true,
})

export const CHAINS = { [ARC_MAINNET.id]: ARC_MAINNET, [ARC_TESTNET.id]: ARC_TESTNET }

// USDC ERC-20 interface on Arc (6 decimals). Same address on mainnet and testnet.
// On-chain: name() = "USDC", version() = "2" (Circle FiatToken v2, EIP-3009 enabled).
export const USDC = '0x3600000000000000000000000000000000000000'
export const USDC_DECIMALS = 6

export const PREFIX = 'arcdrop:1:'

const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
}

export const USDC_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'authorizationState', stateMutability: 'view', inputs: [{ name: 'authorizer', type: 'address' }, { name: 'nonce', type: 'bytes32' }], outputs: [{ type: 'bool' }] },
  {
    type: 'function', name: 'transferWithAuthorization', stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
]

export const domain = (chainId) => ({ name: 'USDC', version: '2', chainId, verifyingContract: USDC })

export function parseUsdc(amount) {
  const [whole, frac = ''] = String(amount).trim().split('.')
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac) || frac.length > USDC_DECIMALS) throw new Error(`invalid amount: ${amount}`)
  return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac.padEnd(USDC_DECIMALS, '0'))
}

export function formatUsdc(value) {
  const v = BigInt(value)
  const frac = (v % 10n ** BigInt(USDC_DECIMALS)).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '')
  return `${v / 10n ** BigInt(USDC_DECIMALS)}${frac ? '.' + frac : ''}`
}

function randomNonce() {
  const b = new Uint8Array(32)
  globalThis.crypto.getRandomValues(b)
  return bytesToHex(b)
}

// Works fully offline: only the local key is needed.
// `account` is a viem LocalAccount (privateKeyToAccount).
export async function createPayment({ account, to, amount, chainId = ARC_MAINNET.id, ttlSeconds = 7 * 24 * 3600, now = Math.floor(Date.now() / 1000) }) {
  const message = {
    from: account.address,
    to: getAddress(to),
    value: typeof amount === 'bigint' ? amount : parseUsdc(amount),
    validAfter: 0n,
    validBefore: BigInt(now + ttlSeconds),
    nonce: randomNonce(),
  }
  const signature = await account.signTypedData({ domain: domain(chainId), types: TYPES, primaryType: 'TransferWithAuthorization', message })
  return { chainId, ...message, signature }
}

// Compact binary layout (157 bytes) so a payment fits a small QR code and a
// couple of BLE fragments:
// chainId u32 | from 20 | to 20 | value u64 | validAfter u32 | validBefore u32 | nonce 32 | sig 65
export function encodePayment(p) {
  const buf = new Uint8Array(157)
  const dv = new DataView(buf.buffer)
  let o = 0
  dv.setUint32(o, p.chainId); o += 4
  buf.set(hexToBytes(p.from), o); o += 20
  buf.set(hexToBytes(p.to), o); o += 20
  dv.setBigUint64(o, BigInt(p.value)); o += 8
  dv.setUint32(o, Number(p.validAfter)); o += 4
  dv.setUint32(o, Number(p.validBefore)); o += 4
  buf.set(hexToBytes(p.nonce), o); o += 32
  buf.set(hexToBytes(p.signature), o)
  return PREFIX + toB64url(buf)
}

export function decodePayment(text) {
  const raw = extractPacket(text)
  if (!raw) throw new Error('not an ArcDrop payment')
  const buf = fromB64url(raw.slice(PREFIX.length))
  if (buf.length !== 157) throw new Error('corrupted payment')
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let o = 0
  const chainId = dv.getUint32(o); o += 4
  const from = getAddress(bytesToHex(buf.slice(o, o + 20))); o += 20
  const to = getAddress(bytesToHex(buf.slice(o, o + 20))); o += 20
  const value = dv.getBigUint64(o); o += 8
  const validAfter = BigInt(dv.getUint32(o)); o += 4
  const validBefore = BigInt(dv.getUint32(o)); o += 4
  const nonce = bytesToHex(buf.slice(o, o + 32)); o += 32
  const signature = bytesToHex(buf.slice(o, o + 65))
  return { chainId, from, to, value, validAfter, validBefore, nonce, signature }
}

// Accepts a bare packet, a link (https://…/#p=arcdrop:1:…) or any text containing one,
// e.g. a bitchat message.
export function extractPacket(text) {
  let t = String(text)
  try { t = decodeURIComponent(t) } catch { /* not URI-encoded */ }
  const m = t.match(/arcdrop:1:[A-Za-z0-9_-]{150,}/)
  return m ? m[0] : null
}

export function paymentLink(p, base) {
  return `${base.replace(/[#?].*$/, '')}#p=${encodePayment(p)}`
}

// Offline check: the signature really comes from `from` and the payment has not expired.
// It cannot tell whether `from` still has the funds; only Arc can.
export async function verifyPayment(p, now = Math.floor(Date.now() / 1000)) {
  const signer = await recoverTypedDataAddress({
    domain: domain(p.chainId), types: TYPES, primaryType: 'TransferWithAuthorization',
    message: { from: p.from, to: p.to, value: p.value, validAfter: p.validAfter, validBefore: p.validBefore, nonce: p.nonce },
    signature: p.signature,
  })
  if (signer !== getAddress(p.from)) return { ok: false, reason: 'bad signature' }
  if (BigInt(now) >= p.validBefore) return { ok: false, reason: 'expired' }
  if (!CHAINS[p.chainId]) return { ok: false, reason: `unknown chain ${p.chainId}` }
  return { ok: true }
}

export function publicClient(chainId, rpcUrl) {
  // Arc finalizes in well under a second; viem's default 4 s polling would hide that.
  return createPublicClient({ chain: CHAINS[chainId], transport: http(rpcUrl), pollingInterval: 150 })
}

function txArgs(p) {
  const { r, s, v, yParity } = parseSignature(p.signature)
  return [p.from, p.to, p.value, p.validAfter, p.validBefore, p.nonce, Number(v ?? 27n + BigInt(yParity)), r, s]
}

// Online status of a payment: already settled on Arc? payer still funded?
export async function checkPayment(p, { rpcUrl } = {}) {
  const client = publicClient(p.chainId, rpcUrl)
  const [used, balance] = await Promise.all([
    client.readContract({ address: USDC, abi: USDC_ABI, functionName: 'authorizationState', args: [p.from, p.nonce] }),
    client.readContract({ address: USDC, abi: USDC_ABI, functionName: 'balanceOf', args: [p.from] }),
  ])
  return { settled: used, payerBalance: balance, funded: balance >= p.value }
}

// Dry run against the real USDC contract, no gas spent.
export async function simulatePayment(p, { rpcUrl, relayer } = {}) {
  const client = publicClient(p.chainId, rpcUrl)
  await client.simulateContract({ address: USDC, abi: USDC_ABI, functionName: 'transferWithAuthorization', args: txArgs(p), account: relayer ?? p.to })
}

// Submits the payment. `relayerAccount` pays the gas (a fraction of a cent of USDC on Arc);
// it can be the recipient, the payer once back online, or any mesh peer with internet.
export async function settlePayment(p, { relayerAccount, rpcUrl }) {
  const chain = CHAINS[p.chainId]
  const wallet = createWalletClient({ account: relayerAccount, chain, transport: http(rpcUrl) })
  const client = publicClient(p.chainId, rpcUrl)
  const hash = await wallet.writeContract({ address: USDC, abi: USDC_ABI, functionName: 'transferWithAuthorization', args: txArgs(p) })
  const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 150 })
  return { hash, status: receipt.status, blockNumber: receipt.blockNumber, url: `${chain.blockExplorers.default.url}/tx/${hash}` }
}

function toB64url(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}
