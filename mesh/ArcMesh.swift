//
// ArcMesh.swift
// ArcDrop's own Bluetooth LE mesh. Every device is both a peripheral
// (advertises, accepts writes, notifies subscribers) and a central (scans,
// connects, subscribes, writes), so phones talk to each other directly with
// no network.
//
// Messages (envelope = type u8 | body):
//   1 payment  signed USDC/EURC authorization (157/158 bytes) or tab voucher (122), flooded
//   2 hello    "I'm here": wallet address 20 | display name (UTF-8), neighbors only
//   3 receipt  recipient's signature over the payment nonce (97 bytes), flooded
//
// Payments and receipts are store-and-forward: a node keeps what it has seen,
// hands it to each new peer it meets, and floods new ones with a hop limit.
// So a payment can cross a crowd in pockets until any node with internet
// settles it on Arc. Everything is self-authenticating (signatures), so nodes
// need no trust in each other.
//
// Shared by the iOS app and the macOS relay node.
//

import CoreBluetooth
import CryptoKit
import Foundation

public struct NearbyPeer: Equatable {
    public let address: String // 0x… wallet address
    public let name: String
    public let rssi: Int?      // dBm; closer to 0 = nearer
}

public protocol ArcMeshDelegate: AnyObject {
    /// A payment (`arcdrop:1:…` / `arcdrop:2:…` / `arcdrop:4:…`) seen for the first time.
    /// With `verifyFirst`, it is neither stored nor forwarded until the app checks its
    /// signature and calls `vouch(_:hops:)`.
    func mesh(_ mesh: ArcMesh, didReceive packet: String, hops: Int)
    /// A receipt (`arcdrop-ack:1:…`) seen for the first time.
    func mesh(_ mesh: ArcMesh, didReceiveReceipt receipt: String)
    func mesh(_ mesh: ArcMesh, nearbyChanged peers: [NearbyPeer])
    func mesh(_ mesh: ArcMesh, peersChanged count: Int)
    func mesh(_ mesh: ArcMesh, log: String)
}

public extension ArcMeshDelegate {
    func mesh(_ mesh: ArcMesh, didReceiveReceipt receipt: String) {}
    func mesh(_ mesh: ArcMesh, nearbyChanged peers: [NearbyPeer]) {}
}

public final class ArcMesh: NSObject {
    public static let serviceUUID = CBUUID(string: "A7C0D509-5E1F-4B8E-9A3B-1D2C3E4F5A60")
    static let packetUUID = CBUUID(string: "A7C0D509-5E1F-4B8E-9A3B-1D2C3E4F5A61")

    enum Kind: UInt8 { case payment = 1, hello = 2, receipt = 3 }

    static let maxHops: UInt8 = 7
    static let maxStored = 500
    static let frameHeader = 7 // msgId 4 | index 1 | count 1 | hops 1
    static let helloEvery: TimeInterval = 5
    static let nearbyTimeout: TimeInterval = 20
    // Abuse limits: any nearby device can send anything, as often as it likes.
    static let linkBurst = 600.0         // messages a link may send at once (a full catch-up)
    static let linkRefillPerSecond = 1.0
    static let frameBurst = 4000.0       // frames, counted before reassembly
    static let frameRefillPerSecond = 20.0
    static let maxStoredReceipts = 100
    static let maxPerPayer = 5           // stored payments per payer address (flood guard)
    static let maxLinks = 300
    static let maxPendingNotify = 200
    static let maxNearby = 30
    static let catchUpCooldown: TimeInterval = 30
    static let knownChains: Set<UInt32> = [5042, 5042002]
    static let maxAwaiting = 2000
    static let maxOwn = 200
    static let storedLifetime: TimeInterval = 30 * 86_400 // the longest tab

    /// The app sets this: payments are stored and forwarded only once their signature
    /// checks out, so nobody can push junk "from" someone else to crowd out their payments.
    /// The macOS relay node (no signature code) leaves it off and relies on the structural checks.
    public var verifyFirst = false

    public weak var delegate: ArcMeshDelegate?
    public private(set) var peerCount = 0

