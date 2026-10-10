/**
 * The app's icon vocabulary: 16×16 line drawings on a `0 0 16 16` viewBox, stroked in
 * `currentColor` so they take the colour of whatever they sit in.
 *
 * One table, because there were two — the [[Command Bar]]'s and the slash menu's, drifting
 * apart with `image` defined identically in both and nothing keeping them that way. A third
 * consumer (the [[Asset Reference]] action icons) is what made that worth fixing rather than
 * copying again.
 *
 * Icons are **inline SVG rather than Unicode glyphs**. The bin character has no text
 * presentation at all, so it renders as a colour emoji at a size and weight nothing else on
 * the row shares — and only where an emoji font is installed; the arrows default to emoji
 * presentation on most platforms too. A glyph would also inherit the editor's font metrics,
 * which is precisely what an icon beside a content column must not do.
 *
 * The markup here is in-repo constant text, never user or document content, which is what
 * makes rendering it with `{@html}` (and `innerHTML` in the CodeMirror widgets) safe. Under the
 * Client's Trusted Types policy (ADR 0130) this module alone makes it trusted markup, through
 * `etherpk-icons`, which passes it as it is. The icons extensions add (`registerIcons`) are not
 * text in this repository, so DOMPurify cleans each of those instead.
 *
 * A few icons are Heroicons (MIT) instead, kept on their own 24-unit grid with their paths copied
 * verbatim from the package's `24/outline/<name>.svg` (`HEROICON_PATHS`), so either can be
 * checked against the other.
 */

import { sanitizedIconMarkup, trustedIconMarkup, type TrustedMarkup } from '$lib/security/trusted-types'

