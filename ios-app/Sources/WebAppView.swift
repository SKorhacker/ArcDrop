// Hosts the ArcDrop web app and gives it what Safari can't: the Bluetooth mesh,
// the native share sheet (AirDrop), the Keychain and background settlement.
// The web app is bundled in the app (Web/), so it works offline from the first launch.
//
// JS → native: webkit.messageHandlers.arcmesh.postMessage({ type, … })
//   { type: "broadcast", packet }        flood a signed payment over Bluetooth
//   { type: "share", url, text }         open the share sheet (AirDrop)
//   { type: "haptic", kind }             success / error vibration
//   { type: "saveKey", key }             store the wallet key in the Keychain
// native → JS: arcdropReceive(packet), arcdropMeshPeers(count), arcdropOpenURL(url)
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
            if self.loaded { self.call("arcdropOpenURL", url.absoluteString) } else { self.pendingURLs.append(url) }
        }
    }

    // MARK: JS → native

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "broadcast":
            guard let packet = body["packet"] as? String else { return }
            mesh.broadcast(packet)
            ArcDropRelay.shared.observe(packet) // settle right away if this phone is online
        case "share":
            var items: [Any] = []
            if let text = body["text"] as? String { items.append(text) }
            if let url = (body["url"] as? String).flatMap(URL.init(string:)) { items.append(url) }
            let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
            sheet.popoverPresentationController?.sourceView = view
            present(sheet, animated: true)
        case "saveKey":
            if let key = body["key"] as? String { Keychain.save(key) }
        case "haptic":
            let kind = body["kind"] as? String
            UINotificationFeedbackGenerator().notificationOccurred(kind == "error" ? .error : .success)
        default:
            break
        }
    }

    // MARK: Mesh → JS

    func mesh(_ mesh: ArcMesh, didReceive packet: String, hops: Int) {
        ArcDropRelay.shared.observe(packet)
        call("arcdropReceive", packet)
    }

    func mesh(_ mesh: ArcMesh, peersChanged count: Int) { call("arcdropMeshPeers", count) }

    func mesh(_ mesh: ArcMesh, log: String) { print("[mesh] \(log)") }

    private func call(_ function: String, _ argument: Any) {
        guard let data = try? JSONSerialization.data(withJSONObject: [argument], options: [.fragmentsAllowed]),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("globalThis.\(function) && globalThis.\(function)(...\(json))")
    }

    // When the web app finishes loading: nearby devices, and any payment link that opened the app.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        call("arcdropMeshPeers", mesh.peerCount)
        for url in pendingURLs { call("arcdropOpenURL", url.absoluteString) }
        pendingURLs = []
    }

    // MARK: Web permissions & dialogs

    // Camera for the QR scanner: the app already asked iOS for camera access.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(type == .camera ? .grant : .deny)
    }

    // window.prompt (used by "Importer une clé").
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Annuler", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
        present(alert, animated: true)
    }

    // The app's own pages are local files; any web link (the explorer) opens in Safari.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, url.scheme == "http" || url.scheme == "https" {
            UIApplication.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { UIApplication.shared.open(url) }
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

    static func save(_ key: String) {
        guard load() != key else { return }
        SecItemDelete(query as CFDictionary)
        var q = query
        q[kSecValueData as String] = Data(key.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }
}
