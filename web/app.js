import QRCode from 'qrcode'
import jsQR from 'jsqr'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { isAddress, getAddress, createWalletClient, http } from 'viem'
import {
  createPayment, encodePayment, decodePayment, verifyPayment, paymentLink, extractPacket,
  checkPayment, settlePayment, simulatePayment, publicClient, formatUsdc, parseUsdc, CHAINS, USDC_ABI, PAYMENT_TTL,
  tokenAddress, symbol, createAck, ackNonce, verifyAck, encodeRequest, decodeRequest,
  tabsAddress, tabState, tabsTo, createTabFunding, createTabPayment, TABS_ABI, confirmSettlement,
} from '../core/arcdrop.js'

const $ = (id) => document.getElementById(id)
const store = {
  get(k, d) { try { const v = localStorage.getItem('arcdrop.' + k); return v == null ? d : JSON.parse(v) } catch { return d } },
  set(k, v) { try { localStorage.setItem('arcdrop.' + k, JSON.stringify(v)); return true } catch { return false } },
}
// Payments, tabs, balances and contacts belong to one wallet: importing another key must
// never reuse them (spending cap, tab running totals, …). `acct` scopes them by address.
const SHAPES = { sent: [], inbox: [], tabs: {}, tabsIn: {}, tabRx: {}, balances: {}, contacts: {} }
const acct = {
  get(k, d) {
    const v = store.get(`${account.address}:${k}`, d)
    const want = SHAPES[k] ?? d
    // Corrupted storage must not take the app down.
    return Array.isArray(want) ? (Array.isArray(v) ? v : d) : (v && typeof v === 'object' && !Array.isArray(v) ? v : d)
  },
  set(k, v) { return store.set(`${account.address}:${k}`, v) },
}

// Inside the iOS app, the native side injects this handler (Bluetooth mesh, share sheet, Keychain).
// iOS: webkit.messageHandlers.arcmesh. Android: ArcMeshAndroid (a WebMessageListener that
// only exists on the app's own bundled origin) takes JSON strings.
const mesh = globalThis.webkit?.messageHandlers?.arcmesh
  ?? (globalThis.ArcMeshAndroid ? { postMessage: (m) => globalThis.ArcMeshAndroid.postMessage(JSON.stringify(m)) } : null)

// ---------- wallet & settings ----------
// In the iOS app the key also lives in the Keychain (injected before this script runs),
// so it survives even if the web view's storage is cleared.
// The Keychain copy wins. A web-storage copy is kept until the native side confirms it has
// saved the key, and the native side never overwrites an existing key unless asked to import.
const webKey = store.get('key')
let key = globalThis.ARCDROP_NATIVE_KEY || webKey
if (!key) key = generatePrivateKey()
// The native store answered with another key (e.g. its read failed once and a wallet was made
// meanwhile): keep that one aside rather than overwrite it.
if (globalThis.ARCDROP_NATIVE_KEY && webKey && webKey !== key) store.set('key.previous', webKey)
store.set('key', key)
if (mesh && !globalThis.ARCDROP_NATIVE_KEY) mesh.postMessage({ type: 'saveKey', key, replace: false })
globalThis.arcdropKeySaved = (ok) => { if (ok) try { localStorage.removeItem('arcdrop.key') } catch {} }
if (mesh && globalThis.ARCDROP_NATIVE_KEY) try { localStorage.removeItem('arcdrop.key') } catch {}
let account = privateKeyToAccount(key)
// One-time migration: data saved before it was scoped per wallet belongs to this wallet.
for (const k of Object.keys(SHAPES)) {
  try {
    const old = localStorage.getItem('arcdrop.' + k)
    if (old != null && localStorage.getItem(`arcdrop.${account.address}:${k}`) == null) localStorage.setItem(`arcdrop.${account.address}:${k}`, old)
    if (old != null) localStorage.removeItem('arcdrop.' + k)
  } catch { /* storage unavailable */ }
}

// Default network is set at build time (ARCDROP_CHAIN=mainnet|testnet); `?net=` overrides it.
const NETS = { mainnet: 5042, testnet: 5042002 }
const netParam = new URLSearchParams(location.search).get('net')
// `?net=` only applies to this visit (never saved), so a crafted link can't switch the network
// you receive on. Anything unexpected falls back to the build default.
const urlNet = Object.hasOwn(NETS, netParam ?? '') ? NETS[netParam] : null
const savedNet = store.get('chain', null)
let chainId = urlNet ?? (Object.values(NETS).includes(savedNet) ? savedNet : (NETS[ARCDROP_CHAIN] ?? 5042002))
let token = store.get('token', 0) // 0 = USDC, 1 = EURC

// Inside the iOS app the page is a local file: talk to (and link to) the public deployment.
const PUBLIC_ORIGIN = 'https://arcdrop-pink.vercel.app'
// The Android app serves its bundled copy from https://appassets.androidplatform.net (local).
const BUNDLED = location.protocol === 'file:' || location.hostname === 'appassets.androidplatform.net'
const webOrigin = BUNDLED ? PUBLIC_ORIGIN : location.origin
const gateway = () => (store.get('gateway', '') || webOrigin).replace(/\/$/, '')

