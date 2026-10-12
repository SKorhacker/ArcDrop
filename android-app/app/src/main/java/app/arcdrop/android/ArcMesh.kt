package app.arcdrop.android

import android.annotation.SuppressLint
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.ParcelUuid
import android.util.Base64
import java.security.MessageDigest
import java.util.UUID
import kotlin.random.Random

/**
 * ArcDrop's Bluetooth LE mesh, Android side. Wire-compatible with mesh/ArcMesh.swift:
 * same service/characteristic UUIDs, same frames (msgId 4 | index 1 | count 1 | hops 1 | chunk),
 * same envelopes (1 payment, 2 hello, 3 receipt) and the same safety rules (plausibility filter,
 * per-kind quotas, own payments never evicted, per-payer cap, per-link token buckets, per-link
 * reassembly, hop-poisoning repair, periodic resync).
 *
 * Every device is both a peripheral (advertises a GATT server) and a central (scans, connects),
 * so Android and iPhone talk directly. Payments and receipts are store-and-forward.
 */
@SuppressLint("MissingPermission") // MainActivity only starts the mesh once permissions are granted
class ArcMesh(private val context: Context, private val listener: Listener) {

    interface Listener {
        /** A payment seen for the first time. It is stored and forwarded only once the app
         *  has checked its signature and called [vouch]. */
        fun onPayment(packet: String, hops: Int)
        fun onReceipt(receipt: String)
        fun onNearby(peers: List<NearbyPeer>)
        fun onPeers(count: Int)
    }

    data class NearbyPeer(val address: String, val name: String, val rssi: Int?)

