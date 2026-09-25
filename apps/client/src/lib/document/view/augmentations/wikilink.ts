/**
 * Augmentation: mark wikilink segments with `.cm-wikilink`, driven by the nested
 * parser + code-suppression (not a regex). A pure decoration over unaltered
 * markdown (ADR 0001). Each segment carries its `data-concept`; links to a concept
 * with no document get `.cm-wikilink--missing`, and a plain click opens the concept
 * (confirming first when it has no document yet). Holding the mod key (Ctrl / ⌘)
 * suppresses that and just places the cursor, which is how link text is edited —
 * inverted from the usual editor convention so touch, which has no modifier, can
 * follow a link at all. The model lives in `$lib/document/wikilink` (see Wikilinks.md, ADR 0011).
 */

import { type EditorState, type Extension, RangeSetBuilder, StateEffect, type Transaction } from '@codemirror/state'
import {
    Decoration,
    type DecorationSet,
    EditorView,
    ViewPlugin,
    type ViewUpdate,
} from '@codemirror/view'

import { conceptKey } from '../../../storage/fs/identity'
import { isInCode } from '../../wikilink/code-ranges'
import { parseWikilinks } from '../../wikilink/parser'
import {
    analysisFor,
    editorAnalysisField,
    type EditorAnalysis,
} from '../analysis/editor-analysis'
import { EXTERNAL } from '../cm-document'
import { isOwnEditing } from '../own-editing'
import { innermostLinkContainingEdit, type LinkAt, WikilinkEpisode } from './wikilink-episode'

export interface WikilinkIndexUpdate {
    full: boolean
    changedConceptKeys: ReadonlySet<string>
}

export interface WikilinkAugmentationOptions {
    /** True if the concept has no document (→ `.cm-wikilink--missing`). */
    isMissing?: (concept: string) => boolean
    /** Open the concept (plain click). Missing concepts are confirmed, then created, by the handler. */
    onOpen?: (concept: string) => void
    /**
     * Subscribe to graph-index updates; returns an unsubscribe. Without this the
     * missing/exists styling is only as fresh as the last EDIT: an editor mounted while
     * the index was still building kept every link dashed-as-missing until the user
     * happened to type in it (live, 2026-07-29).
     */
    onIndexUpdated?: (listener: (update: WikilinkIndexUpdate) => void) => () => void
    /**
     * An editing episode inside a link ended having changed its concept (ADR 0065): what the
     * link named before, and what the link at that place names now - null when the edit left
     * no balanced link there.
     */
    onLinkEdited?: (before: string, after: string | null) => void
    /** A right-click or long-press on a link, with the pointer position for the menu. */
    onContextMenu?: (concept: string, x: number, y: number) => void
}

/**
 * Whether one of the user's own transactions may open an editing episode: typing, deleting,
 * pasting, dragging, undoing, as CodeMirror marks them. Not a wrap or an unwrap
 * (wrap-selection.ts, ADR 0077): those write their markers around the selection and leave the
 * selected text as it was, so a link inside the selection is not being edited. Without this
 * exception, `[[A]] [[B]]` wrapped in `[` reads to the bracket matcher as a link named `[A` until
 * the second press balances it, and the caret, at the selection's end, is outside that link, so
 * the episode ended at once and proposed renaming A (live, 2026-09-18).
 */
export function opensWikilinkEpisode(tr: Transaction): boolean {
    if (tr.isUserEvent('input.wrap') || tr.isUserEvent('input.unwrap')) return false
    return isOwnEditing(tr)
}

/**
 * The balanced wikilinks on the line holding `from`, at absolute offsets (`to` just past the
 * last `]`). Links never span lines; a link inside code or inside the frontmatter block is not a
 * reference and is left out.
 */
