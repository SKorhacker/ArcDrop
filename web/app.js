import QRCode from 'qrcode'
import jsQR from 'jsqr'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { isAddress, getAddress } from 'viem'
import {
  createPayment, encodePayment, decodePayment, verifyPayment, paymentLink, extractPacket,
  checkPayment, settlePayment, publicClient, formatUsdc, parseUsdc, CHAINS, USDC, USDC_ABI,
} from '../core/arcdrop.js'

const $ = (id) => document.getElementById(id)
const store = {
  get(k, d) { try { const v = localStorage.getItem('arcdrop.' + k); return v == null ? d : JSON.parse(v) } catch { return d } },
  set(k, v) { try { localStorage.setItem('arcdrop.' + k, JSON.stringify(v)) } catch {} },
}

// Inside the iOS app, the native side injects this handler (Bluetooth mesh, share sheet).
const mesh = globalThis.webkit?.messageHandlers?.arcmesh

// ---------- wallet ----------
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
// Inside the iOS app the page is a local file: talk to (and link to) the public deployment.
const PUBLIC_ORIGIN = 'https://arcdrop-pink.vercel.app'
const webOrigin = /^https?:$/.test(location.protocol) ? location.origin : PUBLIC_ORIGIN
const gateway = () => (store.get('gateway', '') || webOrigin).replace(/\/$/, '')
// Stored entries may be corrupted or from an older format: skip them instead of breaking the app.
const tryDecode = (packet) => { try { return decodePayment(packet) } catch { return null } }
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`
const explorer = () => CHAINS[chainId].blockExplorers.default.url

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show')
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600)
}

async function qrInto(el, text) {
  el.innerHTML = ''
  const img = new Image()
  img.alt = 'QR code'
  img.src = await QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 1, width: 640 })
  el.append(img)
}

function renderWallet() {
  $('myAddr').textContent = account.address
  $('myAddr2').textContent = account.address
  $('chainLabel').textContent = chainId === 5042 ? 'Arc' : 'Arc testnet'
  $('chainSel').value = String(chainId)
  $('gateway').value = store.get('gateway', '')
  qrInto($('myQr'), account.address)
}

async function refreshBalance() {
  if (!online) return
  try {
    const b = await publicClient(chainId).readContract({ address: USDC, abi: USDC_ABI, functionName: 'balanceOf', args: [account.address] })
    // Gas leaves dust like 0.497821: show cents, rounded down so we never overstate.
    $('balance').textContent = `${formatUsdc(b - (b % 10_000n)).replace('.', ',')} USDC`
    store.set('lastBalance', { chainId, value: b.toString(), at: Date.now() })
    renderAvail()
  } catch { /* offline or RPC hiccup; keep last value */ }
}

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
    if (ok) { toast('Réseau retrouvé : règlement des paiements en attente…'); refreshBalance(); settleAll() }
  }
}
addEventListener('online', probe); addEventListener('offline', probe)
setInterval(probe, 5000)

// ---------- pay ----------
let lastPayment = null
const fmt = (v) => formatUsdc(v - (v % 10_000n)).replace('.', ',')

// Offline spending cap: never promise more than the last balance seen on Arc,
// minus what is already promised and not yet settled. null = balance never seen.
function availableOffline() {
  const last = store.get('lastBalance')
  if (!last || last.chainId !== chainId) return null
  const promised = store.get('sent', []).filter((s) => s.status === 'pending')
    .map((s) => tryDecode(s.packet)).filter((q) => q?.chainId === chainId)
    .reduce((sum, q) => sum + q.value, 0n)
  const left = BigInt(last.value) - promised
  return left > 0n ? left : 0n
}

function renderAvail() {
  const a = availableOffline()
  $('avail').textContent = a == null ? '' : `Disponible : ${fmt(a)} USDC`
}

function shake() {
  const box = $('amountBox')
  box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake')
  navigator.vibrate?.(30)
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

function openSheet() {
  $('scrim').hidden = false; $('payOut').hidden = false
  requestAnimationFrame(() => requestAnimationFrame(() => { $('scrim').classList.add('show'); $('payOut').classList.add('show') }))
}
function closeSheet() {
  $('scrim').classList.remove('show'); $('payOut').classList.remove('show')
  setTimeout(() => { $('scrim').hidden = true; $('payOut').hidden = true }, 450)
}
$('closeSheet').onclick = closeSheet
$('scrim').onclick = closeSheet

$('signBtn').onclick = async () => {
  const to = $('payTo').value.trim()
  if (!isAddress(to)) return toast('Adresse destinataire invalide')
  let value
  try { value = parseUsdc($('payAmount').value.replace(',', '.') || '0') } catch { return toast('Montant invalide') }
  if (value < 10_000n) { shake(); return toast('Minimum 0,01 USDC') }
  if (getAddress(to) === account.address) return toast("C'est ta propre adresse")
  const available = availableOffline()
  if (available == null) return toast('Ouvre l\'app une fois en ligne pour connaître ton solde')
  if (value > available) { shake(); return toast(`Disponible : ${fmt(available)} USDC`) }
  const p = await createPayment({ account, to, amount: value, chainId })
  const packet = encodePayment(p)
  // In the app, AirDrop an arcdrop:// link so the receiver's app opens it directly.
  lastPayment = { p, packet, link: paymentLink(p, mesh ? 'arcdrop://pay' : `${webOrigin}${location.protocol === 'file:' ? '/' : location.pathname}`) }
  const sent = store.get('sent', [])
  sent.unshift({ packet, at: Date.now(), status: 'pending' })
  store.set('sent', sent)
  $('outAmount').textContent = `${formatUsdc(p.value).replace('.', ',')} USDC`
  $('outTo').textContent = `à ${short(p.to)}`
  await qrInto($('outQr'), lastPayment.link)
  openSheet()
  $('payAmount').value = ''; fitAmount()
  renderSent(); renderAvail()
}

$('tQr').onclick = () => toast('Ton pote scanne ce QR depuis « Recevoir »')

// AirDrop: the iOS share sheet offers AirDrop and works without internet.
$('tShare').onclick = async () => {
  if (!lastPayment) return
  const amount = formatUsdc(lastPayment.p.value)
  const data = { title: 'ArcDrop', text: `${amount} USDC pour toi via ArcDrop`, url: lastPayment.link }
  if (mesh) return mesh.postMessage({ type: 'share', ...data }) // native share sheet in the iOS app
  if (navigator.share) {
    try { await navigator.share(data) } catch (e) { if (e.name !== 'AbortError') toast('Partage impossible') }
  } else {
    await copy(lastPayment.link); toast('Lien copié (pas de feuille de partage ici)')
  }
}

// Bluetooth mesh: only the native iOS app can use Bluetooth (see `mesh` above).
$('tMesh').onclick = () => {
  if (!lastPayment) return
  if (!mesh) return toast("Le Bluetooth arrive avec l'app iOS. Ici : QR ou AirDrop.")
  mesh.postMessage({ type: 'broadcast', packet: lastPayment.packet })
  toast('Diffusé en Bluetooth aux appareils proches')
}
// Called by the iOS app when a packet arrives over the mesh, and when neighbors come and go.
globalThis.arcdropReceive = (text) => importPacket(text, 'Bluetooth')
globalThis.arcdropOpenURL = (url) => importPacket(url, 'AirDrop') // arcdrop://pay#p=… opened by iOS
globalThis.arcdropMeshPeers = (n) => {
  $('meshPeers').hidden = false
  $('meshPeers').textContent = n ? `${n} proche${n > 1 ? 's' : ''}` : 'personne autour'
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text) } catch {
    const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove()
  }
}

// ---------- receive ----------
async function importPacket(text, via) {
  const raw = extractPacket(text)
  if (!raw) return toast('Aucun paiement ArcDrop trouvé')
  let p
  try { p = decodePayment(raw) } catch { return toast('Paiement illisible') }
  const v = await verifyPayment(p)
  if (!v.ok) return toast(v.reason === 'expired' ? 'Paiement expiré' : 'Signature invalide : refusé')
  const inbox = store.get('inbox', [])
  if (inbox.some((i) => i.packet === raw)) { toast('Déjà reçu'); return tab('receive') }
  inbox.unshift({ packet: raw, via, at: Date.now(), status: 'pending' })
  store.set('inbox', inbox)
  const mine = p.to === account.address
  toast(mine ? `${formatUsdc(p.value)} USDC reçus par ${via} · signature vérifiée` : `Paiement pour un autre appareil : tu le relaies vers Arc`)
  renderInbox(); tab('receive')
  if (online) settleAll()
}

$('importBtn').onclick = () => { importPacket($('pasteBox').value, 'copier-coller'); $('pasteBox').value = '' }
// The amount field grows with its content so "USDC" stays right next to the number.
// The amount field is as wide as its text, so "USDC" sits right next to the number.
const measure = document.createElement('canvas').getContext('2d')
function fitAmount() {
  const el = $('payAmount')
  const cs = getComputedStyle(el)
  measure.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  el.style.width = `${Math.ceil(measure.measureText(el.value || el.placeholder).width) + 2}px`
}
fitAmount()
$('pastePay').onclick = async () => {
  try {
    const text = await navigator.clipboard.readText()
    if (extractPacket(text)) return importPacket(text, 'copier-coller')
  } catch { /* clipboard blocked: fall back to the manual field */ }
  $('manual').hidden = false
  $('pasteBox').focus()
}
for (const id of ['copyAddr', 'copyAddr2']) $(id).onclick = async () => { await copy(account.address); toast('Adresse copiée') }

// AirDrop / any link opens the app with #p=…
function handleHash() {
  if (location.hash.includes('arcdrop:1:')) {
    const h = location.hash
    history.replaceState(null, '', location.pathname)
    importPacket(h, 'AirDrop')
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
    const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d', { willReadFrequently: true })
    scanning = { stream }
    const tick = () => {
      if (!scanning) return
      if (video.readyState >= 2) {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight
        ctx.drawImage(video, 0, 0)
        const code = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
        if (code?.data) { stopScan(); return onText(code.data) }
      }
      requestAnimationFrame(tick)
    }
    tick()
  } catch { toast('Caméra indisponible (HTTPS requis)') }
}
function stopScan() {
  if (scanning) scanning.stream.getTracks().forEach((t) => t.stop())
  scanning = null; $('video').hidden = true
}
$('scanPay').onclick = () => scan((t) => importPacket(t, 'QR code'))
$('scanTo').onclick = () => { tab('receive'); scan((t) => {
  const m = t.match(/0x[0-9a-fA-F]{40}/)
  tab('pay')
  if (m) { $('payTo').value = getAddress(m[0]); $('payAmount').focus() } else toast('Pas une adresse')
}) }

// ---------- settlement ----------
let settling = false
// ---------- confirmation ----------
// Shown once per payment, when it becomes final on Arc while the app is open.
const confirmQueue = []
function confirmSettled({ title, amount, sub, ms, tx }) {
  confirmQueue.push({ title, amount, sub, ms, tx })
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
function haptic(kind) {
  if (mesh) mesh.postMessage({ type: 'haptic', kind }) // real Taptic Engine in the iOS app
  else navigator.vibrate?.(kind === 'success' ? [20, 60, 30] : 30)
}

async function settleAll() {
  if (settling || !online) return
  settling = true
  try {
    const inbox = store.get('inbox', [])
    for (const item of inbox.filter((i) => i.status === 'pending' && tryDecode(i.packet))) {
      Object.assign(item, await settleOne(item.packet))
      store.set('inbox', inbox); renderInbox()
      const p = decodePayment(item.packet)
      if (item.status === 'settled' && p.to === account.address && item.tx) {
        confirmSettled({ title: 'Paiement reçu', amount: `+${fmt(p.value)} USDC`, sub: `de ${short(p.from)} · par ${item.via ?? '—'}`, ms: item.ms, tx: item.tx })
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
  if (status && !status.funded) return { status: 'pending', note: `payeur pas assez approvisionné (${formatUsdc(status.payerBalance)} USDC)` }

  // 1) gateway pays the gas
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
        confirmSettled({ title: 'Paiement réglé', amount: `${fmt(p.value)} USDC`, sub: `à ${short(p.to)} · final sur Arc` })
      }
    } catch {}
  }
  store.set('sent', sent); renderSent()
}

// ---------- render ----------

const ICON_IN = '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>'
const ICON_OUT = '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>'
const ICON_RELAY = '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 12h16M14 6l6 6-6 6"/></svg>'
const EMPTY = '<div class="empty">Aucun paiement pour l\'instant</div>'
document.addEventListener('click', (e) => {
  const row = e.target.closest('[data-expand]')
  if (row && !e.target.closest('a')) row.nextElementSibling.hidden = !row.nextElementSibling.hidden
})

const STATE = { pending: 'en attente', settled: 'réglé', failed: 'échec' }

function steps(item) {
  const s = item.status
  return `<ol>
    <li class="done">Signé hors ligne par le payeur</li>
    <li class="done">Reçu par ${item.via ?? '—'} · signature vérifiée</li>
    <li class="${s === 'settled' ? 'done' : s === 'failed' ? 'fail' : ''}">Réglé sur Arc${item.ms ? ` en ${(item.ms / 1000).toFixed(2)} s` : ''}${item.tx ? ` · <a href="${item.tx}" target="_blank" rel="noopener">voir la tx</a>` : ''}</li>
  </ol>${item.note ? `<div class="note">${item.note}</div>` : ''}`
}

function txCell({ icon, kind, title, sub, amount, amountClass = '', status, details }) {
  return `<button class="cell tx" ${details ? 'data-expand' : ''}><span class="tx-ic ${kind}">${icon}</span>
    <span class="cell-main"><div>${title}</div><div class="cell-sub">${sub}</div></span>
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
      title: mine ? `De ${short(p.from)}` : 'Relayé',
      sub: mine ? `par ${item.via ?? '—'}` : `${short(p.from)} → ${short(p.to)}`,
      amount: `${mine ? '+' : ''}${formatUsdc(p.value).replace('.', ',')}`, amountClass: mine ? 'in' : '',
      status: item.status, details: steps(item),
    })
  }).join('') : EMPTY
}

function renderSent() {
  const sent = store.get('sent', [])
  $('sent').innerHTML = sent.length ? sent.map((s) => {
    const p = tryDecode(s.packet)
    if (!p) return ''
    return txCell({
      icon: ICON_OUT, kind: 'out', title: `À ${short(p.to)}`,
      sub: new Date(s.at).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
      amount: `−${formatUsdc(p.value).replace('.', ',')}`, status: s.status,
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
$('exportKey').onclick = async () => { await copy(key); toast('Clé privée copiée. Ne la partage jamais.') }
$('importKey').onclick = () => {
  const k = prompt('Clé privée (0x…)')
  if (!k) return
  try {
    account = privateKeyToAccount(k.trim()); key = k.trim(); store.set('key', key)
    mesh?.postMessage({ type: 'saveKey', key })
    renderWallet(); refreshBalance(); toast('Clé importée')
  } catch { toast('Clé invalide') }
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {})

renderWallet(); renderInbox(); renderSent(); renderAvail(); handleHash(); probe()
