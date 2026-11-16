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
import { bulletContent, isBulletLine } from '../../outliner'
import { editorDocument } from '../editor-document'
import { activeFoldMemory, foldFingerprint, type KeptFold } from './fold-memory'
import { bulletFoldRange, foldedBulletLines, foldOfBullet } from './outline-folds'
import { isProtectedDocumentFacet } from './protected-document'

/** The folds of `state` as they are kept: each folded bullet's line and fingerprint, in document order. */
export function keptFoldsOf(state: EditorState): KeptFold[] {
    return foldedBulletLines(state).map((line) => ({ line, fingerprint: foldFingerprint(bulletContent(state.doc.line(line).text)) }))
}

/**
 * The 1-based lines kept folds name in `state`: each at its line when that bullet still has the
 * fingerprint and children, or else at the nearest such bullet not already taken. One found nowhere
 * is left out.
 */
export function resolveKeptFolds(state: EditorState, kept: readonly KeptFold[]): number[] {
    const { doc } = state
    const prints = new Map<number, string>()
    const printOf = (line: number) => {
        let print = prints.get(line)
        if (print === undefined) prints.set(line, (print = foldFingerprint(bulletContent(doc.line(line).text))))
        return print
    }
    const fits = (line: number, fingerprint: string) =>
        line >= 1 && line <= doc.lines && isBulletLine(doc.line(line).text) && printOf(line) === fingerprint && bulletFoldRange(state, line) !== null
    const taken = new Set<number>()
    for (const fold of kept) {
        if (fits(fold.line, fold.fingerprint) && !taken.has(fold.line)) {
            taken.add(fold.line)
            continue
        }
        let best: number | null = null
        for (let line = 1; line <= doc.lines; line++) {
            if (taken.has(line) || !fits(line, fold.fingerprint)) continue
            if (best === null || Math.abs(line - fold.line) < Math.abs(best - fold.line)) best = line
        }
        if (best !== null) taken.add(best)
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
