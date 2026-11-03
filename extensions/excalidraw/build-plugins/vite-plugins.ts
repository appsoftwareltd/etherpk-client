/**
 * What the Client's build does for Excalidraw (`apps/client/compiled-in-extensions.ts` adds these
 * plugins to the Client's Vite configuration). Excalidraw 0.18.1 is pinned exactly, with React.
 *
 * - **Its code is patched** (`patches.ts`) to take its fonts from the Client's origin alone and to
 *   embed them whole in a picture rather than shrink them with code the Client's policy refuses.
 *   In a build, every font Excalidraw names becomes a file of the build with its hash in its name
 *   (`new URL(…, import.meta.url)`, which Vite turns into the file's address), so a font that did
 *   not change keeps its address from one release to the next and the service worker never fetches
 *   it again. On a development server, where Vite bundles Excalidraw with its dependencies once
 *   (dependency optimisation), the same patches run in that bundle, and a font's address is the
 *   file itself.
 * - **The production build everywhere.** The patches are text in the production build, so a
 *   development server bundles that too, in place of the development build its conditions pick.
 * - **Its stylesheet is scoped** (`scope-css.ts`): every rule styles only elements with, or inside,
 *   a class starting `excalidraw`, so loading it cannot restyle the Client.
 * - **The fonts' licences** (`FONT-LICENCES.txt`) are written into the build beside the fonts.
 *
 * A patch that finds nothing to change fails the build or the development server's bundling,
 * rather than shipping an Excalidraw the Client would refuse.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import postcss from 'postcss'
import type { Plugin, Rolldown } from 'vite'

import { missingPatches, patchExcalidrawCode } from './patches.ts'
import { scopeExcalidrawCss } from './scope-css.ts'

/** A file of Excalidraw's production code. */
const PRODUCTION_CODE = /[\\/]@excalidraw[\\/]excalidraw[\\/]dist[\\/]prod[\\/][^\\/]+\.js$/
/** Excalidraw's development entry, which a development server's conditions resolve to. */
const DEVELOPMENT_ENTRY = /[\\/]@excalidraw[\\/]excalidraw[\\/]dist[\\/]dev[\\/]index\.js$/
/** Excalidraw's stylesheet, from either build. */
const STYLESHEET = /[\\/]@excalidraw[\\/]excalidraw[\\/]dist[\\/](prod|dev)[\\/]index\.css$/

const LICENCES = join(import.meta.dirname, 'FONT-LICENCES.txt')

/** Patch one file, failing when a font it names is not in the package. */
function patchFile(code: string, id: string, fontAddress: (font: string, fontsDir: string) => string) {
    const fontsDir = join(dirname(id), 'fonts')
    const patched = patchExcalidrawCode(code, (font) => fontAddress(font, fontsDir))
    const absent = patched.fonts.filter((font) => !existsSync(join(fontsDir, font)))
    if (absent.length > 0) throw new Error(`Excalidraw names fonts its package does not have (${absent.join(', ')}): check the pinned version.`)
    return patched
}

function failUnpatched(applied: ReadonlySet<string>): void {
    const missing = missingPatches(applied)
    if (missing.length > 0) throw new Error(`Excalidraw could not be patched (${missing.join(', ')}): check the pinned version.`)
}

/**
 * The plugin a development server's dependency optimisation runs: Excalidraw's production build in
 * place of its development one, patched, with each font at its own path on the server (`/@fs/…`).
 */
function optimiserPlugin(): Rolldown.Plugin {
    const applied = new Set<string>()
    let seen = false
    return {
        name: 'etherpk-excalidraw-optimise',
        resolveId(source) {
            if (DEVELOPMENT_ENTRY.test(source)) return source.replace(/dist([\\/])dev([\\/])index\.js$/, 'dist$1prod$2index.js')
            return null
        },
        transform(code, id) {
            if (!PRODUCTION_CODE.test(id)) return null
            seen = true
            const patched = patchFile(code, id, (font, fontsDir) => `(location.origin+${JSON.stringify(`/@fs${join(fontsDir, font)}`)})`)
            for (const name of patched.applied) applied.add(name)
            return patched.code === code ? null : { code: patched.code, map: null }
        },
        buildEnd() {
            // A bundling of other dependencies, without Excalidraw, has nothing to check.
            if (seen) failUnpatched(applied)
        },
    }
}

/** The plugins the Client's Vite configuration adds for Excalidraw. */
export default function excalidrawVitePlugins(): Plugin[] {
    let building = false
    /** The patches applied, by Vite environment (`client`, `ssr`). */
    const applied = new Map<string, Set<string>>()
    const scoped = new Set<string>()

    return [
        {
            name: 'etherpk-excalidraw',
            enforce: 'pre',
            config: () => ({ optimizeDeps: { rolldownOptions: { plugins: [optimiserPlugin()] } } }),
            configResolved(config) {
                building = config.command === 'build'
            },
            async transform(code, id) {
                const path = id.split('?')[0]
                if (STYLESHEET.test(path)) {
                    scoped.add(this.environment.name)
                    const result = await postcss([scopeExcalidrawCss()]).process(code, { from: path, map: false })
                    return { code: result.css, map: null }
                }
                if (!PRODUCTION_CODE.test(path)) return null
                const patched = patchFile(code, path, (font) => `new URL(${JSON.stringify(`./fonts/${font}`)},import.meta.url).href`)
                const names = applied.get(this.environment.name) ?? new Set<string>()
                for (const name of patched.applied) names.add(name)
                applied.set(this.environment.name, names)
                return patched.code === code ? null : { code: patched.code, map: null }
            },
            buildEnd(error) {
                if (!building || error) return
                // The browser's build must hold Excalidraw, patched. Another (the server's) need not
                // hold it, but where it does, it is patched too.
                const names = applied.get(this.environment.name)
                if (this.environment.name === 'client' || names) failUnpatched(names ?? new Set())
                if (this.environment.name === 'client' && !scoped.has('client')) throw new Error("Excalidraw's stylesheet was not in the build to be scoped: check the pinned version.")
            },
            generateBundle() {
                if (this.environment.name !== 'client') return
                this.emitFile({ type: 'asset', name: 'excalidraw-font-licences.txt', source: readFileSync(LICENCES, 'utf8') })
            },
        },
    ]
}
