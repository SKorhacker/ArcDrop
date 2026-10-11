// Mesh checks without Bluetooth: message envelopes and framing at several MTUs.
// Args: a v1 packet, a v2 (EURC) packet, a receipt.
import Foundation

let args = Array(CommandLine.arguments.dropFirst())
for text in args {
    guard let envelope = ArcMesh.envelope(from: "msg " + text + " end") else { fatalError("envelope failed: \(text.prefix(14))") }
    precondition(ArcMesh.text(from: envelope) == text, "round trip \(text.prefix(14))")
    for mtu in [20, 23, 64, 100, 159, 160, 182, 185, 512] {
        var a = FrameAssembler()
        let frames = ArcMesh.frames(for: envelope, hops: 3, maxLength: mtu).shuffled()
        precondition(frames.allSatisfy { $0.count <= mtu }, "frame larger than MTU \(mtu)")
        var out: (Data, UInt8)?
        for f in frames { if let r = a.add(f) { out = r } }
        precondition(out?.0 == envelope && out?.1 == 3, "reassembly failed at MTU \(mtu)")
    }
    print("\(text.prefix(14))… envelope + framing ok (\(envelope.count) bytes)")
}
precondition(ArcMesh.envelope(from: "arcdrop:1:tooShort") == nil, "rejects garbage")
precondition(ArcMesh.text(from: Data([9, 1, 2])) == nil, "rejects unknown kind")

var a = FrameAssembler()
let e = ArcMesh.envelope(from: args[0])!
let f1 = ArcMesh.frames(for: e, hops: 1, maxLength: 64), f2 = ArcMesh.frames(for: e, hops: 2, maxLength: 64)
var got = 0
for f in zip(f1, f2).flatMap({ [$0, $1] }) + [Data([1, 2, 3]), Data(repeating: 255, count: 40)] {
    if a.add(f)?.0 == e { got += 1 }
}
precondition(got == 2, "interleaved")
print("interleaved + garbage ok")

// The relay decodes both packet versions.
precondition(ArcDropPacket.decode(args[0])?.symbol == "USDC")
precondition(ArcDropPacket.decode(args[1])?.symbol == "EURC")
print("relay decodes v1 (USDC) and v2 (EURC):", ArcDropPacket.decode(args[1])!.displayAmount)
if args.count > 3 {
    let v = ArcDropPacket.decode(args[3])
    precondition(v?.vault == true && v?.displayAmount == "0.7 USDC", "relay decodes v3 (vault voucher)")
    print("relay decodes v3 (vault voucher):", v!.displayAmount)
}
