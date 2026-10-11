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
let key = store.get('key')
if (!key) { key = generatePrivateKey(); store.set('key', key) }
let account = privateKeyToAccount(key)
// Default network is set at build time (ARCDROP_CHAIN=mainnet|testnet); `?net=` overrides it.
const NETS = { mainnet: 5042, testnet: 5042002 }
const urlNet = NETS[new URLSearchParams(location.search).get('net')]
if (urlNet) store.set('chain', urlNet)
let chainId = urlNet ?? store.get('chain', NETS[ARCDROP_CHAIN] ?? 5042002)
const gateway = () => (store.get('gateway', '') || location.origin).replace(/\/$/, '')
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
    $('balance').textContent = `${formatUsdc(b - (b % 10_000n))} USDC`
    store.set('lastBalance', { chainId, value: b.toString(), at: Date.now() })
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

$('signBtn').onclick = async () => {
  const to = $('payTo').value.trim()
  if (!isAddress(to)) return toast('Adresse destinataire invalide')
  let value
  try { value = parseUsdc($('payAmount').value.replace(',', '.') || '0') } catch { return toast('Montant invalide') }
  if (value < 10_000n) return toast('Minimum 0,01 USDC')
  if (getAddress(to) === account.address) return toast("C'est ta propre adresse")
  // Offline spending cap: never promise more than the last balance seen on Arc,
  // minus what is already promised and not yet settled.
  const last = store.get('lastBalance')
  if (!last || last.chainId !== chainId) return toast('Ouvre l\'app une fois en ligne pour connaître ton solde')
  const promised = store.get('sent', []).filter((s) => s.status === 'pending')
    .map((s) => tryDecode(s.packet)).filter((q) => q?.chainId === chainId)
    .reduce((sum, q) => sum + q.value, 0n)
  const available = BigInt(last.value) - promised
  if (value > available) return toast(`Solde hors ligne disponible : ${formatUsdc(available > 0n ? available : 0n)} USDC`)
  const p = await createPayment({ account, to, amount: value, chainId })
  const packet = encodePayment(p)
  lastPayment = { p, packet, link: paymentLink(p, location.origin + location.pathname) }
  const sent = store.get('sent', [])
  sent.unshift({ packet, at: Date.now(), status: 'pending' })
  store.set('sent', sent)
  $('outAmount').textContent = `${formatUsdc(p.value)} USDC`
  $('outTo').textContent = `à ${p.to}`
  await qrInto($('outQr'), lastPayment.link)
  $('payOut').hidden = false
  $('payOut').scrollIntoView({ behavior: 'smooth' })
  renderSent()
}

$('tQr').onclick = () => { $('outQr').scrollIntoView({ behavior: 'smooth' }); toast('Ton pote scanne ce QR depuis « Recevoir »') }

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
const fitAmount = () => { const el = $('payAmount'); el.style.width = `${Math.max(1, (el.value || el.placeholder).length) + 0.2}ch` }
$('payAmount').addEventListener('input', fitAmount)
fitAmount()
for (const b of document.querySelectorAll('[data-amount]')) b.onclick = () => { $('payAmount').value = b.dataset.amount; fitAmount(); $('payTo').focus() }
$('pastePay').onclick = async () => {
  try { importPacket(await navigator.clipboard.readText(), 'copier-coller') } catch { $('pasteBox').focus() }
}

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
async function settleAll() {
  if (settling || !online) return
  settling = true
  try {
    const inbox = store.get('inbox', [])
    for (const item of inbox.filter((i) => i.status === 'pending' && tryDecode(i.packet))) {
      Object.assign(item, await settleOne(item.packet))
      store.set('inbox', inbox); renderInbox()
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
    try { if ((await checkPayment(p)).settled) s.status = 'settled' } catch {}
  }
  store.set('sent', sent); renderSent()
}

// ---------- render ----------
const LABEL = { pending: 'en attente', settled: 'réglé sur Arc', failed: 'échec' }

const ICON_IN = '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>'
const ICON_OUT = '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>'
const ICON_RELAY = '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 12h16M14 6l6 6-6 6"/></svg>'
const EMPTY = '<div class="empty">Rien pour l\'instant.</div>'

function steps(item) {
  const s = item.status
  return `<ol class="steps">
    <li class="done">Signé hors ligne par le payeur</li>
    <li class="done">Reçu par ${item.via ?? '—'} · signature vérifiée</li>
    <li class="${s === 'settled' ? 'done' : s === 'failed' ? 'fail' : ''}">Réglé sur Arc${item.ms ? ` en ${(item.ms / 1000).toFixed(2)} s` : ''}${item.tx ? ` · <a href="${item.tx}" target="_blank" rel="noopener">voir la tx</a>` : ''}</li>
  </ol>${item.note ? `<div class="note">${item.note}</div>` : ''}`
}

function renderInbox() {
  const inbox = store.get('inbox', [])
  $('inbox').innerHTML = inbox.length ? inbox.map((item) => {
    const p = tryDecode(item.packet)
    if (!p) return ''
    const mine = p.to === account.address
    // A payment for someone else is only carried by this device: never show it as income.
    return `<div class="tx"><div class="tx-top"><span class="tx-ic ${mine ? '' : 'relay'}">${mine ? ICON_IN : ICON_RELAY}</span>
      <div class="tx-main"><div class="tx-amt">${mine ? '+' : ''}${formatUsdc(p.value)} USDC</div>
      <div class="tx-sub">${mine ? `de ${short(p.from)}` : `relayé : ${short(p.from)} → ${short(p.to)}`}</div></div>
      <span class="pill ${item.status}">${LABEL[item.status]}</span></div>${steps(item)}</div>`
  }).join('') : EMPTY
}

function renderSent() {
  const sent = store.get('sent', [])
  $('sent').innerHTML = sent.length ? sent.map((s) => {
    const p = tryDecode(s.packet)
    if (!p) return ''
    return `<div class="tx"><div class="tx-top"><span class="tx-ic out">${ICON_OUT}</span>
      <div class="tx-main"><div class="tx-amt">−${formatUsdc(p.value)} USDC</div>
      <div class="tx-sub">à ${short(p.to)} · ${new Date(s.at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</div></div>
      <span class="pill ${s.status}">${LABEL[s.status]}</span></div></div>`
  }).join('') : EMPTY
}

// ---------- tabs & settings ----------
function tab(name) {
  for (const b of document.querySelectorAll('nav button')) b.setAttribute('aria-selected', String(b.dataset.tab === name))
  for (const s of document.querySelectorAll('section')) s.hidden = s.id !== `tab-${name}`
  scrollTo({ top: 0 })
  if (name !== 'receive') stopScan()
}
for (const b of document.querySelectorAll('nav button')) b.onclick = () => tab(b.dataset.tab)

$('chainSel').onchange = (e) => { chainId = Number(e.target.value); store.set('chain', chainId); online = false; renderWallet(); probe() }
$('gateway').onchange = (e) => store.set('gateway', e.target.value.trim())
$('exportKey').onclick = async () => { await copy(key); toast('Clé privée copiée. Ne la partage jamais.') }
$('importKey').onclick = () => {
  const k = prompt('Clé privée (0x…)')
  if (!k) return
  try { account = privateKeyToAccount(k.trim()); key = k.trim(); store.set('key', key); renderWallet(); refreshBalance(); toast('Clé importée') } catch { toast('Clé invalide') }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {})

renderWallet(); renderInbox(); renderSent(); handleHash(); probe()
