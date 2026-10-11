import { build } from 'esbuild'
import { cp, mkdir } from 'node:fs/promises'

await mkdir('web/dist', { recursive: true })
await build({ entryPoints: ['web/app.js'], bundle: true, minify: true, format: 'esm', target: 'safari15', outfile: 'web/dist/app.js', logLevel: 'info',
  define: { ARCDROP_CHAIN: JSON.stringify(process.env.ARCDROP_CHAIN ?? 'testnet') } })
for (const f of ['index.html', 'sw.js', 'manifest.webmanifest', 'icon.svg']) await cp(`web/${f}`, `web/dist/${f}`)