    companion object {
        val SERVICE: UUID = UUID.fromString("A7C0D509-5E1F-4B8E-9A3B-1D2C3E4F5A60")
        val PACKET: UUID = UUID.fromString("A7C0D509-5E1F-4B8E-9A3B-1D2C3E4F5A61")
        val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        const val KIND_PAYMENT: Byte = 1
        const val KIND_HELLO: Byte = 2
        const val KIND_RECEIPT: Byte = 3

        const val MAX_HOPS = 7
        const val MAX_STORED = 500
        const val MAX_STORED_RECEIPTS = 100
        const val MAX_PER_PAYER = 5
        const val FRAME_HEADER = 7
        const val HELLO_EVERY_MS = 5_000L
        const val NEARBY_TIMEOUT_MS = 20_000L
        const val CATCHUP_COOLDOWN_MS = 30_000L
        const val MAX_NEARBY = 30
        const val MAX_LINKS = 300
        const val MAX_OUTBOUND = 6 // Android stacks hold ~7 LE connections
        const val CONNECT_BACKOFF_MS = 30_000L
        const val WRITE_WATCHDOG_MS = 2_000L
        const val PARTIAL_LIFETIME_MS = 10_000L
        const val MAX_AWAITING = 2000
        const val MAX_OWN = 200
        const val STORED_LIFETIME_MS = 30L * 86_400_000 // the longest tab
        const val LINK_BURST = 600.0
        const val LINK_REFILL_PER_S = 1.0
        const val FRAME_BURST = 4000.0
        const val FRAME_REFILL_PER_S = 20.0
        const val MAX_PENDING_WRITES = 200
        val KNOWN_CHAINS = setOf(5042L, 5042002L)

        // ---- text <-> envelope (same encodings as core/arcdrop.js) ----
        private val PREFIXES = listOf(
            Triple("arcdrop:4:", KIND_PAYMENT, 122),
            Triple("arcdrop:2:", KIND_PAYMENT, 158),
            Triple("arcdrop:1:", KIND_PAYMENT, 157),
            Triple("arcdrop-ack:2:", KIND_RECEIPT, 97),
        )

        fun envelopeFrom(text: String): ByteArray? {
            for ((prefix, kind, length) in PREFIXES) {
                val i = text.indexOf(prefix)
                if (i < 0) continue
                val body = text.substring(i + prefix.length).takeWhile { it.isLetterOrDigit() || it == '-' || it == '_' }
                val data = try { Base64.decode(body, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP) } catch (e: IllegalArgumentException) { return null }
                if (data.size != length) return null
                return byteArrayOf(kind) + data
            }
            return null
        }

        fun textFrom(envelope: ByteArray): String? {
            if (envelope.isEmpty()) return null
            val body = envelope.copyOfRange(1, envelope.size)
            val b64 = Base64.encodeToString(body, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
            return when (envelope[0]) {
                KIND_PAYMENT -> when (body.size) { 157 -> "arcdrop:1:$b64"; 158 -> "arcdrop:2:$b64"; 122 -> "arcdrop:4:$b64"; else -> null }
                KIND_RECEIPT -> if (body.size == 97) "arcdrop-ack:2:$b64" else null
                else -> null
            }
        }

        private fun u(b: ByteArray, o: Int, n: Int): Long {
            var v = 0L
            for (i in o until o + n) v = (v shl 8) or (b[i].toLong() and 0xff)
            return v
        }

        /** Cheap structural checks (signatures are verified by the app): junk is neither stored nor forwarded. */
        fun plausible(e: ByteArray, nowSec: Long = System.currentTimeMillis() / 1000): Boolean {
            if (e.isEmpty()) return false
            if (e[0] == KIND_RECEIPT) return e.size == 98
            if (e[0] != KIND_PAYMENT) return false
            return when (e.size - 1) {
                157, 158 -> {
                    val o = if (e.size - 1 == 158) 2 else 1
                    if (o == 2 && e[1].toInt() != 1) return false // v2 is EURC only
                    val validBefore = u(e, o + 56, 4)
                    KNOWN_CHAINS.contains(u(e, o, 4)) && u(e, o + 44, 8) >= 10_000 && u(e, o + 52, 4) <= nowSec &&
                        validBefore > nowSec && validBefore <= nowSec + 8 * 86_400
                }
                122 -> (e[1].toInt() and 0xff) <= 1 && KNOWN_CHAINS.contains(u(e, 2, 4)) && u(e, 50, 8) >= 10_000
                else -> false
            }
        }

        /** (payer, recipient) of a payment envelope. */
        fun parties(e: ByteArray): Pair<ByteArray, ByteArray>? {
            if (e.isEmpty() || e[0] != KIND_PAYMENT) return null
            val o = when (e.size - 1) { 157 -> 5; 158, 122 -> 6; else -> return null }
            return e.copyOfRange(o, o + 20) to e.copyOfRange(o + 20, o + 40)
        }

        fun frames(bytes: ByteArray, hops: Int, maxLength: Int): List<ByteArray> {
            val chunk = maxOf(1, minOf(maxLength, 512) - FRAME_HEADER)
            val count = (bytes.size + chunk - 1) / chunk
            val id = Random.nextBytes(4)
            return (0 until count).map { i ->
                id + byteArrayOf(i.toByte(), count.toByte(), hops.toByte()) + bytes.copyOfRange(i * chunk, minOf(bytes.size, (i + 1) * chunk))
            }
        }
    }

    /** Reassembles frames per link (a device can't complete another's message), capped and expiring. */
    private class Assembler {
        private data class Key(val link: String, val id: Int)
        private class Partial(val count: Int, val hops: Int, val pieces: HashMap<Int, ByteArray> = HashMap(), val from: Long = System.currentTimeMillis())
        private val partial = LinkedHashMap<Key, Partial>()

        fun add(frame: ByteArray, link: String): Pair<ByteArray, Int>? {
            if (frame.size <= FRAME_HEADER) return null
            val id = ((frame[0].toInt() and 0xff) shl 24) or ((frame[1].toInt() and 0xff) shl 16) or ((frame[2].toInt() and 0xff) shl 8) or (frame[3].toInt() and 0xff)
            val index = frame[4].toInt() and 0xff
            val count = frame[5].toInt() and 0xff
            val hops = frame[6].toInt() and 0xff
            if (count == 0 || count > 32 || index >= count) return null
            val body = frame.copyOfRange(FRAME_HEADER, frame.size)
            if (count == 1) return body to hops
            val key = Key(link, id)
            val now = System.currentTimeMillis()
            if (!partial.containsKey(key)) {
                // A message whose last frames never came expires fast, so it can't use up the link's slots.
                partial.entries.removeAll { now - it.value.from > PARTIAL_LIFETIME_MS }
                if (partial.keys.count { it.link == link } >= 4) return null
                if (partial.size >= 64) partial.remove(partial.keys.first())
            }
            val entry = partial.getOrPut(key) { Partial(count, hops) }
            if (entry.count != count) return null
            entry.pieces[index] = body
            if (entry.pieces.size < count) return null
            partial.remove(key)
            return (0 until count).fold(ByteArray(0)) { acc, i -> acc + (entry.pieces[i] ?: ByteArray(0)) } to hops
        }

        fun forget(link: String) { partial.keys.removeAll { it.link == link } }
    }

    private class Stored(val envelope: ByteArray, var hops: Int, val seen: Long)
    private class Budget(var messages: Double, var frames: Double, var at: Long)

    private val thread = HandlerThread("arcmesh").apply { start() }
    private val handler = Handler(thread.looper)
    private val main = Handler(Looper.getMainLooper())

    private val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
    private var server: BluetoothGattServer? = null
    private var serverChar: BluetoothGattCharacteristic? = null
    private var advertiseCallback: AdvertiseCallback? = null
    private var scanCallback: ScanCallback? = null

    // Outbound links (we are central): address -> gatt + characteristic + write queue
    private class Outbound(val gatt: BluetoothGatt, var char: BluetoothGattCharacteristic? = null, var mtu: Int = 23,
                           val queue: ArrayDeque<ByteArray> = ArrayDeque(), var writing: Boolean = false, var writeSeq: Long = 0,
                           var pendingChar: BluetoothGattCharacteristic? = null)
    private val outbound = HashMap<String, Outbound>()
    // Inbound subscribers (we are peripheral): address -> device + mtu + notify queue
    private class Subscriber(val device: BluetoothDevice, var mtu: Int = 23, val queue: ArrayDeque<ByteArray> = ArrayDeque(), var sending: Boolean = false)
    private val subscribers = HashMap<String, Subscriber>()
    private val connecting = HashSet<String>()
    private val serverMtu = HashMap<String, Int>() // MTU negotiated before the peer subscribes
    private val backoff = LinkedHashMap<String, Long>()

    private val store = LinkedHashMap<String, Stored>()
    private val assembler = Assembler()
    private val budgets = LinkedHashMap<String, Budget>(16, 0.75f, true) // access order: evicts the least recently used
    private val lastCatchUp = LinkedHashMap<String, Long>()
    private val hellos = HashMap<String, Triple<String, String, Long>>() // link -> (address, name, seen)
    private val rssi = HashMap<String, Int>()
    private var profile: ByteArray? = null
    private var myAddress: ByteArray? = null
    private var lastNearby: List<NearbyPeer> = emptyList()
    private var peerCount = 0
    private val awaiting = LinkedHashMap<String, Long>() // payments handed to the app for signature checking
    private val own = HashSet<String>()                   // payments this device broadcast
    private var running = false

    private val tick = object : Runnable {
        override fun run() {
            profile?.let { send(it, 0, null) }
            for (link in outbound.values) if (link.char != null) link.gatt.readRemoteRssi()
            for (id in outbound.keys + subscribers.keys) catchUp(id)
            val now = System.currentTimeMillis()
            hellos.entries.removeAll { now - it.value.third > NEARBY_TIMEOUT_MS }
            rssi.keys.retainAll(hellos.keys + outbound.keys)
            publishNearby()
            handler.postDelayed(this, HELLO_EVERY_MS)
        }
    }

    // ---------------- public API ----------------

    // Bluetooth turned off and on again: rebuild everything (server, advertising, scanning).
    private val stateReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
            when (intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)) {
                BluetoothAdapter.STATE_ON -> handler.post { if (running) bringUp() }
                BluetoothAdapter.STATE_TURNING_OFF, BluetoothAdapter.STATE_OFF -> handler.post { tearDown() }
            }
        }
    }

    fun start() = handler.post {
        if (running) return@post
        running = true
        context.registerReceiver(stateReceiver, IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED))
        bringUp()
    }

    fun stop() {
        handler.post {
            if (running) try { context.unregisterReceiver(stateReceiver) } catch (e: IllegalArgumentException) {}
            running = false
            tearDown()
            thread.quitSafely()
        }
    }

    private fun bringUp() {
        val adapter = manager.adapter ?: return
        if (!adapter.isEnabled) return // the state receiver brings the mesh up when Bluetooth turns on
        tearDown()
        startServer()
        startAdvertising(adapter)
        startScanning(adapter)
        handler.postDelayed(tick, 1_000)
    }

    private fun tearDown() {
        handler.removeCallbacks(tick)
        try { manager.adapter?.bluetoothLeScanner?.let { s -> scanCallback?.let { s.stopScan(it) } } } catch (e: Exception) {}
        try { manager.adapter?.bluetoothLeAdvertiser?.let { a -> advertiseCallback?.let { a.stopAdvertising(it) } } } catch (e: Exception) {}
        scanCallback = null; advertiseCallback = null
        outbound.values.forEach { it.gatt.close() }
        for (id in outbound.keys + subscribers.keys) assembler.forget(id)
        outbound.clear(); subscribers.clear(); connecting.clear(); serverMtu.clear()
        hellos.clear(); rssi.clear()
        try { server?.close() } catch (e: Exception) {}
        server = null; serverChar = null
        updatePeers(); publishNearby()
    }

    /** Floods a payment or receipt (text form) to every neighbour. */
    fun broadcast(text: String) = handler.post {
        val e = envelopeFrom(text) ?: return@post
        if (own.size < MAX_OWN) own.add(key(e))
        if (remember(e, 0) == Remembered.NEW) send(e, 0, null)
    }

    /** The app checked this payment's signature: store it and pass it on. */
    fun vouch(text: String, hops: Int) = handler.post {
        val e = envelopeFrom(text) ?: return@post
        if (e[0] != KIND_PAYMENT || awaiting.remove(key(e)) == null) return@post // only what the mesh handed over
        val h = hops.coerceIn(0, MAX_HOPS)
        if (plausible(e) && remember(e, h) == Remembered.NEW && h < MAX_HOPS) send(e, h, null)
    }

    fun setProfile(address: String, name: String) = handler.post {
        val addr = hex(address) ?: return@post
        if (addr.size != 20) return@post
        var nameBytes = ByteArray(0)
        for (ch in name.codePoints().toArray()) { // at most 32 UTF-8 bytes, cut on a character boundary
            val c = String(Character.toChars(ch)).toByteArray(Charsets.UTF_8)
            if (nameBytes.size + c.size > 32) break
            nameBytes += c
        }
        myAddress = addr
        profile = byteArrayOf(KIND_HELLO) + addr + nameBytes
        send(profile!!, 0, null)
    }

    /** Privacy: stop announcing ourselves (presence only while the Pay screen is open). */
    fun stopPresence() = handler.post { profile = null }

    // ---------------- store & flood ----------------

    private enum class Remembered { NEW, FEWER_HOPS, KNOWN }

    private fun key(e: ByteArray): String =
        Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(e), Base64.NO_WRAP)

    /** Only payments this device broadcast: addresses are public, so anything else can be forged. */
    private fun isMine(e: ByteArray): Boolean = own.contains(key(e))

    private fun remember(e: ByteArray, hops: Int): Remembered {
        val k = key(e)
        store[k]?.let { old ->
            if (hops >= old.hops) return Remembered.KNOWN
            old.hops = hops
            return Remembered.FEWER_HOPS
        }
        val isReceipt = e[0] == KIND_RECEIPT
        val now = System.currentTimeMillis()
        store.entries.removeAll { now - it.value.seen > STORED_LIFETIME_MS } // tab vouchers carry no expiry
        parties(e)?.let { p ->
            if (!isMine(e)) {
                val sameFrom = store.entries.filter { parties(it.value.envelope)?.first?.contentEquals(p.first) == true }
                if (sameFrom.size >= MAX_PER_PAYER) store.remove(sameFrom.minByOrNull { it.value.seen }!!.key)
            }
        }
        val sameKind = { s: Stored -> (s.envelope[0] == KIND_RECEIPT) == isReceipt }
        val quota = if (isReceipt) MAX_STORED_RECEIPTS else MAX_STORED - MAX_STORED_RECEIPTS
        if (store.values.count(sameKind) >= quota) {
            store.entries.removeAll { sameKind(it.value) && !plausible(it.value.envelope) }
            if (store.values.count(sameKind) >= quota) {
                store.entries.filter { sameKind(it.value) && !isMine(it.value.envelope) }.minByOrNull { it.value.seen }?.let { store.remove(it.key) }
            }
            if (store.values.count(sameKind) >= quota && !isMine(e)) return Remembered.KNOWN // hard cap
        }
        store[k] = Stored(e, hops, System.currentTimeMillis())
        return Remembered.NEW
    }

    private fun spend(link: String, messages: Double = 0.0, frames: Double = 0.0): Boolean {
        val now = System.currentTimeMillis()
        val b = budgets.getOrPut(link) { Budget(LINK_BURST, FRAME_BURST, now) }
        val dt = (now - b.at) / 1000.0
        b.messages = minOf(LINK_BURST, b.messages + dt * LINK_REFILL_PER_S)
        b.frames = minOf(FRAME_BURST, b.frames + dt * FRAME_REFILL_PER_S)
        b.at = now
        val ok = b.messages >= messages && b.frames >= frames
        if (ok) { b.messages -= messages; b.frames -= frames }
        if (budgets.size > MAX_LINKS) budgets.remove(budgets.keys.first())
        return ok
    }

    private fun ingest(frame: ByteArray, link: String) {
        if (!spend(link, frames = 1.0)) return
        val (bytes, hops) = assembler.add(frame, link) ?: return
        received(bytes, hops, link)
    }

    private fun received(e: ByteArray, hops: Int, link: String) {
        if (e.isEmpty() || !spend(link, messages = 1.0)) return
        if (e[0] == KIND_HELLO) return heard(e, link)
        if (!plausible(e)) return
        val text = textFrom(e) ?: return
        if (e[0] == KIND_PAYMENT) {
            val k = key(e)
            store[k]?.let { old -> // already verified: only a shorter path matters
                if (hops < old.hops && remember(e, hops) == Remembered.FEWER_HOPS && hops < MAX_HOPS) send(e, hops, null)
                return
            }
            if (awaiting.containsKey(k)) return
            val now = System.currentTimeMillis()
            if (awaiting.size >= MAX_AWAITING) {
                awaiting.entries.removeAll { now - it.value > 60_000 }
                if (awaiting.size >= MAX_AWAITING) return
            }
            awaiting[k] = now
            main.post { listener.onPayment(text, hops) }
            return
        }
        when (remember(e, hops)) {
            Remembered.KNOWN -> return
            Remembered.FEWER_HOPS -> { if (hops < MAX_HOPS) send(e, hops, null); return }
            Remembered.NEW -> Unit
        }
        if (e[0] == KIND_PAYMENT) main.post { listener.onPayment(text, hops) } else main.post { listener.onReceipt(text) }
        if (hops < MAX_HOPS) send(e, hops, null)
    }

    private fun heard(e: ByteArray, link: String) {
        val body = e.copyOfRange(1, e.size)
        if (body.size < 20 || body.size > 52) return
        val address = "0x" + body.copyOfRange(0, 20).joinToString("") { "%02x".format(it) }
        val raw = String(body.copyOfRange(20, body.size), Charsets.UTF_8)
        val name = raw.codePoints().filter { !Character.isISOControl(it) && Character.getType(it) != Character.FORMAT.toInt() }
            .limit(24).toArray().let { String(it, 0, it.size) }
        if (!hellos.containsKey(link) && hellos.size >= MAX_NEARBY * 2) return
        hellos[link] = Triple(address, name, System.currentTimeMillis())
        publishNearby()
    }

    private fun publishNearby() {
        val best = HashMap<String, NearbyPeer>()
        for ((link, h) in hellos) {
            val candidate = NearbyPeer(h.first, h.second, rssi[link])
            val current = best[h.first]
            if (current == null || (current.rssi ?: -200) < (candidate.rssi ?: -200)) best[h.first] = candidate
        }
        val peers = best.values.sortedByDescending { it.rssi ?: -200 }.take(MAX_NEARBY)
        if (peers == lastNearby) return
        lastNearby = peers
        main.post { listener.onNearby(peers) }
    }

    private fun send(e: ByteArray, hops: Int, peer: String?) {
        for ((id, link) in outbound) {
            if (peer != null && peer != id) continue
            if (link.char == null) continue
            val fs = frames(e, hops + 1, link.mtu - 3)
            if (link.queue.size + fs.size > MAX_PENDING_WRITES) continue // whole messages only; a slow peer can't grow memory
            link.queue.addAll(fs)
            pumpWrites(id)
        }
        for ((id, sub) in subscribers) {
            if (peer != null && peer != id) continue
            val fs = frames(e, hops + 1, sub.mtu - 3)
            if (sub.queue.size + fs.size > MAX_PENDING_WRITES) continue
            sub.queue.addAll(fs)
            pumpNotifications(id)
        }
    }

    private fun catchUp(peer: String) {
        profile?.let { send(it, 0, peer) }
        val now = System.currentTimeMillis()
        lastCatchUp[peer]?.let { if (now - it < CATCHUP_COOLDOWN_MS) return }
        lastCatchUp[peer] = now
        while (lastCatchUp.size > MAX_LINKS) lastCatchUp.remove(lastCatchUp.keys.first())
        // Shuffled within each rank: what doesn't fit this time gets its turn on the next resync.
        val items = store.values.filter { it.hops < MAX_HOPS && plausible(it.envelope) }.shuffled().sortedBy {
            if (isMine(it.envelope)) 0 else if (it.envelope[0] == KIND_PAYMENT) 1 else 2
        }
        for (item in items) send(item.envelope, item.hops, peer)
    }

    private fun updatePeers() {
        val count = (outbound.filterValues { it.char != null }.keys + subscribers.keys).size
        if (count == peerCount) return
        peerCount = count
        main.post { listener.onPeers(count) }
    }

    private fun dropLink(id: String) {
        assembler.forget(id)
        // Links come and go: a neighbour stays listed until its hellos stop for NEARBY_TIMEOUT_MS.
        updatePeers(); publishNearby()
    }

    // ---------------- GATT writes / notifications, one at a time ----------------

    private fun pumpWrites(id: String) {
        val link = outbound[id] ?: return
        val char = link.char ?: return
        if (link.writing) return
        val frame = link.queue.removeFirstOrNull() ?: return
        link.writing = true
        val seq = ++link.writeSeq
        // Some stacks never call back right before a disconnect: don't let the link go silent.
        handler.postDelayed({ outbound[id]?.let { if (it.writing && it.writeSeq == seq) { it.writing = false; pumpWrites(id) } } }, WRITE_WATCHDOG_MS)
        val ok = if (Build.VERSION.SDK_INT >= 33) {
            link.gatt.writeCharacteristic(char, frame, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE) == BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            char.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            @Suppress("DEPRECATION")
            char.value = frame
            @Suppress("DEPRECATION")
            link.gatt.writeCharacteristic(char)
        }
        if (!ok) { link.writing = false; link.queue.addFirst(frame); handler.postDelayed({ pumpWrites(id) }, 50) }
    }

    private fun pumpNotifications(id: String) {
        val sub = subscribers[id] ?: return
        val char = serverChar ?: return
        val srv = server ?: return
        if (sub.sending) return
        val frame = sub.queue.removeFirstOrNull() ?: return
        sub.sending = true
        val ok = if (Build.VERSION.SDK_INT >= 33) {
            srv.notifyCharacteristicChanged(sub.device, char, false, frame) == BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            char.value = frame
            @Suppress("DEPRECATION")
            srv.notifyCharacteristicChanged(sub.device, char, false)
        }
        if (!ok) { sub.sending = false; sub.queue.addFirst(frame); handler.postDelayed({ pumpNotifications(id) }, 50) }
    }

    // ---------------- peripheral role ----------------

    private fun startServer() {
        if (server != null) return
        val char = BluetoothGattCharacteristic(
            PACKET,
            BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE or BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_WRITE,
        )
        char.addDescriptor(BluetoothGattDescriptor(CCCD, BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE))
        val service = BluetoothGattService(SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        service.addCharacteristic(char)
        serverChar = char
        server = manager.openGattServer(context, serverCallback)?.also { it.addService(service) }
    }

    private val serverCallback = object : BluetoothGattServerCallback() {
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            handler.post {
                if (newState == BluetoothProfile.STATE_DISCONNECTED) { subscribers.remove(device.address); serverMtu.remove(device.address); dropLink(device.address) }
            }
        }

        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
            handler.post {
                if (serverMtu.size < MAX_LINKS) serverMtu[device.address] = mtu
                subscribers[device.address]?.mtu = mtu
            }
        }

        override fun onCharacteristicWriteRequest(device: BluetoothDevice, requestId: Int, characteristic: BluetoothGattCharacteristic,
                                                  preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray?) {
            if (responseNeeded) server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            if (value == null || preparedWrite || offset != 0) return
            handler.post { ingest(value, device.address) }
        }

        override fun onDescriptorWriteRequest(device: BluetoothDevice, requestId: Int, descriptor: BluetoothGattDescriptor,
                                              preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray?) {
            if (responseNeeded) server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            if (descriptor.uuid != CCCD || value == null) return
            handler.post {
                if (value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)) {
                    subscribers[device.address] = subscribers[device.address] ?: Subscriber(device, serverMtu[device.address] ?: 23)
                    updatePeers()
                    catchUp(device.address)
                } else {
                    subscribers.remove(device.address); dropLink(device.address)
                }
            }
        }

        override fun onDescriptorReadRequest(device: BluetoothDevice, requestId: Int, offset: Int, descriptor: BluetoothGattDescriptor) {
            val on = subscribers.containsKey(device.address)
            server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0,
                if (on) BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE else BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE)
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            handler.post { subscribers[device.address]?.sending = false; pumpNotifications(device.address) }
        }
    }

    private fun startAdvertising(adapter: BluetoothAdapter) {
        val advertiser = adapter.bluetoothLeAdvertiser ?: return
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(true)
            .build()
        val data = AdvertiseData.Builder().addServiceUuid(ParcelUuid(SERVICE)).setIncludeDeviceName(false).build()
        advertiseCallback = object : AdvertiseCallback() {}
        advertiser.startAdvertising(settings, data, advertiseCallback)
    }

    // ---------------- central role ----------------

    private fun startScanning(adapter: BluetoothAdapter) {
        val scanner = adapter.bluetoothLeScanner ?: return
        val filters = listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE)).build())
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        scanCallback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                handler.post { discovered(result.device, result.rssi) }
            }
        }
        scanner.startScan(filters, settings, scanCallback)
    }

    private fun discovered(device: BluetoothDevice, signal: Int) {
        val id = device.address
        if (outbound.containsKey(id) || subscribers.containsKey(id)) { rssi[id] = signal; return }
        if (connecting.contains(id) || outbound.size >= MAX_OUTBOUND) return
        val now = System.currentTimeMillis()
        backoff[id]?.let { if (now < it) return }
        connecting.add(id)
        val gatt = device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE) ?: run { connecting.remove(id); return }
        rssi[id] = signal
        outbound[id] = Outbound(gatt)
    }

    private fun failed(gatt: BluetoothGatt) {
        val id = gatt.device.address
        backoff[id] = System.currentTimeMillis() + CONNECT_BACKOFF_MS
        while (backoff.size > MAX_LINKS) backoff.remove(backoff.keys.first())
        gatt.disconnect()
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            handler.post {
                val id = gatt.device.address
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    if (!gatt.requestMtu(185)) gatt.discoverServices()
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    if (status != BluetoothGatt.GATT_SUCCESS) backoff[id] = System.currentTimeMillis() + CONNECT_BACKOFF_MS
                    connecting.remove(id)
                    outbound.remove(id)?.gatt?.close()
                    dropLink(id)
                }
            }
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            handler.post {
                outbound[gatt.device.address]?.mtu = if (status == BluetoothGatt.GATT_SUCCESS) mtu else 23
                gatt.discoverServices()
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            handler.post {
                val link = outbound[gatt.device.address] ?: return@post
                val char = gatt.getService(SERVICE)?.getCharacteristic(PACKET) ?: run { failed(gatt); return@post }
                gatt.setCharacteristicNotification(char, true)
                val cccd = char.getDescriptor(CCCD) ?: run { ready(gatt, char); return@post }
                link.pendingChar = char // usable for writes only once the subscription is confirmed
                val issued = if (Build.VERSION.SDK_INT >= 33) gatt.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == BluetoothStatusCodes.SUCCESS
                else {
                    @Suppress("DEPRECATION")
                    cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    @Suppress("DEPRECATION")
                    gatt.writeDescriptor(cccd)
                }
                if (!issued) failed(gatt)
            }
        }

        override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            handler.post {
                val char = outbound[gatt.device.address]?.pendingChar ?: return@post
                if (status == BluetoothGatt.GATT_SUCCESS) ready(gatt, char) else failed(gatt)
            }
        }

        override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            handler.post { outbound[gatt.device.address]?.writing = false; pumpWrites(gatt.device.address) }
        }

        @Deprecated("API < 33")
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            @Suppress("DEPRECATION")
            val value = characteristic.value ?: return
            val copy = value.copyOf()
            handler.post { ingest(copy, gatt.device.address) }
        }

        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            handler.post { ingest(value, gatt.device.address) }
        }

        override fun onReadRemoteRssi(gatt: BluetoothGatt, rssiValue: Int, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) handler.post { rssi[gatt.device.address] = rssiValue }
        }
    }

    private fun ready(gatt: BluetoothGatt, char: BluetoothGattCharacteristic) {
        val id = gatt.device.address
        connecting.remove(id)
        outbound[id]?.let { it.char = char; it.pendingChar = null }
        updatePeers()
        catchUp(id)
    }

    private fun hex(s: String): ByteArray? {
        val h = s.removePrefix("0x")
        if (h.length % 2 != 0) return null
        return try { ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() } } catch (e: NumberFormatException) { null }
    }
}