/** Inner markup for each named icon; `default` is the fallback for an unknown name. */
export const ICON_PATHS: Record<string, string> = {
    // Command Bar
    slash: '<path d="M10 3 6 13"/>',
    'wikilink-open':
        '<text x="8" y="11.5" text-anchor="middle" fill="currentColor" stroke="none" font-family="ui-monospace, monospace" font-size="10" font-weight="700">[[</text>',
    'wikilink-close':
        '<text x="8" y="11.5" text-anchor="middle" fill="currentColor" stroke="none" font-family="ui-monospace, monospace" font-size="10" font-weight="700">]]</text>',
    indent: '<path d="M2.5 4h11M7 8h6.5M7 12h6.5M2.5 7.2 4.8 8 2.5 8.8z" fill="currentColor" stroke="none"/><path d="M2.5 4h11"/><path d="M7 8h6.5M7 12h6.5"/>',
    outdent: '<path d="M2.5 4h11M2.5 8h6.5M2.5 12h6.5M6.3 7.2 4 8l2.3 0.8z" fill="currentColor" stroke="none"/><path d="M2.5 4h11"/><path d="M2.5 8h6.5M2.5 12h6.5"/>',
    'move-up': '<path d="M8 12.5V3.5M4.5 7 8 3.5 11.5 7"/>',
    'move-down': '<path d="M8 3.5v9M4.5 9 8 12.5 11.5 9"/>',
    /** A filled dot, as the editor draws a bullet: the bullet toggle. Larger than the `default` dot. */
    bullet: '<circle cx="8" cy="8" r="3" fill="currentColor" stroke="none"/>',
    task: '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5.5 8 7.3 10 10.5 5.8"/>',
    /** Two arrows chasing round a circle: put it back the way it started (Reset workspace). */
    reset: '<path d="M13 8a5 5 0 0 1-8.7 3.4M3 8a5 5 0 0 1 8.7-3.4"/><path d="M11.7 2v2.6H9.1M4.3 14v-2.6h2.6"/>',
    /** "abc" over a tick: the spell check preference (its Command Menu rows). */
    'spell-check': '<text x="8" y="7.5" text-anchor="middle" fill="currentColor" stroke="none" font-family="ui-sans-serif, system-ui, sans-serif" font-size="7" font-weight="700">abc</text><path d="M4.5 11.5 7 14l4.5-4.5"/>',
    fold: '<path d="M4 6 8 10 12 6"/>',
    /** An arrow curling back to the left: take the last step back. */
    undo: '<path d="M3.5 6.5h6.5a3 3 0 0 1 0 6H7"/><path d="M6 4 3.5 6.5 6 9"/>',
    /** The same arrow curling forward to the right: put the undone step back. */
    redo: '<path d="M12.5 6.5H6a3 3 0 0 0 0 6h3"/><path d="M10 4l2.5 2.5L10 9"/>',
    'zoom-in': '<circle cx="7" cy="7" r="4"/><path d="M10 10 14 14M5 7h4M7 5v4"/>',
    'zoom-out': '<circle cx="7" cy="7" r="4"/><path d="M10 10 14 14M5 7h4"/>',

    // Slash menu
    today: '<rect x="2.5" y="3" width="11" height="11" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v2M10.5 2v2"/><circle cx="8" cy="10" r="1.3" fill="currentColor" stroke="none"/>',
    calendar: '<rect x="2.5" y="3" width="11" height="11" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v2M10.5 2v2"/>',

    // The `#` menu: a task's priority, and its waiting, doing and cancelled states.
    flag: '<path d="M4 14V3h7l-1.5 2.5L11 8H4"/>',
    clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.2"/>',

    // The `[[` menu, a row per kind of name (a journal day is `calendar`).
    page: '<path d="M4 2h5l4 4v8.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5z"/><path d="M9 2v4h4"/>',
    alias: '<path d="M5 4v3.5a2 2 0 0 0 2 2h5"/><path d="M9.5 6.5l3 3-3 3"/>',
    /** A dashed page: a name things link to that has no page yet. */
    pageless: '<path d="M4 2h5l4 4v8.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5z" stroke-dasharray="2 1.5"/><path d="M8 8.5v3M6.5 10h3"/>',
    /** A circled plus: make a page by the name typed. */
    'new-page': '<circle cx="8" cy="8" r="6"/><path d="M8 5.5v5M5.5 8h5"/>',

    table: '<rect x="2.5" y="3" width="11" height="10" rx="1"/><path d="M2.5 6.5h11M2.5 9.5h11M6.5 6.5v6.5"/>',
    // Row and column edits, drawn so the four read differently at 18px on the Command Bar: a
    // two-row grid with a plus or a minus, the plus/minus beside the axis it acts on.
    'table-add-row': '<rect x="2.5" y="3" width="11" height="5.5" rx="1"/><path d="M2.5 6.5h11M6.5 3v5"/><path d="M6.5 12.5h3M8 11v3"/>',
    'table-remove-row': '<rect x="2.5" y="3" width="11" height="5.5" rx="1"/><path d="M2.5 6.5h11M6.5 3v5"/><path d="M6.5 12.5h3"/>',
    'table-add-column': '<rect x="2.5" y="3" width="6" height="10" rx="1"/><path d="M2.5 6.5h6M2.5 9.5h6"/><path d="M11 8h3M12.5 6.5v3"/>',
    'table-remove-column': '<rect x="2.5" y="3" width="6" height="10" rx="1"/><path d="M2.5 6.5h6M2.5 9.5h6"/><path d="M11 8h3"/>',
    'table-format': '<rect x="2.5" y="3" width="11" height="10" rx="1"/><path d="M2.5 6.5h11M2.5 9.5h11"/>',
    code: '<path d="M6 5.5 3 8l3 2.5M10 5.5 13 8l-3 2.5"/>',
    // A page with its header band: the block of keys at the top of a document.
    frontmatter: '<rect x="3" y="2.5" width="10" height="11" rx="1.5"/><path d="M3 6.5h10M5.2 4.5h3.3M5.2 9h5.6M5.2 11.3h3.6"/>',
    // Format Toggles (Command Menu → Format): a heavy B, a slanted I, and a marker pen's wash.
    bold: '<text x="8" y="12" text-anchor="middle" fill="currentColor" stroke="none" font-family="ui-sans-serif, system-ui, sans-serif" font-size="11" font-weight="800">B</text>',
    italic: '<text x="8" y="12" text-anchor="middle" fill="currentColor" stroke="none" font-family="ui-serif, Georgia, serif" font-size="12" font-style="italic" font-weight="600">I</text>',
    highlight: '<path d="M3 13h10" stroke-width="2.5" opacity="0.5"/><path d="m5.5 10.5 5-6 1.5 1.5-5 6z"/><path d="m5.5 10.5-1 2 2.5-0.5"/>',
    image: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1.2"/><path d="M3 11.5 6.5 8l2 2 2.5-2.5L13.5 11"/>',

    // Protection
    /** A closed padlock: this content is protected, and the key is not held. */
    lock: '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V4.8a2.5 2.5 0 0 1 5 0V7"/>',
    /**
     * The same body with the shackle swung open: protected, and currently readable. Only the left
     * leg reaches the body and the arc lifts away to the right, so at 13px it reads as a different
     * shape from `lock` rather than the same one with a hairline gap — which is what the first
     * drawing was, and it was not telling anyone anything.
     */
    'lock-open': '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V4.6a2.6 2.6 0 0 1 5.1-.7"/>',

    // Publishing
    /** A globe: this document is a snippet of a published site (an include), so its text is public. */
    globe: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c-2 2-2 9 0 11M8 2.5c2 2 2 9 0 11"/>',

    // Tabs
    /**
     * A drawing pin, seen from the side and tilted the way one sits in a board: this tab stays
     * put. Filled head so it still reads as a pin at 12px, where an outline collapses to a blob.
     */
    pin: '<path d="M6 2.5h4.5l-.8 3.2 2.3 2.3-.9.9H4.4l-.9-.9 2.3-2.3z" fill="currentColor" stroke="none"/><path d="M8 9v4.5"/>',

    // Navigate
    /** A magnifying glass: search. */
    search: '<circle cx="6.8" cy="6.8" r="4"/><path d="M9.8 9.8 13.5 13.5"/>',

    // Asset Reference actions
    /** Arrow into a tray: save this file. */
    download: '<path d="M8 2.5v7.5M5 7l3 3 3-3M3 12.5h10"/>',
    /** A bin with a lid: destroy this. */
    trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .8h3.8a1 1 0 0 0 1-.8l.6-8.2M6.8 7v4M9.2 7v4"/>',
    /** A cross: close this. */
    close: '<path d="M4 4l8 8M12 4l-8 8"/>',
    /** Arrow leaving a frame: open this somewhere else. */
    'open-external': '<path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>',
    /** Two sheets, one behind the other: put a copy of this on the clipboard. */
    copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/>',
    /** A bare tick: that just happened. Swapped in for an action's own icon as its confirmation. */
    check: '<path d="M3.5 8.5 6.5 11.5 12.5 5"/>',

    // Sidebar
    /** Three linked nodes: a knowledge graph. Leads the Graph Sidebar's tab, before the graph's name. */
    graph: '<circle cx="4" cy="4.5" r="1.8"/><circle cx="12" cy="5.5" r="1.8"/><circle cx="7.5" cy="12" r="1.8"/><path d="M5.8 4.7 10.2 5.3M5 6.1l1.7 4.3M8.6 10.6l2.6-3.6"/>',
    /** Three dots in a row: a menu of further actions. */
    more: [3.5, 8, 12.5].map((x) => `<circle cx="${x}" cy="8" r="1.15" fill="currentColor" stroke="none"/>`).join(''),
    /** A pencil: rename. */
    rename: '<path d="M10.6 2.9 13.1 5.4 6 12.5l-3.1.6.6-3.1z"/><path d="M9.3 4.2 11.8 6.7"/>',
    /** Four arrows from the middle: move something to another place. */
    move: '<path d="M8 2.2v11.6M2.2 8h11.6M6.4 3.8 8 2.2l1.6 1.6M6.4 12.2 8 13.8l1.6-1.6M3.8 6.4 2.2 8l1.6 1.6M12.2 6.4 13.8 8l-1.6 1.6"/>',
    /** An arrow rising out of a tray: bring a file in. */
    import: '<path d="M8 10.5V2.8M5.2 5.6 8 2.8l2.8 2.8"/><path d="M2.8 10.2v3h10.4v-3"/>',
    /** Three lines: a list. */
    list: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle cx="2.8" cy="4" r=".9" fill="currentColor" stroke="none"/><circle cx="2.8" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="2.8" cy="12" r=".9" fill="currentColor" stroke="none"/>',
    /** Four corners: fit the whole picture in view. */
    fit: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
    /** Six dots: the grip of a row that can be dragged to reorder. */
    grip: [4, 8, 12]
        .flatMap((y) => [6, 10].map((x) => `<circle cx="${x}" cy="${y}" r="1" fill="currentColor" stroke="none"/>`))
        .join(''),
    default: '<circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/>',
}

