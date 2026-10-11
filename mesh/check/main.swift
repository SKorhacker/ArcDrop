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
    precondition(v?.tab == true && v?.displayAmount == "0.7 USDC", "relay decodes v4 (tab voucher)")
    print("relay decodes v4 (tab voucher, cumulative):", v!.displayAmount)
}

// ---------- attacks from a hostile nearby device ----------
let linkA = UUID(), linkB = UUID()

// 1. Fragment flood: 20 000 never-finished messages must stay bounded and fast.
var flood = FrameAssembler()
let t0 = Date()
for i in 0..<20_000 {
    var f = withUnsafeBytes(of: UInt32(i)) { Data($0) }
    f.append(contentsOf: [0, 2, 1]); f.append(Data(repeating: 7, count: 100))
    _ = flood.add(f, from: linkA)
}
let floodTime = Date().timeIntervalSince(t0)
precondition(floodTime < 2, "fragment flood too slow: \(floodTime)s")
// a genuine message still gets through afterwards
var ok: (Data, UInt8)?
for f in ArcMesh.frames(for: e, hops: 1, maxLength: 64) { if let r = flood.add(f, from: linkB) { ok = r } }
precondition(ok?.0 == e, "genuine message lost after flood")
print(String(format: "✓ 20 000-fragment flood absorbed in %.2f s, genuine message still delivered", floodTime))

// 2. Another device cannot complete (or corrupt) a message in flight from someone else.
var iso = FrameAssembler()
let parts = ArcMesh.frames(for: e, hops: 1, maxLength: 64)
_ = iso.add(parts[0], from: linkA)
var hijack: (Data, UInt8)?
for f in parts.dropFirst() { if let r = iso.add(f, from: linkB) { hijack = r } }
precondition(hijack == nil, "cross-link reassembly must be impossible")
print("✓ frames from another device cannot complete someone else's message")

// 3. Junk payments are neither stored nor forwarded.
func envelopeV1(chain: UInt32, value: UInt64, validAfter: UInt32, validBefore: UInt32) -> Data {
    var d = Data([1])
    withUnsafeBytes(of: chain.bigEndian) { d.append(contentsOf: $0) }
    d.append(Data(repeating: 0xAA, count: 40))
    withUnsafeBytes(of: value.bigEndian) { d.append(contentsOf: $0) }
    withUnsafeBytes(of: validAfter.bigEndian) { d.append(contentsOf: $0) }
    withUnsafeBytes(of: validBefore.bigEndian) { d.append(contentsOf: $0) }
    d.append(Data(repeating: 0xBB, count: 97))
    return d
}
let nowS = UInt32(Date().timeIntervalSince1970)
precondition(ArcMesh.plausible(envelopeV1(chain: 5042002, value: 100_000, validAfter: 0, validBefore: nowS + 3600)))
precondition(!ArcMesh.plausible(envelopeV1(chain: 1, value: 100_000, validAfter: 0, validBefore: nowS + 3600)), "unknown chain")
precondition(!ArcMesh.plausible(envelopeV1(chain: 5042002, value: 0, validAfter: 0, validBefore: nowS + 3600)), "zero value")
precondition(!ArcMesh.plausible(envelopeV1(chain: 5042002, value: 100_000, validAfter: 0, validBefore: nowS - 1)), "expired")
precondition(!ArcMesh.plausible(envelopeV1(chain: 5042002, value: 100_000, validAfter: nowS + 3600, validBefore: nowS + 7200)), "postdated")
precondition(ArcMesh.plausible(ArcMesh.envelope(from: args[0])!), "real packet plausible")
print("✓ expired, zero, postdated and unknown-chain payments are dropped by the mesh")
