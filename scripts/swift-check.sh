#!/bin/bash
# Type-checks and runs the bitchat relay against a local gateway without Xcode.
# Works around the Command Line Tools bug "redefinition of module 'SwiftBridging'"
# with a VFS overlay (no system file is modified).
set -e
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
: > "$TMP/empty.modulemap"
cat > "$TMP/overlay.yaml" <<YAML
{ "version": 0, "roots": [ { "type": "file", "name": "/Library/Developer/CommandLineTools/usr/include/swift/module.modulemap", "external-contents": "$TMP/empty.modulemap" } ] }
YAML
OVERLAY=""
[ -f /Library/Developer/CommandLineTools/usr/include/swift/bridging.modulemap ] && OVERLAY="-vfsoverlay $TMP/overlay.yaml"
swiftc $OVERLAY ios/ArcDropRelay.swift ios/check/main.swift -o "$TMP/relaytest"
INFO=$(curl -sf localhost:8787/api/info) || { echo "start a simulate-only gateway first: node relayer/server.mjs"; exit 1; }
case "$INFO" in *\"relayer\":null*) ;; *) echo "gateway has a relayer key: restart it without one (node relayer/server.mjs) so this check moves no funds"; exit 1;; esac
P0=$(node scripts/make-test-packet.mjs 0); P5=$(node scripts/make-test-packet.mjs 5)
Q0=$(node scripts/make-test-packet.mjs 0)
# Same packet with 3 bytes of the signed body replaced: decodes, but the signature no longer matches.
forge() { printf '%s' "${1:0:150}AAAA${1:154}"; }
"$TMP/relaytest" "$P0" "$P5" "$(forge "$P0")" "$Q0" "$(forge "$Q0")"
