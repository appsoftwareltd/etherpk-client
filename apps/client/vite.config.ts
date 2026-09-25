import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
// Relative rather than through the package exports map: Vite loads this config before it can
// resolve workspace packages, and the module shells out to git, so it stays Node-only.
import { resolveBuildInfo } from '../../packages/shared/src/build-stamp/resolve-build-info'
import { demoGraphPlugin } from './demo-graph-plugin'
import { devDictionariesPlugin } from './dev-dictionaries-plugin'

export default defineConfig({
    // The commit this bundle was built from, frozen in here because a running container has
    // no .git to ask. hooks.server.ts prints it at the top of every page (see build-stamp.ts).
    define: {
        __BUILD_INFO__: JSON.stringify(resolveBuildInfo()),
    },
    plugins: [
        tailwindcss(),
        sveltekit(),
        // The Demo Graph bundle list (ADR 0069); the files are static assets.
        demoGraphPlugin(),
        // The locally built spelling dictionaries, in development only (ADR 0095).
        devDictionariesPlugin(),
    ],
    server: {
        port: 5174,
        strictPort: true
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
