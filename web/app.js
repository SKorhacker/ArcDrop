import QRCode from 'qrcode'
import jsQR from 'jsqr'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { isAddress, getAddress } from 'viem'
import {
  createPayment, encodePayment, decodePayment, verifyPayment, paymentLink, extractPacket,
  checkPayment, settlePayment, publicClient, formatUsdc, parseUsdc, CHAINS, USDC_ABI,
  tokenAddress, symbol, signedAt, createAck, readAck, encodeRequest, decodeRequest,
} from '../core/arcdrop.js'

const $ = (id) => document.getElementById(id)
const store = {
  get(k, d) { try { const v = localStorage.getItem('arcdrop.' + k); return v == null ? d : JSON.parse(v) } catch { return d } },
  set(k, v) { try { localStorage.setItem('arcdrop.' + k, JSON.stringify(v)) } catch {} },
}

// Inside the iOS app, the native side injects this handler (Bluetooth mesh, share sheet, Keychain).
const mesh = globalThis.webkit?.messageHandlers?.arcmesh

// ---------- wallet & settings ----------
// In the iOS app the key also lives in the Keychain (injected before this script runs),
// so it survives even if the web view's storage is cleared.
let key = globalThis.ARCDROP_NATIVE_KEY || store.get('key')
if (!key) key = generatePrivateKey()
store.set('key', key)
mesh?.postMessage({ type: 'saveKey', key })
let account = privateKeyToAccount(key)

// Default network is set at build time (ARCDROP_CHAIN=mainnet|testnet); `?net=` overrides it.
const NETS = { mainnet: 5042, testnet: 5042002 }
const urlNet = NETS[new URLSearchParams(location.search).get('net')]
if (urlNet) store.set('chain', urlNet)
let chainId = urlNet ?? store.get('chain', NETS[ARCDROP_CHAIN] ?? 5042002)
let token = store.get('token', 0) // 0 = USDC, 1 = EURC

// Inside the iOS app the page is a local file: talk to (and link to) the public deployment.
const PUBLIC_ORIGIN = 'https://arcdrop-pink.vercel.app'
const webOrigin = /^https?:$/.test(location.protocol) ? location.origin : PUBLIC_ORIGIN
const gateway = () => (store.get('gateway', '') || webOrigin).replace(/\/$/, '')

