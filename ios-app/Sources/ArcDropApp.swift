import SwiftUI

@main
struct ArcDropApp: App {
    var body: some Scene {
        WindowGroup {
            WebAppView()
                .ignoresSafeArea()
                .preferredColorScheme(nil)
        }
    }
}