function linksOnLineAt(state: EditorState, from: number, to: number): LinkAt[] {
    const analysis = analysisFor(state)
    if (from <= analysis.frontmatterEnd) return []
    const line = state.doc.lineAt(from)
    if (to > line.to) return []
    const links: LinkAt[] = []
    for (const link of parseWikilinks(line.text)) {
        const start = line.from + link.start
        const end = line.from + link.end + 1
        if (isInCode(analysis.codeRanges, start, end - 1)) continue
        links.push({ concept: link.concept, from: start, to: end })
    }
    return links
}

/** The innermost balanced link whose whole span contains `[from, to]`: what occupies a tracked range. */
function innermostLinkContaining(state: EditorState, from: number, to: number): LinkAt | null {
    let best: LinkAt | null = null
    for (const link of linksOnLineAt(state, from, to)) {
        if (link.from > from || link.to < to) continue
        if (!best || link.to - link.from < best.to - best.from) best = link
    }
    return best
}

/** Feeds the episode tracker from editor updates and reports an ended edit (ADR 0065). */
function episodePlugin(options: WikilinkAugmentationOptions): Extension {
    return ViewPlugin.fromClass(
        class {
            private readonly episode = new WikilinkEpisode()

            update(update: ViewUpdate): void {
                const localChanges: { from: number; to: number }[] = []
                for (const tr of update.transactions) {
                    // Only this user's own editing counts: a write-back from the workspace
                    // (EXTERNAL) and another member's edit arriving through the collaborative
                    // binding carry no user event, and neither may open an episode.
                    if (!tr.docChanged || tr.annotation(EXTERNAL) || !opensWikilinkEpisode(tr)) continue
                    tr.changes.iterChangedRanges((fromA, toA) => localChanges.push({ from: fromA, to: toA }))
                }
                if (!this.episode.open && localChanges.length === 0) return
                const edit = this.episode.update({
                    localChanges,
                    // The subject: the link the first change is an edit OF (its text, not its
                    // brackets, wikilink-episode.ts); what occupies the range afterwards is any link there.
                    linkBefore: (from, to) => innermostLinkContainingEdit(linksOnLineAt(update.startState, from, to), from, to),
                    linkAfter: (from, to) => innermostLinkContaining(update.state, from, to),
                    mapPos: (pos, assoc) => update.changes.mapPos(pos, assoc),
                    caret: update.state.selection.main.head,
                    focused: update.view.hasFocus,
                })
                // After the update cycle, so the View's own listener has already forwarded the
                // text to the store the workspace will read.
                if (edit) queueMicrotask(() => options.onLinkEdited?.(edit.before, edit.after))
            }

            destroy(): void {
                // The view is gone; the last state it held is the only answer left.
                const edit = this.episode.close(() => null)
                if (edit) options.onLinkEdited?.(edit.before, edit.after)
            }
        },
    )
}

const LONG_PRESS_MS = 500
const LONG_PRESS_SLOP_PX = 10

/**
 * Right-click, and a touch long-press, on a link raise its Context Menu (ADR 0065). Editor-level
 * handlers rather than per-element ones, as for asset links: a mark decoration has no element
 * this augmentation owns across rebuilds. The click a long-press generates is swallowed so the
 * link does not also open under the menu.
 */
