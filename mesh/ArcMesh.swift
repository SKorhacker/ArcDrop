//
// ArcMesh.swift
// ArcDrop's own Bluetooth LE mesh. Every device is both a peripheral
// (advertises, accepts writes, notifies subscribers) and a central (scans,
// connects, subscribes, writes), so phones talk to each other directly with
// no network.
//
// Messages (envelope = type u8 | body):
//   1 payment  signed USDC/EURC authorization (157 or 158 bytes), flooded
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
    /// A payment (`arcdrop:1:…` / `arcdrop:2:…`) seen for the first time.
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
            guard self.remember(envelope, hops: 0) else { return }
            self.send(envelope, hops: 0, to: nil)
        }
    }

    /// Who this device is, announced to neighbors so they can pay it by name.
    public func setProfile(address: String, name: String) {
        guard let addr = Data(hex: address), addr.count == 20 else { return }
        var body = Data([Kind.hello.rawValue]) + addr
        body.append(Data(name.prefix(32).utf8))
        queue.async {
            self.profile = body
            self.send(body, hops: 0, to: nil)
        }
    }

    // MARK: Text <-> envelope (same encodings as core/arcdrop.js)

    static func envelope(from text: String) -> Data? {
        for (prefix, kind, lengths) in [("arcdrop:2:", Kind.payment, [158]), ("arcdrop:1:", .payment, [157]), ("arcdrop-ack:1:", .receipt, [97])] {
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
        case (.receipt, 97): return "arcdrop-ack:1:" + body.base64URL
        default: return nil
        }
    }

    // MARK: Store & flood

    /// Returns false if we already had it.
    private func remember(_ envelope: Data, hops: UInt8) -> Bool {
        let key = Data(SHA256.hash(data: envelope))
        guard store[key] == nil else { return false }
        if store.count >= Self.maxStored, let oldest = store.min(by: { $0.value.seen < $1.value.seen })?.key {
            store[oldest] = nil
        }
        store[key] = (envelope, hops, Date())
        return true
    }

    private func received(_ envelope: Data, hops: UInt8, from link: UUID) {
        guard let first = envelope.first, let kind = Kind(rawValue: first) else { return }
        if kind == .hello { return heard(envelope, from: link) }
        guard let text = Self.text(from: envelope), remember(envelope, hops: hops) else { return }
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
        let name = String(decoding: body.dropFirst(20), as: UTF8.self)
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
                link.peripheral.writeValue(frame, for: char, type: .withoutResponse)
            }
        }
        // As a peripheral, notify centrals subscribed to us.
        let targets = subscribers.filter { peer == nil || peer == $0.key }.map(\.value)
        guard !targets.isEmpty, let characteristic else { return }
        let max = targets.map { $0.maximumUpdateValueLength }.min() ?? 20
        for frame in Self.frames(for: envelope, hops: hops + 1, maxLength: max) {
            if !peripheral.updateValue(frame, for: characteristic, onSubscribedCentrals: targets) {
                pendingNotify.append((frame, targets))
            }
        }
    }

    private func catchUp(_ peer: UUID) {
        if let profile { send(profile, hops: 0, to: peer) }
        for item in store.values where item.hops < Self.maxHops { send(item.envelope, hops: item.hops, to: peer) }
    }

    /// Every few seconds: say hello, refresh signal strength, forget silent neighbors.
    private func tick() {
        if let profile { send(profile, hops: 0, to: nil) }
        for link in outbound.values where link.char != nil { link.peripheral.readRSSI() }
        hellos = hellos.filter { $0.value.seen.timeIntervalSinceNow > -Self.nearbyTimeout }
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
        let peers = best.values.sorted { ($0.rssi ?? -200) > ($1.rssi ?? -200) }
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
        if let (bytes, hops) = assembler.add(frame) { received(bytes, hops: hops, from: link) }
    }

    private func dropLink(_ id: UUID) {
        hellos[id] = nil
        rssi[id] = nil
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
/// is bounds-checked and incomplete messages expire.
struct FrameAssembler {
    private var partial: [UInt32: (count: Int, hops: UInt8, pieces: [Int: Data], from: Date)] = [:]

    mutating func add(_ frame: Data) -> (Data, UInt8)? {
        let frame = Data(frame) // re-base indices
        guard frame.count > ArcMesh.frameHeader else { return nil }
        let id = frame.prefix(4).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
        let index = Int(frame[4]), count = Int(frame[5]), hops = frame[6]
        guard count > 0, count <= 32, index < count else { return nil }
        let body = Data(frame.dropFirst(ArcMesh.frameHeader))
        if count == 1 { return (body, hops) }

        partial = partial.filter { $0.value.from.timeIntervalSinceNow > -30 }
        var entry = partial[id] ?? (count, hops, [:], Date())
        guard entry.count == count else { return nil }
        entry.pieces[index] = body
        guard entry.pieces.count == count else { partial[id] = entry; return nil }
        partial[id] = nil
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
