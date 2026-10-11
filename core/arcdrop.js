// ArcDrop core. An offline payment is either
//   - an EIP-3009 `transferWithAuthorization` (USDC or EURC) signed by the payer: a promise
//     backed by the payer's balance, which only Arc can check; or
//   - a tab voucher (contracts/ArcDropTabs.sol): funds locked online for ONE recipient,
//     so payments to them are guaranteed up to the locked amount.
// Both need no network to create, travel by QR / AirDrop / Bluetooth, and anyone online can
// submit them. The recipient is part of every signature, so a relay cannot redirect funds.

import TABS from './tabs.json' with { type: 'json' }
import {
  createPublicClient, createWalletClient, http, defineChain, keccak256, encodeAbiParameters, encodePacked,
  hexToBytes, bytesToHex, recoverTypedDataAddress, parseSignature, getAddress, parseEventLogs, parseAbiItem,
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

// Stablecoins with EIP-3009 on Arc (both Circle FiatToken v2, 6 decimals; checked on-chain).
// The token id travels in the packet: 0 = USDC (v1 packets), 1 = EURC (v2 packets).
export const TOKENS = {
  0: { symbol: 'USDC', name: 'USDC', address: { 5042: USDC, 5042002: USDC } },
  1: { symbol: 'EURC', name: 'EURC', address: { 5042: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', 5042002: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a' } },
}
export const tokenAddress = (chainId, token = 0) => {
  const a = knownToken(token) && knownChain(chainId) ? TOKENS[token].address[chainId] : null
  if (!a) throw new Error(`unsupported token ${token} on chain ${chainId}`)
  return a
}
export const symbol = (token = 0) => TOKENS[token]?.symbol ?? '?'

export const PREFIX = 'arcdrop:1:'
export const PREFIX_V2 = 'arcdrop:2:'
export const PREFIX_V4 = 'arcdrop:4:' // tab voucher (guaranteed)

const knownChain = (chainId) => Number.isSafeInteger(chainId) && Object.hasOwn(CHAINS, chainId)
const knownToken = (token) => Number.isSafeInteger(token) && Object.hasOwn(TOKENS, token)

// ---------- tabs ----------
export const tabsAddress = (chainId) => (Object.hasOwn(TABS, String(chainId)) ? TABS[chainId] : null)
const TAB_TYPES = {
  TabVoucher: [
    { name: 'token', type: 'address' }, { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
    { name: 'epoch', type: 'uint64' }, { name: 'cumulative', type: 'uint256' },
  ],
}
const tabsDomain = (chainId) => ({ name: 'ArcDropTabs', version: '1', chainId, verifyingContract: tabsAddress(chainId) })
export const TABS_ABI = [
  { type: 'function', name: 'tabs', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
    outputs: [{ name: 'locked', type: 'uint128' }, { name: 'paid', type: 'uint128' }, { name: 'expiry', type: 'uint64' }, { name: 'epoch', type: 'uint64' }] },
  { type: 'function', name: 'payersOf', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }],
    outputs: [{ name: 'page', type: 'address[]' }, { name: 'total', type: 'uint256' }] },
  { type: 'function', name: 'fund', stateMutability: 'nonpayable', inputs: [
    { name: 'token', type: 'address' }, { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'expiry', type: 'uint256' }, { name: 'salt', type: 'bytes32' },
    { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' },
    { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'redeem', stateMutability: 'nonpayable', inputs: [
    { name: 'token', type: 'address' }, { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'cumulative', type: 'uint256' },
    { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'close', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [] },
]
// A tab voucher's identity (stands in for an EIP-3009 nonce: receipts, dedupe).
const tabNonce = (p) => keccak256(encodePacked(['address', 'uint64', 'uint256'], [p.to, BigInt(p.epoch), BigInt(p.cumulative)]))

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

export const domain = (chainId, token = 0) => ({ name: TOKENS[token].name, version: '2', chainId, verifyingContract: tokenAddress(chainId, token) })

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
export const PAYMENT_TTL = 7 * 24 * 3600

// Packet fields are fixed-width: refuse anything that would silently wrap.
const U64 = 2n ** 64n, U32 = 2 ** 32
function checkRanges({ value, validBefore, chainId }) {
  if (BigInt(value) < 0n || BigInt(value) >= U64) throw new Error('amount out of range')
  if (Number(validBefore) < 0 || Number(validBefore) >= U32) throw new Error('expiry out of range')
  if (!knownChain(chainId)) throw new Error(`unknown chain ${chainId}`)
}

export async function createPayment({ account, to, amount, chainId = ARC_MAINNET.id, token = 0, ttlSeconds = PAYMENT_TTL, now = Math.floor(Date.now() / 1000) }) {
  tokenAddress(chainId, token)
  checkRanges({ value: typeof amount === 'bigint' ? amount : parseUsdc(amount), validBefore: now + ttlSeconds, chainId })
  const message = {
    from: account.address,
    to: getAddress(to),
    value: typeof amount === 'bigint' ? amount : parseUsdc(amount),
    validAfter: 0n,
    validBefore: BigInt(now + ttlSeconds),
    nonce: randomNonce(),
  }
  const signature = await account.signTypedData({ domain: domain(chainId, token), types: TYPES, primaryType: 'TransferWithAuthorization', message })
  return { chainId, token, ...message, signature }
}

// A guaranteed payment on a tab: `cumulative` is the total owed to `to` on this tab so far
// (previous cumulative + this payment). `epoch` is the tab's epoch read when it was opened.
export async function createTabPayment({ account, to, cumulative, epoch, chainId, token = 0 }) {
  if (!tabsAddress(chainId)) throw new Error(`no tabs on chain ${chainId}`)
  checkRanges({ value: cumulative, validBefore: 0, chainId })
  if (BigInt(epoch) < 0n || BigInt(epoch) >= BigInt(U32)) throw new Error('epoch out of range')
  const message = { token: tokenAddress(chainId, token), from: account.address, to: getAddress(to), epoch: BigInt(epoch), cumulative: BigInt(cumulative) }
  const signature = await account.signTypedData({ domain: tabsDomain(chainId), types: TAB_TYPES, primaryType: 'TabVoucher', message })
  const p = { chainId, token, tab: true, from: message.from, to: message.to, epoch: Number(epoch), cumulative: message.cumulative, value: message.cumulative, validAfter: 0n, validBefore: BigInt(U32 - 1), signature }
  return { ...p, nonce: tabNonce(p) }
}

// Compact binary layout so a payment fits a small QR code and a couple of BLE fragments.
// v1 (USDC, 157 bytes): chainId u32 | from 20 | to 20 | value u64 | validAfter u32 | validBefore u32 | nonce 32 | sig 65
// v2 (158 bytes):       token u8 | the v1 layout
// v4 (tab voucher, 122 bytes): token u8 | chainId u32 | from 20 | to 20 | epoch u32 | cumulative u64 | sig 65
export function encodePayment(p) {
  checkRanges(p)
  if (p.tab) {
    const buf = new Uint8Array(122)
    const dv = new DataView(buf.buffer)
    buf[0] = p.token ?? 0
    dv.setUint32(1, p.chainId)
    buf.set(hexToBytes(p.from), 5); buf.set(hexToBytes(p.to), 25)
    dv.setUint32(45, Number(p.epoch)); dv.setBigUint64(49, BigInt(p.cumulative))
    buf.set(hexToBytes(p.signature), 57)
    return PREFIX_V4 + toB64url(buf)
  }
  const v2 = (p.token ?? 0) !== 0
  const buf = new Uint8Array(v2 ? 158 : 157)
  const dv = new DataView(buf.buffer)
  let o = 0
  if (v2) buf[o++] = p.token
  dv.setUint32(o, p.chainId); o += 4
  buf.set(hexToBytes(p.from), o); o += 20
  buf.set(hexToBytes(p.to), o); o += 20
  dv.setBigUint64(o, BigInt(p.value)); o += 8
  dv.setUint32(o, Number(p.validAfter)); o += 4
  dv.setUint32(o, Number(p.validBefore)); o += 4
  buf.set(hexToBytes(p.nonce), o); o += 32
  buf.set(hexToBytes(p.signature), o)
  return (v2 ? PREFIX_V2 : PREFIX) + toB64url(buf)
}

export function decodePayment(text) {
  const raw = extractPacket(text)
  if (!raw) throw new Error('not an ArcDrop payment')
  if (raw.startsWith(PREFIX_V4)) {
    const buf = fromB64url(raw.slice(PREFIX_V4.length))
    if (buf.length !== 122) throw new Error('corrupted payment')
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const token = buf[0]
    if (!TOKENS[token]) throw new Error('unknown token')
    const cumulative = dv.getBigUint64(49)
    const p = {
      chainId: dv.getUint32(1), token, tab: true,
      from: getAddress(bytesToHex(buf.slice(5, 25))), to: getAddress(bytesToHex(buf.slice(25, 45))),
      epoch: dv.getUint32(45), cumulative, value: cumulative, validAfter: 0n, validBefore: BigInt(U32 - 1),
      signature: canonicalSignature(buf.slice(57, 122)),
    }
    return { ...p, nonce: tabNonce(p) }
  }
  const v2 = raw.startsWith(PREFIX_V2)
  const buf = fromB64url(raw.slice(PREFIX.length))
  if (buf.length !== (v2 ? 158 : 157)) throw new Error('corrupted payment')
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let o = 0
  const token = v2 ? buf[o++] : 0
  if (!TOKENS[token]) throw new Error('unknown token')
  const chainId = dv.getUint32(o); o += 4
  const from = getAddress(bytesToHex(buf.slice(o, o + 20))); o += 20
  const to = getAddress(bytesToHex(buf.slice(o, o + 20))); o += 20
  const value = dv.getBigUint64(o); o += 8
  const validAfter = BigInt(dv.getUint32(o)); o += 4
  const validBefore = BigInt(dv.getUint32(o)); o += 4
  const nonce = bytesToHex(buf.slice(o, o + 32)); o += 32
  const signature = canonicalSignature(buf.slice(o, o + 65))
  return { chainId, token, from, to, value, validAfter, validBefore, nonce, signature }
}

// Accepts a bare packet, a link (https://…/#p=arcdrop:1:…) or any text containing one,
// e.g. a bitchat message.
export function extractPacket(text) {
  let t = String(text)
  try { t = decodeURIComponent(t) } catch { /* not URI-encoded */ }
  const m = t.match(/arcdrop:[12]:[A-Za-z0-9_-]{150,}|arcdrop:4:[A-Za-z0-9_-]{160,}/)
  return m ? m[0] : null
}

export function paymentLink(p, base) {
  return `${base.replace(/[#?].*$/, '')}#p=${encodePayment(p)}`
}

// Offline check: the signature really comes from `from` and the payment has not expired.
// It cannot tell whether `from` still has the funds; only Arc can.
export async function verifyPayment(p, now = Math.floor(Date.now() / 1000)) {
  if (!knownChain(p.chainId)) return { ok: false, reason: `unknown chain ${p.chainId}` }
  if (!knownToken(p.token ?? 0)) return { ok: false, reason: 'unknown token' }
  if (p.tab && !tabsAddress(p.chainId)) return { ok: false, reason: `no tabs on chain ${p.chainId}` }
  // A postdated payment would verify yet be unspendable until then.
  if (BigInt(p.validAfter ?? 0n) > BigInt(now)) return { ok: false, reason: 'not yet valid' }
  if (p.tab && p.from === p.to) return { ok: false, reason: 'bad signature' }
  const signer = p.tab
    ? await recoverTypedDataAddress({
      domain: tabsDomain(p.chainId), types: TAB_TYPES, primaryType: 'TabVoucher',
      message: { token: tokenAddress(p.chainId, p.token), from: p.from, to: p.to, epoch: BigInt(p.epoch), cumulative: BigInt(p.cumulative) },
      signature: p.signature,
    })
    : await recoverTypedDataAddress({
      domain: domain(p.chainId, p.token ?? 0), types: TYPES, primaryType: 'TransferWithAuthorization',
      message: { from: p.from, to: p.to, value: p.value, validAfter: p.validAfter, validBefore: p.validBefore, nonce: p.nonce },
      signature: p.signature,
    })
  if (signer !== getAddress(p.from)) return { ok: false, reason: 'bad signature' }
  if (BigInt(now) >= p.validBefore) return { ok: false, reason: 'expired' }
  return { ok: true }
}

export function publicClient(chainId, rpcUrl) {
  // Arc finalizes in well under a second; viem's default 4 s polling would hide that.
  return createPublicClient({ chain: CHAINS[chainId], transport: http(rpcUrl), pollingInterval: 150 })
}

function splitSig(signature) {
  const { r, s, v, yParity } = parseSignature(signature)
  return [Number(v ?? 27n + BigInt(yParity)), r, s]
}

// The contract call that settles a payment: USDC/EURC itself, or the tabs contract.
function settleCall(p) {
  if (p.tab) {
    return { address: tabsAddress(p.chainId), abi: TABS_ABI, functionName: 'redeem',
      args: [tokenAddress(p.chainId, p.token), p.from, p.to, BigInt(p.cumulative), ...splitSig(p.signature)] }
  }
  return { address: tokenAddress(p.chainId, p.token), abi: USDC_ABI, functionName: 'transferWithAuthorization',
    args: [p.from, p.to, p.value, p.validAfter, p.validBefore, p.nonce, ...splitSig(p.signature)] }
}

export async function tabState(chainId, token, from, to, rpcUrl) {
  const [locked, paid, expiry, epoch] = await publicClient(chainId, rpcUrl).readContract({
    address: tabsAddress(chainId), abi: TABS_ABI, functionName: 'tabs', args: [tokenAddress(chainId, token), from, to],
  })
  return { locked, paid, expiry: Number(expiry), epoch: Number(epoch) }
}

// Online status of a payment: already settled on Arc? payer still funded?
// For a tab voucher, "settled" means the tab has paid out at least what this voucher covers,
// which can only ever have gone to `to`.
export async function checkPayment(p, { rpcUrl } = {}) {
  if (p.tab) {
    const t = await tabState(p.chainId, p.token, p.from, p.to, rpcUrl)
    const covered = BigInt(p.cumulative) < t.locked ? BigInt(p.cumulative) : t.locked
    const live = t.epoch === Number(p.epoch) && t.expiry > Math.floor(Date.now() / 1000)
    return { settled: t.epoch === Number(p.epoch) && t.paid >= covered && covered > 0n, payerBalance: t.locked - t.paid, funded: live && covered > t.paid, tab: t }
  }
  const client = publicClient(p.chainId, rpcUrl)
  const token = tokenAddress(p.chainId, p.token)
  const [used, balance] = await Promise.all([
    client.readContract({ address: token, abi: USDC_ABI, functionName: 'authorizationState', args: [p.from, p.nonce] }),
    client.readContract({ address: token, abi: USDC_ABI, functionName: 'balanceOf', args: [p.from] }),
  ])
  return { settled: used, payerBalance: balance, funded: balance >= p.value }
}

// Dry run against the real USDC contract, no gas spent.
export async function simulatePayment(p, { rpcUrl, relayer } = {}) {
  const client = publicClient(p.chainId, rpcUrl)
  await client.simulateContract({ ...settleCall(p), account: relayer ?? p.to })
}

// Submits the payment. `relayerAccount` pays the gas (a fraction of a cent of USDC on Arc);
// it can be the recipient, the payer once back online, or any mesh peer with internet.
export async function settlePayment(p, { relayerAccount, rpcUrl }) {
  const chain = CHAINS[p.chainId]
  const wallet = createWalletClient({ account: relayerAccount, chain, transport: http(rpcUrl) })
  const client = publicClient(p.chainId, rpcUrl)
  const hash = await wallet.writeContract(settleCall(p))
  const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 150 })
  return { hash, status: receipt.status, blockNumber: receipt.blockNumber, url: `${chain.blockExplorers.default.url}/tx/${hash}` }
}

// ---------- proof of payment ----------
// "The nonce is used" is NOT proof of payment: a payer can burn their own nonce (cancel it,
// or reuse it in a payment to themselves) after handing you the packet. A payment counts as
// paid only if a successful transaction moved exactly `value` of the token from `from` to
// `to` under this nonce.
const EV_AUTH_USED = parseAbiItem('event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)')
const EV_TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const EV_TAB_REDEEMED = parseAbiItem('event TabRedeemed(address indexed token, address indexed from, address indexed to, uint256 amount, uint256 cumulative)')
const LOG_WINDOW = 9_999n // Arc RPC limit per eth_getLogs

function receiptPays(receipt, p) {
  if (receipt.status !== 'success') return false
  const token = tokenAddress(p.chainId, p.token).toLowerCase()
  if (p.tab) {
    const tabs = tabsAddress(p.chainId).toLowerCase()
    return parseEventLogs({ abi: [EV_TAB_REDEEMED], logs: receipt.logs.filter((l) => l.address.toLowerCase() === tabs) })
      .some((e) => e.args.token.toLowerCase() === token && getAddress(e.args.from) === p.from && getAddress(e.args.to) === p.to)
  }
  const tokenLogs = receipt.logs.filter((l) => l.address.toLowerCase() === token)
  const used = parseEventLogs({ abi: [EV_AUTH_USED], logs: tokenLogs }).some((e) => getAddress(e.args.authorizer) === p.from && e.args.nonce === p.nonce)
  const moved = parseEventLogs({ abi: [EV_TRANSFER], logs: tokenLogs }).some((e) => getAddress(e.args.from) === p.from && getAddress(e.args.to) === p.to && e.args.value === p.value)
  return used && moved
}

// { paid: true, tx } | { paid: false, reason }. `txHash` (from our own settlement) is checked
// first; otherwise the recent history is searched (`maxBlocks`, ~0.5 s per block on Arc).
export async function confirmSettlement(p, { txHash, maxBlocks = 40_000n, rpcUrl } = {}) {
  const client = publicClient(p.chainId, rpcUrl)
  const explorer = (hash) => `${CHAINS[p.chainId].blockExplorers.default.url}/tx/${hash}`
  if (p.tab) {
    // Tab payouts can only reach `to`: the on-chain tab state is the proof.
    const { settled } = await checkPayment(p, { rpcUrl })
    if (!settled) return { paid: false, reason: 'tab has not paid this voucher' }
    if (txHash && /^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      const r = await client.getTransactionReceipt({ hash: txHash }).catch(() => null)
      if (r && receiptPays(r, p)) return { paid: true, tx: explorer(txHash) }
    }
    return { paid: true }
  }
  if (txHash && /^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    const r = await client.getTransactionReceipt({ hash: txHash }).catch(() => null)
    if (r && receiptPays(r, p)) return { paid: true, tx: explorer(txHash) }
  }
  const head = await client.getBlockNumber()
  for (let to = head, scanned = 0n; scanned < maxBlocks && to > 0n; scanned += LOG_WINDOW + 1n, to -= LOG_WINDOW + 1n) {
    const from = to > LOG_WINDOW ? to - LOG_WINDOW : 0n
    const logs = await client.getLogs({ address: tokenAddress(p.chainId, p.token), event: EV_AUTH_USED, args: { authorizer: p.from, nonce: p.nonce }, fromBlock: from, toBlock: to })
    for (const log of logs) {
      const r = await client.getTransactionReceipt({ hash: log.transactionHash })
      if (receiptPays(r, p)) return { paid: true, tx: explorer(log.transactionHash) }
      return { paid: false, reason: 'nonce used by another transaction' }
    }
  }
  return { paid: false, reason: 'no matching payment found' }
}

// ---------- opening / topping up a tab ----------
// The payer signs an EIP-3009 ReceiveWithAuthorization to the tabs contract whose nonce
// commits to the recipient and expiry; anyone online submits it (the gateway pays gas).
const RECEIVE_TYPES = { ReceiveWithAuthorization: TYPES.TransferWithAuthorization }
const FUND_TYPEHASH = keccak256(new TextEncoder().encode('TabFunding(address to,uint256 expiry,bytes32 salt)'))

export async function createTabFunding({ account, to, amount, days = 7, chainId, token = 0, now = Math.floor(Date.now() / 1000) }) {
  if (!tabsAddress(chainId)) throw new Error(`no tabs on chain ${chainId}`)
  const recipient = getAddress(to)
  if (recipient === account.address) throw new Error('cannot open a tab to yourself')
  const expiry = BigInt(now + Math.round(days * 86_400))
  const salt = randomNonce()
  const nonce = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }], [FUND_TYPEHASH, recipient, expiry, salt]))
  const message = {
    from: account.address, to: tabsAddress(chainId), value: typeof amount === 'bigint' ? amount : parseUsdc(amount),
    validAfter: 0n, validBefore: BigInt(now + 3600), nonce,
  }
  const signature = await account.signTypedData({ domain: domain(chainId, token), types: RECEIVE_TYPES, primaryType: 'ReceiveWithAuthorization', message })
  return { chainId, token, from: account.address, recipient, expiry, salt, value: message.value, validAfter: 0n, validBefore: message.validBefore, signature }
}