    private let queue = DispatchQueue(label: "arcmesh")
    private var central: CBCentralManager!
    private var peripheral: CBPeripheralManager!
    private var characteristic: CBMutableCharacteristic?
    private var timer: DispatchSourceTimer?

    // Remote peripherals we connected to, and the characteristic we write to.
    private var outbound: [UUID: (peripheral: CBPeripheral, char: CBCharacteristic?)] = [:]
    // Remote centrals subscribed to our characteristic.
    private var subscribers: [UUID: CBCentral] = [:]

    // Store-and-forward: envelopes by content hash, with the hop count we got them at.
    private var store: [Data: (envelope: Data, hops: UInt8, seen: Date)] = [:]
    private var assembler = FrameAssembler()
    private var pendingNotify: [(Data, [CBCentral]?)] = []
    private var linkBudget: [UUID: (messages: Double, frames: Double, at: Date)] = [:]
    private var lastCatchUp: [UUID: Date] = [:]
    private var myAddress: Data?
    // Payments handed to the app for signature checking (bounded), and the ones this device sent.
    private var awaiting: [Data: Date] = [:]
    private var own: Set<Data> = []

    // Presence: who is behind each link, and how strong their signal is.
    private var profile: Data?
    private var hellos: [UUID: (address: String, name: String, seen: Date)] = [:]
    private var rssi: [UUID: Int] = [:]
    private var lastNearby: [NearbyPeer] = []