// Stored entries may be corrupted or from an older format: skip them instead of breaking the app.
const tryDecode = (packet) => { try { return decodePayment(packet) } catch { return null } }
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`
// Cents, rounded down so we never overstate.
const fmt = (v) => formatUsdc(v - (v % 10_000n))
const money = (v, t, c = chainId) => `${fmt(v)} ${symbol(t)}${c === 5042 ? '' : ' (test)'}`
// Payments saved by the French version of the app carry French transport names.
const viaLabel = (v) => ({ lien: 'link', 'lien externe': 'external link', 'copier-coller': 'paste', 'QR code': 'QR code' })[v] ?? v ?? '—'
const time = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
const MIN_VALUE = 10_000n // 0.01
// A payment's identity, independent of how it was encoded or carried.
const payId = (p) => `${p.chainId}:${p.token ?? 0}:${p.tab ? 't' : 'a'}:${p.from}:${p.nonce}`
// The amount a payment actually moves: a tab voucher carries a running total.
const amountOf = (item, p) => (item?.amount != null ? BigInt(item.amount) : p.value)
// Explorer links are built here from a validated hash, never taken from a server response.
const txUrl = (hash, c = chainId) => (/^0x[0-9a-fA-F]{64}$/.test(hash ?? '') ? `${CHAINS[c].blockExplorers.default.url}/tx/${hash}` : null)
const hashOf = (url) => (String(url ?? '').match(/0x[0-9a-fA-F]{64}$/) ?? [])[0]
// Bluetooth names are attacker-controlled: no control, zero-width or bidi characters.
const cleanName = (n) => [...String(n ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u034F\u115F\u1160\u3164\uFFA0]/gu, '').trim()].slice(0, 24).join('')
// For impostor checks: case, accents and look-alike letters folded.
const CONFUSABLE = {
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', х: 'x', у: 'y', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ӏ: 'l', ү: 'y', һ: 'h', ԛ: 'q', ԝ: 'w',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ϲ: 'c', ϳ: 'j',
  Ꭺ: 'a', Ᏼ: 'b', Ꮯ: 'c', Ꭰ: 'd', Ꭼ: 'e', Ꮐ: 'g', Ꮋ: 'h', Ꭻ: 'j', Ꮶ: 'k', Ꮮ: 'l', Ꮇ: 'm', Ꮲ: 'p', Ꮪ: 's', Ꭲ: 't', Ꮩ: 'v', Ꮃ: 'w', Ꮓ: 'z',
  '0': 'o', '1': 'l', '|': 'l', 'ı': 'i', 'ɡ': 'g', 'ɑ': 'a',
}
const fold = (n) => cleanName(n).replace(/./gu, (c) => CONFUSABLE[c] ?? c).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/./gu, (c) => CONFUSABLE[c] ?? c)
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// Contacts = people you actually paid (name as seen when you paid them). Names merely
// heard over Bluetooth are kept in memory only and shown with the address next to them.
let contacts = acct.get('contacts', {})
const heard = new Map()
// In money contexts only names you confirmed (people you paid) are shown; strangers stay an address.
const nameOf = (addr) => contacts[getAddress(addr)] || short(addr)
const nearbyName = (addr) => contacts[getAddress(addr)] || heard.get(getAddress(addr)) || short(addr)
const myName = () => store.get('name', '')

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show')
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600)
}

function haptic(kind) {
  if (mesh) mesh.postMessage({ type: 'haptic', kind }) // real Taptic Engine in the iOS app
  else navigator.vibrate?.(kind === 'success' ? [20, 60, 30] : 30)
}

// Renders are async: when several overlap (typing fast), only the latest one is shown.
async function qrInto(el, text) {
  el.dataset.qr = text
  const src = await QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 1, width: 640 })
  if (el.dataset.qr !== text) return
  const img = new Image()
  img.alt = 'QR code'
  img.src = src
  el.replaceChildren(img)
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true } catch {
    const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch {}
    t.remove()
    return ok
  }
}

// Presence over Bluetooth reveals your address and name to anyone nearby: only while the
// Pay screen is open (that's when "Nearby" is useful), never in the background.
let currentTab = 'pay'
function announce() {
  if (!mesh) return
  if (currentTab === 'pay' && document.visibilityState === 'visible') mesh.postMessage({ type: 'profile', address: account.address, name: myName() })
  else mesh.postMessage({ type: 'presence', on: false })
}
document.addEventListener('visibilitychange', () => announce())

function renderWallet() {
  $('myAddr').textContent = account.address
  $('myAddr2').textContent = account.address
  $('chainLabel').textContent = chainId === 5042 ? '' : 'TESTNET'
  $('chainLabel').hidden = chainId === 5042
  $('chainSel').value = String(chainId)
  $('gateway').value = store.get('gateway', '')
  $('myName').value = myName()
  $('unitLabel').textContent = symbol(token)
  qrInto($('myQr'), account.address)
  renderBalances()
}

// ---------- balances & offline spending cap ----------
const balanceKey = (t) => `${chainId}:${t}`

function lastBalance(t) {
  const b = acct.get('balances', {})[balanceKey(t)]
  return b ? BigInt(b) : null
}

async function refreshBalance() {
  if (!online) return
  const c = chainId, who = account.address // the user may switch network/wallet while we wait
  const client = publicClient(c)
  const fresh = {}
  for (const t of [0, 1]) {
    try {
      fresh[`${c}:${t}`] = (await client.readContract({ address: tokenAddress(c, t), abi: USDC_ABI, functionName: 'balanceOf', args: [who] })).toString()
    } catch { /* offline or RPC hiccup; keep last value */ }
  }
  if (who !== account.address) return
  acct.set('balances', { ...acct.get('balances', {}), ...fresh })
  renderBalances()
  refreshTabs()
}

function renderBalances() {
  const main = lastBalance(token), other = lastBalance(1 - token)
  $('balance').textContent = main == null ? '—' : money(main, token)
  $('balance2').hidden = !other
  $('balance2').textContent = other ? `and ${money(other, 1 - token)}` : ''
  // The key exists only on this device: once there's money on it, ask once for a backup.
  $('backupNag').hidden = !(BigInt(main ?? 0) > 0n || BigInt(other ?? 0) > 0n) || store.get(`${account.address}:backedUp`, false) === true
  renderTabs()
  renderAvail()
}

// Never promise more than the last balance seen on Arc, minus payments still pending.
// Plain payments draw on the wallet; tab payments on their tab. null = never seen online.
function availableOffline(t = token) {
  const last = lastBalance(t)
  if (last == null) return null
  const now = BigInt(Math.floor(Date.now() / 1000))
  const promised = acct.get('sent', []).filter((s) => s.status === 'pending')
    .map((s) => tryDecode(s.packet)).filter((q) => q?.chainId === chainId && (q.token ?? 0) === t && !q.tab && q.validBefore > now)
    .reduce((sum, q) => sum + q.value, 0n)
  const left = last - promised
  return left > 0n ? left : 0n
}

function renderAvail() {
  const a = availableOffline()
  const to = $('payTo').value.trim()
  const tab = isAddress(to) ? usableTab(getAddress(to)) : null
  $('avail').textContent = a == null ? '' : `Available: ${money(a, token)}${tab ? ` · 🔒 tab: ${money(tab.left, token)} guaranteed` : ''}`
}

// ---------- tabs ("ardoises"): guaranteed offline payments to one person ----------
// Payer side: tabs I opened, with the running total I have signed so far (never decreases).
// Receiver side: tabs opened for me, seen while online, so offline payments can be shown as guaranteed.
const tabKey = (t, who, c = chainId) => `${c}:${t}:${getAddress(who)}`
const myTabs = () => acct.get('tabs', {})
const tabsForMe = () => acct.get('tabsIn', {})
// A tab is only used (payer) or trusted (receiver) if it stays open at least this long, so a
// receiver who stays offline for a day still has time to cash in before it can be closed.
const MARGIN = 24 * 3600

function usableTab(to, t = token) {
  const tab = myTabs()[tabKey(t, to)]
  if (!tab || tab.chainId !== chainId || tab.expiry <= Date.now() / 1000 + MARGIN) return null
  const left = BigInt(tab.locked) - BigInt(tab.cumulative)
  return left > 0n ? { ...tab, left } : null
}

async function refreshTabs() {
  if (!online || !tabsAddress(chainId)) return renderTabs()
  const c = chainId, who = account.address
  try {
    const states = {}
    for (const [k, tab] of Object.entries(myTabs())) {
      if (k.startsWith(`${c}:`)) states[k] = await tabState(c, tab.token, who, tab.to)
    }
    if (who !== account.address) return
    // Merge into the CURRENT list: a payment may have been signed during the calls above,
    // and its running total must never go backwards.
    const mine = myTabs()
    for (const [k, st] of Object.entries(states)) {
      const tab = mine[k]
      if (!tab) continue
      if (st.expiry === 0 && st.locked === 0n && st.epoch !== tab.epoch) { delete mine[k]; continue } // closed
      // A new epoch means the tab was closed and reopened: start a new running total.
      const cumulative = st.epoch === tab.epoch ? (BigInt(tab.cumulative) > st.paid ? BigInt(tab.cumulative) : st.paid) : st.paid
      mine[k] = { ...tab, locked: st.locked.toString(), paid: st.paid.toString(), expiry: st.expiry, epoch: st.epoch, cumulative: cumulative.toString() }
    }
    acct.set('tabs', mine)
    const incoming = {}
    for (const t of [0, 1]) {
      for (const tab of await tabsTo(c, t, who, { limit: 500 })) {
        if (tab.expiry > Date.now() / 1000) {
          incoming[tabKey(t, tab.from, c)] = { chainId: c, from: tab.from, token: t, locked: tab.locked.toString(), paid: tab.paid.toString(), expiry: tab.expiry, epoch: tab.epoch }
        }
      }
    }
    if (who !== account.address) return
    // keep other networks' entries, replace this network's
    const keep = Object.fromEntries(Object.entries(acct.get('tabsIn', {})).filter(([k]) => !k.startsWith(`${c}:`)))
    acct.set('tabsIn', { ...keep, ...incoming })
  } catch { /* keep the last known state */ }
  renderTabs()
}

const day = (sec) => new Date(sec * 1000).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })

function renderTabs() {
  const has = !!tabsAddress(chainId)
  $('tabOpen').hidden = !has
  const now = Date.now() / 1000
  const rows = []
  for (const tab of Object.values(myTabs())) {
    if (tab.chainId !== chainId) continue
    const left = BigInt(tab.locked) - BigInt(tab.cumulative)
    const expired = tab.expiry <= now
    rows.push(`<button class="cell tx" data-tab-close="${tab.to}" data-tab-token="${tab.token}" ${expired ? '' : 'disabled'}>
      <span class="tx-ic out">🔒</span><span class="cell-main"><div>For ${esc(nameOf(tab.to))}</div>
      <div class="cell-sub">${expired ? 'expired · tap to reclaim the rest' : `until ${day(tab.expiry)}`}</div></span>
      <span class="tx-end"><div class="tx-amt">${money(left > 0n ? left : 0n, tab.token)}</div><div class="tx-state">of ${money(BigInt(tab.locked), tab.token)}</div></span></button>`)
  }
  for (const tab of Object.values(tabsForMe())) {
    if (tab.chainId !== chainId || tab.expiry <= now || BigInt(tab.locked) <= BigInt(tab.paid)) continue
    rows.push(`<div class="cell tx"><span class="tx-ic in">🔒</span><span class="cell-main"><div>From ${esc(nameOf(tab.from))}</div>
      <div class="cell-sub">guaranteed for you until ${day(tab.expiry)}</div></span>
      <span class="tx-end"><div class="tx-amt in">${money(BigInt(tab.locked) - BigInt(tab.paid), tab.token)}</div><div class="tx-state">locked</div></span></div>`)
  }
  $('tabsList').innerHTML = rows.join('') || '<div class="empty">No tabs</div>'
}

function askAmount(question) {
  const raw = prompt(question)
  if (!raw) return null
  try { const v = parseUsdc(raw.replace(',', '.').trim()); return v >= 100_000n ? v : null } catch { return null }
}

$('tabOpen').onclick = async () => {
  if (!online) return toast('You need a connection to open a tab')
  let to = $('payTo').value.trim()
  if (!isAddress(to)) to = (prompt('Their 0x… address (or pick them in Pay first)') ?? '').trim()
  if (!isAddress(to)) return toast('Invalid address')
  to = getAddress(to)
  if (to === account.address) return toast("You can't open a tab with yourself")
  const value = askAmount(`How much ${symbol(token)} to lock for ${nameOf(to)} for 7 days? (min 0.1)`)
  if (value == null) return toast('Invalid amount (minimum 0.1)')
  if (value > (availableOffline() ?? 0n)) return toast('Insufficient balance (including pending payments)')
  const c = chainId, t = token
  let before
  try { before = await tabState(c, t, account.address, to) } catch { return toast('Can’t reach Arc, try again') }
  try {
    const f = await createTabFunding({ account, to, amount: value, days: 7, chainId: c, token: t })
    const r = await fetch(`${gateway()}/api/fund`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tab: f }, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) })
    let out = {}
    try { out = await r.json() } catch { /* ambiguous: check the chain below */ }
    // Whatever the gateway said, the chain decides: did our lock land?
    const st = await tabState(c, t, account.address, to)
    if (!(st.locked > before.locked || (st.epoch === before.epoch && st.expiry > before.expiry))) throw new Error(out.error ?? 'refused')
    const mine = myTabs()
    const prev = mine[tabKey(t, to, c)]
    mine[tabKey(t, to, c)] = { chainId: c, token: t, to, epoch: st.epoch, locked: st.locked.toString(), paid: st.paid.toString(), expiry: st.expiry,
      cumulative: (prev && prev.epoch === st.epoch && BigInt(prev.cumulative) > st.paid ? BigInt(prev.cumulative) : st.paid).toString() }
    acct.set('tabs', mine)
    if (heard.get(to) && !contacts[to]) { contacts[to] = heard.get(to); acct.set('contacts', contacts) }
    toast(`🔒 Tab: ${money(value, t)} guaranteed for ${nameOf(to)}`); haptic('success')
    refreshBalance()
  } catch (e) { toast(`Couldn’t open tab: ${e.message}`.slice(0, 90)) }
}

$('tabsList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-tab-close]')
  if (!b || b.disabled) return
  if (!online) return toast('You need a connection')
  try {
    const wallet = createWalletClient({ account, chain: CHAINS[chainId], transport: http() })
    const hash = await wallet.writeContract({ address: tabsAddress(chainId), abi: TABS_ABI, functionName: 'close', args: [tokenAddress(chainId, Number(b.dataset.tabToken)), b.dataset.tabClose] })
    await publicClient(chainId).waitForTransactionReceipt({ hash })
    toast('Tab balance reclaimed'); refreshBalance()
  } catch (err) { toast(`Failed: ${err.shortMessage ?? err.message}`.slice(0, 90)) }
})

function setToken(t) {
  token = t
  store.set('token', t)
  $('unitLabel').textContent = symbol(t)
  renderBalances()
}
$('unitBtn').onclick = () => { setToken(1 - token); haptic('light') }

// ---------- connectivity ----------
let online = false
async function probe() {
  let ok = navigator.onLine
  if (ok) {
    try {
      const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 3000)
      const r = await fetch(CHAINS[chainId].rpcUrls.default.http[0], {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      })
      ok = r.ok
    } catch { ok = false }
  }
  if (ok !== online) {
    online = ok
    $('netDot').classList.toggle('on', ok)
    $('netLabel').textContent = ok ? 'online' : 'offline'
    if (ok) { refreshBalance(); settleAll() }
  }
}
addEventListener('online', probe); addEventListener('offline', probe)
setInterval(probe, 5000)

// ---------- nearby (Bluetooth presence) ----------
let nearby = []
const distance = (rssi) => rssi == null ? 'in range' : rssi > -60 ? 'very close' : rssi > -75 ? 'close' : 'farther'

// A name already used by a contact with another address: someone may be impersonating them.
const impostor = (p) => !!p.name && (Object.entries(contacts).some(([a, n]) => fold(n) === fold(p.name) && a !== p.address)
  || nearby.some((o) => o.address !== p.address && o.name && fold(o.name) === fold(p.name)))

function renderNearby() {
  $('nearbyBox').hidden = !nearby.length
  const selected = isAddress($('payTo').value.trim()) ? getAddress($('payTo').value.trim()) : null
  $('nearby').innerHTML = nearby.map((p) => {
    const known = !!contacts[p.address]
    const label = p.name || short(p.address)
    return `<button class="peer" data-peer="${p.address}" aria-pressed="${selected === p.address}">
      <span class="av" aria-hidden="true">${esc(label.charAt(0).toUpperCase() || '?')}</span>
      <span class="nm">${impostor(p) ? '⚠︎ ' : known ? '✓ ' : ''}${esc(label)}</span>
      <span class="ds">…${p.address.slice(-4)} · ${distance(p.rssi)}</span></button>`
  }).join('')
}

$('nearby').addEventListener('click', (e) => {
  const b = e.target.closest('[data-peer]')
  if (!b) return
  $('payTo').value = b.dataset.peer
  pendingRequest = null
  renderWho(); renderNearby(); renderAvail(); haptic('light')
})

// Called by the iOS app: the devices currently around, with their signal strength.
globalThis.arcdropNearby = (list) => {
  nearby = (Array.isArray(list) ? list : []).slice(0, 30)
    .filter((p) => typeof p?.address === 'string' && isAddress(p.address, { strict: false }))
    .map((p) => ({ address: getAddress(p.address), name: cleanName(p.name), rssi: Number.isFinite(p.rssi) ? p.rssi : null }))
    .filter((p) => p.address !== account.address)
  if (heard.size > 200) heard.clear()
  for (const p of nearby) if (p.name) heard.set(p.address, p.name)
  renderNearby(); renderWho()
}

globalThis.arcdropMeshPeers = (n) => {
  $('meshPeers').hidden = false
  $('meshPeers').textContent = n ? `${n} nearby` : 'no one nearby'
}

// ---------- pay ----------
let lastPayment = null
let pendingRequest = null // a scanned payment request prefills amount, currency and recipient

function renderWho() {
  const to = $('payTo').value.trim()
  const known = isAddress(to)
  const near = known && nearby.some((p) => p.address === getAddress(to))
  const parts = []
  if (known) {
    const a = getAddress(to)
    const n = nearby.find((x) => x.address === a)
    parts.push(`To <b>${esc(nearbyName(a))}</b> · …${a.slice(-4)}${contacts[a] ? ' · paid before' : n && impostor(n) ? ' · ⚠︎ name already used by a contact' : ''}${near ? ' · nearby' : ''}`)
  }
  if (pendingRequest?.label) parts.push(`for “${esc(pendingRequest.label)}”`)
  $('payWho').hidden = !parts.length
  $('payWho').innerHTML = parts.join(' ')
}
$('payTo').addEventListener('input', () => { pendingRequest = null; renderWho(); renderNearby(); renderAvail() })

function shake() {
  const box = $('amountBox')
  box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake')
  haptic('error')
}

// The amount field is as wide as its text, so the currency sits right next to the number.
const measure = document.createElement('canvas').getContext('2d')
function fitAmount() {
  const el = $('payAmount')
  const cs = getComputedStyle(el)
  measure.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  el.style.width = `${Math.ceil(measure.measureText(el.value || el.placeholder).width) + 2}px`
}

// Keypad: digits, one decimal point, at most 2 decimals and 7 integer digits.
$('keypad').addEventListener('click', (e) => {
  const k = e.target.closest('[data-k]')?.dataset.k
  if (!k) return
  let v = $('payAmount').value
  if (k === 'del') v = v.slice(0, -1)
  else if (k === '.') { if (!v.includes('.')) v = (v || '0') + '.' }
  else {
    const [int, dec] = v.split('.')
    if (dec !== undefined ? dec.length >= 2 : int.length >= 7) return shake()
    v = v === '0' ? k : v + k
  }
  $('payAmount').value = v
  fitAmount()
})

function applyRequest(r) {
  if (r.chainId !== chainId) return toast('Request is for another network')
  if (r.value % 10_000n !== 0n) return toast('Invalid request (amount not rounded to the cent)')
  pendingRequest = r
  setToken(r.token)
  $('payTo').value = r.to
  $('payAmount').value = fmt(r.value).replace(/\.00$/, '')
  fitAmount(); renderWho(); renderNearby()
  tab('pay')
  toast(`Request from ${nameOf(r.to)}: ${money(r.value, r.token)} · check the recipient before signing`)
}

function openSheet(id) {
  $('scrim').hidden = false; $(id).hidden = false
  requestAnimationFrame(() => requestAnimationFrame(() => { $('scrim').classList.add('show'); $(id).classList.add('show') }))
}
function closeSheets() {
  $('scrim').classList.remove('show')
  for (const id of ['payOut', 'reqSheet']) $(id).classList.remove('show')
  setTimeout(() => { $('scrim').hidden = true; $('payOut').hidden = true; $('reqSheet').hidden = true }, 450)
  activeRequest = null
}
$('closeSheet').onclick = closeSheets
$('closeReq').onclick = closeSheets
$('scrim').onclick = closeSheets

$('signBtn').onclick = async () => {
  const to = $('payTo').value.trim()
  if (!isAddress(to)) return toast('Choose a recipient')
  let value
  try { value = parseUsdc($('payAmount').value.replace(',', '.') || '0') } catch { return toast('Invalid amount') }
  if (value < 10_000n) { shake(); return toast(`Minimum 0.01 ${symbol(token)}`) }
  if (getAddress(to) === account.address) return toast("That's your own address")
  // Guaranteed payment on a tab with this person when it covers the amount, otherwise a plain one.
  const tab = usableTab(getAddress(to))
  const onTab = !!tab && tab.left >= value
  const available = availableOffline()
  if (!onTab) {
    if (available == null) return toast('Open the app once while online to load your balance')
    if (value > available) { shake(); return toast(`Available: ${money(available, token)}`) }
  }

  let p
  if (onTab) {
    // Record the new running total BEFORE handing anything over: it must never be reused.
    const mine = myTabs()
    const cumulative = BigInt(tab.cumulative) + value
    mine[tabKey(token, to)] = { ...mine[tabKey(token, to)], cumulative: cumulative.toString() }
    if (!acct.set('tabs', mine)) return toast('Storage full: payment canceled (nothing was sent)')
    p = await createTabPayment({ account, to, cumulative, epoch: tab.epoch, chainId, token })
  } else {
    p = await createPayment({ account, to, amount: value, chainId, token })
  }
  const packet = encodePayment(p)
  // In the app, AirDrop an arcdrop:// link so the receiver's app opens it directly.
  lastPayment = { p, packet, amount: value, link: paymentLink(p, mesh && !globalThis.ArcMeshAndroid ? 'arcdrop://pay' : `${webOrigin}${BUNDLED ? '/' : location.pathname}`) }
  const sent = acct.get('sent', [])
  sent.unshift({ packet, at: Date.now(), status: 'pending', label: pendingRequest?.label, amount: value.toString() })
  if (!acct.set('sent', sent)) return toast('Storage full: payment canceled (nothing was sent)')
  const heardAs = nearby.find((n) => n.address === p.to)
  if (heardAs && heard.get(p.to) && !contacts[p.to] && !impostor(heardAs)) { contacts[p.to] = heard.get(p.to); acct.set('contacts', contacts) }

  // Someone right next to us over Bluetooth: send it straight away.
  const near = nearby.some((n) => n.address === p.to)
  if (mesh && near) mesh.postMessage({ type: 'broadcast', packet })

  $('outAmount').textContent = money(value, p.token)
  $('outPill').textContent = p.tab ? 'Signed · 🔒 guaranteed (tab)' : 'Signed · pending'
  $('outTo').textContent = `to ${nameOf(p.to)}`
  $('transportHint').textContent = near
    ? `Sent over Bluetooth to ${nameOf(p.to)}. You can also show the QR or use ${APPLE ? 'AirDrop' : 'Share'}.`
    : 'No network needed. The first device to get a signal settles the payment on Arc.'
  await qrInto($('outQr'), lastPayment.link)
  openSheet('payOut')
  $('payAmount').value = ''; pendingRequest = null
  fitAmount(); renderWho(); renderSent(); renderAvail()
  haptic('success')
  if (online) settleAll()
}

$('tQr').onclick = () => toast('Your friend scans this QR from “Receive”')

// AirDrop: the iOS share sheet offers AirDrop and works without internet.
$('tShare').onclick = async () => {
  if (!lastPayment) return
  const data = { title: 'ArcDrop', text: `${money(lastPayment.amount, lastPayment.p.token)} for you via ArcDrop`, url: lastPayment.link }
  if (mesh) return mesh.postMessage({ type: 'share', ...data }) // native share sheet in the iOS app
  if (navigator.share) {
    try { await navigator.share(data) } catch (e) { if (e.name !== 'AbortError') toast('Couldn’t share') }
  } else {
    await copy(lastPayment.link); toast('Link copied (no share sheet here)')
  }
}

// Bluetooth mesh: only the native iOS app can use Bluetooth.
$('tMesh').onclick = () => {
  if (!lastPayment) return
  if (!mesh) return toast(`Bluetooth needs the ArcDrop app. Here: QR or ${APPLE ? 'AirDrop' : 'Share'}.`)
  mesh.postMessage({ type: 'broadcast', packet: lastPayment.packet })
  toast('Broadcast over Bluetooth to nearby devices')
}

// ---------- receive ----------
// Payments for other people that this device only carries: memory only, bounded,
// so a Bluetooth flood can neither fill storage nor push out your own payments.
const relays = []

async function importPacket(text, via, hops) {
  const raw = extractPacket(text)
  const quiet = via === 'Bluetooth' // mesh traffic: never toast errors for strangers' packets
  if (!raw) return quiet || toast('No ArcDrop payment found')
  let p
  try { p = decodePayment(raw) } catch { return quiet || toast('Unreadable payment') }
  const v = await verifyPayment(p)
  if (!v.ok) return quiet || toast(v.reason === 'expired' ? 'Payment expired' : v.reason === 'not yet valid' ? 'Payment not valid yet: refused' : 'Invalid signature: refused')
  // Genuine signature: the mesh may now keep it and pass it on (whatever the network).
  if (via === 'Bluetooth' && mesh) mesh.postMessage({ type: 'vouch', packet: raw, hops: Number(hops) || 0 })
  if (p.chainId !== chainId) return quiet || toast(`Refused: payment is on ${CHAINS[p.chainId]?.name ?? 'another network'}, not ${CHAINS[chainId].name}`)
  // The app signs for 7 days: a far-off expiry is a payment built to sit "pending" forever.
  if (!p.tab && p.validBefore > BigInt(Math.floor(Date.now() / 1000) + PAYMENT_TTL + 86_400)) return quiet || toast('Refused: expiry too far in the future')
  const id = payId(p)
  const mine = p.to === account.address
  if (!mine) {
    if (!relays.some((r) => r.id === id)) { relays.unshift({ id, packet: raw, via, hops, at: Date.now(), status: 'pending' }); relays.length = Math.min(relays.length, 50) }
    renderInbox()
    if (online) settleAll()
    return
  }
  if (p.value < MIN_VALUE) return quiet || toast('Refused: amount below 0.01')
  const inbox = acct.get('inbox', [])
  if (inbox.some((i) => (i.id ?? payId(tryDecode(i.packet) ?? {})) === id)) return // same payment, any encoding
  // Flood guard: unsettled payments from people you never paid are capped.
  const strangers = contacts[p.from] ? [] : inbox.filter((i) => i.status === 'pending' && !contacts[tryDecode(i.packet)?.from])
  if (strangers.filter((i) => tryDecode(i.packet)?.from === p.from).length >= 5) return quiet || toast('Too many pending payments from this payer')
  if (strangers.length >= 30) return quiet || toast('Too many pending payments: settle them first (needs a connection)')
  let amount = p.value, guaranteed = false, prev = 0n, redeemBefore
  const rx = acct.get('tabRx', {})
  const rk = p.tab ? `${tabKey(p.token, p.from)}:${p.epoch}` : null
  if (p.tab) {
    // A tab voucher states the running total: this payment is the increase over what was
    // already received (held locally) or already paid out on-chain (known when last online).
    const known = tabsForMe()[tabKey(p.token, p.from)]
    const knownPaid = known && known.epoch === p.epoch ? BigInt(known.paid) : 0n
    prev = BigInt(rx[rk] ?? 0) > knownPaid ? BigInt(rx[rk] ?? 0) : knownPaid
    if (p.cumulative <= prev) return quiet || toast('Voucher already covered by an earlier payment')
    amount = p.cumulative - prev
    if (amount < MIN_VALUE) return quiet || toast('Refused: amount below 0.01')
    guaranteed = !!known && known.epoch === p.epoch && BigInt(known.locked) >= p.cumulative && known.expiry > Date.now() / 1000 + MARGIN
    redeemBefore = known?.expiry
  }
  // Already settled before it reached us (an old QR shown again, a second device): it's not new money.
  if (online && !p.tab) {
    const st = await checkPayment(p).catch(() => null)
    if (st?.settled) return quiet || toast('This payment was already settled before it reached you: nothing new')
  }
  // Save the payment first, the running total second: a full storage must never lose the payment.
  inbox.unshift({ id, packet: raw, via, hops, at: Date.now(), status: 'pending', amount: amount.toString(), prev: prev.toString(), guaranteed, redeemBefore })
  if (!acct.set('inbox', inbox)) return toast('Storage full: payment NOT saved, keep the QR!')
  if (p.tab) { rx[rk] = p.cumulative.toString(); acct.set('tabRx', rx) }
  toast(p.tab
    ? `${money(amount, p.token)} from ${nameOf(p.from)} · ${guaranteed ? '🔒 guaranteed, cash in before ' + day(redeemBefore) : 'unverified tab, not paid yet'}`
    : `${money(amount, p.token)} from ${nameOf(p.from)} · NOT PAID YET (settles once you’re back online)`)
  haptic('success')
  // Tell the payer, over Bluetooth and without internet, that it arrived (real payments only).
  if (mesh && p.value >= MIN_VALUE) mesh.postMessage({ type: 'broadcast', packet: await createAck(account, p) })
  renderInbox(); renderRequestStatus()
  if (!activeRequest) tab('receive')
  if (online) settleAll()
}

// A receipt: the recipient signed the nonce of one of our payments.
globalThis.arcdropReceipt = async (text) => {
  let nonce
  try { ({ nonce } = ackNonce(text)) } catch { return }
  const s = acct.get('sent', []).find((x) => tryDecode(x.packet)?.nonce === nonce)
  const p = s && tryDecode(s.packet)
  if (!p || s.delivered || !(await verifyAck(text, p))) return
  updateEntry('sent', s.packet, { delivered: Date.now() }); renderSent()
  if (p.tab) { // the recipient holds this running total: never sign below it again
    const mine = myTabs(), k = tabKey(p.token, p.to)
    if (mine[k] && BigInt(mine[k].cumulative) < p.cumulative) { mine[k].cumulative = p.cumulative.toString(); acct.set('tabs', mine) }
  }
  toast(`✓ ${nameOf(p.to)} received your ${money(amountOf(s, p), p.token)} payment (not settled yet)`)
  haptic('success')
}

// The native side passes (packet, hops) for Bluetooth deliveries.
globalThis.arcdropReceive = (text, hops) => importPacket(text, 'Bluetooth', hops)
// AirDrop only exists on Apple devices: elsewhere the same button opens the system share sheet.
const APPLE = !!globalThis.webkit?.messageHandlers?.arcmesh || /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent)
const SHARE_NAME = APPLE ? 'AirDrop' : 'Share'
$('tShareLabel').textContent = SHARE_NAME
globalThis.arcdropOpenURL = (url) => handleText(url, 'external link') // arcdrop://… opened by iOS (AirDrop, or any app/site)

// Anything scanned, pasted or opened: a payment request or a payment.
function handleText(text, via) {
  const r = decodeRequest(text)
  if (r) return applyRequest(r)
  return importPacket(text, via)
}

$('importBtn').onclick = () => { handleText($('pasteBox').value, 'paste'); $('pasteBox').value = '' }
// Android web views can't read the clipboard: the app reads it natively and answers via arcdropClipboard.
function readClipboard() {
  if (!globalThis.ArcMeshAndroid) return navigator.clipboard.readText()
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(''), 2000)
    globalThis.arcdropClipboard = (text) => { clearTimeout(t); resolve(typeof text === 'string' ? text : '') }
    mesh.postMessage({ type: 'readClipboard' })
  })
}
$('pastePay').onclick = async () => {
  try {
    const text = await readClipboard()
    if (extractPacket(text) || decodeRequest(text)) return handleText(text, 'paste')
  } catch { /* clipboard blocked: fall back to the manual field */ }
  $('manual').hidden = false
  $('pasteBox').focus()
}
for (const id of ['copyAddr', 'copyAddr2']) $(id).onclick = async () => { await copy(account.address); toast('Address copied') }

// AirDrop / any link opens the app with #p=… (payment) or #r=… (request).
function handleHash() {
  if (!/arcdrop(-req)?:\d:/.test(location.hash)) return
  const h = location.hash
  history.replaceState(null, '', location.pathname + location.search)
  let text = h
  try { text = decodeURIComponent(h) } catch { /* malformed: use as is */ }
  handleText(text, 'link')
}
addEventListener('hashchange', handleHash)

// Camera QR scanner (jsQR, works offline).
let scanning = null
async function scan(onText) {
  stopScan()
  const video = $('video')
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    video.srcObject = stream; video.hidden = false; await video.play()
    video.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d', { willReadFrequently: true })
    scanning = { stream }
    const tick = () => {
      if (!scanning) return
      if (video.readyState >= 2) {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight
        ctx.drawImage(video, 0, 0)
        const code = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
        if (code?.data) { stopScan(); haptic('light'); return onText(code.data) }
      }
      requestAnimationFrame(tick)
    }
    tick()
  } catch { toast('Camera unavailable') }
}
function stopScan() {
  if (scanning) scanning.stream.getTracks().forEach((t) => t.stop())
  scanning = null; $('video').hidden = true
}
$('scanPay').onclick = () => scan((t) => handleText(t, 'QR code'))
$('scanTo').onclick = () => {
  tab('receive')
  scan((t) => {
    const r = decodeRequest(t)
    if (r) return applyRequest(r)
    const m = String(t).trim().match(/^(?:ethereum:)?(0x[0-9a-fA-F]{40})(?:@\d+)?$/)
    tab('pay')
    if (m) { $('payTo').value = getAddress(m[1]); pendingRequest = null; renderWho(); renderNearby() } else toast('Not an address')
  })
}

// ---------- payment requests (merchant mode, split bill) ----------
let activeRequest = null // { value, token, label, split, since }

function requestPart() {
  let total
  try { total = parseUsdc(($('reqAmount').value || '0').replace(',', '.').replace(/\s/g, '')) } catch { return null }
  const split = Number($('splitN').textContent)
  const part = total / BigInt(split)
  return { total, split, value: part - (part % 10_000n) }
}

async function renderRequest() {
  const part = requestPart()
  $('reqUnitLabel').textContent = symbol(activeRequest.token)
  $('splitInfo').hidden = !part || part.split === 1
  if (part && part.split > 1) $('splitInfo').textContent = `${money(part.total, activeRequest.token)} ÷ ${part.split} = ${money(part.value, activeRequest.token)} per person`
  if (!part || part.value < 10_000n) { $('reqQr').dataset.qr = ''; $('reqQr').replaceChildren(); $('reqStatus').textContent = 'Enter an amount.'; return }
  Object.assign(activeRequest, { value: part.value, label: $('reqLabel').value.trim() })
  const req = encodeRequest({ chainId, token: activeRequest.token, to: account.address, value: part.value, label: activeRequest.label })
  await qrInto($('reqQr'), `${webOrigin}/#r=${req}`)
  renderRequestStatus()
}

