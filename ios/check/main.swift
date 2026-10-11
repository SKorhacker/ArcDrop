import Foundation
// Run with scripts/swift-check.sh. Expected: valid -> settled, unfunded -> queued,
// forged -> rejected, and a genuine packet still settles when a forgery arrives first.
UserDefaults.standard.set("http://localhost:8787", forKey: "arcdrop.gateway")
let args = CommandLine.arguments
let relay = ArcDropRelay.shared
relay.observe("💸 0 USDC via mesh\n" + args[1])   // valid -> settled (simulated)
relay.observe("hey " + args[2])                    // unfunded -> stays queued
relay.observe(args[3])                             // tampered -> rejected
relay.observe(args[1])                             // duplicate path -> ignored
relay.observe("hello world")                       // not a packet
try await Task.sleep(nanoseconds: 4_000_000_000)
for (k, v) in await relay.states { print(k.dropFirst(10).prefix(12), v) }
// forged copy first, then the genuine one: the genuine one must still settle
let relay2 = ArcDropRelay()
relay2.observe(args[5]); try await Task.sleep(nanoseconds: 1_000_000_000)
relay2.observe(args[4]); try await Task.sleep(nanoseconds: 3_000_000_000)
print("--- forged first:"); for (k, v) in await relay2.states { print(k.dropFirst(10).prefix(12), v) }