// Stored entries may be corrupted or from an older format: skip them instead of breaking the app.
const tryDecode = (packet) => { try { return decodePayment(packet) } catch { return null } }
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`
// Cents, rounded down so we never overstate; French decimal comma.
const fmt = (v) => formatUsdc(v - (v % 10_000n)).replace('.', ',')
const money = (v, t) => `${fmt(v)} ${symbol(t)}`
const time = (ms) => new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// Names learned over Bluetooth, so lists say "Mams" instead of 0x786b….
const contacts = store.get('contacts', {})
const nameOf = (addr) => contacts[getAddress(addr)] || short(addr)
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

function announce() {
  mesh?.postMessage({ type: 'profile', address: account.address, name: myName() })
}

function renderWallet() {
  $('myAddr').textContent = account.address
  $('myAddr2').textContent = account.address
  $('chainLabel').textContent = chainId === 5042 ? 'Arc' : 'Arc testnet'
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
  const b = store.get('balances', {})[balanceKey(t)]
  return b ? BigInt(b) : null
}

async function refreshBalance() {
  if (!online) return
  const client = publicClient(chainId)
  const balances = store.get('balances', {})
  for (const t of [0, 1]) {
    try {
      const b = await client.readContract({ address: tokenAddress(chainId, t), abi: USDC_ABI, functionName: 'balanceOf', args: [account.address] })
      balances[balanceKey(t)] = b.toString()
    } catch { /* offline or RPC hiccup; keep last value */ }
  }
  store.set('balances', balances)
  renderBalances()
}

function renderBalances() {
  const main = lastBalance(token), other = lastBalance(1 - token)
  $('balance').textContent = main == null ? '—' : money(main, token)
  $('balance2').hidden = !other
  $('balance2').textContent = other ? `et ${money(other, 1 - token)}` : ''
  renderAvail()
}

// Never promise more than the last balance seen on Arc, minus payments still pending.
// null = this wallet's balance was never seen online.
function availableOffline(t = token) {
  const last = lastBalance(t)
  if (last == null) return null
  const promised = store.get('sent', []).filter((s) => s.status === 'pending')
    .map((s) => tryDecode(s.packet)).filter((q) => q?.chainId === chainId && (q.token ?? 0) === t)
    .reduce((sum, q) => sum + q.value, 0n)
  const left = last - promised
  return left > 0n ? left : 0n
}

function renderAvail() {
  const a = availableOffline()
  $('avail').textContent = a == null ? '' : `Disponible : ${money(a, token)}`
}

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

function renderNearby() {
  $('nearbyBox').hidden = !nearby.length
  const selected = isAddress($('payTo').value.trim()) ? getAddress($('payTo').value.trim()) : null
  $('nearby').innerHTML = nearby.map((p) => {
    const label = p.name || short(p.address)
    return `<button class="peer" data-peer="${p.address}" aria-pressed="${selected === p.address}">
      <span class="av" aria-hidden="true">${esc((p.name || '?').trim().charAt(0).toUpperCase() || '?')}</span>
      <span class="nm">${esc(label)}</span><span class="ds">${distance(p.rssi)}</span></button>`
  }).join('')
}

$('nearby').addEventListener('click', (e) => {
  const b = e.target.closest('[data-peer]')
  if (!b) return
  $('payTo').value = b.dataset.peer
  pendingRequest = null
  renderWho(); renderNearby(); haptic('light')
})

// Called by the iOS app: the devices currently around, with their signal strength.
globalThis.arcdropNearby = (list) => {
  nearby = (list || [])
    .filter((p) => isAddress(p.address) && getAddress(p.address) !== account.address)
    .map((p) => ({ ...p, address: getAddress(p.address) }))
  let learned = false
  for (const p of nearby) if (p.name && contacts[p.address] !== p.name) { contacts[p.address] = p.name; learned = true }
  if (learned) { store.set('contacts', contacts); renderInbox(); renderSent() }
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
  if (known) parts.push(`À <b>${esc(nameOf(to))}</b>${near ? ' · à proximité' : ''}`)
  if (pendingRequest?.label) parts.push(`pour « ${esc(pendingRequest.label)} »`)
  $('payWho').hidden = !parts.length
  $('payWho').innerHTML = parts.join(' ')
}
$('payTo').addEventListener('input', () => { pendingRequest = null; renderWho(); renderNearby() })

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
  $('payAmount').value = fmt(r.value).replace(/,00$/, '')
  fitAmount(); renderWho(); renderNearby()
  tab('pay')
  toast(`Demande de ${nameOf(r.to)} : ${money(r.value, r.token)}`)
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
  const available = availableOffline()
  if (available == null) return toast("Ouvre l'app une fois en ligne pour connaître ton solde")
  if (value > available) { shake(); return toast(`Disponible : ${money(available, token)}`) }

  const p = await createPayment({ account, to, amount: value, chainId, token })
  const packet = encodePayment(p)
  // In the app, AirDrop an arcdrop:// link so the receiver's app opens it directly.
  lastPayment = { p, packet, link: paymentLink(p, mesh ? 'arcdrop://pay' : `${webOrigin}${location.protocol === 'file:' ? '/' : location.pathname}`) }
  const sent = store.get('sent', [])
  sent.unshift({ packet, at: Date.now(), status: 'pending', label: pendingRequest?.label })
  store.set('sent', sent)

  // Someone right next to us over Bluetooth: send it straight away.
  const near = nearby.some((n) => n.address === p.to)
  if (mesh && near) mesh.postMessage({ type: 'broadcast', packet })

  $('outAmount').textContent = money(p.value, p.token)
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
  const data = { title: 'ArcDrop', text: `${money(lastPayment.p.value, lastPayment.p.token)} pour toi via ArcDrop`, url: lastPayment.link }
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
async function importPacket(text, via, hops) {
  const raw = extractPacket(text)
  if (!raw) return toast('Aucun paiement ArcDrop trouvé')
  let p
  try { p = decodePayment(raw) } catch { return toast('Paiement illisible') }
  const v = await verifyPayment(p)
  if (!v.ok) return toast(v.reason === 'expired' ? 'Paiement expiré' : 'Signature invalide : refusé')
  const inbox = store.get('inbox', [])
  if (inbox.some((i) => i.packet === raw)) return
  inbox.unshift({ packet: raw, via, hops, at: Date.now(), status: 'pending' })
  store.set('inbox', inbox)
  const mine = p.to === account.address
  if (mine) {
    toast(`${money(p.value, p.token)} de ${nameOf(p.from)} · signature vérifiée`)
    haptic('success')
    // Tell the payer, over Bluetooth and without internet, that it arrived.
    if (mesh) mesh.postMessage({ type: 'broadcast', packet: await createAck(account, p) })
  }
  renderInbox(); renderRequestStatus()
  if (!activeRequest) tab('receive')
  if (online) settleAll()
}

// A receipt: the recipient signed the nonce of one of our payments.
globalThis.arcdropReceipt = async (text) => {
  let ack
  try { ack = await readAck(text) } catch { return }
  const sent = store.get('sent', [])
  const s = sent.find((x) => tryDecode(x.packet)?.nonce === ack.nonce)
  const p = s && tryDecode(s.packet)
  if (!p || p.to !== ack.signer || s.delivered) return
  s.delivered = Date.now()
  store.set('sent', sent); renderSent()
  toast(`✓ ${nameOf(p.to)} a reçu ${money(p.value, p.token)}`)
  haptic('success')
}

// The native side passes (packet, hops) for Bluetooth deliveries.
globalThis.arcdropReceive = (text, hops) => importPacket(text, 'Bluetooth', hops)
globalThis.arcdropOpenURL = (url) => handleText(url, 'AirDrop') // arcdrop://pay#p=… opened by iOS

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
  if (/arcdrop(-req)?:\d:/.test(location.hash)) {
    const h = decodeURIComponent(location.hash)
    history.replaceState(null, '', location.pathname + location.search)
    handleText(h, 'AirDrop')
  }
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
    const m = t.match(/0x[0-9a-fA-F]{40}/)
    tab('pay')
    if (m) { $('payTo').value = getAddress(m[0]); pendingRequest = null; renderWho(); renderNearby() } else toast('Pas une adresse')
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
  const got = store.get('inbox', []).map((i) => ({ i, p: tryDecode(i.packet) }))
    .filter(({ i, p }) => p && i.at >= activeRequest.since && p.to === account.address && p.value === activeRequest.value && (p.token ?? 0) === activeRequest.token)
  $('reqStatus').innerHTML = got.length
    ? `<b>✓ ${got.length} paiement${got.length > 1 ? 's' : ''} reçu${got.length > 1 ? 's' : ''}</b> · ${got.map(({ p }) => esc(nameOf(p.from))).join(', ')}`
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

async function settleAll() {
  if (settling || !online) return
  settling = true
  try {
    const inbox = store.get('inbox', [])
    for (const item of inbox.filter((i) => i.status === 'pending' && tryDecode(i.packet))) {
      Object.assign(item, await settleOne(item.packet))
      if (item.status === 'settled' && !item.settledAt) item.settledAt = Date.now()
      store.set('inbox', inbox); renderInbox()
      const p = decodePayment(item.packet)
      if (item.status === 'settled' && p.to === account.address && item.tx) {
        confirmSettled({ title: 'Paiement reçu', amount: `+${money(p.value, p.token)}`, sub: `de ${nameOf(p.from)} · par ${item.via ?? '—'}`, ms: item.ms, tx: item.tx })
      }
    }
    await refreshSent()
    refreshBalance()
  } finally { settling = false }
}

async function settleOne(packet) {
  const p = decodePayment(packet)
  const status = await checkPayment(p).catch(() => null)
  if (status?.settled) return { status: 'settled', note: 'déjà réglé sur Arc' }
  if (status && !status.funded) return { status: 'pending', note: `payeur pas assez approvisionné (${money(status.payerBalance, p.token)})` }

  // 1) the gateway pays the gas
  try {
    const r = await fetch(`${gateway()}/api/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ packet }) })
    const out = await r.json()
    if (out.ok && out.hash) return { status: 'settled', tx: out.url, ms: out.settleMs }
    if (out.ok && out.alreadySettled) return { status: 'settled', note: 'déjà réglé sur Arc' }
    if (!out.simulated && r.status !== 404) return { status: r.status === 402 ? 'pending' : 'failed', note: out.error }
  } catch { /* no gateway reachable: settle ourselves */ }

  // 2) this device pays the gas (fractions of a cent in USDC on Arc)
  try {
    const t0 = performance.now()
    const res = await settlePayment(p, { relayerAccount: account })
    return { status: res.status === 'success' ? 'settled' : 'failed', tx: res.url, ms: Math.round(performance.now() - t0) }
  } catch (e) {
    return { status: 'pending', note: `en attente : ${e.shortMessage ?? e.message}`.slice(0, 140) }
  }
}

