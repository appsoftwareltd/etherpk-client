/**
 * The [[Theme]]s of a [[Filesystem Backend]] graph: `etherpk/theme-<id>.jsonc`, one flat file
 * per theme beside `settings.json` and `quick-notes.json` (ADR 0082, the ADR 0078 shape). The
 * same file a [[Local Mirror]] writes for a synced graph and an [[Export]] carries, so the
 * four-directory layout stays flat and a theme travels with the folder.
 *
 * The file is JSON with comments (`.jsonc`), so it can open with a note telling whoever finds it
 * in the folder where the theme is actually edited (2026-09-19). Comments are stripped before
 * parsing, outside strings only: a stylesheet or script inside the theme carries `//` and
 * `/*` of its own, and those are data.
 *
 * Read/write go through the {@link DirectoryAdapter} seam, so this is pure and Node-testable
 * over the in-memory adapter. A missing or malformed file reads as no theme.
 */

import { type GraphTheme, isGraphThemeId, sanitizeGraphTheme } from '$lib/document/publish/theme/graph-theme'

import type { DirectoryAdapter } from './directory-adapter'

const PREFIX = 'theme-'
const SUFFIX = '.jsonc'

/** The comment a theme file opens with: where it is edited, and why not here. */
const HEADER = [
    '// A website theme kept by EtherPK for this graph: its templates, stylesheet and script as JSON',
    '// strings, as described at https://docs.etherpk.com/theming-a-published-site.',
    "// Edit it in EtherPK's Theme editor (Settings → Publish → Themes in this graph → Open editor),",
    '// which shows each file on its own. EtherPK rewrites this whole file on every save there, so an',
    '// edit made here by hand lasts only until the next one.',
]

/** The file under `etherpk/` a theme is kept in. */
export function themeFileName(id: string): string {
    return `${PREFIX}${id}${SUFFIX}`
}

/** The theme id a file name under `etherpk/` carries, or null for any other file. */
export function themeIdOfFileName(name: string): string | null {
    if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) return null
    const id = name.slice(PREFIX.length, -SUFFIX.length)
    return isGraphThemeId(id) ? id : null
}

/** The file's text: the header comment, then the theme pretty-printed, newline-terminated. */
export function graphThemeFileText(theme: GraphTheme): string {
    return `${HEADER.join('\n')}\n${JSON.stringify(theme, null, 2)}\n`
}

/**
 * JSON-with-comments to JSON: `//` to end of line and `/* ... *\/` blocks are removed wherever they
 * sit outside a string literal; inside one they are content. Not a full JSONC parser (no
 * trailing commas), which is all the files EtherPK writes need.
 */
export function stripJsonComments(text: string): string {
    let out = ''
    let inString = false
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        if (inString) {
            out += ch
            if (ch === '\\') {
                out += text[i + 1] ?? ''
                i++
            } else if (ch === '"') inString = false
            continue
        }
        if (ch === '"') {
            inString = true
            out += ch
            continue
        }
        if (ch === '/' && text[i + 1] === '/') {
            const end = text.indexOf('\n', i)
            i = end === -1 ? text.length : end - 1
            continue
        }
        if (ch === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2)
            i = end === -1 ? text.length : end + 1
            continue
        }
        out += ch
    }
    return out
}

/** A theme file's text to a theme, or null when it is malformed or names another theme. */
export function parseGraphThemeFile(text: string, id: string): GraphTheme | null {
    try {
        const theme = sanitizeGraphTheme(JSON.parse(stripJsonComments(text)))
        // The file name is the identity on disk; a theme whose json disagrees is left out.
        return theme && theme.id === id ? theme : null
    } catch {
        return null
    }
}

export async function readGraphThemes(adapter: DirectoryAdapter): Promise<GraphTheme[]> {
    const out: GraphTheme[] = []
    let entries: { name: string }[]
    try {
        entries = await adapter.list('etherpk')
    } catch {
        return out
    }
    for (const entry of entries) {
        const id = themeIdOfFileName(entry.name)
        if (id === null) continue
        try {
            const theme = parseGraphThemeFile((await adapter.read('etherpk', entry.name)).text, id)
            if (theme) out.push(theme)
        } catch {
            // Unreadable: skipped, never a crash.
        }
    }
    out.sort((a, b) => a.id.localeCompare(b.id))
    return out
}

export async function writeGraphTheme(adapter: DirectoryAdapter, theme: GraphTheme): Promise<void> {
    await adapter.write('etherpk', themeFileName(theme.id), graphThemeFileText(theme))
}

export async function deleteGraphTheme(adapter: DirectoryAdapter, id: string): Promise<void> {
    await adapter.remove('etherpk', themeFileName(id))
}
