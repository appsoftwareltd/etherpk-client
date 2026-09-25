import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { untypedDialogButtons } from '@appsoftwareltd/etherpk-shared/dialog-buttons'

/**
 * Guards the client's dialogs against the untyped-button trap described in the shared
 * `dialog-buttons.ts`. Its sibling in `packages/shared` covers the shared surfaces.
 *
 * `wholeFile` marks components that render INTO someone else's dialog rather than hosting one:
 * `OrphanAssetsSection` is exactly that, and its untyped scan button started saving and closing
 * the Graph Settings dialog (2026-08-30).
 */

interface Surface {
    label: string
    path: string
    wholeFile: boolean
}

/** Dialog hosts, scanned inside their snippets; and dialog contents, scanned in full. */
const HOSTS = [
    'src/lib/sync/ui',
    'src/lib/import/ui',
    'src/lib/document/protection/ui',
    'src/lib/document/view/RenameDocumentDialog.svelte',
    'src/lib/workspace/KeyboardShortcutsDialog.svelte',
]
const CONTENTS = ['src/lib/storage/ui', 'src/lib/components']

function surfaces(): Surface[] {
    const appRoot = new URL('../../../../', import.meta.url).pathname
    const collect = (entry: string, wholeFile: boolean): Surface[] => {
        const path = join(appRoot, entry)
        const files = statSync(path).isFile()
            ? [path]
            : readdirSync(path)
                  .filter((name) => name.endsWith('.svelte'))
                  .map((name) => join(path, name))
        return files.map((file) => ({ label: file.slice(file.lastIndexOf('/src/') + 1), path: file, wholeFile }))
    }
    return [
        ...HOSTS.flatMap((entry) => collect(entry, false)),
        ...CONTENTS.flatMap((entry) => collect(entry, true)),
    ].sort((a, b) => a.label.localeCompare(b.label))
}

describe('client dialog buttons declare their type', () => {
    it.each(surfaces().map((s) => [s.label, s]))('%s', (_label, surface) => {
        const untyped = untypedDialogButtons(readFileSync(surface.path, 'utf8'), {
            wholeFile: surface.wholeFile,
        })
        expect(untyped, `untyped <button> at line(s) ${untyped.join(', ')}`).toEqual([])
    })
})
