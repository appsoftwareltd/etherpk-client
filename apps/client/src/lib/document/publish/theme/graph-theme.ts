/**
 * A [[Theme]] kept in the knowledge graph (ADR 0082): graph content that is not a note, in its
 * own container beside [[Graph Settings]], the shape ADR 0078 gave Quick Notes. A graph may hold
 * several, one per look its publications need; two publications may share one. This is the
 * pure shape both backends store - a `themes` Y.Map on the server, `etherpk/theme-<id>.jsonc` on
 * a folder - and the sanitiser that reads it back without trusting it.
 */

import { PUBLICATION_ID } from '../publication'
import type { ThemeFiles } from './manifest'
import { parseThemeManifest } from './manifest'

export interface GraphTheme {
    /** Kebab-case, what a publication's `theme:` names. Fixed once chosen. */
    id: string
    /** Display name, free text. */
    name: string
    /** Path → text, `theme.json` included. Every file is text. */
    files: Record<string, string>
    /** Where the copy came from, for the editor's "Reset to original": a bundled name or a url. */
    origin?: string
    /** ISO time of the last save, for the list. */
    updatedAt?: string
}

export function isGraphThemeId(value: unknown): value is string {
    return typeof value === 'string' && PUBLICATION_ID.test(value)
}

/** Whether a path may be a theme file: relative, no traversal, one of the known kinds of place. */
export function isThemeFilePath(path: string): boolean {
    if (path === 'theme.json') return true
    if (path.startsWith('/') || path.includes('..') || path.includes('\\')) return false
    return /^(layouts|partials|assets)\/[^/]+(\/[^/]+)*$/.test(path)
}

/** A stored theme read back defensively: a malformed entry is null, never a crash. */
export function sanitizeGraphTheme(raw: unknown): GraphTheme | null {
    if (typeof raw !== 'object' || raw === null) return null
    const data = raw as Record<string, unknown>
    if (!isGraphThemeId(data.id)) return null
    const files: Record<string, string> = {}
    if (typeof data.files === 'object' && data.files !== null) {
        for (const [path, text] of Object.entries(data.files as Record<string, unknown>)) {
            if (typeof text === 'string' && isThemeFilePath(path)) files[path] = text
        }
    }
    const theme: GraphTheme = {
        id: data.id,
        name: typeof data.name === 'string' && data.name.trim() !== '' ? data.name : data.id,
        files,
    }
    if (typeof data.origin === 'string') theme.origin = data.origin
    if (typeof data.updatedAt === 'string') theme.updatedAt = data.updatedAt
    return theme
}

/** The publisher's view of a graph theme; throws with the reason when the manifest is unusable. */
export function themeFilesOf(theme: GraphTheme): ThemeFiles {
    const json = theme.files['theme.json']
    if (json === undefined) throw new Error(`The theme "${theme.name}" has no theme.json.`)
    const { manifest, errors } = parseThemeManifest(json)
    if (!manifest) throw new Error(`The theme "${theme.name}" cannot be used: ${errors.join(' ')}`)
    const files = new Map<string, string>()
    for (const [path, text] of Object.entries(theme.files)) if (path !== 'theme.json') files.set(path, text)
    return { manifest, files }
}

/** A graph theme made from a set of files (a bundled theme or a fetched one), ready to store. */
export function graphThemeFromFiles(id: string, name: string, files: ReadonlyMap<string, string>, origin: string, now: Date = new Date()): GraphTheme {
    const out: Record<string, string> = {}
    for (const [path, text] of files) if (isThemeFilePath(path)) out[path] = text
    return { id, name, files: out, origin, updatedAt: now.toISOString() }
}