// Merchant mode: the sheet stays open and counts the matching payments as they arrive.
function renderRequestStatus() {
  if (!activeRequest?.value) return
  const seen = new Set()
  const got = acct.get('inbox', []).map((i) => ({ i, p: tryDecode(i.packet) }))
    .filter(({ i, p }) => p && i.at >= activeRequest.since && p.chainId === chainId && p.to === account.address
      && amountOf(i, p) === activeRequest.value && (p.token ?? 0) === activeRequest.token && i.status !== 'failed'
      && !seen.has(payId(p)) && seen.add(payId(p)))
  const paid = got.filter(({ i }) => i.status === 'settled').length // partial / unverified never count
  $('reqStatus').innerHTML = got.length
    ? `<b>✓ ${paid} settled on Arc</b>${got.length > paid ? ` · ${got.length - paid} waiting for a connection` : ''} · ${got.map(({ p }) => esc(nameOf(p.from))).join(', ')}`
    : `The payer scans this QR: ${money(activeRequest.value, activeRequest.token)} to you, already filled in.`
}

$('askBtn').onclick = () => {
  activeRequest = { token, since: Date.now() }
  $('reqAmount').value = ''; $('reqLabel').value = ''; $('splitN').textContent = '1'
  renderRequest()
  openSheet('reqSheet')
  setTimeout(() => $('reqAmount').focus(), 350)
}
$('reqAmount').addEventListener('input', renderRequest)
$('reqLabel').addEventListener('input', renderRequest)
$('reqUnit').onclick = () => { activeRequest.token = 1 - activeRequest.token; renderRequest() }
$('splitMinus').onclick = () => { $('splitN').textContent = Math.max(1, Number($('splitN').textContent) - 1); renderRequest() }
$('splitPlus').onclick = () => { $('splitN').textContent = Math.min(20, Number($('splitN').textContent) + 1); renderRequest() }