function contextMenuHandlers(options: WikilinkAugmentationOptions): Extension {
    let timer: ReturnType<typeof setTimeout> | undefined
    let start: { x: number; y: number } | null = null
    let fired = false
    const clear = () => {
        if (timer) clearTimeout(timer)
        timer = undefined
        start = null
    }
    const conceptAt = (event: Event): string | null =>
        (event.target as HTMLElement | null)?.closest?.('.cm-wikilink')?.getAttribute('data-concept') ?? null

    return EditorView.domEventHandlers({
        contextmenu(event) {
            const concept = conceptAt(event)
            if (!concept || !options.onContextMenu) return false
            event.preventDefault()
            // A platform that raises contextmenu for a touch hold (Android) gets one menu, not
            // one from here and one from the timer; the click that follows is swallowed too.
            clear()
            fired = true
            options.onContextMenu(concept, event.clientX, event.clientY)
            return true
        },
        pointerdown(event) {
            if (event.pointerType !== 'touch' || !options.onContextMenu) return false
            const concept = conceptAt(event)
            if (!concept) return false
            fired = false
            start = { x: event.clientX, y: event.clientY }
            const { clientX, clientY } = event
            timer = setTimeout(() => {
                fired = true
                clear()
                options.onContextMenu?.(concept, clientX, clientY)
            }, LONG_PRESS_MS)
            return false
        },
        pointermove(event) {
            // A drag is a selection or a scroll, not a press.
            if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP_PX) clear()
            return false
        },
        pointerup() {
            clear()
            return false
        },
        pointercancel() {
            clear()
            return false
        },
        click(event) {
            if (!fired) return false
            fired = false
            event.preventDefault()
            return true
        },
        mousedown(event) {
            // The mousedown a fired long-press generates must not open the link either.
            if (!fired) return false
            event.preventDefault()
            return true
        },
    })
}

/** Carried by the transaction the plugin dispatches when the index says it changed. */
const refreshWikilinks = StateEffect.define<null>()
let decorationBuildCount = 0

/** Content-free counters used by the performance harness and regression tests. */
export function wikilinkDecorationDiagnostics(): { builds: number } {
    return { builds: decorationBuildCount }
}

export function resetWikilinkDecorationDiagnostics(): void {
    decorationBuildCount = 0
}

function buildDecorations(
    view: EditorView,
    options: WikilinkAugmentationOptions,
): { decorations: DecorationSet; referencedKeys: Set<string> } {
    decorationBuildCount += 1
    const builder = new RangeSetBuilder<Decoration>()
    const referencedKeys = new Set<string>()
    // The shared analysis owns parsing and code suppression. This full decoration build
    // runs on mount and structural fallback edits; ordinary line edits use the mapped
    // patch path in update().
    for (const seg of analysisFor(view.state).wikilinks) {
        const concept = seg.wikilink.concept
        referencedKeys.add(conceptKey(concept))
        const missing = options.isMissing?.(concept) ?? false
        builder.add(
            seg.start,
            seg.end,
            Decoration.mark({
                class: missing ? 'cm-wikilink cm-wikilink--missing' : 'cm-wikilink',
                attributes: { 'data-augmentation': 'wikilink', 'data-concept': concept },
            }),
        )
    }
    return { decorations: builder.finish(), referencedKeys }
}

function decorationFor(
    segment: EditorAnalysis['wikilinks'][number],
    options: WikilinkAugmentationOptions,
) {
    const concept = segment.wikilink.concept
    const missing = options.isMissing?.(concept) ?? false
    return Decoration.mark({
        class: missing ? 'cm-wikilink cm-wikilink--missing' : 'cm-wikilink',
        attributes: { 'data-augmentation': 'wikilink', 'data-concept': concept },
    }).range(segment.start, segment.end)
}

