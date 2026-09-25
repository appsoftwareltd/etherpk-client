/**
 * The CodeMirror → store translation (sequential-text-changes.ts): a transaction's changes, handed to
 * `EditorDocument.applyChange` one at a time, must leave a store holding what the editor shows.
 *
 * The store modelled here is the splice every real one performs (filesystem-store.ts,
 * in-memory-store.ts, draft.ts): each change applied to the text the previous ones left. The
 * oracle is CodeMirror's own `tr.newDoc`. The multi-change transactions an author actually makes
 * are the wrap keys' and the format toggles' (Editor Content Rules → Wrapping a selection, ADR
 * 0077), so those are driven through the real `wrapSelectionOnInput` / `toggleMarkSpec` specs over
 * the headless fixture, exactly as the live input handler and keymap dispatch them. The last
 * block drives the real Filesystem store over the memory adapter: the file, and a fresh open of
 * it, read as the editor showed.
 */

import { ChangeSet, EditorSelection, EditorState, Text, type TransactionSpec } from '@codemirror/state'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createFilesystemDocumentStore } from '../../storage/fs/filesystem-store'
import { createMemoryDirectoryAdapter } from '../../storage/fs/memory-adapter'

import type { TextChange } from '../types'
import { sequentialTextChanges } from './sequential-text-changes'
import { type EditorFixtureOptions, type HeadlessEditor, editorFixture } from './testing/editor-state-fixture'
import { toggleMarkSpec } from './wrap-selection'

/** What every store does with one change: a splice of the text as it stands. */
function splice(text: string, change: TextChange): string {
    return text.slice(0, change.from) + change.insert + text.slice(change.to)
}

/**
 * A headless editor whose every transaction also reaches a store, one change at a time, the way
 * `cm-document.ts` forwards them. The fixture's own `type()` and `dispatch` are used unchanged and
 * the store listens through a wrapped `dispatch`, so a change to the live wrap decision reaches
 * this suite too.
 */
class EditorWithStore {
    readonly editor: HeadlessEditor
    /** The modelled store: a string spliced once per forwarded change. */
    store: string

    constructor(fixture: string, options: EditorFixtureOptions & { sink?: (change: TextChange) => void } = {}) {
        const { sink = (change) => (this.store = splice(this.store, change)), ...fixtureOptions } = options
        this.editor = editorFixture(fixture, fixtureOptions)
        this.store = this.editor.text()
        const apply = this.editor.dispatch
        this.editor.dispatch = (tr) => {
            for (const change of sequentialTextChanges(tr.changes)) sink(change)
            apply(tr)
        }
    }

    dispatch(spec: TransactionSpec): void {
        this.editor.dispatch(this.editor.state.update(spec))
    }

    /** Type over the selection the way the live input handler sees it (the fixture's `type()`). */
    type(text: string): void {
        this.editor.type(text)
    }

    /** Select `words` where they occur in the text. A selection changes nothing, so nothing is forwarded. */
    selectWords(words: string): void {
        const from = this.editor.text().indexOf(words)
        if (from < 0) throw new Error(`"${words}" is not in the document`)
        this.dispatch({ selection: EditorSelection.single(from, from + words.length) })
    }

    text(): string {
        return this.editor.text()
    }
}

const REPORTED = '# How Desktop CRM, Lighthouse, the AC Database and the Superset Schema fit together'
const LINKED = '# How [[Desktop CRM]], Lighthouse, the [[AC Database]] and the [[Superset Schema]] fit together'

/** Make each of `names` a wikilink the wrap-key way: select it, press `[` twice. */
function linkEach(h: EditorWithStore, names: string[]): void {
    for (const name of names) {
        h.selectWords(name)
        h.type('[')
        h.type('[')
    }
}

