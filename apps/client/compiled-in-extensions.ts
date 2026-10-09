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
import { fileURLToPath } from 'node:url'

const extensionsRoot = fileURLToPath(new URL('../../extensions/', import.meta.url))

/** The folder names under `extensions/`, sorted. None when the folder is missing. */
export function compiledInExtensionFolders(): string[] {
    if (!existsSync(extensionsRoot)) return []
    return readdirSync(extensionsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(`${extensionsRoot}${entry.name}/src/extension.ts`))
        .map((entry) => entry.name)
        .sort()
}