function referencedKeyCounts(analysis: EditorAnalysis): Map<string, number> {
    const counts = new Map<string, number>()
    for (const segment of analysis.wikilinks) {
        const key = conceptKey(segment.wikilink.concept)
        counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
}

export function wikilinkAugmentation(options: WikilinkAugmentationOptions = {}): Extension {
    const plugin = ViewPlugin.fromClass(
        class {
            decorations: DecorationSet
            private unsubscribe?: () => void
            private destroyed = false
            private referencedKeys = new Set<string>()
            private referencedKeyCounts: Map<string, number>
            constructor(view: EditorView) {
                const built = buildDecorations(view, options)
                this.decorations = built.decorations
                this.referencedKeys = built.referencedKeys
                this.referencedKeyCounts = referencedKeyCounts(analysisFor(view.state))
                this.unsubscribe = options.onIndexUpdated?.((change) => {
                    if (
                        !change.full &&
                        ![...change.changedConceptKeys].some((key) => this.referencedKeys.has(key))
                    ) {
                        return
                    }
                    // Deferred: the index can fire mid-update, and CM forbids re-entrant
                    // dispatches. The effect makes update() rebuild the decorations.
                    queueMicrotask(() => {
                        if (!this.destroyed) view.dispatch({ effects: refreshWikilinks.of(null) })
                    })
                })
            }
            update(update: ViewUpdate) {
                const refreshed = update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshWikilinks)))
                const analysis = analysisFor(update.state)
                if (update.docChanged && !refreshed && analysis.incremental) {
                    const change = analysis.incremental
                    const previous = update.startState.field(editorAnalysisField)
                    const withoutOldLine = this.decorations.update({
                        filterFrom: change.oldFrom,
                        filterTo: change.oldTo,
                        filter: () => false,
                    })
                    const additions = analysis.wikilinks
                        .filter(
                            (segment) =>
                                segment.start >= change.newFrom && segment.end <= change.newTo,
                        )
                        .map((segment) => decorationFor(segment, options))
                    this.decorations = withoutOldLine
                        .map(update.changes)
                        .update({ add: additions, sort: true })
                    for (const segment of previous.wikilinks) {
                        if (
                            segment.start < change.oldFrom ||
                            segment.end > change.oldTo
                        ) {
                            continue
                        }
                        const key = conceptKey(segment.wikilink.concept)
                        const next = (this.referencedKeyCounts.get(key) ?? 1) - 1
                        if (next > 0) this.referencedKeyCounts.set(key, next)
                        else this.referencedKeyCounts.delete(key)
                    }
                    for (const segment of analysis.wikilinks) {
                        if (
                            segment.start < change.newFrom ||
                            segment.end > change.newTo
                        ) {
                            continue
                        }
                        const key = conceptKey(segment.wikilink.concept)
                        this.referencedKeyCounts.set(
                            key,
                            (this.referencedKeyCounts.get(key) ?? 0) + 1,
                        )
                    }
                    this.referencedKeys = new Set(this.referencedKeyCounts.keys())
                } else if (update.docChanged || refreshed) {
                    const built = buildDecorations(update.view, options)
                    this.decorations = built.decorations
                    this.referencedKeys = built.referencedKeys
                    this.referencedKeyCounts = referencedKeyCounts(analysis)
                }
            }
            destroy() {
                this.destroyed = true
                this.unsubscribe?.()
            }
        },
        { decorations: (v) => v.decorations },
    )

    // A plain click on a link opens it — the one gesture that works on touch, where there is
    // no modifier to hold. Holding the mod key (Ctrl on Win/Linux, ⌘ on macOS) suppresses that,
    // leaving the click to place the caret (and to start a drag-selection) inside the link text,
    // which is how a link is retyped on a desktop; on touch the caret goes outside the link and
    // moves in. Taken on `mousedown` so the caret never moves first, and so the handler still
    // sees its own element: a click-bound handler can lose it to the decoration rebuild that the
    // caret landing on the line triggers.
    const clickHandler = EditorView.domEventHandlers({
        mousedown(event) {
            if (event.metaKey || event.ctrlKey || event.button !== 0) return false
            const el = (event.target as HTMLElement | null)?.closest('.cm-wikilink')
            const concept = el?.getAttribute('data-concept')
            if (!concept) return false
            event.preventDefault()
            options.onOpen?.(concept)
            return true
        },
    })

    const theme = EditorView.baseTheme({
        '.cm-wikilink': { color: 'var(--gk-accent, #007ACC)', textDecoration: 'underline' },
        // Missing target: link colour like any other wikilink, distinguished only by a
        // dashed underline, so it reads as "not yet a page" rather than an error/warning.
        '.cm-wikilink--missing': {
            textDecorationLine: 'underline',
            textDecorationStyle: 'dashed',
        },
    })
    // The context-menu handlers precede the click handler so a fired long-press swallows the
    // mousedown before it can open the link.
    return [plugin, contextMenuHandlers(options), clickHandler, episodePlugin(options), theme]
}