/** Icons drawn on Heroicons' 24-unit grid: Heroicons 2.2.0 outline, each path copied verbatim. */
const HEROICON_PATHS: Record<string, string> = {
    /**
     * heroicons/outline `link`, a chain: the documents that link to this one. On the Backlinks
     * View's tab and the Show Backlinks row.
     */
    backlinks:
        '<path d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244"/>',
}

export interface IconOptions {
    /** Rendered size in px, square. Defaults to 16. */
    size?: number
    /** Stroke width. Defaults to 1.4. */
    strokeWidth?: number
    /** Accessible label. Omitted ⇒ the icon is marked decorative (`aria-hidden`). */
    label?: string
}

/**
 * Icons extensions' manifests add (ADR 0121), each under `<extension id>.<name>`, drawn on the
 * table's 16-unit grid. Kept apart from the table so an extension can never redraw one of the
 * Client's icons.
 */
const EXTENSION_ICONS = new Map<string, string>()

/** Add extension icons by their registered names. Returns the undo. */
export function registerIcons(icons: Record<string, string>): () => void {
    for (const name of Object.keys(icons)) {
        if (name in ICON_PATHS || name in HEROICON_PATHS) throw new Error(`The icon "${name}" is the Client's own.`)
    }
    for (const [name, markup] of Object.entries(icons)) EXTENSION_ICONS.set(name, markup)
    return () => {
        for (const name of Object.keys(icons)) EXTENSION_ICONS.delete(name)
    }
}

