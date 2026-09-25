/**
 * **Graph Settings** (CONTEXT.md → Graph Settings): shared, graph-level configuration
 * that belongs to the knowledge graph rather than to any one user. It is part of the
 * graph's content — persisted in the committed, exported `etherpk/` folder (DESIGN.md →
 * On-disk layout), not in per-user presentation state.
 *
 * It started with a single setting (the default image size applied on upload); more have
 * landed since. Read/write go through the {@link DirectoryAdapter} seam, so this is pure and
 * Node-testable over the in-memory adapter. A missing or malformed file reads as empty
 * defaults — settings are convenience, never load-bearing for identity or content.
 */

import type { DirectoryAdapter } from './directory-adapter'

/** The settings file under the graph's `etherpk/` folder. */
const SETTINGS_FILE = 'settings.json'

export interface GraphSettings {
    /**
     * Default **maximum display size** applied to an image on upload — e.g. `300` or `300x200`,
     * the value that goes after the `|` in `![alt|300](…)`. It caps the rendered dimensions (not
     * the file size): a larger image scales down to fit, a smaller one is left alone. Absent ⇒
     * {@link DEFAULT_IMAGE_DISPLAY_SIZE}; {@link IMAGE_DISPLAY_SIZE_OFF} ⇒ no hint, so images
     * upload at their natural display size. Resolve it through {@link imageDisplaySizeOf}.
     */
    defaultMaxImageDisplaySize?: string
    /**
     * Default info-string injected when a Fenced Code Block is created with bare backticks
     * (ADR 0018). Absent ⇒ `text` (no highlighting until the author picks a language).
     */
    defaultCodeLanguage?: string
    /**
     * How many [[Recents]] the Sidebar shows. Absent ⇒ {@link DEFAULT_RECENT_COUNT}.
     *
     * The one shared knob over a personal list (ADR 0036 §3): the recents *list* is
     * per-device, but how many of them are shown belongs to the graph.
     */
    recentDocumentCount?: number
    /**
     * The graph's [[Favourite]]s, in the order the Sidebar shows them: whatever the user
     * dragged them into, with a newly favourited concept appended at the end.
     *
     * Shared graph content, not per-device state (ADR 0036): they travel in an [[Export]]
     * and every [[Member]] sees the same list, order included.
     */
    favourites?: string[]
    /**
     * Background colour of the workspace's top bar: on a desktop the toolbar holding the Sidebar
     * toggles, Docs, Keyboard Shortcuts, Settings and Tasks; on a phone the strip holding the
     * drawer toggles and the open-panes tabs. A `#rrggbb` hex, lowercase (ADR 0071). Absent ⇒
     * the theme's own surface. One colour for both light and dark themes: it is a way to tell
     * graphs apart at a glance, so it stays the same colour wherever the graph is opened.
     */
    toolbarColor?: string
}

/** Applied on upload when `defaultMaxImageDisplaySize` is absent - the value after the `|` in `![alt|800](…)`. */
export const DEFAULT_IMAGE_DISPLAY_SIZE = '800'
/**
 * The stored value that switches the upload hint OFF. A blank field in the dialog means "use the
 * default", so opting out of any cap needs a value of its own; `0` is never a valid size, so it
 * cannot collide with a real one.
 */
export const IMAGE_DISPLAY_SIZE_OFF = '0'

/** Shown when `recentDocumentCount` is absent. */
export const DEFAULT_RECENT_COUNT = 10
/** Bounds for `recentDocumentCount` - below 1 the section is pointless, above this it is a wall. */
export const MIN_RECENT_COUNT = 1
export const MAX_RECENT_COUNT = 50
/** Hard cap on stored favourites, so a runaway client cannot bloat shared graph content. */
const MAX_FAVOURITES = 200

