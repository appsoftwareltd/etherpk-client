/**
 * Which fences an interactive fence widget draws over (`interactive-fence-contract.ts`), and when its
 * text is shown instead: while any selection range touches the fence, boundaries included, as a
 * rendered fence's is (range-kind reveal, reveal-policy.ts; ADR 0022). The caret on one of its lines,
 * a selection reaching into it, **Edit as text** (which puts the caret on its first body line) and an
 * undo that puts the caret back inside all show its text, and the widget is drawn again once no
 * selection touches the fence. The caret at the end of the line above it, or at the start of the
 * line below, leaves it drawn.
 *
 * Kept apart from the widget host (`interactive-fence.ts`) so the code panel, the content clamp
 * and the code scroll bar can ask "is this fence drawn as a widget?" through
 * `rendered-common.ts`, as they do for a collapsed rendered fence, without importing the host.
 *
 * A fence is drawn as a widget when it is complete and outermost (a fence shown as an example
 * inside another is code) and its info word has a registered widget. One opened on a bullet's line
 * (`- ```map`, form 1) is drawn after the bullet's marker, which stays text, as a rendered fence is
 * there. Nothing is drawn in a [[Protected Document]] (ADR 0118): a Map Block there is ordinary text.
 */
import { type EditorState, MapMode, StateField } from '@codemirror/state'

import { analysisFor } from '../analysis/editor-analysis'
import { type RenderableFence } from './fence-render-core'
import { fenceRegistrationsChanged, type InteractiveFence, lookupInteractiveFence } from './interactive-fence-contract'
import { isProtectedDocumentFacet } from './protected-document'
import { rangeRevealed } from './reveal-policy'

/** A fence an interactive widget draws over, where it sits and what it holds. */
export interface InteractiveFenceRange extends RenderableFence {
    fence: InteractiveFence
    /** How many fences with the same info word come before it in the document. */
    ordinal: number
    /** The body's lines, less the indentation up to the fence column. Empty for an empty fence. */
    body: string[]
    /**
     * Document offsets of the whole block: the opener line's start and the closer line's end. A form-1
     * fence's block starts at its bullet's line, marker included, so a caret anywhere on that line
     * shows its text.
     */
    blockFrom: number
    blockTo: number
}

/** Read once per state: the field, the decorations and the keys all ask in one transaction. */
const fencesByState = new WeakMap<EditorState, InteractiveFenceRange[]>()

/** Every interactive fence in the document, shown as text or not. */
export function interactiveFences(state: EditorState): InteractiveFenceRange[] {
    let fences = fencesByState.get(state)
    if (!fences) {
        fences = findInteractiveFences(state)
        fencesByState.set(state, fences)
    }
    return fences
}

function findInteractiveFences(state: EditorState): InteractiveFenceRange[] {
    if (state.facet(isProtectedDocumentFacet)()) return []
    const out: InteractiveFenceRange[] = []
    const ordinals = new Map<string, number>()
    for (const f of analysisFor(state).renderableFences) {
        const fence = lookupInteractiveFence(f.info)
        if (!fence) continue
        const ordinal = ordinals.get(f.info) ?? 0
        ordinals.set(f.info, ordinal + 1)
        out.push({
            ...f,
            fence,
            ordinal,
            body: f.end - f.start > 1 ? f.source.split('\n') : [],
            blockFrom: state.doc.line(f.start + 1).from,
            blockTo: state.doc.line(f.end + 1).to,
        })
    }
    return out
}

/** The interactive fences drawn as their widget: every one no selection range touches (range-kind reveal). */
export function collapsedInteractiveFences(state: EditorState): InteractiveFenceRange[] {
    return interactiveFences(state).filter((f) => !rangeRevealed(state, f.blockFrom, f.blockTo))
}

interface FenceIdentity {
    /** Each fence's id, by its opener line's start. */
    readonly ids: ReadonlyMap<number, number>
    /** The id the next new fence is given. */
    readonly next: number
}

/** A fence an edit removed, with what it said, whose id a fence with the same text may take. */
interface RemovedFence {
    id: number
    info: string
    body: readonly string[]
}

/** A fence's text as one key: its info word and its body. */
function fenceText(fence: { info: string; body: readonly string[] }): string {
    return [fence.info, ...fence.body].join('\n')
}