export const fundCall = (f) => ({
  address: tabsAddress(f.chainId), abi: TABS_ABI, functionName: 'fund',
  args: [tokenAddress(f.chainId, f.token), f.from, f.recipient, BigInt(f.expiry), f.salt, BigInt(f.value), BigInt(f.validAfter), BigInt(f.validBefore), ...splitSig(f.signature)],
})

// Payers who funded tabs for `to` (most recent first), with their tab state.
export async function tabsTo(chainId, token, to, { limit = 50 } = {}) {
  if (!tabsAddress(chainId)) return []
  const client = publicClient(chainId)
  const [, total] = await client.readContract({ address: tabsAddress(chainId), abi: TABS_ABI, functionName: 'payersOf', args: [tokenAddress(chainId, token), to, 0n, 0n] })
  const start = total > BigInt(limit) ? total - BigInt(limit) : 0n
  const [page] = await client.readContract({ address: tabsAddress(chainId), abi: TABS_ABI, functionName: 'payersOf', args: [tokenAddress(chainId, token), to, start, BigInt(limit)] })
  const states = await Promise.all(page.map((from) => tabState(chainId, token, from, to)))
  return page.map((from, i) => ({ from: getAddress(from), ...states[i] })).reverse()
}

// When the payer signed it (validBefore is always signing time + PAYMENT_TTL).
export const signedAt = (p) => Number(p.validBefore) - PAYMENT_TTL

