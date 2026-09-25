import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'url'
import { resolve } from 'path'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
    define: {
        // SvelteKit build-time constants — needed by error() helper in @sveltejs/kit
        __SVELTEKIT_DEV__: false,
        __SVELTEKIT_APP_VERSION_FILE__: JSON.stringify('/_app/version.json'),
        __SVELTEKIT_APP_VERSION_POLL_INTERVAL__: 0
    },
    // Provide inline esbuild tsconfig so vitest doesn't try to resolve
    // ./.svelte-kit/tsconfig.json (which is only present after `svelte-kit sync`)
    esbuild: {
        tsconfigRaw: {
            compilerOptions: {
                target: 'ESNext',
                module: 'ESNext',
                moduleResolution: 'bundler',
                strict: true,
                esModuleInterop: true,
                skipLibCheck: true,
                allowJs: true,
                resolveJsonModule: true,
                verbatimModuleSyntax: true
            }
        }
    },
    resolve: {
        alias: {
            '$env/dynamic/private': resolve(__dirname, 'src/__mocks__/env.private.ts'),
            '$env/dynamic/public': resolve(__dirname, 'src/__mocks__/env.public.ts'),
            '$app/environment': resolve(__dirname, 'src/__mocks__/app-environment.ts'),
            '$lib': resolve(__dirname, 'src/lib')
        }
    },
    test: {
        environment: 'node',
        // Vitest answers every css-shaped id from its own empty stub unless told to process it,
        // which turned the bundled themes' stylesheets (read through `?raw`) into empty files in
        // the publish tests while the real build carried them. Only the raw reads are let through.
        css: { include: [/\.css\?raw$/] },
        globals: true,
        include: ['src/**/*.test.ts'],
        // Records each test's declaration line so the generated report can point at
        // file:line rather than just the file.
        includeTaskLocation: true,
        coverage: {
            provider: 'v8',
            reportsDirectory: 'coverage',
            // json-summary feeds scripts/test-report.mjs; html is the browsable drill-down.
            reporter: ['text-summary', 'html', 'json-summary'],
            // The unit suites reach the whole TypeScript surface of the app, not only the
            // server slice. Scoping this to src/lib/server/** reported coverage for a
            // fraction of the code the tests actually exercise -- and for the Client, which
            // has no src/routes/api at all, for almost nothing.
            //
            // .svelte files are absent by design: these suites run in the node environment and
            // never import a component, so including them would report 0% for untested reasons.
            include: ['src/**/*.ts'],
            exclude: [
                'src/**/*.test.ts',
                'src/**/*.d.ts',
                'src/__mocks__/**',
                'src/app.d.ts',
                // Rune modules need the Svelte compiler, which this config does not load.
                'src/**/*.svelte.ts'
            ]
        }
    }
})