/**
 * Canonicalise a CSS hex colour to lowercase `#rrggbb`, or `null` for anything else. Accepts
 * the 3-digit shorthand a hand-edited file might carry; a colour input only ever yields the
 * 6-digit form. Named colours, `rgb()` and alpha are rejected: the value is written back into
 * shared graph content, and one spelling keeps two clients from disagreeing about it.
 */
export function normalizeHexColor(raw: string): string | null {
    const value = raw.trim().toLowerCase()
    if (/^#[0-9a-f]{6}$/.test(value)) return value
    if (/^#[0-9a-f]{3}$/.test(value)) {
        return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`
    }
    return null
}

/**
 * Keep only the fields we recognise, with the right types — tolerant of a hand-edited or
 * stale file, and of a synced `meta.settings` object written by another (newer) client.
 */
export function sanitizeGraphSettings(raw: unknown): GraphSettings {
    if (typeof raw !== 'object' || raw === null) return {}
    const out: GraphSettings = {}
    const rec = raw as Record<string, unknown>
    const size = rec.defaultMaxImageDisplaySize
    if (typeof size === 'string' && size.trim() !== '') out.defaultMaxImageDisplaySize = size
    const lang = rec.defaultCodeLanguage
    if (typeof lang === 'string' && lang.trim() !== '') out.defaultCodeLanguage = lang.trim()
    const count = rec.recentDocumentCount
    if (typeof count === 'number' && Number.isInteger(count) && count >= MIN_RECENT_COUNT && count <= MAX_RECENT_COUNT) {
        out.recentDocumentCount = count
    }
    const favourites = rec.favourites
    if (Array.isArray(favourites)) {
        // Deduped case-insensitively, matching Concept identity (CONTEXT.md: `[[Physics]]`
        // and `[[physics]]` are one concept), keeping the FIRST spelling seen: the entry
        // already on the list keeps its place and its casing, as re-favouriting it does.
        const seen = new Set<string>()
        const clean: string[] = []
        for (const entry of favourites) {
            if (typeof entry !== 'string') continue
            const trimmed = entry.trim()
            if (trimmed === '') continue
            const key = trimmed.toLowerCase()
            if (seen.has(key)) continue
            seen.add(key)
            clean.push(trimmed)
        }
        // Over the cap the OLDEST go. New favourites are appended, so cutting the tail would
        // silently swallow the one just added the next time the file is read.
        if (clean.length > 0) out.favourites = clean.slice(-MAX_FAVOURITES)
    }
    const toolbarColor = rec.toolbarColor
    if (typeof toolbarColor === 'string') {
        const hex = normalizeHexColor(toolbarColor)
        if (hex) out.toolbarColor = hex
    }
    return out
}

/**
 * The display-size hint uploads should carry: the setting when present, the default when absent,
 * or `undefined` when switched off ({@link IMAGE_DISPLAY_SIZE_OFF}).
 */
export function imageDisplaySizeOf(settings: GraphSettings): string | undefined {
    const size = settings.defaultMaxImageDisplaySize ?? DEFAULT_IMAGE_DISPLAY_SIZE
    return size === IMAGE_DISPLAY_SIZE_OFF ? undefined : size
}

/** The effective Recents count: the setting when valid, else the default. */
export function recentCountOf(settings: GraphSettings): number {
    return settings.recentDocumentCount ?? DEFAULT_RECENT_COUNT
}

/** Read the graph's settings; resolves to empty defaults when the file is absent or unparseable. */
export async function readGraphSettings(adapter: DirectoryAdapter): Promise<GraphSettings> {
    try {
        const { text } = await adapter.read('etherpk', SETTINGS_FILE)
        return sanitizeGraphSettings(JSON.parse(text))
    } catch {
        return {}
    }
}

/** Write the graph's settings to `etherpk/settings.json` (pretty-printed, newline-terminated). */
export async function writeGraphSettings(adapter: DirectoryAdapter, settings: GraphSettings): Promise<void> {
    await adapter.write('etherpk', SETTINGS_FILE, `${JSON.stringify(sanitizeGraphSettings(settings), null, 2)}\n`)
}
