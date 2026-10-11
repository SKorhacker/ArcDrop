# bitchat × ArcDrop

`ArcDropRelay.swift` turns every bitchat node into a payment courier: when a message contains an `arcdrop:1:` packet, the node queues it and forwards it to the ArcDrop gateway as soon as it has internet (retries every 15 s; a 402 "payer not funded yet" keeps it queued).

`bitchat-arcdrop.patch` applies the file plus three hooks to bitchat `main`:
- `ChatTransportEventCoordinator.handleReceivedMessage` (private + mesh messages)
- `ChatTransportEventCoordinator.handlePublicMessage` (public mesh channel)
- `ChatOutgoingCoordinator.sendMessage` (the sender settles right away if online)

It also extends `/pay` (`CommandProcessor.swift`) to send ArcDrop payments to the current DM or the public mesh.

**Status:** `ArcDropRelay.swift` compiles and passes `scripts/swift-check.sh` (Command Line Tools + VFS overlay workaround). The hooks and the `/pay` change touch app types, so they need a full Xcode build: this Mac has no Xcode and SwiftPM cannot even compile bitchat's manifest with these Command Line Tools.
