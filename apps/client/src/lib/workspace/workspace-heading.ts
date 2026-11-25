/**
 * What is open, as the desktop workspace toolbar says it after the left Sidebar toggle and as the
 * Graphs page says it on a card: a name, then two icons (`KindIcons.svelte`). The first icon says
 * what kind of thing it is, a graph or a folder of files. The second says where it is kept, on a
 * Sync Server or on this device. Several windows can each hold a graph, and the toolbar is where
 * each one says which it holds.
 *
 * Pure and Node-tested. A long name is returned whole: the toolbar clips it, and the whole of it
 * stays in the heading's text.
 */

/** A [[Knowledge Graph]], a [[Plain Folder]], or one file opened without its folder. */
export type KindOfThing = 'graph' | 'folder' | 'file'
/** On a [[Sync Server]], or on this device and nowhere else. */
export type WhereKept = 'synced' | 'device'

export interface WorkspaceKind {
    what: KindOfThing
    kept: WhereKept
    /** The pair of icons in words, for a screen reader and the tooltip: "Synced graph". */
    words: string
}

/**
 * Every kind of thing a workspace opens. `browser` is a graph in the browser's own storage that is
 * not the Demo Graph: a dev graph. Both are kept on this device.
 */
export const KINDS = {
    synced: { what: 'graph', kept: 'synced', words: 'Synced graph' },
    folder: { what: 'graph', kept: 'device', words: 'Folder graph' },
    demo: { what: 'graph', kept: 'device', words: 'Demo graph' },
    browser: { what: 'graph', kept: 'device', words: 'Graph' },
    plain: { what: 'folder', kept: 'device', words: 'Plain Folder' },
    file: { what: 'file', kept: 'device', words: 'File' },
} as const satisfies Record<string, WorkspaceKind>

/** Where an open graph is kept. */
export type OpenGraphKind = 'synced' | 'folder' | 'demo' | 'browser'

export interface WorkspaceHeading {
    /** Its name, or null while there is none to show. */
    name: string | null
    kind: WorkspaceKind
}

/**
 * The graph's name, trimmed, or null when there is none to show. A name equal to `graphId` is the
 * id standing in: a dev graph in the browser's own storage has no registry record, so the
 * workspace lets the id serve the settings dialog's name field.
 */
export function knownGraphName(name: string, graphId: string): string | null {
    const trimmed = name.trim()
    return trimmed === '' || trimmed === graphId ? null : trimmed
}

/** A graph's heading. The name is left out while it is not known, or while the id stands in for it. */
export function graphHeading(kind: OpenGraphKind, name: string, graphId: string): WorkspaceHeading {
    return { name: knownGraphName(name, graphId), kind: KINDS[kind] }
}

/** A Plain Folder's heading, or that of one file opened without its folder. */
export function plainHeading(name: string, onlyFile: boolean): WorkspaceHeading {
    return { name: name.trim() === '' ? null : name.trim(), kind: onlyFile ? KINDS.file : KINDS.plain }
}

/** The heading's text: the name, or the kind in words while there is no name. */
export function headingText(heading: WorkspaceHeading): string {
    return heading.name ?? heading.kind.words
}
