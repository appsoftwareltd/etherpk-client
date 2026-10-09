/**
 * The Built-in Extensions this Client ships (ADR 0121), found without the Client naming any of
 * them:
 *
 * - **compiled in:** every package in the repository's `extensions/` folder with a
 *   `src/extension.ts`, found by a build-time glob, so adding the folder adds the extension. It is
 *   compiled with the Client, its Svelte and its Tailwind.
 * - **loaded:** the prebuilt bundles the Client's package.json names, which the Vite plugin serves
 *   from the Client's own origin (extensions-plugin.ts).
 *
 * The only module that imports anything from `extensions/`, which the lint rule allows here and
 * nowhere else. Kept apart from the catalogue's logic so tests never compile an extension.
 */
import loaded from 'virtual:etherpk-loaded-extensions'

import { buildCatalogue, type Catalogue } from './catalogue'

const packages = import.meta.glob<unknown>('../../../../../extensions/*/package.json', { eager: true, import: 'default' })
const modules = import.meta.glob<unknown>('../../../../../extensions/*/src/extension.ts', { eager: true })

/** The folder name of an `extensions/<folder>/...` path. */
function folderOf(path: string): string {
    return path.split('/extensions/')[1].split('/')[0]
}

export const builtInCatalogue: Catalogue = buildCatalogue({
    clientVersion: __RELEASE_VERSION__,
    compiledIn: Object.entries(modules).map(([path, module]) => {
        const folder = folderOf(path)
        return { folder, packageJson: packages[`../../../../../extensions/${folder}/package.json`], module }
    }),
    loaded,
})

if (builtInCatalogue.broken.length > 0) console.error('[extensions] some built-in extensions could not be read', builtInCatalogue.broken)
