import QRCode from 'qrcode'
import jsQR from 'jsqr'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { isAddress, getAddress, createWalletClient, http } from 'viem'
import {
  createPayment, encodePayment, decodePayment, verifyPayment, paymentLink, extractPacket,
  checkPayment, settlePayment, simulatePayment, publicClient, formatUsdc, parseUsdc, CHAINS, USDC_ABI,
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
let key = globalThis.ARCDROP_NATIVE_KEY || store.get('key')
if (!key) key = generatePrivateKey()
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
// Cents, rounded down so we never overstate; French decimal comma.
const fmt = (v) => formatUsdc(v - (v % 10_000n)).replace('.', ',')
const money = (v, t, c = chainId) => `${fmt(v)} ${symbol(t)}${c === 5042 ? '' : ' (test)'}`
const time = (ms) => new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
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
const CONFUSABLE = { а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ӏ: 'l', '0': 'o', '1': 'l' }
const fold = (n) => cleanName(n).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/./gu, (c) => CONFUSABLE[c] ?? c)
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
  try { await navigator.clipboard.writeText(text) } catch {
    const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove()
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
  $('balance2').textContent = other ? `et ${money(other, 1 - token)}` : ''
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
  $('avail').textContent = a == null ? '' : `Disponible : ${money(a, token)}${tab ? ` · 🔒 ardoise : ${money(tab.left, token)} garantis` : ''}`
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

const day = (sec) => new Date(sec * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })

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
      <span class="tx-ic out">🔒</span><span class="cell-main"><div>Pour ${esc(nameOf(tab.to))}</div>
      <div class="cell-sub">${expired ? 'expirée · touche pour récupérer le reste' : `jusqu’au ${day(tab.expiry)}`}</div></span>
      <span class="tx-end"><div class="tx-amt">${money(left > 0n ? left : 0n, tab.token)}</div><div class="tx-state">sur ${money(BigInt(tab.locked), tab.token)}</div></span></button>`)
  }
  for (const tab of Object.values(tabsForMe())) {
    if (tab.chainId !== chainId || tab.expiry <= now || BigInt(tab.locked) <= BigInt(tab.paid)) continue
    rows.push(`<div class="cell tx"><span class="tx-ic in">🔒</span><span class="cell-main"><div>De ${esc(nameOf(tab.from))}</div>
      <div class="cell-sub">garantie pour toi jusqu’au ${day(tab.expiry)}</div></span>
      <span class="tx-end"><div class="tx-amt in">${money(BigInt(tab.locked) - BigInt(tab.paid), tab.token)}</div><div class="tx-state">bloqués</div></span></div>`)
  }
  $('tabsList').innerHTML = rows.join('') || '<div class="empty">Aucune ardoise</div>'
}

function askAmount(question) {
  const raw = prompt(question)
  if (!raw) return null
  try { const v = parseUsdc(raw.replace(',', '.').trim()); return v >= 100_000n ? v : null } catch { return null }
}

$('tabOpen').onclick = async () => {
  if (!online) return toast('Il faut du réseau pour ouvrir une ardoise')
  let to = $('payTo').value.trim()
  if (!isAddress(to)) to = (prompt('Adresse 0x… de la personne (ou choisis-la d’abord dans Payer)') ?? '').trim()
  if (!isAddress(to)) return toast('Adresse invalide')
  to = getAddress(to)
  if (to === account.address) return toast("Pas d'ardoise avec toi-même")
  const value = askAmount(`Combien de ${symbol(token)} bloquer pour ${nameOf(to)} pendant 7 jours ? (min 0,1)`)
  if (value == null) return toast('Montant invalide (minimum 0,1)')
  if (value > (availableOffline() ?? 0n)) return toast('Solde insuffisant (paiements en attente compris)')
  const c = chainId, t = token
  let before
  try { before = await tabState(c, t, account.address, to) } catch { return toast('Arc injoignable, réessaie') }
  try {
    const f = await createTabFunding({ account, to, amount: value, days: 7, chainId: c, token: t })
    const r = await fetch(`${gateway()}/api/fund`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tab: f }, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) })
    let out = {}
    try { out = await r.json() } catch { /* ambiguous: check the chain below */ }
    // Whatever the gateway said, the chain decides: did our lock land?
    const st = await tabState(c, t, account.address, to)
    if (!(st.locked > before.locked || (st.epoch === before.epoch && st.expiry > before.expiry))) throw new Error(out.error ?? 'refusé')
    const mine = myTabs()
    const prev = mine[tabKey(t, to, c)]
    mine[tabKey(t, to, c)] = { chainId: c, token: t, to, epoch: st.epoch, locked: st.locked.toString(), paid: st.paid.toString(), expiry: st.expiry,
      cumulative: (prev && prev.epoch === st.epoch && BigInt(prev.cumulative) > st.paid ? BigInt(prev.cumulative) : st.paid).toString() }
    acct.set('tabs', mine)
    if (heard.get(to) && !contacts[to]) { contacts[to] = heard.get(to); acct.set('contacts', contacts) }
    toast(`🔒 Ardoise : ${money(value, t)} garantis pour ${nameOf(to)}`); haptic('success')
    refreshBalance()
  } catch (e) { toast(`Ardoise impossible : ${e.message}`.slice(0, 90)) }
}

$('tabsList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-tab-close]')
  if (!b || b.disabled) return
  if (!online) return toast('Il faut du réseau')
  try {
    const wallet = createWalletClient({ account, chain: CHAINS[chainId], transport: http() })
    const hash = await wallet.writeContract({ address: tabsAddress(chainId), abi: TABS_ABI, functionName: 'close', args: [tokenAddress(chainId, Number(b.dataset.tabToken)), b.dataset.tabClose] })
    await publicClient(chainId).waitForTransactionReceipt({ hash })
    toast('Reste de l’ardoise récupéré'); refreshBalance()
  } catch (err) { toast(`Impossible : ${err.shortMessage ?? err.message}`.slice(0, 90)) }
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
    $('netLabel').textContent = ok ? 'en ligne' : 'hors ligne'
    if (ok) { refreshBalance(); settleAll() }
  }
}
addEventListener('online', probe); addEventListener('offline', probe)
setInterval(probe, 5000)

// ---------- nearby (Bluetooth presence) ----------
let nearby = []
const distance = (rssi) => rssi == null ? 'à côté' : rssi > -60 ? 'tout près' : rssi > -75 ? 'proche' : 'plus loin'

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
  $('meshPeers').textContent = n ? `${n} proche${n > 1 ? 's' : ''}` : 'personne autour'
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
    parts.push(`À <b>${esc(nearbyName(a))}</b> · …${a.slice(-4)}${contacts[a] ? ' · déjà payé' : n && impostor(n) ? ' · ⚠︎ nom déjà pris par un contact' : ''}${near ? ' · à proximité' : ''}`)
  }
  if (pendingRequest?.label) parts.push(`pour « ${esc(pendingRequest.label)} »`)
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

// Keypad: digits, one decimal comma, at most 2 decimals and 7 integer digits.
$('keypad').addEventListener('click', (e) => {
  const k = e.target.closest('[data-k]')?.dataset.k
  if (!k) return
  let v = $('payAmount').value
  if (k === 'del') v = v.slice(0, -1)
  else if (k === ',') { if (!v.includes(',')) v = (v || '0') + ',' }
  else {
    const [int, dec] = v.split(',')
    if (dec !== undefined ? dec.length >= 2 : int.length >= 7) return shake()
    v = v === '0' ? k : v + k
  }
  $('payAmount').value = v
  fitAmount()
})

function applyRequest(r) {
  if (r.chainId !== chainId) return toast('Demande pour un autre réseau')
  pendingRequest = r
  setToken(r.token)
  $('payTo').value = r.to
  if (r.value % 10_000n !== 0n) return toast('Demande invalide (montant non arrondi au centime)')
  $('payAmount').value = fmt(r.value).replace(/,00$/, '')
  fitAmount(); renderWho(); renderNearby()
  tab('pay')
  toast(`Demande de ${nameOf(r.to)} : ${money(r.value, r.token)} · vérifie le destinataire avant de signer`)
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
  if (!isAddress(to)) return toast('Choisis un destinataire')
  let value
  try { value = parseUsdc($('payAmount').value.replace(',', '.') || '0') } catch { return toast('Montant invalide') }
  if (value < 10_000n) { shake(); return toast(`Minimum 0,01 ${symbol(token)}`) }
  if (getAddress(to) === account.address) return toast("C'est ta propre adresse")
  // Guaranteed payment on a tab with this person when it covers the amount, otherwise a plain one.
  const tab = usableTab(getAddress(to))
  const onTab = !!tab && tab.left >= value
  const available = availableOffline()
  if (!onTab) {
    if (available == null) return toast("Ouvre l'app une fois en ligne pour connaître ton solde")
    if (value > available) { shake(); return toast(`Disponible : ${money(available, token)}`) }
  }

  let p
  if (onTab) {
    // Record the new running total BEFORE handing anything over: it must never be reused.
    const mine = myTabs()
    const cumulative = BigInt(tab.cumulative) + value
    mine[tabKey(token, to)] = { ...mine[tabKey(token, to)], cumulative: cumulative.toString() }
    if (!acct.set('tabs', mine)) return toast('Stockage plein : paiement annulé (rien n’a été envoyé)')
    p = await createTabPayment({ account, to, cumulative, epoch: tab.epoch, chainId, token })
  } else {
    p = await createPayment({ account, to, amount: value, chainId, token })
  }
  const packet = encodePayment(p)
  // In the app, AirDrop an arcdrop:// link so the receiver's app opens it directly.
  lastPayment = { p, packet, amount: value, link: paymentLink(p, mesh ? 'arcdrop://pay' : `${webOrigin}${BUNDLED ? '/' : location.pathname}`) }
  const sent = acct.get('sent', [])
  sent.unshift({ packet, at: Date.now(), status: 'pending', label: pendingRequest?.label, amount: value.toString() })
  if (!acct.set('sent', sent)) return toast('Stockage plein : paiement annulé (rien n’a été envoyé)')
  if (nearby.some((n) => n.address === p.to) && heard.get(p.to) && !contacts[p.to]) { contacts[p.to] = heard.get(p.to); acct.set('contacts', contacts) }

  // Someone right next to us over Bluetooth: send it straight away.
  const near = nearby.some((n) => n.address === p.to)
  if (mesh && near) mesh.postMessage({ type: 'broadcast', packet })

  $('outAmount').textContent = money(value, p.token)
  $('outPill').textContent = p.tab ? 'Signé · 🔒 garanti (ardoise)' : 'Signé · en attente'
  $('outTo').textContent = `à ${nameOf(p.to)}`
  $('transportHint').textContent = near
    ? `Envoyé en Bluetooth à ${nameOf(p.to)}. Tu peux aussi montrer le QR ou utiliser AirDrop.`
    : 'Aucun réseau nécessaire. Le premier appareil qui capte règle le paiement sur Arc.'
  await qrInto($('outQr'), lastPayment.link)
  openSheet('payOut')
  $('payAmount').value = ''; pendingRequest = null
  fitAmount(); renderWho(); renderSent(); renderAvail()
  haptic('success')
  if (online) settleAll()
}

$('tQr').onclick = () => toast('Ton pote scanne ce QR depuis « Recevoir »')

// AirDrop: the iOS share sheet offers AirDrop and works without internet.
$('tShare').onclick = async () => {
  if (!lastPayment) return
  const data = { title: 'ArcDrop', text: `${money(lastPayment.amount, lastPayment.p.token)} pour toi via ArcDrop`, url: lastPayment.link }
  if (mesh) return mesh.postMessage({ type: 'share', ...data }) // native share sheet in the iOS app
  if (navigator.share) {
    try { await navigator.share(data) } catch (e) { if (e.name !== 'AbortError') toast('Partage impossible') }
  } else {
    await copy(lastPayment.link); toast('Lien copié (pas de feuille de partage ici)')
  }
}

// Bluetooth mesh: only the native iOS app can use Bluetooth.
$('tMesh').onclick = () => {
  if (!lastPayment) return
  if (!mesh) return toast("Le Bluetooth arrive avec l'app iOS. Ici : QR ou AirDrop.")
  mesh.postMessage({ type: 'broadcast', packet: lastPayment.packet })
  toast('Diffusé en Bluetooth aux appareils proches')
}

// ---------- receive ----------
// Payments for other people that this device only carries: memory only, bounded,
// so a Bluetooth flood can neither fill storage nor push out your own payments.
const relays = []

async function importPacket(text, via, hops) {
  const raw = extractPacket(text)
  const quiet = via === 'Bluetooth' // mesh traffic: never toast errors for strangers' packets
  if (!raw) return quiet || toast('Aucun paiement ArcDrop trouvé')
  let p
  try { p = decodePayment(raw) } catch { return quiet || toast('Paiement illisible') }
  if (p.chainId !== chainId) return quiet || toast(`Refusé : paiement sur ${CHAINS[p.chainId]?.name ?? 'un autre réseau'}, pas ${CHAINS[chainId].name}`)
  const v = await verifyPayment(p)
  if (!v.ok) return quiet || toast(v.reason === 'expired' ? 'Paiement expiré' : v.reason === 'not yet valid' ? 'Paiement pas encore valable : refusé' : 'Signature invalide : refusé')
  const id = payId(p)
  const mine = p.to === account.address
  if (!mine) {
    if (!relays.some((r) => r.id === id)) { relays.unshift({ id, packet: raw, via, hops, at: Date.now(), status: 'pending' }); relays.length = Math.min(relays.length, 50) }
    renderInbox()
    if (online) settleAll()
    return
  }
  if (p.value < MIN_VALUE) return quiet || toast('Refusé : montant inférieur à 0,01')
  const inbox = acct.get('inbox', [])
  if (inbox.some((i) => (i.id ?? payId(tryDecode(i.packet) ?? {})) === id)) return // same payment, any encoding
  // Flood guard: unsettled payments from people you never paid are capped.
  if (!contacts[p.from] && inbox.filter((i) => i.status === 'pending' && tryDecode(i.packet)?.from === p.from).length >= 5) return quiet || toast('Trop de paiements en attente de ce payeur')
  let amount = p.value, guaranteed = false, prev = 0n, redeemBefore
  const rx = acct.get('tabRx', {})
  const rk = p.tab ? `${tabKey(p.token, p.from)}:${p.epoch}` : null
  if (p.tab) {
    // A tab voucher states the running total: this payment is the increase over what was
    // already received (held locally) or already paid out on-chain (known when last online).
    const known = tabsForMe()[tabKey(p.token, p.from)]
    const knownPaid = known && known.epoch === p.epoch ? BigInt(known.paid) : 0n
    prev = BigInt(rx[rk] ?? 0) > knownPaid ? BigInt(rx[rk] ?? 0) : knownPaid
    if (p.cumulative <= prev) return quiet || toast('Bon déjà couvert par un paiement précédent')
    amount = p.cumulative - prev
    guaranteed = !!known && known.epoch === p.epoch && BigInt(known.locked) >= p.cumulative && known.expiry > Date.now() / 1000 + MARGIN
    redeemBefore = known?.expiry
  }
  // Save the payment first, the running total second: a full storage must never lose the payment.
  inbox.unshift({ id, packet: raw, via, hops, at: Date.now(), status: 'pending', amount: amount.toString(), prev: prev.toString(), guaranteed, redeemBefore })
  if (!acct.set('inbox', inbox)) return toast('Stockage plein : paiement NON enregistré, garde le QR !')
  if (p.tab) { rx[rk] = p.cumulative.toString(); acct.set('tabRx', rx) }
  toast(p.tab
    ? `${money(amount, p.token)} de ${nameOf(p.from)} · ${guaranteed ? '🔒 garanti, à encaisser avant le ' + day(redeemBefore) : 'ardoise non vérifiée, pas encore payé'}`
    : `${money(amount, p.token)} de ${nameOf(p.from)} · PAS ENCORE PAYÉ (réglé dès que le réseau revient)`)
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
  toast(`✓ ${nameOf(p.to)} a reçu ton paiement de ${money(amountOf(s, p), p.token)} (pas encore réglé)`)
  haptic('success')
}

// The native side passes (packet, hops) for Bluetooth deliveries.
globalThis.arcdropReceive = (text, hops) => importPacket(text, 'Bluetooth', hops)
globalThis.arcdropOpenURL = (url) => handleText(url, 'lien externe') // arcdrop://… opened by iOS (AirDrop, or any app/site)

// Anything scanned, pasted or opened: a payment request or a payment.
function handleText(text, via) {
  const r = decodeRequest(text)
  if (r) return applyRequest(r)
  return importPacket(text, via)
}

$('importBtn').onclick = () => { handleText($('pasteBox').value, 'copier-coller'); $('pasteBox').value = '' }
$('pastePay').onclick = async () => {
  try {
    const text = await navigator.clipboard.readText()
    if (extractPacket(text) || decodeRequest(text)) return handleText(text, 'copier-coller')
  } catch { /* clipboard blocked: fall back to the manual field */ }
  $('manual').hidden = false
  $('pasteBox').focus()
}
for (const id of ['copyAddr', 'copyAddr2']) $(id).onclick = async () => { await copy(account.address); toast('Adresse copiée') }

// AirDrop / any link opens the app with #p=… (payment) or #r=… (request).
function handleHash() {
  if (!/arcdrop(-req)?:\d:/.test(location.hash)) return
  const h = location.hash
  history.replaceState(null, '', location.pathname + location.search)
  let text = h
  try { text = decodeURIComponent(h) } catch { /* malformed: use as is */ }
  handleText(text, 'lien')
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
  } catch { toast('Caméra indisponible') }
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
    if (m) { $('payTo').value = getAddress(m[1]); pendingRequest = null; renderWho(); renderNearby() } else toast('Pas une adresse')
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
  if (part && part.split > 1) $('splitInfo').textContent = `${money(part.total, activeRequest.token)} ÷ ${part.split} = ${money(part.value, activeRequest.token)} par personne`
  if (!part || part.value < 10_000n) { $('reqQr').dataset.qr = ''; $('reqQr').replaceChildren(); $('reqStatus').textContent = 'Tape un montant.'; return }
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
    ? `<b>✓ ${paid} réglé${paid > 1 ? 's' : ''} sur Arc</b>${got.length > paid ? ` · ${got.length - paid} en attente de réseau` : ''} · ${got.map(({ p }) => esc(nameOf(p.from))).join(', ')}`
    : `Le payeur scanne ce QR : ${money(activeRequest.value, activeRequest.token)} pour toi, déjà rempli.`
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
    for (const pending of acct.get('inbox', []).filter((i) => i.status === 'pending' && tryDecode(i.packet))) {
      const result = await settleOne(pending.packet, true, pending)
      if (result.status === 'settled' && !pending.settledAt) result.settledAt = Date.now()
      const item = updateEntry('inbox', pending.packet, result)
      renderInbox(); renderRequestStatus()
      if (!item) continue
      const p = decodePayment(item.packet)
      if (item.status === 'settled' && txUrl(hashOf(item.tx))) {
        confirmSettled({ title: 'Paiement reçu', amount: `+${money(item.received ? BigInt(item.received) : amountOf(item, p), p.token)}`, sub: `de ${nameOf(p.from)} · par ${item.via ?? '—'}`, ms: item.ms, tx: txUrl(hashOf(item.tx)) })
      }
    }
    // Strangers' payments: forwarded through the gateway only, never with our own gas.
    for (const r of relays.filter((x) => x.status === 'pending')) { Object.assign(r, await settleOne(r.packet, false, r)); renderInbox() }
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
  if (!c) return { status: 'pending', note: 'vérification sur Arc impossible pour le moment' }
  if (p.tab) {
    const prev = BigInt(item?.prev ?? 0)
    const got = c.paidUpTo > prev ? c.paidUpTo - prev : 0n
    if (got > 0n) return { status: 'partial', received: got.toString(), tx: c.tx, note: `payé ${money(got, p.token)} sur ${money(amountOf(item, p), p.token)} : ardoise dépassée ou vidée` }
    return { status: 'pending', note: 'ardoise pas encore encaissée' }
  }
  if (c.unknown) return { status: 'unverified', note: 'déjà utilisé sur Arc, mais preuve introuvable (règlement ancien ?) : ne compte pas comme payé' }
  return { status: 'failed', note: 'NON payé : le numéro de ce paiement a servi à une autre transaction' }
}

async function settleOne(packet, mine, item) {
  const p = decodePayment(packet)
  const now = Math.floor(Date.now() / 1000)
  const status = await checkPayment(p).catch(() => null)
  if (status?.settled || (p.tab && status?.paidUpTo > BigInt(item?.prev ?? 0) && !status.funded)) return proven(p, undefined, undefined, item)
  if (p.tab && status && status.tab.epoch !== p.epoch) return { status: 'failed', note: 'ardoise fermée avant encaissement : non payé' }
  if (p.tab && status && status.tab.expiry <= now) return { status: 'failed', note: 'ardoise expirée avant encaissement : non payé' }
  if (!p.tab && p.validBefore <= BigInt(now)) return { status: 'failed', note: 'expiré avant d’avoir été réglé' }
  if (status && !status.funded) return { status: 'pending', note: `payeur pas assez approvisionné (${money(status.payerBalance, p.token)})` }

  // 1) the gateway pays the gas. Its errors are never final: only chain evidence or expiry are.
  let gatewayNote
  try {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 12_000)
    const r = await fetch(`${gateway()}/api/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ packet }), signal: ctrl.signal })
    clearTimeout(timer)
    const out = await r.json()
    if (out.ok && out.hash) return proven(p, out.hash, Number(out.settleMs) || undefined, item)
    if (out.ok && out.alreadySettled) return proven(p, undefined, undefined, item)
    gatewayNote = String(out.error ?? `passerelle : ${r.status}`).slice(0, 100)
  } catch { gatewayNote = 'passerelle injoignable' }

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
      if (!p.tab && p.validBefore <= BigInt(Math.floor(Date.now() / 1000))) { updateEntry('sent', s.packet, { status: 'failed' }); continue }
      const st = await checkPayment(p)
      if (p.tab && st.tab.epoch !== p.epoch) { updateEntry('sent', s.packet, { status: 'failed' }); continue }
      if (st.settled) {
        const r = await proven(p, undefined, undefined, s)
        updateEntry('sent', s.packet, { status: r.status, settledAt: Date.now() })
        if (r.status === 'settled') confirmSettled({ title: 'Paiement réglé', amount: money(amountOf(s, p), p.token), sub: `à ${nameOf(p.to)} · final sur Arc`, tx: r.tx })
      }
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
  $('cSpeed').textContent = c.ms ? `⚡ Réglé sur Arc en ${(c.ms / 1000).toFixed(2).replace('.', ',')} s` : ''
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
const EMPTY = '<div class="empty">Aucun paiement pour l\'instant</div>'
const STATE = { pending: 'en attente', delivered: 'reçu ✓', settled: 'réglé', failed: 'échec', partial: 'partiel', unverified: 'à vérifier' }