    public override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: queue)
        peripheral = CBPeripheralManager(delegate: self, queue: queue)
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 1, repeating: Self.helloEvery)
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }

    // MARK: Public API

    /// Floods a payment or a receipt to every neighbor. Signs nothing, trusts nothing.
    public func broadcast(_ text: String) {
        guard let envelope = Self.envelope(from: text) else { log("not an ArcDrop message"); return }
        queue.async {
            let key = Data(SHA256.hash(data: envelope))
            if self.own.count < Self.maxOwn { self.own.insert(key) }
            guard self.remember(envelope, hops: 0) == .new else { return }
            self.send(envelope, hops: 0, to: nil)
        }
    }

    /// The app checked this payment's signature: store it and pass it on.
    public func vouch(_ text: String, hops: Int) {
        guard let envelope = Self.envelope(from: text), envelope.first == Kind.payment.rawValue else { return }
        let h = UInt8(clamping: max(0, hops))
        queue.async {
            let key = Data(SHA256.hash(data: envelope))
            guard self.awaiting.removeValue(forKey: key) != nil else { return } // only what the mesh handed over
            guard Self.plausible(envelope), self.remember(envelope, hops: h) == .new, h < Self.maxHops else { return }
            self.send(envelope, hops: h, to: nil)
        }
    }

    /// Who this device is, announced to neighbors so they can pay it by name.
    public func setProfile(address: String, name: String) {
        guard let addr = Data(hex: address), addr.count == 20 else { return }
        var body = Data([Kind.hello.rawValue]) + addr
        // At most 32 UTF-8 bytes, cut on a character boundary.
        var bytes = Data()
        for ch in name { let c = Data(String(ch).utf8); if bytes.count + c.count > 32 { break }; bytes.append(c) }
        body.append(bytes)
        queue.async {
            self.myAddress = addr
            self.profile = body
            self.send(body, hops: 0, to: nil)
        }
    }

    /// Stop announcing ourselves (privacy: presence only while the Pay screen is open).
    public func stopPresence() {
        queue.async { self.profile = nil }
    }

    // MARK: Text <-> envelope (same encodings as core/arcdrop.js)

    static func envelope(from text: String) -> Data? {
        for (prefix, kind, lengths) in [("arcdrop:4:", Kind.payment, [122]), ("arcdrop:2:", .payment, [158]), ("arcdrop:1:", .payment, [157]), ("arcdrop-ack:2:", .receipt, [97])] {
            guard let range = text.range(of: prefix) else { continue }
            let body = text[range.upperBound...].prefix { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
            guard let data = Data(base64URL: String(body)), lengths.contains(data.count) else { return nil }
            return Data([kind.rawValue]) + data
        }
        return nil
    }

    static func text(from envelope: Data) -> String? {
        guard let first = envelope.first, let kind = Kind(rawValue: first) else { return nil }
        let body = Data(envelope.dropFirst())
        switch (kind, body.count) {
        case (.payment, 157): return "arcdrop:1:" + body.base64URL
        case (.payment, 158): return "arcdrop:2:" + body.base64URL
        case (.payment, 122): return "arcdrop:4:" + body.base64URL
        case (.receipt, 97): return "arcdrop-ack:2:" + body.base64URL
        default: return nil
        }
    }

    // MARK: Store & flood

    enum Remembered { case new, fewerHops, known }

    /// Payer (from) and recipient (to) of a payment envelope.
    static func parties(_ envelope: Data) -> (from: Data, to: Data)? {
        let b = [UInt8](envelope)
        guard b.first == Kind.payment.rawValue else { return nil }
        let o: Int
        switch b.count - 1 { case 157: o = 5; case 158, 122: o = 6; default: return nil }
        return (Data(b[o..<o + 20]), Data(b[o + 20..<o + 40]))
    }

    /// Only payments this device broadcast itself: anything else can be forged by a neighbour
    /// (addresses are public), so it can't claim a protected slot.
    private func isMine(_ envelope: Data) -> Bool {
        own.contains(Data(SHA256.hash(data: envelope)))
    }

    /// Stores an envelope. Receipts and payments have separate quotas; our own payments are
    /// never evicted; one payer address cannot hold more than a few slots; a copy that
    /// arrives with fewer hops replaces a "poisoned" high-hop copy.
    private func remember(_ envelope: Data, hops: UInt8) -> Remembered {
        let key = Data(SHA256.hash(data: envelope))
        if let old = store[key] {
            guard hops < old.hops else { return .known }
            store[key] = (old.envelope, hops, old.seen)
            return .fewerHops
        }
        let isReceipt = envelope.first == Kind.receipt.rawValue
        store = store.filter { $0.value.seen.timeIntervalSinceNow > -Self.storedLifetime } // tab vouchers have no expiry inside
        if let p = Self.parties(envelope), !isMine(envelope) {
            let sameFrom = store.filter { Self.parties($0.value.envelope)?.from == p.from }
            if sameFrom.count >= Self.maxPerPayer, let oldest = sameFrom.min(by: { $0.value.seen < $1.value.seen })?.key { store[oldest] = nil }
        }
        let sameKind = { (e: Data) in (e.first == Kind.receipt.rawValue) == isReceipt }
        let quota = isReceipt ? Self.maxStoredReceipts : Self.maxStored - Self.maxStoredReceipts
        if store.values.filter({ sameKind($0.envelope) }).count >= quota {
            for (k, v) in store where sameKind(v.envelope) && !Self.plausible(v.envelope) { store[k] = nil } // expired first
            if store.values.filter({ sameKind($0.envelope) }).count >= quota,
               let oldest = store.filter({ sameKind($0.value.envelope) && !isMine($0.value.envelope) }).min(by: { $0.value.seen < $1.value.seen })?.key {
                store[oldest] = nil // never our own payments
            }
            // Hard cap: still full (only our own left)? Keep what we have.
            if store.values.filter({ sameKind($0.envelope) }).count >= quota && !isMine(envelope) { return .known }
        }
        store[key] = (envelope, hops, Date())
        return .new
    }

    /// Cheap structural checks (no signature crypto here; the app verifies signatures):
    /// known chain, non-zero amount, not expired, not postdated. Junk is neither stored nor forwarded.
    static func plausible(_ envelope: Data, now: Date = Date()) -> Bool {
        let bytes = [UInt8](envelope)
        guard let kind = bytes.first.flatMap(Kind.init(rawValue:)) else { return false }
        guard kind == .payment else { return kind == .receipt && bytes.count == 98 }
        func u(_ o: Int, _ n: Int) -> UInt64 { bytes[o..<o + n].reduce(0) { $0 << 8 | UInt64($1) } }
        let t = UInt64(now.timeIntervalSince1970)
        switch bytes.count - 1 {
        case 157, 158: // v1 / v2: [token] chainId from to value validAfter validBefore nonce sig
            let o = bytes.count - 1 == 158 ? 2 : 1
            if o == 2 && bytes[1] != 1 { return false } // v2 is EURC only
            let validBefore = u(o + 56, 4)
            return knownChains.contains(UInt32(u(o, 4))) && u(o + 44, 8) >= 10_000 && u(o + 52, 4) <= t
                && validBefore > t && validBefore <= t + 8 * 86_400 // the app signs for 7 days
        case 122: // v4 tab voucher: token chainId from to epoch cumulative sig (expiry lives on-chain)
            return bytes[1] <= 1 && knownChains.contains(UInt32(u(2, 4))) && u(50, 8) >= 10_000
        default: return false
        }
    }

    /// Token buckets per link: a full catch-up fits in the burst, a flood does not.
    private func spend(_ link: UUID, messages: Double = 0, frames: Double = 0) -> Bool {
        let now = Date()
        var b = linkBudget[link] ?? (Self.linkBurst, Self.frameBurst, now)
        let dt = now.timeIntervalSince(b.at)
        b.messages = min(Self.linkBurst, b.messages + dt * Self.linkRefillPerSecond)
        b.frames = min(Self.frameBurst, b.frames + dt * Self.frameRefillPerSecond)
        b.at = now
        let ok = b.messages >= messages && b.frames >= frames
        if ok { b.messages -= messages; b.frames -= frames }
        linkBudget[link] = b
        if linkBudget.count > Self.maxLinks, let stale = linkBudget.min(by: { $0.value.at < $1.value.at })?.key { linkBudget[stale] = nil }
        return ok
    }

    private func received(_ envelope: Data, hops: UInt8, from link: UUID) {
        guard let first = envelope.first, let kind = Kind(rawValue: first) else { return }
        guard spend(link, messages: 1) else { return }
        if kind == .hello { return heard(envelope, from: link) }
        guard Self.plausible(envelope), let text = Self.text(from: envelope) else { return }
        if verifyFirst && kind == .payment {
            let key = Data(SHA256.hash(data: envelope))
            if let old = store[key] { // already verified: only a shorter path matters
                if hops < old.hops, remember(envelope, hops: hops) == .fewerHops, hops < Self.maxHops { send(envelope, hops: hops, to: nil) }
                return
            }
            guard awaiting[key] == nil else { return }
            if awaiting.count >= Self.maxAwaiting {
                awaiting = awaiting.filter { $0.value.timeIntervalSinceNow > -60 }
                if awaiting.count >= Self.maxAwaiting { return }
            }
            awaiting[key] = Date()
            log("payment received (\(hops) hop\(hops == 1 ? "" : "s")), checking signature")
            DispatchQueue.main.async { self.delegate?.mesh(self, didReceive: text, hops: Int(hops)) }
            return
        }
        switch remember(envelope, hops: hops) {
        case .known: return
        case .fewerHops: // a shorter path showed up: keep spreading it (defeats hop poisoning)
            if hops < Self.maxHops { send(envelope, hops: hops, to: nil) }
            return
        case .new: break
        }
        if kind == .payment {
            log("payment received (\(hops) hop\(hops == 1 ? "" : "s"))")
            DispatchQueue.main.async { self.delegate?.mesh(self, didReceive: text, hops: Int(hops)) }
        } else {
            log("receipt received")
            DispatchQueue.main.async { self.delegate?.mesh(self, didReceiveReceipt: text) }
        }
        if hops < Self.maxHops { send(envelope, hops: hops, to: nil) }
    }

    private func heard(_ envelope: Data, from link: UUID) {
        let body = Data(envelope.dropFirst())
        guard body.count >= 20, body.count <= 52 else { return }
        let address = "0x" + body.prefix(20).map { String(format: "%02x", $0) }.joined()
        // Names come from anyone: drop control, format (zero-width, bidi) characters.
        let name = String(String(decoding: body.dropFirst(20), as: UTF8.self).unicodeScalars
            .filter { !CharacterSet.controlCharacters.contains($0) && $0.properties.generalCategory != .format }.prefix(24))
        if hellos[link] == nil, hellos.count >= Self.maxNearby * 2 { return }
        hellos[link] = (address, name, Date())
        publishNearby()
    }

    /// Sends to every neighbor, or only to `peer` (a newly met device catching up).
    private func send(_ envelope: Data, hops: UInt8, to peer: UUID?) {
        // As a central, write to peripherals we connected to.
        for (id, link) in outbound where peer == nil || peer == id {
            guard let char = link.char else { continue }
            let max = link.peripheral.maximumWriteValueLength(for: .withoutResponse)
            for frame in Self.frames(for: envelope, hops: hops + 1, maxLength: max) {
                // Full write buffer: stop here; the periodic catch-up resends later.
                guard link.peripheral.canSendWriteWithoutResponse else { break }
                link.peripheral.writeValue(frame, for: char, type: .withoutResponse)
            }
        }
        // As a peripheral, notify centrals subscribed to us.
        let targets = subscribers.filter { peer == nil || peer == $0.key }.map(\.value)
        guard !targets.isEmpty, let characteristic else { return }
        let max = targets.map { $0.maximumUpdateValueLength }.min() ?? 20
        let frames = Self.frames(for: envelope, hops: hops + 1, maxLength: max)
        guard pendingNotify.count + frames.count <= Self.maxPendingNotify else { return } // whole messages only
        for frame in frames {
            if !peripheral.updateValue(frame, for: characteristic, onSubscribedCentrals: targets) {
                guard pendingNotify.count < Self.maxPendingNotify else { break } // a stalled reader can't grow memory
                pendingNotify.append((frame, targets))
            }
        }
    }

    private func catchUp(_ peer: UUID) {
        if let profile { send(profile, hops: 0, to: peer) }
        // Reconnecting over and over must not make us resend everything each time.
        if let last = lastCatchUp[peer], Date().timeIntervalSince(last) < Self.catchUpCooldown { return }
        lastCatchUp[peer] = Date()
        while lastCatchUp.count > Self.maxLinks, let stale = lastCatchUp.min(by: { $0.value < $1.value })?.key { lastCatchUp[stale] = nil }
        // Our own payments first, then other payments, receipts last.
        // Shuffled within each rank: whatever doesn't fit this time gets its turn on the next resync.
        let items = store.values.filter { $0.hops < Self.maxHops && Self.plausible($0.envelope) }.shuffled().sorted { a, b in
            let rank = { (e: Data) in self.isMine(e) ? 0 : (e.first == Kind.payment.rawValue ? 1 : 2) }
            return rank(a.envelope) < rank(b.envelope)
        }
        for item in items { send(item.envelope, hops: item.hops, to: peer) }
    }

    /// Every few seconds: say hello, refresh signal strength, forget silent neighbors.
    private func tick() {
        if let profile { send(profile, hops: 0, to: nil) }
        // Periodic resync, so whatever didn't fit in a burst still reaches every neighbour.
        for id in Set(outbound.keys).union(subscribers.keys) { catchUp(id) }
        for link in outbound.values where link.char != nil { link.peripheral.readRSSI() }
        hellos = hellos.filter { $0.value.seen.timeIntervalSinceNow > -Self.nearbyTimeout }
        rssi = rssi.filter { hellos[$0.key] != nil || outbound[$0.key] != nil }
        publishNearby()
    }

    private func publishNearby() {
        // One device can be linked twice (as central and as peripheral): merge by address.
        var best: [String: NearbyPeer] = [:]
        for (link, hello) in hellos {
            let candidate = NearbyPeer(address: hello.address, name: hello.name, rssi: rssi[link])
            if let current = best[hello.address], (current.rssi ?? -200) >= (candidate.rssi ?? -200) { continue }
            best[hello.address] = candidate
        }
        let peers = Array(best.values.sorted { ($0.rssi ?? -200) > ($1.rssi ?? -200) }.prefix(Self.maxNearby))
        guard peers != lastNearby else { return }
        lastNearby = peers
        DispatchQueue.main.async { self.delegate?.mesh(self, nearbyChanged: peers) }
    }

    // MARK: Framing (BLE packets can be smaller than a message)

    static func frames(for bytes: Data, hops: UInt8, maxLength: Int) -> [Data] {
        let chunk = max(1, min(maxLength, 512) - frameHeader)
        let count = Int((Double(bytes.count) / Double(chunk)).rounded(.up))
        var id = UInt32.random(in: .min ... .max)
        let idBytes = withUnsafeBytes(of: &id) { Data($0) }
        return (0..<count).map { i in
            var frame = idBytes
            frame.append(UInt8(i))
            frame.append(UInt8(count))
            frame.append(hops)
            frame.append(bytes.subdata(in: (i * chunk)..<min(bytes.count, (i + 1) * chunk)))
            return frame
        }
    }

    private func ingest(frame: Data, from link: UUID) {
        guard spend(link, frames: 1) else { return }
        if let (bytes, hops) = assembler.add(frame, from: link) { received(bytes, hops: hops, from: link) }
    }

    private func dropLink(_ id: UUID) {
        assembler.forget(id)
        // BLE links come and go every few seconds: a neighbour stays listed until its hellos
        // stop for `nearbyTimeout` (the tick forgets it), instead of flickering on every drop.
        updatePeers()
        publishNearby()
    }

    private func updatePeers() {
        let ids = Set(outbound.compactMap { $0.value.char == nil ? nil : $0.key }).union(subscribers.keys)
        guard ids.count != peerCount else { return }
        peerCount = ids.count
        let count = ids.count
        DispatchQueue.main.async { self.delegate?.mesh(self, peersChanged: count) }
    }

    private func log(_ text: String) {
        DispatchQueue.main.async { self.delegate?.mesh(self, log: text) }
    }
}

