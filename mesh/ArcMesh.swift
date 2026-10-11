//
// ArcMesh.swift
// ArcDrop's own Bluetooth LE mesh. Every device is both a peripheral
// (advertises, accepts writes, notifies subscribers) and a central (scans,
// connects, subscribes, writes), so phones talk to each other directly with
// no network.
//
// What travels: ArcDrop payments (157-byte signed USDC authorizations).
// They are store-and-forward: a node keeps every payment it has seen and
// hands it to each new peer it meets, and floods new ones with a hop limit.
// So a payment can cross a festival in pockets, hours later, until any node
// with internet settles it on Arc. Packets are self-authenticating (the
// recipient is inside the signature), so nodes need no trust in each other.
//
// Shared by the iOS app and the macOS relay node.
//

import CoreBluetooth
import CryptoKit
import Foundation

public protocol ArcMeshDelegate: AnyObject {
    /// A payment packet (`arcdrop:1:…`) seen for the first time.
    func mesh(_ mesh: ArcMesh, didReceive packet: String, hops: Int)
    func mesh(_ mesh: ArcMesh, peersChanged count: Int)
    func mesh(_ mesh: ArcMesh, log: String)
}

public final class ArcMesh: NSObject {
    public static let serviceUUID = CBUUID(string: "A7C0D509-5E1F-4B8E-9A3B-1D2C3E4F5A60")
    static let packetUUID = CBUUID(string: "A7C0D509-5E1F-4B8E-9A3B-1D2C3E4F5A61")

    static let maxHops: UInt8 = 7
    static let maxStored = 500
    static let frameHeader = 7 // msgId 4 | index 1 | count 1 | hops 1

    public weak var delegate: ArcMeshDelegate?
    public private(set) var peerCount = 0

    private let queue = DispatchQueue(label: "arcmesh")
    private var central: CBCentralManager!
    private var peripheral: CBPeripheralManager!
    private var characteristic: CBMutableCharacteristic?

    // Remote peripherals we connected to, and the characteristic we write to.
    private var outbound: [UUID: (peripheral: CBPeripheral, char: CBCharacteristic?)] = [:]
    // Remote centrals subscribed to our characteristic.
    private var subscribers: [UUID: CBCentral] = [:]

    // Store-and-forward: packet bytes by content hash, with the hop count we got it at.
    private var store: [Data: (bytes: Data, hops: UInt8, seen: Date)] = [:]
    private var assembler = FrameAssembler()
    // Frames waiting for the peripheral manager to have room again.
    private var pendingNotify: [(Data, [CBCentral]?)] = []

    public override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: queue)
        peripheral = CBPeripheralManager(delegate: self, queue: queue)
    }

    // MARK: Public API

    /// Signs nothing, trusts nothing: just floods a payment to every neighbor.
    public func broadcast(_ text: String) {
        guard let bytes = Self.packetBytes(from: text) else { log("not an ArcDrop packet"); return }
        queue.async {
            guard self.remember(bytes, hops: 0) else { self.log("already carrying this payment"); return }
            self.send(bytes, hops: 0, to: nil)
        }
    }

    /// Payments currently carried by this device.
    public var carried: [String] {
        queue.sync { store.values.map { Self.packetText(from: $0.bytes) } }
    }

    // MARK: Packet encoding (same 157-byte layout as core/arcdrop.js)

    static let prefix = "arcdrop:1:"
    static let packetLength = 157

    public static func packetBytes(from text: String) -> Data? {
        guard let range = text.range(of: prefix) else { return nil }
        let body = text[range.upperBound...].prefix { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
        var b64 = body.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64.append("=") }
        guard let data = Data(base64Encoded: b64), data.count == packetLength else { return nil }
        return data
    }

    public static func packetText(from bytes: Data) -> String {
        prefix + bytes.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    // MARK: Store & flood

    /// Returns false if we already had it.
    private func remember(_ bytes: Data, hops: UInt8) -> Bool {
        let key = Data(SHA256.hash(data: bytes))
        guard store[key] == nil else { return false }
        if store.count >= Self.maxStored, let oldest = store.min(by: { $0.value.seen < $1.value.seen })?.key {
            store[oldest] = nil
        }
        store[key] = (bytes, hops, Date())
        return true
    }

    private func received(_ bytes: Data, hops: UInt8) {
        guard bytes.count == Self.packetLength, remember(bytes, hops: hops) else { return }
        let text = Self.packetText(from: bytes)
        log("payment received (\(hops) hop\(hops == 1 ? "" : "s"))")
        DispatchQueue.main.async { self.delegate?.mesh(self, didReceive: text, hops: Int(hops)) }
        if hops < Self.maxHops { send(bytes, hops: hops, to: nil) }
    }

    /// Sends to every neighbor, or only to `peer` (a newly met device catching up).
    private func send(_ bytes: Data, hops: UInt8, to peer: UUID?) {
        let frames = Self.frames(for: bytes, hops: hops + 1, maxLength: 180)
        // As a central, write to peripherals we connected to.
        for (id, link) in outbound where peer == nil || peer == id {
            guard let char = link.char else { continue }
            let max = link.peripheral.maximumWriteValueLength(for: .withoutResponse)
            for frame in Self.frames(for: bytes, hops: hops + 1, maxLength: max) {
                link.peripheral.writeValue(frame, for: char, type: .withoutResponse)
            }
        }
        // As a peripheral, notify centrals subscribed to us.
        let targets = subscribers.filter { peer == nil || peer == $0.key }.map(\.value)
        guard !targets.isEmpty, let characteristic else { return }
        let max = targets.map { $0.maximumUpdateValueLength }.min() ?? 20
        for frame in (max >= 180 ? frames : Self.frames(for: bytes, hops: hops + 1, maxLength: max)) {
            if !peripheral.updateValue(frame, for: characteristic, onSubscribedCentrals: targets) {
                pendingNotify.append((frame, targets))
            }
        }
    }

    private func catchUp(_ peer: UUID) {
        for item in store.values where item.hops < Self.maxHops { send(item.bytes, hops: item.hops, to: peer) }
    }

    // MARK: Framing (BLE packets can be smaller than a payment)

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

    private func ingest(frame: Data) {
        if let (bytes, hops) = assembler.add(frame) { received(bytes, hops: hops) }
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
        updatePeers()
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
        if let value = char.value { ingest(frame: value) }
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
            if let value = request.value { ingest(frame: value) }
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
        updatePeers()
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

/// Reassembles frames into packets. Input comes from any nearby device, so it
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
