// ArcDrop mesh relay for macOS: joins the Bluetooth mesh, carries payments,
// and settles them through the gateway whenever this Mac has internet.
//   arcmesh-node [gateway-url]          then paste packets on stdin to broadcast them
import Foundation

/// Strings from the air or from a gateway may contain terminal escape sequences:
/// keep printable characters only, and keep them short.
func clean(_ text: String, max: Int = 80) -> String {
    String(text.unicodeScalars.filter {
        !CharacterSet.controlCharacters.contains($0) && $0.properties.generalCategory != .format
    }.prefix(max).map(Character.init))
}

setvbuf(stdout, nil, _IOLBF, 0) // line-buffered even when piped to a log

final class Node: ArcMeshDelegate {
    let mesh = ArcMesh()
    init() { mesh.delegate = self }
    func mesh(_ mesh: ArcMesh, didReceive packet: String, hops: Int) {
        let amount = ArcDropPacket.decode(packet)?.displayAmount ?? "?"
        print("💸 \(amount) received over Bluetooth (\(hops) hop\(hops == 1 ? "" : "s"), signature checked by the gateway)")
        ArcDropRelay.shared.observe(packet)
        report(packet)
    }
    func mesh(_ mesh: ArcMesh, peersChanged count: Int) { print("📡 linked devices: \(count)") }
    func mesh(_ mesh: ArcMesh, nearbyChanged peers: [NearbyPeer]) {
        print("👥 nearby: " + (peers.isEmpty ? "nobody" : peers.map { "\($0.name.isEmpty ? String($0.address.prefix(10)) : clean($0.name, max: 24)) …\($0.address.suffix(4)) (\($0.rssi.map { "\($0) dBm" } ?? "?"))" }.joined(separator: ", ")))
    }
    func mesh(_ mesh: ArcMesh, didReceiveReceipt receipt: String) { print("🧾 receipt carried over Bluetooth") }
    func mesh(_ mesh: ArcMesh, log: String) { print("· \(clean(log))") }
}

/// Prints the outcome once the gateway answers; keeps waiting while there is no internet.
var reporting = 0 // bounded: a flood must not spawn unlimited pollers
func report(_ packet: String) {
    guard reporting < 50 else { return }
    reporting += 1
    Task { @MainActor in
        defer { reporting -= 1 }
        var announcedWait = false
        for _ in 0..<1200 {
            switch await ArcDropRelay.shared.state(of: packet) {
            case .settled(let tx, let ms)?:
                print("✅ settled on Arc\(ms.map { String(format: " in %.2f s", Double($0) / 1000) } ?? "")\(tx.map { " → \(clean($0, max: 120))" } ?? "")")
                return
            case .rejected(let reason)?:
                print("⛔️ rejected: \(clean(reason))")
                return
            case .queued?:
                if !announcedWait { print("⏳ carried; settles as soon as this Mac has internet"); announcedWait = true }
            case nil:
                break
            }
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
    }
}

if CommandLine.arguments.count > 1 {
    UserDefaults.standard.set(CommandLine.arguments[1], forKey: "arcdrop.gateway")
}
let node = Node()
print("ArcDrop mesh node started. Paste an arcdrop:1:… packet and press enter to broadcast it.")

let stdin = FileHandle.standardInput
stdin.readabilityHandler = { handle in
    let data = handle.availableData
    guard !data.isEmpty else { handle.readabilityHandler = nil; return } // stdin closed
    guard let line = String(data: data, encoding: .utf8) else { return }
    // Hop to the main thread: report() and the mesh delegate share state there.
    DispatchQueue.main.async { for text in line.split(separator: "\n") where text.contains("arcdrop:") {
        node.mesh.broadcast(String(text))
        ArcDropRelay.shared.observe(String(text))
        print("→ broadcasting to nearby devices")
        report(String(text))
    } }
}
RunLoop.main.run()