/** The `<svg>` markup for a named icon, falling back to a neutral dot for an unknown name. */
export function iconSvg(name: string, options: IconOptions = {}): TrustedMarkup {
    const { size = 16, strokeWidth = 1.4, label } = options
    // The label is the one value here that is not a number or a table entry, so it is escaped.
    const a11y = label ? `role="img" aria-label="${escapeAttribute(label)}"` : 'aria-hidden="true"'
    // A Heroicon keeps its own grid; its stroke is scaled up with it, so it draws as heavy as the
    // table's 16-unit icons beside it rather than at Heroicons' lighter 1.5 of 24.
    const hero = HEROICON_PATHS[name]
    const grid = hero === undefined ? 16 : 24
    const stroke = Math.round(((strokeWidth * grid) / 16) * 1000) / 1000
    const svg = (body: string) =>
        `<svg viewBox="0 0 ${grid} ${grid}" width="${Number(size)}" height="${Number(size)}" fill="none" stroke="currentColor" ` +
        `stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${body}</svg>`
    const own = hero ?? ICON_PATHS[name]
    const extension = own === undefined ? EXTENSION_ICONS.get(name) : undefined
    // An extension's icon came from its manifest, not this file, so DOMPurify cleans it. Only the
    // Client's own table goes through `etherpk-icons`, which passes markup as it is.
    if (extension !== undefined) return sanitizedIconMarkup(svg(extension))
    return trustedIconMarkup(svg(own ?? ICON_PATHS.default))
}

function escapeAttribute(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