// MARK: - Central role

extension ArcMesh: CBCentralManagerDelegate, CBPeripheralDelegate {
    public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        log("central: \(central.state.label)")
        guard central.state == .poweredOn else { return }
        central.scanForPeripherals(withServices: [Self.serviceUUID], options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
    }

    public func centralManager(_ central: CBCentralManager, didDiscover p: CBPeripheral, advertisementData: [String: Any], rssi: NSNumber) {
        guard outbound[p.identifier] == nil else { return }
        outbound[p.identifier] = (p, nil)
        self.rssi[p.identifier] = rssi.intValue
        p.delegate = self
        central.connect(p)
    }

    public func centralManager(_ central: CBCentralManager, didConnect p: CBPeripheral) {
        p.discoverServices([Self.serviceUUID])
    }

    public func centralManager(_ central: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        outbound[p.identifier] = nil
    }

    public func centralManager(_ central: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        outbound[p.identifier] = nil
        dropLink(p.identifier)
    }

    public func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard let service = p.services?.first(where: { $0.uuid == Self.serviceUUID }) else { return }
        p.discoverCharacteristics([Self.packetUUID], for: service)
    }

    public func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard let char = service.characteristics?.first(where: { $0.uuid == Self.packetUUID }) else { return }
        outbound[p.identifier] = (p, char)
        p.setNotifyValue(true, for: char)
        log("connected to a nearby device")
        updatePeers()
        catchUp(p.identifier)
    }

    public func peripheral(_ p: CBPeripheral, didUpdateValueFor char: CBCharacteristic, error: Error?) {
        if let value = char.value { ingest(frame: value, from: p.identifier) }
    }

    public func peripheral(_ p: CBPeripheral, didReadRSSI RSSI: NSNumber, error: Error?) {
        guard error == nil else { return }
        rssi[p.identifier] = RSSI.intValue
    }
}

