// Hosts the ArcDrop web app and gives it what Safari can't: the Bluetooth mesh,
// the native share sheet (AirDrop), the Keychain and background settlement.
// The web app is bundled in the app (Web/), so it works offline from the first launch.
//
// JS → native: webkit.messageHandlers.arcmesh.postMessage({ type, … })
//   { type: "broadcast", packet }        flood a signed payment or a receipt over Bluetooth
//   { type: "profile", address, name }   announce this wallet to nearby devices
//   { type: "share", url, text }         open the share sheet (AirDrop)
//   { type: "haptic", kind }             light / success / error vibration
//   { type: "saveKey", key }             store the wallet key in the Keychain
// native → JS: arcdropReceive(packet, hops), arcdropReceipt(text), arcdropNearby([{address,name,rssi}]),
//              arcdropMeshPeers(count), arcdropOpenURL(url)
//              ARCDROP_NATIVE_KEY is injected before the page's scripts run.

import Security
import SwiftUI
import WebKit

struct WebAppView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> WebAppController { WebAppController() }
    func updateUIViewController(_ controller: WebAppController, context: Context) {}
}

final class WebAppController: UIViewController, WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate, ArcMeshDelegate {
    private var webView: WKWebView!
    private let mesh = ArcMesh()
    private var loaded = false
    private var pendingURLs: [URL] = []
    private var peers = 0 // last count reported on the main thread (ArcMesh's own counter lives on its queue)

    override func viewDidLoad() {
        super.viewDidLoad()
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true // QR scanner video
        config.userContentController.add(self, name: "arcmesh")
        if let key = Keychain.load(), let json = try? JSONSerialization.data(withJSONObject: [key]),
           let literal = String(data: json, encoding: .utf8) {
            config.userContentController.addUserScript(WKUserScript(
                source: "globalThis.ARCDROP_NATIVE_KEY = \(literal)[0]",
                injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }

        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        view.addSubview(webView)
        if let page = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "Web") {
            webView.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
        }

        mesh.delegate = self
        NotificationCenter.default.addObserver(forName: .arcdropOpenURL, object: nil, queue: .main) { [weak self] note in
            guard let self, let url = note.object as? URL else { return }
            if self.loaded { self.call("arcdropOpenURL", url.absoluteString) } else if self.pendingURLs.count < 10 { self.pendingURLs.append(url) }
        }
    }

    // MARK: JS → native

    /// The bridge only answers ArcDrop's own bundled page, never another document or frame.
    private func trusted(_ frame: WKFrameInfo) -> Bool {
        frame.isMainFrame && frame.request.url?.isFileURL == true && webView.url?.isFileURL == true
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard trusted(message.frameInfo),
              let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "broadcast":
            guard let packet = body["packet"] as? String else { return }
            mesh.broadcast(packet)
            ArcDropRelay.shared.observe(packet) // settle right away if this phone is online (ignores receipts)
        case "profile":
            if let address = body["address"] as? String { mesh.setProfile(address: address, name: body["name"] as? String ?? "") }
        case "presence":
            if body["on"] as? Bool == false { mesh.stopPresence() }
        case "share":
            var items: [Any] = []
            if let text = body["text"] as? String { items.append(text) }
            if let url = (body["url"] as? String).flatMap(URL.init(string:)) { items.append(url) }
            let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
            sheet.popoverPresentationController?.sourceView = view
            present(sheet, animated: true)
        case "saveKey":
            // Never overwrite an existing wallet unless the user explicitly imported a key.
            guard let key = body["key"] as? String else { return }
            let replace = body["replace"] as? Bool ?? false
            let ok = Keychain.load() == nil || replace ? Keychain.save(key) : Keychain.load() == key
            call("arcdropKeySaved", ok)
        case "haptic":
            switch body["kind"] as? String {
            case "light": UISelectionFeedbackGenerator().selectionChanged()
            case "error": UINotificationFeedbackGenerator().notificationOccurred(.error)
            default: UINotificationFeedbackGenerator().notificationOccurred(.success)
            }
        default:
            break
        }
    }

    // MARK: Mesh → JS

    func mesh(_ mesh: ArcMesh, didReceive packet: String, hops: Int) {
        ArcDropRelay.shared.observe(packet)
        call("arcdropReceive", packet, hops)
    }

    func mesh(_ mesh: ArcMesh, peersChanged count: Int) { peers = count; call("arcdropMeshPeers", count) }

    func mesh(_ mesh: ArcMesh, didReceiveReceipt receipt: String) { call("arcdropReceipt", receipt) }

    func mesh(_ mesh: ArcMesh, nearbyChanged peers: [NearbyPeer]) {
        call("arcdropNearby", peers.map { ["address": $0.address, "name": $0.name, "rssi": $0.rssi.map { $0 as Any } ?? NSNull()] })
    }

    func mesh(_ mesh: ArcMesh, log: String) { print("[mesh] \(log)") }

    private func call(_ function: String, _ arguments: Any...) {
        guard let data = try? JSONSerialization.data(withJSONObject: arguments, options: [.fragmentsAllowed]),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("globalThis.\(function) && globalThis.\(function)(...\(json))")
    }

    // When the web app finishes loading: nearby devices, and any payment link that opened the app.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        call("arcdropMeshPeers", peers)
        for url in pendingURLs { call("arcdropOpenURL", url.absoluteString) }
        pendingURLs = []
    }

    // MARK: Web permissions & dialogs

    // Camera for the QR scanner: the app already asked iOS for camera access.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(type == .camera && frame.isMainFrame && origin.protocol == "file" ? .grant : .deny)
    }

    // window.confirm (used before importing a key).
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Annuler", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "Continuer", style: .destructive) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    // window.prompt (used by "Importer une clé").
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Annuler", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
        present(alert, animated: true)
    }

    // Only the bundled app may load in the web view. https links (the explorer) open in
    // Safari on a user tap; every other scheme (javascript:, data:, tel:, other apps) is refused.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.isFileURL, url.path.hasPrefix(Bundle.main.bundlePath) { return decisionHandler(.allow) }
        if url.absoluteString == "about:blank" { return decisionHandler(.allow) }
        if url.scheme == "https", action.navigationType == .linkActivated { UIApplication.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, url.scheme == "https" { UIApplication.shared.open(url) }
        return nil
    }
}

/// The wallet key, kept in the Keychain (this device only, available after first unlock).
enum Keychain {
    private static let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "app.arcdrop.wallet",
        kSecAttrAccount as String: "key",
    ]

    static func load() -> String? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Adds or updates in place (never delete-then-add: a failed add would lose the wallet).
    @discardableResult
    static func save(_ key: String) -> Bool {
        if load() == key { return true }
        let data = Data(key.utf8)
        let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return load() == key }
        guard update == errSecItemNotFound else { return false }
        var q = query
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess && load() == key
    }
}
