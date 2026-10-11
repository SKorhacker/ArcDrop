# bitchat × ArcDrop

`ArcDropRelay.swift` turns every bitchat node into a payment courier: when a message contains an `arcdrop:1:` packet, the node queues it and forwards it to the ArcDrop gateway as soon as it has internet (retries every 15 s; a 402 "payer not funded yet" keeps it queued).

`bitchat-arcdrop.patch` applies the file plus three hooks to bitchat `main`:
- `ChatTransportEventCoordinator.handleReceivedMessage` (private + mesh messages)
- `ChatTransportEventCoordinator.handlePublicMessage` (public mesh channel)
- `ChatOutgoingCoordinator.sendMessage` (the sender settles right away if online)

**Status: not compiled yet.** This Mac has no full Xcode and its Command Line Tools Swift toolchain is broken, so neither file has been type-checked. Build with Xcode before the demo.