/**
 * Give every fence in `fences` the id `ids` holds for its opener, or failing that the id of the
 * fence the same edit removed with exactly its text, or a new one. An edit that rewrites the lines
 * it moves (the outliner's Alt+Arrow) removes the fence and writes it again, and the fence it wrote
 * is the same map, moved; a different text is a different map. The id passes only when the text
 * names one removed fence and one written fence: two identical maps rewritten together (every map
 * `/map` makes starts empty) cannot be told apart, and handing each the other's id would hand it
 * the other's live widget, so both are given new ones.
 */
function identify(ids: ReadonlyMap<number, number>, next: number, fences: readonly InteractiveFenceRange[], removed: readonly RemovedFence[] = []): FenceIdentity {
    const removedByText = new Map<string, RemovedFence[]>()
    for (const r of removed) removedByText.set(fenceText(r), [...(removedByText.get(fenceText(r)) ?? []), r])
    const unkeyedByText = new Map<string, number>()
    for (const fence of fences) {
        if (!ids.has(fence.blockFrom)) unkeyedByText.set(fenceText(fence), (unkeyedByText.get(fenceText(fence)) ?? 0) + 1)
    }
    const kept = new Map<number, number>()
    for (const fence of fences) {
        let id = ids.get(fence.blockFrom)
        if (id === undefined) {
            const text = fenceText(fence)
            const same = removedByText.get(text)
            if (same?.length === 1 && unkeyedByText.get(text) === 1) id = same[0].id
        }
        kept.set(fence.blockFrom, id ?? next++)
    }
    return { ids: kept, next }
}

/**
 * Each interactive fence's identity: a number it keeps for as long as it exists, whatever is edited
 * around it or inside it. The host tells widgets apart by it, so CodeMirror can never hand one
 * map's live widget to another map when it redraws, and an edit a widget asks for late (after its
 * DOM was taken down) reaches its own fence or none. A fence that gets a new id has its widget
 * mounted again, losing what the widget held (a map's view, its selection, a place half added).
 *
 * Kept by the opener line's start, and carried through each change by the opener's first backtick
 * (`MapMode.TrackAfter`, `assoc` 1), then read back as the start of the line the backtick is on.
 * Indenting or outdenting the fence's bullet adds or removes spaces before the backtick and keeps
 * the id, lines inserted above it move it, and once the backtick itself is deleted the id is
 * dropped, so a deleted fence's id never passes to the fence that slides into its place. A fence
 * the same edit writes again with exactly the removed one's text takes its id (`identify`).
 */
export const fenceIdentity = StateField.define<FenceIdentity>({
    create: (state) => identify(new Map(), 1, interactiveFences(state)),
    update(value, tr) {
        // A widget registered or withdrawn adds or takes away fences with no edit (ADR 0121).
        if (!tr.docChanged && !tr.reconfigured && !tr.effects.some((e) => e.is(fenceRegistrationsChanged))) return value
        let ids = value.ids
        const removed: RemovedFence[] = []
        if (tr.docChanged) {
            const before = interactiveFences(tr.startState)
            const mapped = new Map<number, number>()
            for (const [pos, id] of value.ids) {
                const fence = before.find((f) => f.blockFrom === pos)
                const to = tr.changes.mapPos(pos + (fence?.fenceColumn ?? 0), 1, MapMode.TrackAfter)
                if (to !== null) mapped.set(tr.newDoc.lineAt(to).from, id)
                else if (fence) removed.push({ id, info: fence.info, body: fence.body })
            }
            ids = mapped
        }
        return identify(ids, value.next, interactiveFences(tr.state), removed)
    },
})

/** A fence's id, or null for a position that opens no interactive fence. */
export function fenceIdAt(state: EditorState, blockFrom: number): number | null {
    return state.field(fenceIdentity, false)?.ids.get(blockFrom) ?? null
}

/** The interactive fence with this id, or null once it is gone. */
export function fenceById(state: EditorState, id: number): InteractiveFenceRange | null {
    const ids = state.field(fenceIdentity, false)?.ids
    if (!ids) return null
    for (const [blockFrom, fenceId] of ids) {
        if (fenceId === id) return interactiveFences(state).find((fence) => fence.blockFrom === blockFrom) ?? null
    }
    return null
}
