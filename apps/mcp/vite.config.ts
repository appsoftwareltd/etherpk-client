import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { builtinModules } from 'node:module'

const here = fileURLToPath(new URL('.', import.meta.url))

/**
 * A Node bundle of the headless client. `$lib` resolves into the client's own source, so the
 * sync engine, crypto, index and server store are compiled in rather than copied (ADR 0072).
 * Everything else that is a real package stays external and is installed with this one; the
 * shared workspace package exports TypeScript source, so it has to be bundled too.
 */
const bundled = new Set(['@appsoftwareltd/etherpk-shared', '@appsoftwareltd/etherpk-themes'])

export default defineConfig({
    resolve: {
        alias: {
            $lib: resolve(here, '../client/src/lib'),
        },
    },
    build: {
        target: 'node22',
        ssr: true,
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: true,
        minify: false,
        rollupOptions: {
            input: resolve(here, 'src/main.ts'),
            output: { entryFileNames: 'main.js', format: 'es' },
            external: (id) =>
                builtinModules.includes(id) ||
                id.startsWith('node:') ||
                (!id.startsWith('.') && !id.startsWith('/') && !id.startsWith('$lib') && !bundled.has(id) && !id.includes('/client/src/lib')),
        },
    },
    ssr: {
        // Vite's SSR build externalises bare imports by default; the shared package is source.
        noExternal: [...bundled],
    },
})
