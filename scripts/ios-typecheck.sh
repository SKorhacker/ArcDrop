#!/bin/bash
# Type-checks the iOS app sources without Xcode by targeting Mac Catalyst, whose
# UIKit/SwiftUI ship with the Command Line Tools SDK. Catches API and type errors;
# it is not a substitute for an Xcode build on a device.
set -e
cd "$(dirname "$0")/.."
SDK=$(xcrun --show-sdk-path)
TMP=$(mktemp -d)
OVERLAY=()
if [ -f /Library/Developer/CommandLineTools/usr/include/swift/bridging.modulemap ]; then
  : > "$TMP/empty.modulemap"
  printf '{ "version": 0, "roots": [ { "type": "file", "name": "/Library/Developer/CommandLineTools/usr/include/swift/module.modulemap", "external-contents": "%s/empty.modulemap" } ] }' "$TMP" > "$TMP/overlay.yaml"
  OVERLAY=(-vfsoverlay "$TMP/overlay.yaml")
fi
swiftc -typecheck "${OVERLAY[@]}" -target arm64-apple-ios16.0-macabi -sdk "$SDK" \
  -Fsystem "$SDK/System/iOSSupport/System/Library/Frameworks" -I "$SDK/System/iOSSupport/usr/lib/swift" \
  ios-app/Sources/*.swift mesh/ArcMesh.swift ios/ArcDropRelay.swift
echo "iOS sources type-check OK"
