// ArcDrop mesh relay for macOS: joins the Bluetooth mesh, carries payments,
// and settles them through the gateway whenever this Mac has internet.
//   arcmesh-node [gateway-url]          then paste packets on stdin to broadcast them
import Foundation

final class Node: ArcMeshDelegate {
    let mesh = ArcMesh()
    init() { mesh.delegate = self }
    func mesh(_ mesh: ArcMesh, didReceive packet: String, hops: Int) {
        print("💸 received over Bluetooth (\(hops) hops): \(packet.prefix(28))…")
        ArcDropRelay.shared.observe(packet)
    }
    func mesh(_ mesh: ArcMesh, peersChanged count: Int) { print("📡 nearby devices: \(count)") }
    func mesh(_ mesh: ArcMesh, log: String) { print("· \(log)") }
}

if CommandLine.arguments.count > 1 {
    UserDefaults.standard.set(CommandLine.arguments[1], forKey: "arcdrop.gateway")
}
let node = Node()
print("ArcDrop mesh node started. Paste an arcdrop:1:… packet and press enter to broadcast it.")

let stdin = FileHandle.standardInput
stdin.readabilityHandler = { handle in
    guard let line = String(data: handle.availableData, encoding: .utf8), !line.isEmpty else { return }
    for text in line.split(separator: "\n") where text.contains("arcdrop:1:") {
        node.mesh.broadcast(String(text))
        ArcDropRelay.shared.observe(String(text))
        print("→ broadcasting to nearby devices")
    }
}
RunLoop.main.run()
