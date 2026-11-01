/**
 * Bundles src/server.ts to build/index.js, over the server adapter-node wrote there. The adapter's
 * server stays in build/server/adapter-index.js, and src/server.ts runs it with the ORIGIN setting
 * added. `node build` starts the Client as before.
 *
 * Run via: pnpm build (after vite build completes)
 */
import { build } from 'esbuild'

await build({
    bundle: true,
    platform: 'node',
    format: 'esm',
    entryPoints: ['src/server.ts'],
    outfile: 'build/index.js',
    external: ['./server/adapter-index.js'],
})
