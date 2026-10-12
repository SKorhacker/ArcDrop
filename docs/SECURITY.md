# Security

ArcDrop moves real money through devices nobody controls, so it was built assuming every carrier, nearby device and network message is hostile.

## What is protected

| Threat | Protection |
|---|---|
| A courier redirects or changes a payment | Recipient, amount and expiry are inside the payer's signature; the USDC contract checks it. |
| The same payment is cashed twice | EIP-3009 nonces settle once; one canonical encoding per payment; tab vouchers carry a running total. |
| "Paid" shown for a payment that wasn't | Settled only with an on-chain transfer of exactly that amount to exactly that recipient under that nonce. A burnt nonce is reported as NOT paid. |
| An old payment replayed as new income | Already-settled payments are recognised on import and not counted. |
| Test money passed off as real | Lists show the current network only; testnet amounts are always labelled. |
| Malformed or forged packets | Strict decoding, canonical signatures only, bounds checks; refused, never crashing. |
| Junk flooding the Bluetooth mesh | Payments are stored and forwarded only after their signature checks out; per-link budgets, per-kind and per-payer quotas; a device's own payments are never evicted. |
| Gas drain on the gateway | Dust, self-payments and far-future expiries refused; per-IP, per-payer, per-recipient and global limits; anti ping-pong; simulation before every submission. |
| Tab abuse | Funding signatures can't be redirected; locked funds can only reach the recipient; epochs kill old vouchers; only real USDC/EURC accepted. |
| Losing the wallet | Key in the iOS Keychain / Android Keystore, never overwritten without an explicit import; backup reminder once the wallet holds funds. |
| Malicious pages talking to the app | The native bridge only answers the app's own bundled page; payment links only pre-fill, never pay. |

## How it was checked

- **Two rounds of independent AI security reviews** (contract; gateway, core and web app; iOS, Android and Bluetooth). Every confirmed finding is fixed and has a regression test.
- `npm test`: offline tests, attack tests (alternate encodings, malleable or malformed signatures, postdated payments, overflow, receipt forgery, hostile requests) and gateway tests (gas drain, dust, malformed input, rate limits, CORS, path traversal).
- `node scripts/mesh-check.mjs`: Bluetooth framing at MTUs from 20 to 512 bytes, a 20 000-fragment flood, cross-device frame injection, junk payments, recovery from half-sent messages.
- Live on Arc testnet: `scripts/attack-e2e.mjs` (burnt-nonce attack → reported NOT paid) and `scripts/tabs-e2e.mjs` (redirected funding, self-redeem, early close, replay, forged amount, wrong epoch, overspend, fake tokens: all refused).

## Residual risks (stated, not hidden)

- **Outside a tab, an offline payment is a promise.** The receiver can check the signature, not the payer's balance. The app says "NOT PAID YET" until Arc confirms it.
- **Tabs must be redeemed before they expire.** The app trusts a tab only with at least 24 h left and redeems as soon as it is online.
- **Bluetooth is an open radio.** While the Pay screen is open, your wallet address and display name are visible to devices in range. Payments carried for others reveal payer, recipient and amount to the carriers.
- **Receipts carried for others are only checked structurally** (only the payer can verify a receipt), within their own quota.
- **Gateway limits are per instance.** A production deployment should keep counters and the gas budget in shared storage.
- **Keys live on the device.** Export your key to move phones; uninstalling the Android app erases it. Keep small amounts only.

## Reporting

Please open a GitHub issue without exploit details and ask for a private contact, or use GitHub's private vulnerability reporting on this repository.
