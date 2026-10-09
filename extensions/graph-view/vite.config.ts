/**
 * The Graph View's bundle (ADR 0122): one ES module the Client imports at run time from its own
 * origin, the chunks it loads on first use beside it, and one stylesheet for its shadow roots.
 *
 * Everything it uses is bundled, Svelte's runtime included, because a precompiled Svelte component
 * must run against the exact Svelte that compiled it (ADR 0121). Paths are relative (`base: './'`),
 * so the module finds its chunks wherever the Client serves it.
 */
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
    plugins: [tailwindcss(), svelte()],
    base: './',
    // A library build leaves `process.env.NODE_ENV` for its consumer, but this bundle has none:
    // the browser imports it as it is.
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        target: 'es2022',
        sourcemap: true,
        // One stylesheet, adopted whole by every shadow root a Graph View mounts in.
        cssCodeSplit: false,
        lib: {
            entry: 'src/main.ts',
            formats: ['es'],
            fileName: 'main',
            cssFileName: 'main',
        },
    },
})
