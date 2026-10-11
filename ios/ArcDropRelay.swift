//
// ArcDropRelay.swift
// bitchat + ArcDrop
//
// Turns every bitchat node into a payment courier. An ArcDrop payment is a
// signed USDC authorization (EIP-3009) serialized as `arcdrop:1:<base64url>`.
// It travels the BLE mesh as an ordinary message; the first node that sees it
// while it has internet forwards it to an ArcDrop gateway, which settles it on
// Arc. The recipient is inside the signature, so a courier cannot redirect it.
//
// This parses attacker-controlled message content: it is size-capped and
// returns nil instead of trapping. No keys live here; nodes only carry packets.
//
// This is free and unencumbered software released into the public domain.
//

import Foundation

enum ArcDropPacket {
    // v1 = USDC (157 bytes); v2 = token u8 + v1 layout (158 bytes), token 1 = EURC;
    // v3 = vault voucher (154 bytes): token u8 | chainId u32 | from 20 | to 20 | value u64 | validBefore u32 | nonce 32 | sig 65.
    static let prefix = "arcdrop:1:"
    static let prefixV2 = "arcdrop:2:"
    static let prefixV3 = "arcdrop:3:"
    static let byteLength = 157

    struct Info: Equatable {
        let packet: String
        let chainId: UInt32
        let from: String
        let to: String
        /// USDC base units (6 decimals).
        let value: UInt64
        let validBefore: UInt32
        let nonce: String
        var token: UInt8 = 0
        var vault = false

        var symbol: String { token == 1 ? "EURC" : "USDC" }

        var displayAmount: String {
            let whole = value / 1_000_000
            var frac = String(format: "%06llu", value % 1_000_000)
            while frac.hasSuffix("0") { frac.removeLast() }
            return frac.isEmpty ? "\(whole) \(symbol)" : "\(whole).\(frac) \(symbol)"
        }
    }

    /// Finds the first packet in arbitrary text (a bitchat message, a link…).
    static func extract(from text: String) -> String? {
        guard text.count < 4_000, let start = text.range(of: prefixV3) ?? text.range(of: prefixV2) ?? text.range(of: prefix) else { return nil }
        let head = String(text[start])
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        var body = ""
        for scalar in text[start.upperBound...].unicodeScalars {
            guard allowed.contains(scalar) else { break }
            body.unicodeScalars.append(scalar)
            if body.count > 400 { return nil }
        }
        return body.count >= 150 ? head + body : nil
    }

    static func decode(_ text: String) -> Info? {
        guard let packet = extract(from: text) else { return nil }
        let v2 = packet.hasPrefix(prefixV2), v3 = packet.hasPrefix(prefixV3)
        var b64 = String(packet.dropFirst(prefix.count))
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64.append("=") }
        guard let data = Data(base64Encoded: b64), data.count == (v3 ? 154 : byteLength + (v2 ? 1 : 0)) else { return nil }
        let token: UInt8 = v2 || v3 ? data[data.startIndex] : 0
        guard token <= 1 else { return nil }
        let bytes = [UInt8](v2 || v3 ? data.dropFirst() : data)

        func uint(_ offset: Int, _ size: Int) -> UInt64 {
            bytes[offset..<offset + size].reduce(0) { $0 << 8 | UInt64($1) }
        }
        func hex(_ offset: Int, _ size: Int) -> String {
            "0x" + bytes[offset..<offset + size].map { String(format: "%02x", $0) }.joined()
        }
        if v3 { // chainId u32 | from 20 | to 20 | value u64 | validBefore u32 | nonce 32 | sig 65
            return Info(packet: packet, chainId: UInt32(uint(0, 4)), from: hex(4, 20), to: hex(24, 20),
                        value: uint(44, 8), validBefore: UInt32(uint(52, 4)), nonce: hex(56, 32), token: token, vault: true)
        }
        // chainId u32 | from 20 | to 20 | value u64 | validAfter u32 | validBefore u32 | nonce 32 | sig 65
        return Info(
            packet: packet,
            chainId: UInt32(uint(0, 4)),
            from: hex(4, 20),
            to: hex(24, 20),
            value: uint(44, 8),
            validBefore: UInt32(uint(56, 4)),
            nonce: hex(60, 32),
            token: token
        )
    }
}

