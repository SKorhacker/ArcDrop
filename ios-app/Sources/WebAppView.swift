// Hosts the ArcDrop web app and gives it what Safari can't: the Bluetooth mesh,
// the native share sheet (AirDrop) and background settlement.
//
// JS → native: webkit.messageHandlers.arcmesh.postMessage({ type, … })
//   { type: "broadcast", packet }        flood a signed payment over Bluetooth
//   { type: "share", url, text }         open the share sheet (AirDrop)
// native → JS: arcdropReceive(packet), arcdropMeshPeers(count)

import SwiftUI
import WebKit

struct WebAppView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> WebAppController { WebAppController() }
    func updateUIViewController(_ controller: WebAppController, context: Context) {}
}

final class WebAppController: UIViewController, WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate, ArcMeshDelegate {
    static let appURL = URL(string: "https://arcdrop-pink.vercel.app/?app=ios")!

    private var webView: WKWebView!
    private let mesh = ArcMesh()

    override func viewDidLoad() {
        super.viewDidLoad()
        let config = WKWebViewConfiguration()
        config.limitsNavigationsToAppBoundDomains = true // enables the service worker (offline)
        config.allowsInlineMediaPlayback = true           // QR scanner video
        config.userContentController.add(self, name: "arcmesh")

        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        view.addSubview(webView)
        webView.load(URLRequest(url: Self.appURL, cachePolicy: .returnCacheDataElseLoad))

        mesh.delegate = self
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

    // When the web app finishes loading, tell it how many devices are nearby.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { call("arcdropMeshPeers", mesh.peerCount) }

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

    // Links to the explorer open in Safari, not inside the app.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, url.host != Self.appURL.host, action.navigationType == .linkActivated {
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