// ---------- receipts ----------
// The recipient proves, offline, that the payment reached them. They sign an EIP-712
// Receipt binding the whole payment (never a raw hash chosen by someone else, which
// would turn the auto-receipt into a signing oracle). Travels back over the mesh as
// arcdrop-ack:2:<nonce 32 | signature 65>; the payer rebuilds the Receipt from the
// payment they sent.
export const ACK_PREFIX = 'arcdrop-ack:2:'
const RECEIPT_TYPES = {
  Receipt: [
    { name: 'token', type: 'address' }, { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }, { name: 'tab', type: 'bool' },
  ],
}
const receiptTyped = (p) => ({
  domain: { name: 'ArcDrop Receipt', version: '1', chainId: p.chainId },
  types: RECEIPT_TYPES, primaryType: 'Receipt',
  message: { token: tokenAddress(p.chainId, p.token), from: p.from, to: p.to, value: p.value, nonce: p.nonce, tab: !!p.tab },
})

export async function createAck(account, p) {
  const signature = await account.signTypedData(receiptTyped(p))
  return ACK_PREFIX + toB64url(new Uint8Array([...hexToBytes(p.nonce), ...hexToBytes(signature)]))
}

// Which payment a receipt is about (to find it among sent payments). Throws on garbage.
export function ackNonce(text) {
  const m = String(text).match(/arcdrop-ack:2:([A-Za-z0-9_-]{120,})/)
  if (!m) throw new Error('not an ArcDrop receipt')
  const buf = fromB64url(m[1])
  if (buf.length !== 97) throw new Error('corrupted receipt')
  return { nonce: bytesToHex(buf.slice(0, 32)), signature: canonicalSignature(buf.slice(32)) }
}