// MARK: - Peripheral role

extension ArcMesh: CBPeripheralManagerDelegate {
    public func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        log("peripheral: \(peripheral.state.label)")
        guard peripheral.state == .poweredOn, characteristic == nil else { return }
        let char = CBMutableCharacteristic(
            type: Self.packetUUID,
            properties: [.writeWithoutResponse, .write, .notify],
            value: nil,
            permissions: [.writeable]
        )
        let service = CBMutableService(type: Self.serviceUUID, primary: true)
        service.characteristics = [char]
        peripheral.add(service)
        characteristic = char
        peripheral.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [Self.serviceUUID]])
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        for request in requests {
            if let value = request.value { ingest(frame: value, from: request.central.identifier) }
        }
        if let first = requests.first { peripheral.respond(to: first, withResult: .success) }
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        subscribers[central.identifier] = central
        updatePeers()
        catchUp(central.identifier)
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        subscribers[central.identifier] = nil
        dropLink(central.identifier)
    }

    public func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        guard let characteristic else { return }
        while let (frame, targets) = pendingNotify.first {
            guard peripheral.updateValue(frame, for: characteristic, onSubscribedCentrals: targets) else { return }
            pendingNotify.removeFirst()
        }
    }
}

extension CBManagerState {
    var label: String {
        switch self {
        case .poweredOn: return "on"
        case .poweredOff: return "Bluetooth is off"
        case .unauthorized: return "Bluetooth permission denied"
        case .unsupported: return "Bluetooth LE unsupported"
        case .resetting: return "resetting"
        default: return "unknown"
        }
    }
}