document.addEventListener('click', (e) => {
  const row = e.target.closest('[data-expand]')
  if (row && !e.target.closest('a')) row.nextElementSibling.hidden = !row.nextElementSibling.hidden
})

// The payment's journey: signed offline → carried → settled.
function journey(item, p) {
  const s = item.status
  const carried = item.via === 'Bluetooth'
    ? `Reçu en Bluetooth${item.hops ? ` · ${item.hops} saut${item.hops > 1 ? 's' : ''} de téléphone en téléphone` : ''}`
    : `Reçu par ${item.via ?? '—'}`
  let settled = 'Réglé sur Arc'
  if (s === 'settled' && item.settledAt) {
    const mins = Math.round((item.settledAt - item.at) / 60_000)
    settled += ` à ${time(item.settledAt)}${mins >= 1 ? ` · ${mins} min après réception` : ''}`
  }
  if (item.ms) settled += ` · en ${(item.ms / 1000).toFixed(2).replace('.', ',')} s`
  return `<ol>
    <li class="done">Signé hors ligne par ${esc(nameOf(p.from))}${p.tab ? (item.guaranteed ? ' · 🔒 garanti par son ardoise' : ' · ardoise non vérifiée') : ''}</li>
    <li class="done">${carried} à ${time(item.at)} · signature vérifiée</li>
    <li class="${s === 'settled' ? 'done' : s === 'failed' ? 'fail' : ''}">${settled}${txUrl(hashOf(item.tx)) ? ` · <a href="${txUrl(hashOf(item.tx))}" target="_blank" rel="noopener">voir la tx</a>` : ''}</li>
  </ol>${item.note ? `<div class="note">${esc(item.note)}</div>` : ''}`
}