/// Forwards payments seen on the mesh to a gateway once internet is available.
/// Gateway URL: UserDefaults `arcdrop.gateway`, else `defaultGateway`.
actor ArcDropRelay {
    static let shared = ArcDropRelay()
    /// Set to the deployed ArcDrop gateway before building.
    static let defaultGateway = "https://arcdrop-pink.vercel.app"

    enum State: Equatable { case queued, settled(tx: String?, ms: Int?), rejected(String) }

    // Keyed by the whole packet, not from+nonce: a forged copy reusing a real
    // nonce must not be able to get the genuine payment ignored.
    private var queue: [String: ArcDropPacket.Info] = [:]
    private(set) var states: [String: State] = [:]
    private var retryTask: Task<Void, Never>?
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    private var gateway: URL? {
        URL(string: UserDefaults.standard.string(forKey: "arcdrop.gateway") ?? Self.defaultGateway)
    }

    // Anyone nearby can feed us packets: bound what we keep and what we forward.
    static let maxStates = 500
    static let maxQueue = 100
    static let minValue: UInt64 = 10_000 // 0.01, same floor as the gateway
    private var flushing = false

    /// Call with every message sent or received. Cheap when there is no packet.
    nonisolated func observe(_ content: String) {
        guard content.contains("arcdrop:"), let info = ArcDropPacket.decode(content) else { return }
        Task { await self.enqueue(info) }
    }

    func enqueue(_ info: ArcDropPacket.Info) async {
        let key = info.packet
        guard states[key] == nil else { return }    // same packet via another mesh path
        guard UInt32(Date().timeIntervalSince1970) < info.validBefore, info.value >= Self.minValue else { return }
        if states.count >= Self.maxStates {
            states = states.filter { if case .queued = $0.value { return true } else { return false } }
        }
        guard queue.count < Self.maxQueue, states.count < Self.maxStates else { return }
        queue[key] = info
        states[key] = .queued
        await flush()
    }

    func flush() async {
        // One pass at a time: actor reentrancy would otherwise post the same packets repeatedly.
        guard let gateway, !flushing else { return }
        flushing = true
        defer { flushing = false }
        let now = UInt32(Date().timeIntervalSince1970)
        for (key, info) in queue where info.validBefore <= now { queue[key] = nil; states[key] = .rejected("expired") }
        for (key, info) in queue {
            var request = URLRequest(url: gateway.appendingPathComponent("api/relay"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: ["packet": info.packet])
            guard let (data, response) = try? await session.data(for: request),
                  let status = (response as? HTTPURLResponse)?.statusCode else {
                continue    // offline: keep it, retry later
            }
            let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            switch status {
            case 200 where body["ok"] as? Bool == true:
                states[key] = .settled(tx: body["url"] as? String, ms: body["settleMs"] as? Int)
                queue[key] = nil
            case 402:
                continue    // payer not funded yet; keep carrying it
            default:
                states[key] = .rejected(body["error"] as? String ?? "HTTP \(status)")
                queue[key] = nil
            }
        }
        scheduleRetry()
    }

    /// Where a payment stands, by packet text (`arcdrop:1:…`).
    func state(of packet: String) -> State? {
        ArcDropPacket.extract(from: packet).flatMap { states[$0] }
    }

    private func scheduleRetry() {
        guard !queue.isEmpty, retryTask == nil else { return }
        retryTask = Task {
            try? await Task.sleep(nanoseconds: 15_000_000_000)
            self.retryDone()
            await self.flush()
        }
    }

    private func retryDone() { retryTask = nil }
}