async function refreshSent() {
  const sent = store.get('sent', [])
  for (const s of sent.filter((s) => s.status === 'pending')) {
    const p = tryDecode(s.packet)
    if (!p) continue
    try {
      if ((await checkPayment(p)).settled) {
        s.status = 'settled'
        s.settledAt = Date.now()
        confirmSettled({ title: 'Paiement réglé', amount: money(p.value, p.token), sub: `à ${nameOf(p.to)} · final sur Arc` })
      }
    } catch {}
  }
  store.set('sent', sent); renderSent()
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
  $('cLink').hidden = !c.tx
  if (c.tx) $('cLink').href = c.tx
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
const STATE = { pending: 'en attente', delivered: 'reçu ✓', settled: 'réglé', failed: 'échec' }

document.addEventListener('click', (e) => {
  const row = e.target.closest('[data-expand]')
  if (row && !e.target.closest('a')) row.nextElementSibling.hidden = !row.nextElementSibling.hidden
})

// The payment's journey: signed offline → carried → settled.
function journey(item, p) {
  const s = item.status
  const signed = signedAt(p) * 1000
  const carried = item.via === 'Bluetooth'
    ? `Reçu en Bluetooth${item.hops ? ` · ${item.hops} saut${item.hops > 1 ? 's' : ''} de téléphone en téléphone` : ''}`
    : `Reçu par ${item.via ?? '—'}`
  let settled = 'Réglé sur Arc'
  if (s === 'settled' && item.settledAt) {
    const mins = Math.round((item.settledAt - signed) / 60_000)
    settled += ` à ${time(item.settledAt)}${mins >= 1 ? ` · ${mins} min après la signature` : ''}`
  }
  if (item.ms) settled += ` · en ${(item.ms / 1000).toFixed(2).replace('.', ',')} s`
  return `<ol>
    <li class="done">Signé hors ligne à ${time(signed)}</li>
    <li class="done">${carried} · signature vérifiée</li>
    <li class="${s === 'settled' ? 'done' : s === 'failed' ? 'fail' : ''}">${settled}${item.tx ? ` · <a href="${item.tx}" target="_blank" rel="noopener">voir la tx</a>` : ''}</li>
  </ol>${item.note ? `<div class="note">${esc(item.note)}</div>` : ''}`
}

function txCell({ icon, kind, title, sub, amount, amountClass = '', status, details }) {
  return `<button class="cell tx" ${details ? 'data-expand' : ''}><span class="tx-ic ${kind}">${icon}</span>
    <span class="cell-main"><div>${esc(title)}</div><div class="cell-sub">${esc(sub)}</div></span>
    <span class="tx-end"><div class="tx-amt ${amountClass}">${amount}</div><div class="tx-state ${status}">${STATE[status]}</div></span></button>
    ${details ? `<div class="details" hidden>${details}</div>` : ''}`
}

function renderInbox() {
  const inbox = store.get('inbox', [])
  $('inbox').innerHTML = inbox.length ? inbox.map((item) => {
    const p = tryDecode(item.packet)
    if (!p) return ''
    const mine = p.to === account.address
    // A payment for someone else is only carried by this device: never show it as income.
    return txCell({
      icon: mine ? ICON_IN : ICON_RELAY, kind: mine ? 'in' : 'relay',
      title: mine ? `De ${nameOf(p.from)}` : 'Relayé',
      sub: mine ? `par ${item.via ?? '—'}` : `${nameOf(p.from)} → ${nameOf(p.to)}`,
      amount: `${mine ? '+' : ''}${money(p.value, p.token)}`, amountClass: mine ? 'in' : '',
      status: item.status, details: journey(item, p),
    })
  }).join('') : EMPTY
}

function renderSent() {
  const sent = store.get('sent', [])
  $('sent').innerHTML = sent.length ? sent.map((s) => {
    const p = tryDecode(s.packet)
    if (!p) return ''
    const when = new Date(s.at).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    return txCell({
      icon: ICON_OUT, kind: 'out', title: `À ${nameOf(p.to)}`,
      sub: s.label ? `${s.label} · ${when}` : when,
      amount: `−${money(p.value, p.token)}`,
      status: s.status === 'pending' && s.delivered ? 'delivered' : s.status,
    })
  }).join('') : EMPTY
}

// ---------- tabs & settings ----------
function tab(name) {
  for (const b of document.querySelectorAll('nav button')) b.setAttribute('aria-selected', String(b.dataset.tab === name))
  for (const s of document.querySelectorAll('section')) s.hidden = s.id !== `tab-${name}`
  $('compactTitle').textContent = $(`tab-${name}`).dataset.title
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
  const k = prompt('Clé privée (0x…)')
  if (!k) return
  try {
    account = privateKeyToAccount(k.trim()); key = k.trim(); store.set('key', key)
    mesh?.postMessage({ type: 'saveKey', key })
    renderWallet(); announce(); refreshBalance(); toast('Clé importée')
  } catch { toast('Clé invalide') }
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {})

fitAmount(); renderWallet(); renderInbox(); renderSent(); renderWho(); announce(); handleHash(); probe()