// ---------- settlement ----------
let settling = false

// Lists can change while a slow network call is in flight (a new payment arrives, a new one
// is signed): always re-read and update the one entry, never write back an old snapshot.
function updateEntry(list, packet, patch) {
  const all = acct.get(list, [])
  const entry = all.find((x) => x.packet === packet)
  if (!entry) return null
  Object.assign(entry, patch)
  acct.set(list, all)
  return entry
}

let settleAgain = false
async function settleAll() {
  if (!online) return
  if (settling) { settleAgain = true; return } // something arrived mid-run: one more pass after
  settling = true
  try {
    const due = (i) => i.status === 'pending' || (i.status === 'unverified' && Date.now() - (i.checkedAt ?? 0) > 600_000)
    for (const pending of acct.get('inbox', []).filter((i) => due(i) && tryDecode(i.packet)?.chainId === chainId)) {
      if (pending.status === 'unverified') { // settled by someone else long ago: look for the proof again
        const p = decodePayment(pending.packet)
        const r = await proven(p, undefined, undefined, pending)
        updateEntry('inbox', pending.packet, { ...r, checkedAt: Date.now() }); renderInbox()
        continue
      }
      const result = await settleOne(pending.packet, true, pending)
      if (result.status === 'settled' && !pending.settledAt) result.settledAt = Date.now()
      const item = updateEntry('inbox', pending.packet, result)
      renderInbox(); renderRequestStatus()
      if (!item) continue
      const p = decodePayment(item.packet)
      if (item.status === 'settled' && txUrl(hashOf(item.tx))) {
        confirmSettled({ title: 'Payment received', amount: `+${money(item.received ? BigInt(item.received) : amountOf(item, p), p.token)}`, sub: `from ${nameOf(p.from)} · via ${viaLabel(item.via)}`, ms: item.ms, tx: txUrl(hashOf(item.tx)) })
      }
    }
    // Strangers' payments: forwarded through the gateway only, never with our own gas.
    for (const r of relays.filter((x) => x.status === 'pending' && tryDecode(x.packet)?.chainId === chainId)) { Object.assign(r, await settleOne(r.packet, false, r)); renderInbox() }
    await refreshSent()
    refreshBalance()
  } finally {
    settling = false
    if (settleAgain) { settleAgain = false; settleAll() }
  }
}

