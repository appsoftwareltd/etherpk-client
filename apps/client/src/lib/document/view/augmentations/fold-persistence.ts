/**
 * Augmentation: an editor's [[Fold]]s kept on the device and put back when the document opens again
 * (ADR 0191; fold-memory.ts keeps them). Two editors of one document in the tab share them: a fold
 * made in one pane shows in the other at once.
 *
 * The folds are put back once the document has its text, which can arrive after the editor is made
 * (a synced document fills from the sync), and before the person has folded anything here: from then
 * on this editor's folds are the ones kept. A [[Protected Document]]'s folds are never kept, and any
 * kept before it was protected are forgotten.
 */

import { foldedRanges, foldEffect, unfoldEffect } from '@codemirror/language'
import type { EditorState, Extension, StateEffect } from '@codemirror/state'
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

import { conceptKey } from '../../backlinks/backlink-index'
import { bulletContent } from '../../outliner'
import { analysisFor } from '../analysis/editor-analysis'
import { editorDocument } from '../editor-document'
import { activeFoldMemory, foldFingerprint, foldPath, type KeptFold } from './fold-memory'
import { bulletFoldRange, foldedBulletLines, foldOfBullet } from './outline-folds'
import { isProtectedDocumentFacet } from './protected-document'

/**
 * Every foldable bullet's fingerprint in `state`, by 1-based line, in document order: over its own
 * words and those of each bullet above it in the outline, so a "Comments" under one task is not the
 * "Comments" under another, nor a bullet its parent of the same name.
 */
function foldablePrints(state: EditorState): Map<number, string> {
    const { lines, branchEnds } = analysisFor(state)
    const out = new Map<number, string>()
    /** The bullets the current line is under: each one's indent and words, outermost first. */
    const above: { indent: number; words: string }[] = []
    for (let i = 0; i < lines.length; i++) {
        if (branchEnds[i] < 0) continue // not a bullet: a soft line, code, prose
        const indent = lines[i].length - lines[i].trimStart().length
        while (above.length && above[above.length - 1].indent >= indent) above.pop()
        above.push({ indent, words: bulletContent(lines[i]) })
        if (bulletFoldRange(state, i + 1)) out.set(i + 1, foldFingerprint(foldPath(above.map((a) => a.words))))
    }
    return out
}

/** The lines of the bullets with each fingerprint, in document order. */
function linesByPrint(prints: Map<number, string>): Map<string, number[]> {
    const out = new Map<string, number[]>()
    for (const [line, print] of prints) out.set(print, [...(out.get(print) ?? []), line])
    return out
}

/** The folds of `state` as they are kept: each folded bullet's line, fingerprint and place among its like, in document order. */
export function keptFoldsOf(state: EditorState): KeptFold[] {
    const prints = foldablePrints(state)
    const byPrint = linesByPrint(prints)
    return [...foldedBulletLines(state)]
        .sort((a, b) => a - b)
        .flatMap((line) => {
            const fingerprint = prints.get(line)
            return fingerprint === undefined ? [] : [{ line, fingerprint, nth: byPrint.get(fingerprint)!.indexOf(line) }]
        })
}

/**
 * The 1-based lines kept folds name in `state`. A fold is looked for among the foldable bullets
 * with its fingerprint: the one at its line when that is also its place among them, or else the one
 * at its place among them (lines added above move a bullet's line, not its place), or else the
 * nearest to its line. One found nowhere is left out.
 */
export function resolveKeptFolds(state: EditorState, kept: readonly KeptFold[]): number[] {
    const byPrint = linesByPrint(foldablePrints(state))
    const taken = new Set<number>()
    for (const fold of kept) {
        const like = (byPrint.get(fold.fingerprint) ?? []).filter((line) => !taken.has(line))
        if (like.length === 0) continue
        const all = byPrint.get(fold.fingerprint)!
        const atPlace = all[fold.nth]
        const best = atPlace !== undefined && !taken.has(atPlace) ? atPlace : like.reduce((a, b) => (Math.abs(b - fold.line) < Math.abs(a - fold.line) ? b : a))
        taken.add(best)
    }
    return [...taken].sort((a, b) => a - b)
}

/** The effects that make `state`'s folds exactly the bullets on `lines`. */
export function foldsToEffects(state: EditorState, lines: readonly number[]): StateEffect<unknown>[] {
    const want = new Set(lines)
    const effects: StateEffect<unknown>[] = []
    for (const line of foldedBulletLines(state)) {
        if (want.has(line)) continue
        const fold = foldOfBullet(state, line)
        if (fold) effects.push(unfoldEffect.of(fold))
    }
    for (const line of want) {
        if (foldOfBullet(state, line)) continue
        const range = bulletFoldRange(state, line)
        if (range) effects.push(foldEffect.of(range))
    }
    return effects
}

const isProtected = (state: EditorState) => state.facet(isProtectedDocumentFacet)()

const persistence = ViewPlugin.fromClass(
    class {
        /** The document's key in the memory, or null outside a document (nothing is kept). */
        private readonly key: string | null
        /** Whether the kept folds have been put back, or the person has folded here first. */
        private settled = false
        private readonly unsubscribe: () => void
        private destroyed = false

        constructor(readonly view: EditorView) {
            const doc = view.state.facet(editorDocument)
            this.key = doc ? conceptKey(doc.concept) : null
            this.unsubscribe = this.key ? activeFoldMemory().subscribe(this.key, (source) => source !== this && this.follow()) : () => {}
            this.restore()
        }

        update(update: ViewUpdate) {
            if (!this.key) return
            const foldsChanged = foldedRanges(update.startState) !== foldedRanges(update.state)
            if (!this.settled) {
                // The person folded before the kept folds could be put back: theirs stand.
                if (foldsChanged && update.transactions.some((tr) => tr.isUserEvent('fold'))) this.settled = true
                else if (update.docChanged) this.restore()
                if (!this.settled) return
            }
            if (foldsChanged || (update.docChanged && foldedRanges(update.state).size > 0)) this.save()
        }

        /** Put the kept folds back, once the document has text. */
        private restore() {
            if (!this.key || this.settled || this.view.state.doc.length === 0) return
            this.settled = true
            if (isProtected(this.view.state)) {
                activeFoldMemory().set(this.key, [], this)
                return
            }
            this.apply()
        }

        /** Another editor of the document changed its folds. */
        private follow() {
            if (this.settled) this.apply()
        }

        /** Make this editor's folds the kept ones, after the update in progress. */
        private apply() {
            const key = this.key
            if (!key) return
            queueMicrotask(() => {
                if (this.destroyed || isProtected(this.view.state)) return
                const lines = resolveKeptFolds(this.view.state, activeFoldMemory().get(key))
                const effects = foldsToEffects(this.view.state, lines)
                if (effects.length) this.view.dispatch({ effects })
            })
        }

        private save() {
            if (!this.key) return
            const kept = isProtected(this.view.state) ? [] : keptFoldsOf(this.view.state)
            activeFoldMemory().set(this.key, kept, this)
        }

        destroy() {
            this.destroyed = true
            this.unsubscribe()
        }
    },
)

/** Keep this editor's folds on the device (fold-memory.ts). Needs `editorDocument` to know which document. */
export function foldPersistence(): Extension {
    return persistence
}
