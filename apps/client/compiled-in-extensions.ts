/**
 * The Built-in Extensions compiled into the Client (ADR 0121): each folder of the repository's
 * `extensions/` that has a `src/extension.ts`, the same test `src/lib/extensions/built-ins.ts`
 * globs for. Read from disk by the build's own configuration, so the Client's type check and unit
 * tests cover a compiled-in extension as they cover the Client's code, without naming any of them.
 *
 * A loaded Built-in Extension has no `src/extension.ts`: it is built, type-checked and tested as
 * a package of its own.
 */
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { Plugin } from 'vite'

const extensionsRoot = fileURLToPath(new URL('../../extensions/', import.meta.url))

/** The folder names under `extensions/`, sorted. None when the folder is missing. */
export function compiledInExtensionFolders(): string[] {
    if (!existsSync(extensionsRoot)) return []
    return readdirSync(extensionsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(`${extensionsRoot}${entry.name}/src/extension.ts`))
        .map((entry) => entry.name)
        .sort()
}

/**
 * The Vite plugins the compiled-in extensions add to the Client's build: the default export of
 * each one's `build-plugins/vite-plugins.ts`, called. An extension has one when a library it
 * bundles must be changed on its way into the Client, as Excalidraw's code and stylesheet are.
 * Imported by path at run time, so the Client's configuration names no extension; Node runs the
 * TypeScript as it is. The folder is not named `build`, which .dockerignore leaves out of an image.
 */
export async function compiledInBuildPlugins(): Promise<Plugin[]> {
    const plugins: Plugin[] = []
    for (const folder of compiledInExtensionFolders()) {
        const file = `${extensionsRoot}${folder}/build-plugins/vite-plugins.ts`
        if (!existsSync(file)) continue
        const module = (await import(pathToFileURL(file).href)) as { default?: () => Plugin[] }
        if (typeof module.default !== 'function') throw new Error(`extensions/${folder}/build-plugins/vite-plugins.ts must export a function returning Vite plugins by default.`)
        plugins.push(...module.default())
    }
    return plugins
}