/// Reassembles frames into messages. Input comes from any nearby device, so it
/// is bounds-checked, keyed per link (a device can't complete another's message),
/// capped in size, and incomplete messages expire.
struct FrameAssembler {
    struct Key: Hashable { let link: UUID; let id: UInt32 }
    static let maxPartial = 64
    static let maxPartialPerLink = 4
    static let partialLifetime: TimeInterval = 10

    mutating func forget(_ link: UUID) { partial = partial.filter { $0.key.link != link } }
    private var partial: [Key: (count: Int, hops: UInt8, pieces: [Int: Data], from: Date)] = [:]

    static let anyLink = UUID(uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))

    mutating func add(_ frame: Data, from link: UUID = FrameAssembler.anyLink) -> (Data, UInt8)? {
        let frame = Data(frame) // re-base indices
        guard frame.count > ArcMesh.frameHeader else { return nil }
        let id = frame.prefix(4).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
        let index = Int(frame[4]), count = Int(frame[5]), hops = frame[6]
        guard count > 0, count <= 32, index < count else { return nil }
        let body = Data(frame.dropFirst(ArcMesh.frameHeader))
        if count == 1 { return (body, hops) }

        let key = Key(link: link, id: id)
        // A message whose last frames never came (full buffer, disconnect) expires fast,
        // so it can't use up the link's slots for good.
        if partial[key] == nil { partial = partial.filter { $0.key.link != link || $0.value.from.timeIntervalSinceNow > -Self.partialLifetime } }
        if partial[key] == nil, partial.keys.filter({ $0.link == link }).count >= Self.maxPartialPerLink { return nil }
        if partial[key] == nil, partial.count >= Self.maxPartial {
            partial = partial.filter { $0.value.from.timeIntervalSinceNow > -30 }
            if partial.count >= Self.maxPartial, let oldest = partial.min(by: { $0.value.from < $1.value.from })?.key { partial[oldest] = nil }
        }
        var entry = partial[key] ?? (count, hops, [:], Date())
        guard entry.count == count else { return nil }
        entry.pieces[index] = body
        guard entry.pieces.count == count else { partial[key] = entry; return nil }
        partial[key] = nil
        return ((0..<count).reduce(into: Data()) { $0.append(entry.pieces[$1] ?? Data()) }, hops)
    }
}

extension Data {
    init?(base64URL text: String) {
        var b64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64.append("=") }
        self.init(base64Encoded: b64)
    }

    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    init?(hex: String) {
        let s = hex.hasPrefix("0x") ? String(hex.dropFirst(2)) : hex
        guard s.count % 2 == 0 else { return nil }
        var out = Data(capacity: s.count / 2)
        var i = s.startIndex
        while i < s.endIndex {
            let j = s.index(i, offsetBy: 2)
            guard let b = UInt8(s[i..<j], radix: 16) else { return nil }
            out.append(b)
            i = j
        }
        self = out
    }
}
