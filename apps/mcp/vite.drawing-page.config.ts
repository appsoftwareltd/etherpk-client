import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { defineConfig, type Plugin } from 'vite'

const here = fileURLToPath(new URL('.', import.meta.url))

/**
 * The browser bundle the Headless Client draws drawing pictures with (src/drawing-picture-page.ts),
 * built after the Node bundle into `dist/drawing-page/`. Unlike the map page it holds its library:
 * Excalidraw has to go through the same patches as in the Client's build, which also make each font
 * a file of this build. Not a library build, which would inline those fonts into the JavaScript.
 */
export default defineConfig(async () => {
    // By path at run time, as the Client's configuration loads them: Node runs the TypeScript as it is.
    const file = resolve(here, '../../extensions/excalidraw/build-plugins/vite-plugins.ts')
    const { default: excalidrawVitePlugins } = (await import(pathToFileURL(file).href)) as { default: () => Plugin[] }
    return {
        base: './',
        plugins: [excalidrawVitePlugins()],
        // Production whatever NODE_ENV says, as when a test builds this: the patches are text in
        // Excalidraw's production build, and the other one would fail them.
        define: { 'process.env.NODE_ENV': JSON.stringify('production') },
        resolve: {
            alias: {
                '#lib': resolve(here, '../client/src/lib'),
            },
            conditions: ['module', 'browser', 'production'],
        },
        build: {
            outDir: 'dist/drawing-page',
            emptyOutDir: true,
            sourcemap: false,
            target: 'es2022',
            assetsInlineLimit: 0,
            rollupOptions: {
                input: resolve(here, 'src/drawing-picture-page.ts'),
                output: { entryFileNames: 'drawing-picture-page.js' },
            },
        },
    }
})