function txCell({ icon, kind, title, sub, amount, amountClass = '', status, details }) {
  return `<button class="cell tx" ${details ? 'data-expand' : ''}><span class="tx-ic ${kind}">${icon}</span>
    <span class="cell-main"><div>${esc(title)}</div><div class="cell-sub">${esc(sub)}</div></span>
    <span class="tx-end"><div class="tx-amt ${amountClass}">${amount}</div><div class="tx-state ${status}">${STATE[status]}</div></span></button>
    ${details ? `<div class="details" hidden>${details}</div>` : ''}`
}

function renderInbox() {
  const inbox = [...acct.get('inbox', []), ...relays]
  $('inbox').innerHTML = inbox.length ? inbox.slice(0, 100).map((item) => {
    const p = tryDecode(item.packet)
    if (!p) return ''
    const mine = p.to === account.address
    // A payment for someone else is only carried by this device: never show it as income.
    return txCell({
      icon: mine ? ICON_IN : ICON_RELAY, kind: mine ? 'in' : 'relay',
      title: mine ? `De ${nameOf(p.from)}` : 'Relayé',
      sub: (mine ? `par ${item.via ?? '—'}` : `${nameOf(p.from)} → ${nameOf(p.to)}`)
        + (p.tab && item.guaranteed && item.status === 'pending' && (item.redeemBefore ?? 0) > Date.now() / 1000 ? ` · 🔒 garanti jusqu’au ${day(item.redeemBefore)}` : ''),
      amount: `${mine ? '+' : ''}${money(item.received ? BigInt(item.received) : amountOf(item, p), p.token)}`, amountClass: mine && item.status === 'settled' ? 'in' : '',
      status: item.status, details: journey(item, p),
    })
  }).join('') : EMPTY
}

