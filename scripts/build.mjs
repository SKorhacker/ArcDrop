import { build } from 'esbuild'
import { cp, mkdir } from 'node:fs/promises'

await mkdir('web/dist', { recursive: true })
await build({ entryPoints: ['web/app.js'], bundle: true, minify: true, format: 'iife', target: 'safari15', outfile: 'web/dist/app.js', logLevel: 'info',
  define: { ARCDROP_CHAIN: JSON.stringify(process.env.ARCDROP_CHAIN ?? 'testnet') } })
for (const f of ['index.html', 'sw.js', 'manifest.webmanifest', 'icon.svg']) await cp(`web/${f}`, `web/dist/${f}`)

// The iOS app ships its own copy, so it works offline from the very first launch.
await cp('web/dist', 'ios-app/Web', { recursive: true })
// WebKit does not treat file:// as 'self', so the bundled copy carries no CSP meta;
// the iOS shell restricts navigation and the bridge instead.
const { readFile, writeFile } = await import('node:fs/promises')
const html = await readFile('ios-app/Web/index.html', 'utf8')
await writeFile('ios-app/Web/index.html', html.replace(/<!--CSP-->.*?<!--\/CSP-->/s, ''))