// True only if the payment's recipient signed this exact payment.
export async function verifyAck(text, p) {
  try {
    const { nonce, signature } = ackNonce(text)
    if (nonce !== p.nonce) return false
    return (await recoverTypedDataAddress({ ...receiptTyped(p), signature })) === getAddress(p.to)
  } catch { return false }
}

// ---------- payment requests ----------
// The receiver sets the amount (merchant, split bill): arcdrop-req:1:<chainId u32 | token u8 | to 20 | value u64 | label utf8>
export const REQ_PREFIX = 'arcdrop-req:1:'

// Labels are shown to the payer: no control or bidi-override characters, at most 40 bytes,
// never cut in the middle of a character.
function cleanLabel(label) {
  let out = ''
  for (const ch of String(label).replace(/[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, '').trim()) {
    if (new TextEncoder().encode(out + ch).length > 40) break
    out += ch
  }
  return out
}

export function encodeRequest({ chainId, token = 0, to, value, label = '' }) {
  checkRanges({ value, validBefore: 0, chainId })
  if (!knownToken(token)) throw new Error('unknown token')
  const text = new TextEncoder().encode(cleanLabel(label))
  const buf = new Uint8Array(33 + text.length)
  const dv = new DataView(buf.buffer)
  dv.setUint32(0, chainId); buf[4] = token
  buf.set(hexToBytes(getAddress(to)), 5)
  dv.setBigUint64(25, BigInt(value))
  buf.set(text, 33)
  return REQ_PREFIX + toB64url(buf)
}

export function decodeRequest(text) {
  const m = String(text).match(/arcdrop-req:1:([A-Za-z0-9_-]{44,})/)
  if (!m) return null
  let buf
  try { buf = fromB64url(m[1]) } catch { return null }
  if (buf.length < 33 || buf.length > 73) return null
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const chainId = dv.getUint32(0), token = buf[4]
  if (!knownChain(chainId) || !knownToken(token)) return null
  return {
    chainId, token, to: getAddress(bytesToHex(buf.slice(5, 25))),
    value: dv.getBigUint64(25), label: cleanLabel(new TextDecoder().decode(buf.slice(33))),
  }
}

// One payment, one encoding: the contracts reject high-s signatures and v outside {27, 28},
// so such packets would look valid offline yet never settle. Reject them up front.
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n
function canonicalSignature(sig) {
  const s = BigInt(bytesToHex(sig.slice(32, 64)))
  if (sig[64] !== 27 && sig[64] !== 28) throw new Error('non-canonical signature')
  if (s === 0n || s > HALF_N) throw new Error('non-canonical signature')
  return bytesToHex(sig)
}

function toB64url(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Strict: the text must be exactly the canonical encoding of its bytes (no stray padding bits),
// so the same payment can never travel under two different strings.
function fromB64url(str) {
  let s
  try { s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4)) } catch { throw new Error('bad encoding') }
  const bytes = Uint8Array.from(s, (c) => c.charCodeAt(0))
  if (toB64url(bytes) !== str) throw new Error('non-canonical encoding')
  return bytes
}