function renderSent() {
  const sent = acct.get('sent', [])
  $('sent').innerHTML = sent.length ? sent.map((s) => {
    const p = tryDecode(s.packet)
    if (!p) return ''
    const when = new Date(s.at).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    return txCell({
      icon: ICON_OUT, kind: 'out', title: `À ${nameOf(p.to)}`,
      sub: s.label ? `${s.label} · ${when}` : when,
      amount: `−${money(amountOf(s, p), p.token)}`,
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
$('myName').onchange = (e) => { store.set('name', e.target.value.trim()); announce(); toast('Nom visible par les appareils proches') }
$('exportKey').onclick = async () => { await copy(key); toast('Clé privée copiée. Ne la partage jamais.') }
$('importKey').onclick = () => {
  if (!confirm('Importer une clé remplace ce wallet sur cet appareil. As-tu exporté la clé actuelle ?')) return
  const k = prompt('Clé privée (0x…)')
  if (!k) return
  try {
    account = privateKeyToAccount(k.trim()); key = k.trim()
    store.set('key', key)
    if (mesh) mesh.postMessage({ type: 'saveKey', key, replace: true })
    contacts = acct.get('contacts', {})
    renderWallet(); renderInbox(); renderSent(); renderTabs(); announce(); refreshBalance(); toast('Clé importée')
  } catch { toast('Clé invalide') }
}

if ('serviceWorker' in navigator && !BUNDLED) navigator.serviceWorker.register('sw.js').catch(() => {})

fitAmount(); renderWallet(); renderInbox(); renderSent(); renderWho(); announce(); handleHash(); probe()
