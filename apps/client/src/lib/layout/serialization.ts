/**
 * Layout persistence shape, versioning, and the first-run default.
 *
 * Persisted Layout outlives the code that wrote it, so a version guard ships
 * from day one: an unknown or incompatible `version` is *discarded* (parse
 * returns `null`) and the caller resets to {@link defaultLayout}, never a
 * partial migration. A real migration is added only when one is warranted.
 */

import { z } from 'zod'

import type { LayoutModel, SerializedLayout, ViewInstance } from './types'
import { viewKey } from './view-ref'

/** Bump only alongside a real migration; until then, old payloads are reset. */
export const LAYOUT_VERSION = 1

// ── Schema ──────────────────────────────────────────────────────────────────

const viewRefSchema = z.object({
    kind: z.string(),
    target: z.string(),
})

const viewInstanceSchema = z.object({
    panelId: z.string(),
    view: viewRefSchema,
    // Optional, so a Layout persisted before pinning existed still parses as "nothing pinned".
    // Pinning is additive, which is exactly the kind of change that must NOT bump
    // LAYOUT_VERSION - that would discard everyone's pane arrangement to add one flag.
    pinned: z.boolean().optional(),
})

const paneSchema = z.object({
    id: z.string(),
    views: z.array(viewInstanceSchema),
    activePanelId: z.string().nullable(),
})

const regionSchema = z.object({
    panes: z.array(paneSchema),
    collapsed: z.boolean(),
    // Optional for the same reason as `pinned`: additive, and not worth a version bump.
    activePaneId: z.string().optional(),
})

const modelSchema = z.object({
    regions: z.object({
        main: regionSchema,
        'left-sidebar': regionSchema,
        'right-sidebar': regionSchema,
    }),
    activePanelId: z.string().nullable(),
})

const serializedLayoutSchema = z.object({
    version: z.number(),
    model: modelSchema,
    renderer: z.unknown().optional(),
})

/**
 * Validate and version-check a persisted payload.
 *
 * Returns the typed {@link SerializedLayout} on success, or `null` when the
 * payload is structurally invalid *or* carries an incompatible version. Never
 * throws — a corrupt store must degrade to the default Layout, not crash.
 */
export function parseSerializedLayout(raw: unknown): SerializedLayout | null {
    const result = serializedLayoutSchema.safeParse(raw)
    if (!result.success) return null
    if (result.data.version !== LAYOUT_VERSION) return null
    return result.data as SerializedLayout
}

// ── First-run default ─────────────────────────────────────────────────────────

export interface DefaultLayoutOptions {
    /** Target of today's journal document opened in `main`. Defaults to `today`. */
    journalTarget?: string
    /**
     * Whether the right Sidebar starts collapsed. A phone's presenter shows one drawer at a time
     * and opens the left one first, so there it must; a desktop has room for both, and a graph
     * that opens with Backlinks and Tasks in view says what the right Sidebar is for. Default
     * `true`, the safe answer for a caller that has not said which presenter it is for.
     */
    rightSidebarCollapsed?: boolean
}

/**
 * The Tasks View's one and only identity: a singleton (kind + a constant target), so opening
 * it twice focuses the one tab. Exported so the workspace can ensure this resident exists in
 * a Layout persisted before it was one — see the workspace's post-restore step.
 */
export const TASKS_VIEW = { kind: 'tasks', target: 'tasks' } as const
/** The [[Quick Notes View]]'s identity: a singleton resident of the left Sidebar, like Tasks on the right. */
export const QUICK_NOTES_VIEW = { kind: 'quick-notes', target: 'quick-notes' } as const

function pane(view: ViewInstance['view']): {
    id: string
    views: ViewInstance[]
    activePanelId: string
} {
    const panelId = viewKey(view)
    return { id: `pane-${panelId}`, views: [{ panelId, view }], activePanelId: panelId }
}

/**
 * The Layout a brand-new graph (or an unreadable/incompatible payload) opens
 * with: today's journal entry in `main`, the two left-Sidebar residents - the graph sidebar
 * and the [[Quick Notes View]] - as two tabs of one Pane in the `left-sidebar`, and the two
 * right-Sidebar residents - [[Backlink]]s and the [[Tasks View]] - as two tabs of one Pane in
 * the `right-sidebar`, collapsed or not as the caller says. Five Views in all.
 */
export function defaultLayout(options: DefaultLayoutOptions = {}): SerializedLayout {
    const journalTarget = options.journalTarget ?? 'today'
    const rightSidebarCollapsed = options.rightSidebarCollapsed ?? true

    const mainPane = pane({ kind: 'document', target: journalTarget })
    // The left Sidebar's residents: the graph sidebar in front, Quick Notes behind it, so the
    // tab is there from the first open on every device (CONTEXT.md → Sidebar, ADR 0078).
    const tree = { kind: 'document-tree', target: 'root' } as const
    const treePane = {
        id: `pane-${viewKey(tree)}`,
        views: [
            { panelId: viewKey(tree), view: tree },
            { panelId: viewKey(QUICK_NOTES_VIEW), view: QUICK_NOTES_VIEW },
        ],
        activePanelId: viewKey(tree),
    }
    // The right Sidebar's RESIDENTS (CONTEXT.md → Sidebar): Backlinks and Tasks, as two tabs of
    // one Pane, present from the first open on every device. Tasks is a resident rather than a
    // View the toolbar button creates, so the mobile drawer can show both tabs before anything
    // has been pressed — and the button becomes "focus it", the same on both presenters.
    const backlinks = { kind: 'backlinks', target: journalTarget } as const
    const rightPane = {
        id: `pane-${viewKey(backlinks)}`,
        views: [
            { panelId: viewKey(backlinks), view: backlinks },
            { panelId: viewKey(TASKS_VIEW), view: TASKS_VIEW },
        ],
        activePanelId: viewKey(backlinks),
    }

    const model: LayoutModel = {
        regions: {
            'left-sidebar': { panes: [treePane], collapsed: false },
            main: { panes: [mainPane], collapsed: false },
            'right-sidebar': { panes: [rightPane], collapsed: rightSidebarCollapsed },
        },
        activePanelId: mainPane.activePanelId,
    }

    return { version: LAYOUT_VERSION, model }
}
