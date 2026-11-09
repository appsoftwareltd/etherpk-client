/**
 * Runs `vite build` as a production build, whatever the development `.env` says. Vite honours
 * NODE_ENV=development from a `.env` file and then resolves each package's development entry, which
 * puts development code in the output and stops the build at Excalidraw, whose patches apply only
 * to its production code (extensions/excalidraw/build-plugins/vite-plugins.ts). A value already in
 * the process environment wins over the file.
 *
 * This is a script because `NODE_ENV=production vite build` in package.json would not run on Windows.
 *
 * Run via: pnpm build (after build-extensions.mjs, before build-server.mjs)
 */
import { spawnSync } from 'node:child_process'

const { status } = spawnSync('vite build', {
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production' },
})

process.exit(status ?? 1)
