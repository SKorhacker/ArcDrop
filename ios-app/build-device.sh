#!/bin/sh
# Builds and installs the iOS app on a connected (or Wi-Fi paired) iPhone.
#   ARCDROP_TEAM=<Apple team ID> ARCDROP_BUNDLE=<unique bundle id> ios-app/build-device.sh <device-udid>
set -e
cd "$(dirname "$0")"
xcodegen generate -q
xcodebuild -project ArcDrop.xcodeproj -scheme ArcDrop -configuration Debug -destination "id=$1" -derivedDataPath build \
  -allowProvisioningUpdates DEVELOPMENT_TEAM="$ARCDROP_TEAM" PRODUCT_BUNDLE_IDENTIFIER="${ARCDROP_BUNDLE:-app.arcdrop.ios}" build
xcrun devicectl device install app --device "$1" build/Build/Products/Debug-iphoneos/ArcDrop.app
