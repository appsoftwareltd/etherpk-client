import adapter from '@sveltejs/adapter-node'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'
import type { Config } from '@sveltejs/kit'
import { fileURLToPath } from 'node:url'
// Relative rather than through the package's exports map: this file is loaded by SvelteKit's
// config loader before Vite resolves workspace packages, and cspDirectives reads app.html
// from disk, so it must stay a Node-only module out of the browser barrel.
import { cspDirectives } from '../../packages/shared/src/security/csp.ts'
import { PLAYER_FRAME_HOSTS } from '../../packages/shared/src/security/frame-hosts.ts'
import { compiledInExtensionFolders } from './compiled-in-extensions.ts'
import { CLIENT_TRUSTED_TYPES_POLICIES } from './src/lib/security/trusted-types-policies.ts'

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
                // Agent Chat reaches a model server on the person's own machine, such as Ollama,
                // over plain HTTP on loopback only (ADR 0147).
                allowLoopbackHttp: true,
                // Documents embed images from the web (`![alt](https://…)`); without this
                // every one of them rendered as the broken-image affordance.
                allowRemoteImages: true,
                // Video players from YouTube and Vimeo, in frames the Client builds (ADR 0137).
                frameHosts: PLAYER_FRAME_HOSTS,
                dev: process.env.NODE_ENV !== 'production',
                // A build served over plain HTTP, such as a local test stack on *.localhost
                // names, needs plaintext origins allowed. The policy is baked here at build time,
                // so that build is told explicitly (apps/client/Dockerfile ARG PLAINTEXT_ORIGINS);
                // production never sets it.
                plaintext: process.env.PLAINTEXT_ORIGINS === 'true',
                // HTML and script URLs reach the page only through named policies (ADR 0130), and
                // every violation is reported to the Client's own server, which logs it.
                trustedTypesPolicies: CLIENT_TRUSTED_TYPES_POLICIES,
                reportUri: '/api/csp-report',
            }),
        },
        typescript: {
            // The compiled-in Built-in Extensions are type-checked with the Client, as its own
            // code is (ADR 0121): they compile with it, and the Client reaches them only through a
            // glob, which the type checker does not follow. Paths are relative to .svelte-kit.
            config(tsconfig) {
                for (const folder of compiledInExtensionFolders()) {
                    tsconfig.include.push(`../../../extensions/${folder}/src/**/*.ts`, `../../../extensions/${folder}/src/**/*.svelte`)
                }
            },
        },
        version: {
            // Assets are content-hashed by the build already; this closes the OTHER
            // stale-code gap — a long-lived tab running old client code. The app polls
            // /_app/version.json and the root layout hard-navigates on the next route
            // change once a new version is live (see +layout.svelte).
            pollInterval: 60_000
        },
        // The service worker serves one cached page, the shell, at any app address (ADR 0142),
        // so the files a page loads must be named from the root: a relative `./_app/...` written
        // for `/offline-shell` would point nowhere when served for `/g/<id>/d/<page>`.
        paths: { relative: false },
        // Registered by the root layout, after the Trusted Types default policy exists (ADR 0130),
        // rather than by an inline script SvelteKit would add to every page.
        serviceWorker: { register: false }
    }
}

export default config
