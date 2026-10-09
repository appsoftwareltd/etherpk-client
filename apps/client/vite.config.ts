import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
// Relative rather than through the package exports map: Vite loads this config before it can
// resolve workspace packages, and the module shells out to git, so it stays Node-only.
import { readPackageVersion, resolveBuildInfo } from '../../packages/shared/src/build-stamp/resolve-build-info'
import { demoGraphPlugin } from './demo-graph-plugin'
import { devDictionariesPlugin } from './dev-dictionaries-plugin'
import { devPostcodesPlugin } from './dev-postcodes-plugin'
import { extensionsPlugin } from './extensions-plugin'

// This Client's release. `pnpm release:version` keeps every package.json in the repository on one
// version, so the Agents tab can name the Headless Client released with this Client.
const releaseVersion = readPackageVersion(new URL('./package.json', import.meta.url))

export default defineConfig({
    // The release version and the commit this bundle was built from, frozen in here because a
    // running container has no .git to ask. hooks.server.ts prints them at the top of every page
    // (see build-stamp.ts).
    define: {
        __BUILD_INFO__: JSON.stringify(resolveBuildInfo(releaseVersion)),
        __RELEASE_VERSION__: JSON.stringify(releaseVersion),
    },
    plugins: [
        tailwindcss(),
        sveltekit(),
        // The Demo Graph bundle list (ADR 0069); the files are static assets.
        demoGraphPlugin(),
        // The locally built spelling dictionaries, in development only (ADR 0095).
        devDictionariesPlugin(),
        // The locally built postcode files, in development only (ADR 0119, amended 2026-10-09).
        devPostcodesPlugin(),
        // The loaded Built-in Extensions, served and shipped from the Client's origin (ADR 0121).
        extensionsPlugin(),
    ],
    server: {
        port: 5173,
        strictPort: true
    },
    resolve: {
        // A compiled-in extension (ADR 0121) is a package of its own under `extensions/`, with its
        // own node_modules, but it runs on the Client's Svelte runtime and shares its schemas'
        // library: always the Client's copy, never a second one beside it.
        dedupe: ['svelte', 'zod'],
    },
    // sqlite-wasm ships its own .wasm + worker; pre-bundling breaks asset resolution.
    optimizeDeps: {
        // hunspell-wasm too: its Emscripten glue finds its .wasm through import.meta.url, and the
        // spelling worker hands it the URL of a ?url asset instead (spelling-worker.ts).
        exclude: ['@sqlite.org/sqlite-wasm', 'hunspell-wasm'],
        // Discovered lazily (only /dev/editor?yjs=1 / Server-backed graphs import them);
        // without this, the first hit triggers a mid-session re-optimize + server reload,
        // which mass-fails a running e2e suite with goto timeouts.
        include: ['yjs', 'y-codemirror.next']
    }
})
