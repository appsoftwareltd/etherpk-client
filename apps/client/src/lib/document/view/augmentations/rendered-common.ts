/**
 * Shared machinery for the rendered-augmentation hosts (ADR 0022), split out of
 * fence-render.ts so code-highlight.ts and content-clamp.ts can consult the SAME
 * collapse predicate without an import cycle (fence-render imports hangWidthForPos
 * FROM content-clamp):
 *
 * - {@link rendererCollapsedFences} — the one definition of "this fence is currently a
 *   collapsed rendered widget", shared by the widget builder, the code panel, and the
 *   clamp so they can never disagree.
 * - {@link themeTick} / {@link renderedThemePlugin} — ONE window listener for the app
 *   theme change, re-dispatched as a StateEffect both hosts' fields rebuild on.
 * - {@link renderFailed} / {@link markRenderFailed} — a hard render failure must drop
 *   the replace decoration IMMEDIATELY (the raw source is the fallback, ADR 0022); the
 *   effect is the rebuild trigger, the bounded key set is the memory.
 * - {@link fenceRenderResults} / {@link renderedSizes} / the failure set - the host's three
 *   caches, and {@link clearRenderCaches} to empty them in one call. A lock on a
 *   [[Protected Document]] promises that no plaintext for protected content is left on the
 *   device (ADR 0058), and rendered output is plaintext: the results hold the diagram DOM, so
 *   the composition root clears them when the key goes (and on graph close). The keys that
 *   outlive a document carry a hash of the source, never the source.
 */

import { type EditorState, Facet, StateEffect } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'

import { THEME_CHANGE_EVENT } from '@appsoftwareltd/etherpk-shared/theme'

import { type RenderableFence } from './fence-render-core'
import { rangeRevealed } from './reveal-policy'
import { type AugmentationRenderer, lookupAugmentationRenderer } from './renderers/contract'
import { analysisFor } from '../analysis/editor-analysis'

/** Dispatched when the app theme flips — rendered widgets carry `dark` in `eq`, so a rebuild re-creates them. */
export const themeTick = StateEffect.define<null>()

/** Dispatched when a render rejected hard — the next build drops the replace so raw source shows. */
export const renderFailed = StateEffect.define<null>()

/**
 * Dispatched by the fence render coordinator when an async render lands (success or error).
 * Rendering happens OUTSIDE the widgets: a widget's toDOM is synchronous over the stored
 * result, so every height change rides a real decoration redraw — CodeMirror ignores DOM
 * mutations inside widget subtrees, so an in-place async swap would leave its height map
 * stale and clicks below the widget landing on the wrong block.
 */
export const renderCompleted = StateEffect.define<null>()

/**
 * Which editor a render result belongs to. `fenceRenderAugmentation()` mints a fresh owner per
 * call (one per mounted editor) and provides it here, so two panes holding the same info-string
 * on the same line never share an entry - before this, every transaction in one pane swept the
 * other's results and a click into one fence reparented the other pane's diagram under it. The
 * default is 0, an owner nothing ever stores under, so a state without the augmentation finds
 * no results and collapses nothing.
 */
export const renderOwner = Facet.define<number, number>({
    combine: (values) => (values.length ? values[values.length - 1] : 0),
})

/** One fence's latest render outcome, owned by the coordinator in fence-render.ts. */
export interface FenceRenderResult {
    /** The editor this result belongs to ({@link renderOwner}); a coordinator touches only its own. */
    owner: number
    source: string
    dark: boolean
    /** Bumped on every completed render — widgets carry it in eq so a completion redraws. */
    version: number
    node: HTMLElement | null
    error: string | null
    pending: ReturnType<typeof setTimeout> | null
    /** Monotonic per-entry request id — a stale completion must never land. */
    reqSeq: number
}