// "Settled" only with on-chain proof that exactly this amount reached exactly this recipient.
async function proven(p, hash, ms, item) {
  const c = await confirmSettlement(p, { txHash: hash }).catch(() => null)
  if (c?.paid) return { status: 'settled', tx: c.tx, ms, note: undefined }
  if (!c) return { status: 'pending', note: 'can’t verify on Arc right now' }
  if (p.tab) {
    const prev = BigInt(item?.prev ?? 0)
    const got = c.paidUpTo > prev ? c.paidUpTo - prev : 0n
    if (got > 0n) return { status: 'partial', received: got.toString(), tx: c.tx, note: `paid ${money(got, p.token)} of ${money(amountOf(item, p), p.token)}: tab exceeded or emptied` }
    return { status: 'pending', note: 'tab not cashed in yet' }
  }
  if (c.unknown) return { status: 'unverified', note: 'already used on Arc, but no proof found (old settlement?): not counted as paid' }
  return { status: 'failed', note: 'NOT paid: this payment’s nonce was used by another transaction' }
}

async function settleOne(packet, mine, item) {
  const p = decodePayment(packet)
  const now = Math.floor(Date.now() / 1000)
  const status = await checkPayment(p).catch(() => null)
  if (status?.settled || (p.tab && status?.paidUpTo > BigInt(item?.prev ?? 0) && !status.funded)) return proven(p, undefined, undefined, item)
  if (!status && (p.tab || p.validBefore <= BigInt(now))) return { status: 'pending', note: 'can’t verify on Arc right now' }
  if (p.tab && status.tab.epoch !== p.epoch) return { status: 'failed', note: 'tab closed before cash-in: not paid' }
  if (p.tab && status.tab.expiry <= now) return { status: 'failed', note: 'tab expired before cash-in: not paid' }
  if (!p.tab && p.validBefore <= BigInt(now)) return { status: 'failed', note: 'expired before it was settled' }
  if (status && !status.funded) return { status: 'pending', note: `payer’s balance too low (${money(status.payerBalance, p.token)})` }

  // 1) the gateway pays the gas. Its errors are never final: only chain evidence or expiry are.
  let gatewayNote
  try {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 12_000)
    const r = await fetch(`${gateway()}/api/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ packet }), signal: ctrl.signal })
    clearTimeout(timer)
    const out = await r.json()
    if (out.ok && out.hash) return proven(p, out.hash, Number(out.settleMs) || undefined, item)
    if (out.ok && out.alreadySettled) return proven(p, undefined, undefined, item)
    gatewayNote = String(out.error ?? `gateway: ${r.status}`).slice(0, 100)
  } catch { gatewayNote = 'gateway unreachable' }

  // 2) this device pays the gas, only for payments addressed to us (never for strangers' floods)
  if (!mine || p.value < MIN_VALUE) return { status: 'pending', note: gatewayNote }
  try {
    const t0 = performance.now()
    await simulatePayment(p, { relayer: account.address }) // a doomed tx would cost us gas for nothing
    const res = await settlePayment(p, { relayerAccount: account })
    return proven(p, res.hash, Math.round(performance.now() - t0), item)
  } catch (e) {
    return { status: 'pending', note: `${gatewayNote} · ${e.shortMessage ?? e.message}`.slice(0, 140) }
  }
}

async function refreshSent() {
  for (const s of acct.get('sent', []).filter((s) => s.status === 'pending')) {
    const p = tryDecode(s.packet)
    if (!p) continue
    try {
      if (p.chainId !== chainId) continue
      const st = await checkPayment(p) // a read error throws: nothing is decided without the chain
      if (st.settled) {
        const r = await proven(p, undefined, undefined, s)
        updateEntry('sent', s.packet, { status: r.status, settledAt: Date.now() })
        if (r.status === 'settled') confirmSettled({ title: 'Payment settled', amount: money(amountOf(s, p), p.token), sub: `to ${nameOf(p.to)} · final on Arc`, tx: r.tx })
        continue
      }
      // Not settled, and the chain says so: only now can expiry or a closed tab mean "failed".
      if (p.tab ? st.tab.epoch !== p.epoch : p.validBefore <= BigInt(Math.floor(Date.now() / 1000))) updateEntry('sent', s.packet, { status: 'failed' })
    } catch {}
  }
  renderSent()
}

// ---------- confirmation ----------
// Shown once per payment, when it becomes final on Arc while the app is open.
const confirmQueue = []
function confirmSettled(c) {
  confirmQueue.push(c)
  if (confirmQueue.length === 1) showConfirm()
}
function showConfirm() {
  const c = confirmQueue[0]
  if (!c) return
  $('cTitle').textContent = c.title
  $('cAmount').textContent = c.amount
  $('cSub').textContent = c.sub
  $('cSpeed').hidden = !c.ms
  $('cSpeed').textContent = c.ms ? `⚡ Settled on Arc in ${(c.ms / 1000).toFixed(2)} s` : ''
  const link = txUrl(hashOf(c.tx))
  $('cLink').hidden = !link
  if (link) $('cLink').href = link
  $('confirm').hidden = false
  requestAnimationFrame(() => requestAnimationFrame(() => $('confirm').classList.add('show')))
  haptic('success')
}
$('cDone').onclick = () => {
  $('confirm').classList.remove('show')
  setTimeout(() => { $('confirm').hidden = true; confirmQueue.shift(); showConfirm() }, 300)
}

// ---------- lists ----------
const ICON_IN = '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>'
const ICON_OUT = '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>'
const ICON_RELAY = '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 12h16M14 6l6 6-6 6"/></svg>'
const EMPTY = '<div class="empty">No payments yet</div>'
const STATE = { pending: 'pending', delivered: 'received ✓', settled: 'settled', failed: 'failed', partial: 'partial', unverified: 'to verify' }

document.addEventListener('click', (e) => {
  const row = e.target.closest('[data-expand]')
  if (row && !e.target.closest('a')) row.nextElementSibling.hidden = !row.nextElementSibling.hidden
})

// The payment's journey: signed offline → carried → settled.
function journey(item, p) {
  const s = item.status
  const carried = item.via === 'Bluetooth'
    ? `Received over Bluetooth${item.hops ? ` · ${item.hops} hop${item.hops > 1 ? 's' : ''} phone to phone` : ''}`
    : `Received via ${viaLabel(item.via)}`
  let settled = 'Settled on Arc'
  if (s === 'settled' && item.settledAt) {
    const mins = Math.round((item.settledAt - item.at) / 60_000)
    settled += ` at ${time(item.settledAt)}${mins >= 1 ? ` · ${mins} min after receipt` : ''}`
  }
  if (item.ms) settled += ` · in ${(item.ms / 1000).toFixed(2)} s`
  return `<ol>
    <li class="done">Signed offline by ${esc(nameOf(p.from))}${p.tab ? (item.guaranteed ? ' · 🔒 guaranteed by their tab' : ' · unverified tab') : ''}</li>
    <li class="done">${carried} at ${time(item.at)} · signature verified</li>
    <li class="${s === 'settled' ? 'done' : s === 'failed' ? 'fail' : ''}">${settled}${txUrl(hashOf(item.tx)) ? ` · <a href="${txUrl(hashOf(item.tx))}" target="_blank" rel="noopener">view tx</a>` : ''}</li>
  </ol>${item.note ? `<div class="note">${esc(item.note)}</div>` : ''}`
}

function txCell({ icon, kind, title, sub, amount, amountClass = '', status, details }) {
  return `<button class="cell tx" ${details ? 'data-expand' : ''}><span class="tx-ic ${kind}">${icon}</span>
    <span class="cell-main"><div>${esc(title)}</div><div class="cell-sub">${esc(sub)}</div></span>
    <span class="tx-end"><div class="tx-amt ${amountClass}">${amount}</div><div class="tx-state ${status}">${STATE[status]}</div></span></button>
    ${details ? `<div class="details" hidden>${details}</div>` : ''}`
}

function renderInbox() {
  const inbox = [...acct.get('inbox', []), ...relays].filter((i) => tryDecode(i.packet)?.chainId === chainId)
  $('inbox').innerHTML = inbox.length ? inbox.slice(0, 100).map((item) => {
    const p = tryDecode(item.packet)
    if (!p) return ''
    const mine = p.to === account.address
    // A payment for someone else is only carried by this device: never show it as income.
    return txCell({
      icon: mine ? ICON_IN : ICON_RELAY, kind: mine ? 'in' : 'relay',
      title: mine ? `From ${nameOf(p.from)}` : 'Relayed',
      sub: (mine ? `via ${viaLabel(item.via)}` : `${nameOf(p.from)} → ${nameOf(p.to)}`)
        + (p.tab && item.guaranteed && item.status === 'pending' && (item.redeemBefore ?? 0) > Date.now() / 1000 ? ` · 🔒 guaranteed until ${day(item.redeemBefore)}` : ''),
      amount: `${mine ? '+' : ''}${money(item.received ? BigInt(item.received) : amountOf(item, p), p.token, p.chainId)}`, amountClass: mine && item.status === 'settled' ? 'in' : '',
      status: item.status, details: journey(item, p),
    })
  }).join('') : EMPTY
}

function renderSent() {
  const sent = acct.get('sent', []).filter((s) => tryDecode(s.packet)?.chainId === chainId)
  $('sent').innerHTML = sent.length ? sent.map((s) => {
    const p = tryDecode(s.packet)
    if (!p) return ''
    const when = new Date(s.at).toLocaleString('en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    return txCell({
      icon: ICON_OUT, kind: 'out', title: `To ${nameOf(p.to)}`,
      sub: s.label ? `${s.label} · ${when}` : when,
      amount: `−${money(amountOf(s, p), p.token, p.chainId)}`,
      status: s.status === 'pending' && s.delivered ? 'delivered' : s.status,
    })
  }).join('') : EMPTY
}

// ---------- tabs & settings ----------
function tab(name) {
  for (const b of document.querySelectorAll('nav button')) b.setAttribute('aria-selected', String(b.dataset.tab === name))
  for (const s of document.querySelectorAll('section')) s.hidden = s.id !== `tab-${name}`
  $('compactTitle').textContent = $(`tab-${name}`).dataset.title
  currentTab = name
  announce()
  scrollTo({ top: 0 })
  if (name !== 'receive') stopScan()
}
for (const b of document.querySelectorAll('nav button')) b.onclick = () => tab(b.dataset.tab)
addEventListener('scroll', () => $('navbar').classList.toggle('scrolled', scrollY > 40), { passive: true })

$('chainSel').onchange = (e) => { chainId = Number(e.target.value); store.set('chain', chainId); online = false; renderWallet(); probe() }
$('gateway').onchange = (e) => store.set('gateway', e.target.value.trim())
$('myName').onchange = (e) => { store.set('name', e.target.value.trim()); announce(); toast('Name visible to nearby devices') }
$('exportKey').onclick = $('backupKey').onclick = async () => {
  if (!(await copy(key))) return toast('Couldn’t copy here: try again, or export from another browser')
  store.set(`${account.address}:backedUp`, true)
  $('backupNag').hidden = true
  toast('Private key copied: paste it into your password manager, then copy something else. Never share it.')
}
$('importKey').onclick = () => {
  if (!confirm('Importing a key replaces this wallet on this device. Have you exported the current key?')) return
  const k = prompt('Private key (0x…)')
  if (!k) return
  try {
    account = privateKeyToAccount(k.trim()); key = k.trim()
    store.set('key', key)
    if (mesh) mesh.postMessage({ type: 'saveKey', key, replace: true })
    contacts = acct.get('contacts', {})
    renderWallet(); renderInbox(); renderSent(); renderTabs(); announce(); refreshBalance(); toast('Key imported')
  } catch { toast('Invalid key') }
}

if ('serviceWorker' in navigator && !BUNDLED) navigator.serviceWorker.register('sw.js').catch(() => {})

fitAmount(); renderWallet(); renderInbox(); renderSent(); renderWho(); announce(); handleHash(); probe()
