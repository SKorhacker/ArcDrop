import SwiftUI

@main
struct ArcDropApp: App {
    var body: some Scene {
        WindowGroup {
            WebAppView()
                .ignoresSafeArea()
                // arcdrop://pay#p=… (an AirDropped payment) is handed to the web app.
                .onOpenURL { url in NotificationCenter.default.post(name: .arcdropOpenURL, object: url) }
        }
    }
}

extension Notification.Name {
    static let arcdropOpenURL = Notification.Name("arcdropOpenURL")
}
