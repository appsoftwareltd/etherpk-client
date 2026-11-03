import adapter from '@sveltejs/adapter-node'
import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
// Relative rather than through the package exports map: Vite loads this config before it can
// resolve workspace packages. resolve-build-info shells out to git and cspDirectives reads
// app.html from disk, so both stay Node-only modules out of the browser barrel.
import { readPackageVersion, resolveBuildInfo } from '../../packages/shared/src/build-stamp/resolve-build-info.ts'
import { devServerHttps } from '../../packages/shared/src/dev-server/dev-server-https.ts'
import { cspDirectives } from '../../packages/shared/src/security/csp.ts'
import { PLAYER_FRAME_HOSTS } from '../../packages/shared/src/security/frame-hosts.ts'
import { demoGraphPlugin } from './demo-graph-plugin.ts'
import { devDictionariesPlugin } from './dev-dictionaries-plugin.ts'
import { devPostcodesPlugin } from './dev-postcodes-plugin.ts'
import { compiledInBuildPlugins } from './compiled-in-extensions.ts'
import { extensionsPlugin } from './extensions-plugin.ts'
import { CLIENT_TRUSTED_TYPES_POLICIES } from './src/lib/security/trusted-types-policies.ts'

// This Client's release. `pnpm release:version` keeps every package.json in the repository on one
// version, so the Agents tab can name the Headless Client released with this Client.
const releaseVersion = readPackageVersion(new URL('./package.json', import.meta.url))

const appHtmlPath = fileURLToPath(new URL('./src/app.html', import.meta.url))

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
        sveltekit({
            preprocess: vitePreprocess(),
            adapter: adapter(),
            // A dev server writes its settings into the generated files under outDir, and reloads
            // them when another server rewrites them. The e2e configurations give each server they
            // start an outDir of its own, so it never reads a manual dev server's settings.
            outDir: process.env.SVELTEKIT_OUT_DIR || '.svelte-kit',
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
                    reportUri: '/api/csp-report'
                })
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
        }),

        // The Demo Graph bundle list (ADR 0069); the files are static assets.
        demoGraphPlugin(),
        // The locally built spelling dictionaries, in development only (ADR 0095).
        devDictionariesPlugin(),
        // The locally built postcode files, in development only (ADR 0119, amended 2026-10-09).
        devPostcodesPlugin(),
        // The loaded Built-in Extensions, served and shipped from the Client's origin (ADR 0121).
        extensionsPlugin(),
        // What the compiled-in Built-in Extensions change in the libraries they bundle, such as
        // Excalidraw's code and stylesheet (ADR 0121).
        ...(await compiledInBuildPlugins()),
    ],
    server: {
        port: 5173,
        strictPort: true,
        // HTTPS and extra allowed hosts when the DEV_SERVER_* settings ask for them, to test from
        // another device through a TLS proxy such as Tailscale Serve (see dev-server-https.ts).
        ...devServerHttps(),
    },
    resolve: {
        alias: {
            // The Client's own modules reach `#lib` through package.json `imports`. A compiled-in
            // extension (ADR 0121) is a package of its own, so that field does not apply to it, and
            // this alias gives its imports of the Client's library the same name.
            '#lib': fileURLToPath(new URL('./src/lib', import.meta.url)),
        },
        // A compiled-in extension (ADR 0121) is a package of its own under `extensions/`, with its
        // own node_modules, but it runs on the Client's Svelte runtime and shares its schemas'
        // library: always the Client's copy, never a second one beside it. SvelteKit too: the
        // shared package can resolve another copy, and SvelteKit does not recognise a redirect or
        // an error thrown by another copy's helpers, so it answers 500.
        dedupe: ['svelte', 'zod', '@sveltejs/kit'],
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
