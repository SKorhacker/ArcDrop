// Framing check without Bluetooth: split payments at several MTUs, shuffle, reassemble.
import Foundation

let sample = CommandLine.arguments[1]
guard let bytes = ArcMesh.packetBytes(from: "💸 msg " + sample) else { fatalError("decode failed") }
precondition(ArcMesh.packetText(from: bytes) == sample, "round trip text")

for mtu in [20, 23, 64, 100, 159, 160, 182, 185, 512] {
    var a = FrameAssembler()
    let frames = ArcMesh.frames(for: bytes, hops: 3, maxLength: mtu).shuffled()
    precondition(frames.allSatisfy { $0.count <= mtu }, "frame larger than MTU \(mtu)")
    var out: (Data, UInt8)?
    for f in frames { if let r = a.add(f) { out = r } }
    precondition(out?.0 == bytes && out?.1 == 3, "reassembly failed at MTU \(mtu)")
    print("MTU \(mtu): \(frames.count) frame(s) ok")
}
// Interleaved messages, garbage and truncated frames must not crash or mix.
var a = FrameAssembler()
let f1 = ArcMesh.frames(for: bytes, hops: 1, maxLength: 64), f2 = ArcMesh.frames(for: bytes, hops: 2, maxLength: 64)
var got = 0
for f in zip(f1, f2).flatMap({ [$0, $1] }) + [Data([1, 2, 3]), Data(repeating: 255, count: 40)] {
    if a.add(f)?.0 == bytes { got += 1 }
}
precondition(got == 2, "interleaved")
print("interleaved + garbage ok")
