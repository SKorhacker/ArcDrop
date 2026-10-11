# ArcDrop

**Pay in USDC with no internet. Carry the payment by QR code, AirDrop or Bluetooth mesh. It settles on Arc the moment any device gets a signal.**

Airplane mode on. You type `5 USDC`, tap sign, and hand the payment to a friend: show a QR, AirDrop it, or drop it in [bitchat](https://github.com/permissionlesstech/bitchat), where it hops from phone to phone over Bluetooth. The first device in the chain that finds internet settles it on Arc, final in about a second.

## How it works

```
 payer (offline)                 carriers (offline)                    any node online           Arc
 ───────────────                 ──────────────────                    ───────────────           ───
 sign EIP-3009        ──QR──▶    friend's phone
 transferWithAuth     ──AirDrop─▶ friend's phone          ──────────▶  POST /api/relay  ──────▶  USDC.transferWithAuthorization
 (157-byte packet)    ──bitchat─▶ phone ─BLE─▶ phone ─BLE─▶ phone ─────▶                           final in < 1 s
```

- **The payment is a signed USDC authorization** ([EIP-3009](https://eips.ethereum.org/EIPS/eip-3009)) against Arc's native USDC (`0x3600…0000`, FiatToken v2). Signing needs only the local key, so it works in airplane mode. No custom contract: the money moves through Circle's own USDC contract.
- **Anyone can carry it, nobody can steal it.** The recipient, amount and expiry are inside the signature. A courier can only deliver it to the intended recipient, and the random nonce means it settles at most once, however many mesh paths it takes.
- **Arc specifics that make this work:** gas is paid in USDC, so the relayer pays a known dollar amount (no ETH/SOL to hold); deterministic sub-second finality turns "pending" into "final" the instant a node reconnects; no reorgs means a settled payment never comes back.
- **Packet:** `arcdrop:1:<base64url>`, 157 bytes (chainId, from, to, value, validAfter, validBefore, nonce, signature). It fits in a small QR code, a URL fragment (AirDrop) or a bitchat message.

## The three transports

| Transport | How | Status |
|---|---|---|
| **QR code** | Payer shows a QR, receiver scans it in the app (camera, offline) | Working in the web app |
| **AirDrop** | "AirDrop" opens the iOS share sheet with a link `…/#p=arcdrop:1:…`; the receiver's offline-cached app imports it | Working in the web app (iOS ↔ iOS) |
| **Bluetooth mesh** | Payment pasted as a bitchat message rides the BLE mesh. With the [bitchat patch](ios/), every bitchat node that has internet forwards the packet to the gateway automatically, and `/pay arcdrop:1:…` floods it across the mesh | Stock bitchat: works today (copy/paste). Relay (`ArcDropRelay.swift`): compiled and tested against the gateway. Hooks + `/pay`: written, need an Xcode build |

## What's verified

`npm test` runs offline tests plus read-only checks against **Arc mainnet** (no funds, no gas):

- our EIP-712 domain matches the on-chain `DOMAIN_SEPARATOR` of USDC on Arc;
- a signed `transferWithAuthorization` passes simulation on the real contract;
- a tampered payment (recipient swapped) is rejected by the contract;
- encode/decode round-trip, expiry, extraction from links and chat messages.

## ArcDrop's own Bluetooth mesh

`mesh/ArcMesh.swift` is a CoreBluetooth mesh: every device is both peripheral and central, so phones talk directly. Payments are **store-and-forward**: each node keeps the payments it has seen, hands them to every new device it meets, and floods new ones (7-hop limit, deduplicated by hash). A payment can cross a crowd in pockets until any node with internet settles it. Packets are self-authenticating, so nodes need no trust.

- `ios-app/`: iOS app (XcodeGen project). It hosts the web app and adds the mesh, the native share sheet (AirDrop) and background settlement. Bridge: `webkit.messageHandlers.arcmesh` (JS → native), `arcdropReceive` / `arcdropMeshPeers` (native → JS).
- `mesh/node/`: the same mesh as a macOS relay node (`arcmesh-node`), so a Mac can carry and settle payments too.
- `mesh/check/`: framing tests (BLE MTUs from 20 to 512 bytes, interleaving, garbage).

```bash
# macOS relay node (no Xcode needed; see scripts/swift-check.sh for the toolchain workaround)
mesh/build/arcmesh-node https://arcdrop-pink.vercel.app
# iOS app
cd ios-app && xcodegen generate && open ArcDrop.xcodeproj   # set your team, run on device
```

## Tabs: guaranteed offline payments

A plain offline payment is a promise: the payer's balance can only be checked online. A **tab** (`contracts/ArcDropTabs.sol`, Arc testnet, address in `core/tabs.json`) turns it into a guarantee for one recipient:

- online, once, the payer locks funds **for one address** until an expiry (EIP-3009 `receiveWithAuthorization`; its nonce commits to the recipient and expiry, so the signature cannot be redirected);
- offline, each payment is an EIP-712 voucher with the **running total** owed (`arcdrop:4:…`); the recipient redeems the latest one, the contract pays the difference;
- locked funds can only go to that recipient before expiry: no early withdrawal, no redirect, no "pay my other wallet". Older vouchers are harmless, closed tabs bump an epoch so their vouchers are dead, and a voucher above the locked amount pays exactly what is locked.

The recipient's app learns, while online, which tabs exist for it (on-chain index), so offline it shows "🔒 guaranteed" only for vouchers its cached tab covers. `scripts/tabs-e2e.mjs` runs everything live, including the attacks.

## Security review

The project was attacked by three independent AI reviewers (contract, gateway/core, app/iOS/Bluetooth). Every confirmed finding is fixed and has a regression test:

- `npm test`: offline + live checks, including `test/attacks.test.mjs` (alternate encodings, malleable signatures, postdated payments, overflow, receipt forgery, hostile requests) and `test/gateway.test.mjs` (self-payment gas drain, dust, malformed input, rate limits, CORS, path traversal, oversized bodies).
- `mesh/check`: Bluetooth framing plus hostile-device tests (20 000-fragment flood, cross-device frame injection, junk payments).
- `scripts/attack-e2e.mjs`: live burnt-nonce attack on testnet; ArcDrop reports the payment as NOT paid, because "settled" requires an on-chain transfer of exactly that amount to exactly that recipient.
- `scripts/tabs-e2e.mjs`: live tab attacks (redirected funding, self-redeem, early close, replay, forged amount, wrong epoch, overspend).

Known limits: outside a tab, an offline payment is a promise (the payer's balance can only be checked online); tab guarantees require the recipient to redeem before the tab expires (the app does it as soon as it is online); gateway rate limits are per instance.

## Run it

```bash
npm install
npm test                          # offline + Arc mainnet read-only checks
npm run build                     # bundles the web app into web/dist
RELAYER_PRIVATE_KEY=0x… npm run dev   # app + gateway on http://localhost:8787
```

Without `RELAYER_PRIVATE_KEY`, the gateway verifies and simulates but does not submit. The relayer key only pays gas (fractions of a cent in USDC); it never holds user funds.

Settle from the terminal (accepts a packet, a link or a whole bitchat message):

```bash
node relayer/cli.mjs '💸 5 USDC → 0xab…cd (ArcDrop)
arcdrop:1:…'
```

Deploy (camera, service worker and AirDrop links need HTTPS): `vercel --prod`, then set `RELAYER_PRIVATE_KEY` in the project's environment variables.

### bitchat (Bluetooth mesh)

```bash
git clone https://github.com/permissionlesstech/bitchat && cd bitchat
git apply ../arcdrop/ios/bitchat-arcdrop.patch
# set ArcDropRelay.defaultGateway to your deployed URL, then build with Xcode
```

The patch adds `Services/ArcDropRelay.swift` (packet decoder + relay queue), three one-line hooks (every received public/private message, every sent message) and extends `/pay` to accept ArcDrop payments. Unlike cashu tokens, they need no "public channel" confirmation: only the named recipient can receive them, so flooding the mesh is the point. bitchat is public domain (Unlicense).

`scripts/swift-check.sh` compiles the relay without Xcode and runs it against a local gateway: valid → settled, unfunded → stays queued, forged → rejected, and a genuine packet still settles when a forged copy reaches the node first.

## Layout

```
core/arcdrop.js        packet format, offline sign/verify, status, settle (viem)
web/                   offline-first PWA: pay, receive, QR, AirDrop, bitchat copy
relayer/server.mjs     gateway: serves the app, POST /api/relay settles on Arc
relayer/cli.mjs        settle from the terminal
api/relay.mjs          same gateway as a Vercel function
ios/                   bitchat integration (Swift) + patch
test/                  tests, incl. Arc mainnet simulation
```

## Limits (on purpose, for an MVP)

- **Offline, a payment is a promise.** The receiver can verify the signature offline, but cannot know whether the payer still has the funds until a node reaches Arc. The app shows "pending" until it is final, and the payer's app refuses to sign more than the last balance it saw on Arc minus payments still pending.
- The demo wallet key lives in the browser's storage: keep small amounts on it.
- AirDrop only works between Apple devices; QR and bitchat cover the rest.

## Roadmap

- Sign payments directly inside bitchat (`/pay 5 @alice`), no web app needed.
- Arc opt-in privacy (confidential amounts) once it ships.
