/**
 * The address segments Built-in Extensions declare (ADR 0121), read from their manifests alone,
 * for the route's parameter matcher (src/params/extensionAddress.ts).
 *
 * The router loads the matcher before any page, so it must not load any extension's code: this
 * reads only the compiled-in packages' package.json files and the loaded extensions' manifests,
 * never a module. A segment of a package the catalogue later refuses still matches here, and the
 * workspace then finds no View for it and opens the graph as a bare address would.
 */
import { readExtensionPackage } from '@appsoftwareltd/etherpk-extension-api'
import loaded from 'virtual:etherpk-loaded-extensions'

const compiledIn = import.meta.glob<unknown>('../../../../../extensions/*/package.json', { eager: true, import: 'default' })

export const DECLARED_SEGMENTS: ReadonlySet<string> = new Set(
    [...Object.values(compiledIn), ...loaded.map((extension) => extension.packageJson)].flatMap((packageJson) => {
        const read = readExtensionPackage(packageJson)
        if (!read.ok) return []
        return (read.extension.manifest.views ?? []).flatMap((view) => (view.address ? [view.address.segment] : []))
    }),
)