/**
 * Per-fence render results, keyed by {@link fenceResultKey}. Module-level so it survives the
 * decoration rebuilds that happen on every transaction; the entries are owned per editor, so a
 * coordinator's destroy() removes its own, and a lock drops every pane's rendered nodes and
 * the leftovers of panes no longer mounted ({@link clearRenderCaches}).
 */
export const fenceRenderResults = new Map<string, FenceRenderResult>()

/** Identity of a fence for render-result storage: owner + info + opener line (stable enough; an
 *  edit above the fence shifts it to a fresh key and the orphan is swept by its coordinator). */
export function fenceResultKey(owner: number, info: string, startLine: number): string {
    return `${owner}:${info}:${startLine}`
}

/**
 * Last rendered heights (px) keyed by {@link renderKey}, so a re-created widget can reserve its
 * space before the first render lands (no page jump) - the imageSizes pattern. Shared by every
 * editor: the same artefact has the same height wherever it is drawn.
 */
export const renderedSizes = new Map<string, number>()

/** The resolved app theme right now (theme.ts stamps the root element). */
export function isDark(): boolean {
    // State fields build during EditorState.create, which the Node test tier does without a DOM.
    return typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark'
}

/**
 * cyrb53: a cheap, non-cryptographic 53-bit string hash (two Math.imul mixing lanes). Enough to
 * keep the size and failure caches from confusing two artefacts in practice, and a collision
 * costs a wrong height reservation or a skipped collapse, never a wrong render - which is why
 * the mermaid SVG cache keeps its exact-source key and this one does not need to.
 */
