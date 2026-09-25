import adapter from '@sveltejs/adapter-node'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'
import type { Config } from '@sveltejs/kit'
import { fileURLToPath } from 'node:url'
// Relative rather than through the package's exports map: this file is loaded by SvelteKit's
// config loader before Vite resolves workspace packages, and cspDirectives reads app.html
// from disk, so it must stay a Node-only module out of the browser barrel.
import { cspDirectives } from '../../packages/shared/src/security/csp.ts'

const appHtmlPath = fileURLToPath(new URL('./src/app.html', import.meta.url))

const config: Config = {
    preprocess: vitePreprocess(),
    kit: {
        adapter: adapter(),
        // The Client renders untrusted document content through Mermaid and KaTeX and holds
        // the key that decrypts every graph in localStorage, so this is the policy that
        // matters most. connect-src cannot be pinned: the Sync Server
        // origin is whatever the user configured, including a self-hosted one.
        csp: {
            mode: 'auto',
            directives: cspDirectives({
                appHtmlPath,
                allowArbitrarySyncOrigins: true,
                // Documents embed images from the web (`![alt](https://…)`); without this
                // every one of them rendered as the broken-image affordance.
                allowRemoteImages: true,
                dev: process.env.NODE_ENV !== 'production',
                // A build served over plain HTTP, such as a local test stack on *.localhost
                // names, needs plaintext origins allowed. The policy is baked here at build time,
                // so that build is told explicitly (apps/client/Dockerfile ARG PLAINTEXT_ORIGINS);
                // production never sets it.
                plaintext: process.env.PLAINTEXT_ORIGINS === 'true',
            }),
        },
        version: {
            // Assets are content-hashed by the build already; this closes the OTHER
            // stale-code gap — a long-lived tab running old client code. The app polls
            // /_app/version.json and the root layout hard-navigates on the next route
            // change once a new version is live (see +layout.svelte).
            pollInterval: 60_000
        }
    }
}

export default config