describe('sequentialTextChanges: each change against the text the ones before it leave', () => {
    it('forwards a single change as CodeMirror reports it', () => {
        const set = ChangeSet.of({ from: 2, to: 4, insert: 'xy' }, 10)
        expect(sequentialTextChanges(set)).toEqual([{ from: 2, to: 4, insert: 'xy' }])
    })

    it('wrapping a selection in [[ ]] reaches the store as the editor shows it', () => {
        // Found live on 2026-09-22 on a Filesystem graph. The wrap is one transaction of two
        // changes (`[` before the selection, `]` after it), and both were forwarded in
        // pre-transaction offsets, so the store spliced the `]` one character early once the `[`
        // had shifted the text. Each press compounded the last: `[[Desktop CR]]M` on disk, and a
        // pageless "Desktop CR" in the index.
        const h = new EditorWithStore(`# How «Desktop CRM», ${REPORTED.slice('# How Desktop CRM, '.length)}`)
        h.type('[')
        expect(h.store).toBe('# How [Desktop CRM], Lighthouse, the AC Database and the Superset Schema fit together')
        h.type('[')
        expect(h.store).toBe('# How [[Desktop CRM]], Lighthouse, the AC Database and the Superset Schema fit together')
        linkEach(h, ['AC Database', 'Superset Schema'])
        expect(h.store).toBe(LINKED)
        expect(h.store).toBe(h.text())
    })

    it.each([
        ['prose', 'How «Desktop CRM» fits together', 'How [[Desktop CRM]] fits together'],
        ['a heading', '## How «Desktop CRM» fits together', '## How [[Desktop CRM]] fits together'],
        ['an outliner block', '- How «Desktop CRM» fits together', '- How [[Desktop CRM]] fits together'],
        ['a nested block', '- parent\n  - How «Desktop CRM» fits', '- parent\n  - How [[Desktop CRM]] fits'],
        ['a task', '- [ ] How «Desktop CRM» fits', '- [ ] How [[Desktop CRM]] fits'],
        ['a line after a fence', '```\ncode\n```\nHow «Desktop CRM» fits', '```\ncode\n```\nHow [[Desktop CRM]] fits'],
    ])('holds in %s', (_, before, after) => {
        const h = new EditorWithStore(before)
        h.type('[')
        h.type('[')
        expect(h.store).toBe(after)
        expect(h.store).toBe(h.text())
    })

    it('a format toggle takes its two markers off, and puts them back, where the editor did', () => {
        const h = new EditorWithStore('- the **«fox»** jumped')
        h.dispatch(toggleMarkSpec(h.editor.state, '**')!)
        expect(h.text()).toBe('- the fox jumped')
        expect(h.store).toBe(h.text())
        h.dispatch(toggleMarkSpec(h.editor.state, '**')!)
        expect(h.text()).toBe('- the **fox** jumped')
        expect(h.store).toBe(h.text())
    })

    it('a multi-caret edit lands in every range', () => {
        const h = new EditorWithStore('- a|\n- b\n- c', {
            extensions: [EditorState.allowMultipleSelections.of(true)],
            withoutFilters: true,
        })
        h.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(3), EditorSelection.cursor(7), EditorSelection.cursor(11)]) })
        h.dispatch(h.editor.state.replaceSelection('x'))
        expect(h.text()).toBe('- ax\n- bx\n- cx')
        expect(h.store).toBe(h.text())
    })

    it('mixed deletions and insertions, given out of order, apply as one change set', () => {
        const doc = 'one two three four'
        const set = ChangeSet.of(
            [
                { from: 14, to: 18, insert: '4' },
                { from: 0, to: 3, insert: '1' },
                { from: 8, insert: 'X' },
            ],
            doc.length,
        )
        let text = doc
        for (const change of sequentialTextChanges(set)) text = splice(text, change)
        expect(text).toBe('1 two Xthree 4')
        expect(text).toBe(set.apply(Text.of([doc])).toString())
    })

    it('any change set, applied one change at a time, is what CodeMirror applied at once', () => {
        const unit = fc.constantFrom('a', 'b', ' ', '\n', '[', ']', '-', 'é')
        const docAndChanges = fc
            .tuple(
                fc.string({ unit, maxLength: 40 }),
                fc.array(fc.tuple(fc.nat({ max: 60 }), fc.nat({ max: 60 }), fc.string({ unit, maxLength: 6 })), { maxLength: 6 }),
            )
            .map(([doc, raw]) => {
                // Non-overlapping ranges in document order: what one transaction can hold. Adjacent
                // ranges, empty ranges and empty inserts are all kept, since CodeMirror allows them.
                const sorted = raw
                    .map(([a, b, insert]) => {
                        const from = a % (doc.length + 1)
                        const to = from + (b % (doc.length - from + 1))
                        return { from, to, insert }
                    })
                    .sort((x, y) => x.from - y.from)
                const specs: { from: number; to: number; insert: string }[] = []
                let end = 0
                for (const spec of sorted) {
                    if (spec.from < end) continue
                    specs.push(spec)
                    end = spec.to
                }
                return { doc, specs }
            })
        fc.assert(
            fc.property(docAndChanges, ({ doc, specs }) => {
                const set = ChangeSet.of(specs, doc.length)
                let text = doc
                for (const change of sequentialTextChanges(set)) text = splice(text, change)
                expect(text).toBe(set.apply(Text.of(doc.split('\n'))).toString())
            }),
            { numRuns: 400 },
        )
    })
})

describe('sequentialTextChanges through a Filesystem store', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    function clock(start = 1000) {
        let t = start
        return () => (t += 1000)
    }

    /** Let the open()-time async hydration read resolve. */
    async function flushMicrotasks() {
        await Promise.resolve()
        await Promise.resolve()
    }

    it('the wikilinks reach the file, and a fresh open of it, as the editor showed them', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'Fit Together.md': REPORTED } } })
        const store = createFilesystemDocumentStore(fs, { autosaveMs: 400 })
        await store.scan()
        const doc = store.open('Fit Together')
        await flushMicrotasks()
        expect(doc.getText()).toBe(REPORTED)

        // The editor seeds from the store and pushes every change through `applyChange`, as DocumentView does.
        const h = new EditorWithStore(`|${doc.getText()}`, { sink: (change) => doc.applyChange(change) })
        linkEach(h, ['Desktop CRM', 'AC Database', 'Superset Schema'])
        expect(h.text()).toBe(LINKED)
        expect(doc.getText()).toBe(LINKED)

        await vi.advanceTimersByTimeAsync(400)
        expect((await fs.read('pages', 'Fit Together.md')).text).toBe(LINKED)

        // Close and reopen: a store over the same folder hydrates from the file.
        const reopened = createFilesystemDocumentStore(fs)
        await reopened.scan()
        const again = reopened.open('Fit Together')
        await flushMicrotasks()
        expect(again.getText()).toBe(LINKED)
    })
})