function hashSource(text: string): string {
    let h1 = 0xdeadbeef
    let h2 = 0x41c6ce57
    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i)
        h1 = Math.imul(h1 ^ ch, 2654435761)
        h2 = Math.imul(h2 ^ ch, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/**
 * Key for the failure memory and size caches: one rendered artefact. The source goes in hashed:
 * these two caches outlive the document they were filled from, and a locked Protected Document
 * must leave no plaintext behind (ADR 0058) - not even TeX or diagram labels inside a map key.
 */
export function renderKey(info: string, source: string, dark: boolean): string {
    return `${info}|${dark}|${hashSource(source)}`
}

const FAILED_MAX = 64
const failed = new Set<string>()

/** Remember a hard render failure so the build stops collapsing this source (raw-source fallback). */
export function markRenderFailed(key: string): void {
    failed.delete(key)
    failed.add(key)
    if (failed.size > FAILED_MAX) failed.delete(failed.values().next().value!)
}

export function hasRenderFailed(key: string): boolean {
    return failed.has(key)
}

/** What {@link clearRenderCaches} needs of a live coordinator (fence-render.ts). */
export interface LiveRenderCoordinator {
    readonly owner: number
    /** Drop every rendered node this pane holds and render the pane's fences again. */
    refresh(): void
}

/**
 * The live render coordinators (one per mounted editor), so {@link clearRenderCaches} can ask
 * each to render again what it still shows. Without that, an unprotected diagram in another
 * pane would keep its DOM until the next transaction there, then redraw as an empty placeholder
 * with no reserved height and jump when the render landed. Asked straight away, and with the
 * entry's version carried across, the old widget stays on screen until the fresh result redraws
 * it in place.
 */
const liveCoordinators = new Set<LiveRenderCoordinator>()

/** Register a live coordinator; the returned function forgets it (call from destroy()). */
export function trackRenderCoordinator(coordinator: LiveRenderCoordinator): () => void {
    liveCoordinators.add(coordinator)
    return () => liveCoordinators.delete(coordinator)
}

/** How much each host cache holds - for the dev introspection hook and the tests. */
export function renderCacheSizes(): { results: number; sizes: number; failed: number } {
    return { results: fenceRenderResults.size, sizes: renderedSizes.size, failed: failed.size }
}

/**
 * Empty the host caches: every pending render is cancelled, the results of panes no longer
 * mounted are deleted, the sizes and the failure set are cleared, and each mounted pane drops
 * its rendered nodes and renders again. Called by the composition root when the Protection Key
 * is discarded and when the renderers detach on graph close.
 *
 * Entries of a pane that is still mounted are not deleted here but handed to that pane's
 * `refresh()`, which drops their rendered nodes and renders them again: keeping the entry keeps
 * its version, so a rebuild that lands before the fresh result still builds a widget equal to
 * the one on screen and CodeMirror leaves that DOM alone - no blank, no jump. After a lock those
 * panes show only unprotected content, because the relock has already swapped the ciphertext
 * into every protected editor and their coordinators swept the plaintext entries as it did.
 * Everything else - a closed pane's leftovers, an entry whose editor never mounted - goes.
 * A render already in flight for a swept or deleted entry finds it gone and drops out (the
 * coordinator checks the map before it lands), so nothing comes back.
 */
export function clearRenderCaches(): void {
    const live = new Set([...liveCoordinators].map((c) => c.owner))
    for (const [key, entry] of fenceRenderResults) {
        if (entry.pending !== null) clearTimeout(entry.pending)
        entry.pending = null
        if (!live.has(entry.owner)) fenceRenderResults.delete(key)
    }
    renderedSizes.clear()
    failed.clear()
    for (const coordinator of liveCoordinators) coordinator.refresh()
}

export interface DispatchedFence extends RenderableFence {
    renderer: AugmentationRenderer
    /** Document offsets of the whole block (opening fence start … closing fence end). */
    blockFrom: number
    blockTo: number
    /** Any selection range touches the block (touch-inclusive) — the reveal predicate. */
    revealed: boolean
}

/** The complete info-fences whose info-string resolves to a registered renderer, with reveal state. */
export function rendererDispatchedFences(state: EditorState): DispatchedFence[] {
    const out: DispatchedFence[] = []
    for (const f of analysisFor(state).renderableFences) {
        const renderer = lookupAugmentationRenderer(f.info)
        if (!renderer) continue
        const blockFrom = state.doc.line(f.start + 1).from
        const blockTo = state.doc.line(f.end + 1).to
        const revealed = rangeRevealed(state, blockFrom, blockTo) // range-kind reveal (reveal-policy.ts)
        out.push({ ...f, renderer, blockFrom, blockTo, revealed })
    }
    return out
}

/** The fences currently shown as a collapsed rendered widget: not revealed, and not a failed
 *  `flip` render (a flip renderer's hard failure falls back to raw source — ADR 0022). */
export function rendererCollapsedFences(state: EditorState): DispatchedFence[] {
    const owner = state.facet(renderOwner)
    return rendererDispatchedFences(state).filter((f) => {
        if (f.revealed) return false
        const entry = fenceRenderResults.get(fenceResultKey(owner, f.info, f.start))
        const flipFailed =
            f.renderer.editing === 'flip' && entry !== undefined && entry.source === f.source && entry.error !== null
        return !flipFailed
    })
}

/** 0-based opener line indices of the collapsed fences — the cheap membership test for the panel/clamp skips. */
export function rendererCollapsedStarts(state: EditorState): Set<number> {
    return new Set(rendererCollapsedFences(state).map((f) => f.start))
}

/**
 * The single theme listener: forwards the app's THEME_CHANGE_EVENT into the editor as a
 * {@link themeTick} effect. Mounted once (by fenceRenderAugmentation); the window listener
 * is removed in destroy().
 */
export function renderedThemePlugin() {
    return ViewPlugin.fromClass(
        class {
            private readonly onTheme: () => void
            constructor(view: EditorView) {
                this.onTheme = () => view.dispatch({ effects: themeTick.of(null) })
                window.addEventListener(THEME_CHANGE_EVENT, this.onTheme)
            }
            destroy() {
                window.removeEventListener(THEME_CHANGE_EVENT, this.onTheme)
            }
        },
    )
}
