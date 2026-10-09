import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))

/**
 * The browser bundle the Headless Client draws map pictures with (src/map-picture-page.ts),
 * built after the Node bundle into the same `dist/`. MapLibre stays outside it: the page loads
 * the copy this package installs, through an import map (map-pictures.ts).
 */
export default defineConfig({
    resolve: {
        alias: {
            $lib: resolve(here, '../client/src/lib'),
        },
    },
    build: {
        outDir: 'dist',
        emptyOutDir: false,
        sourcemap: false,
        target: 'es2022',
        lib: {
            entry: resolve(here, 'src/map-picture-page.ts'),
            formats: ['es'],
            fileName: () => 'map-picture-page.js',
        },
        rollupOptions: {
            external: ['maplibre-gl'],
        },
    },
})
