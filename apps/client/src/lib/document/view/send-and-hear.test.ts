/**
 * An editor's own changes going out and the store's text coming in (send-and-hear.ts), over the real
 * in-memory store with two editors on one document.
 */

import { describe, expect, it } from 'vitest'

import { createInMemoryDocumentStore } from '../in-memory-store'
import type { TextChange } from '../types'
import { createSendAndHear } from './send-and-hear'

describe('an editor sending its changes and hearing the store', () => {
    it('applies text it hears at once while it is not sending', () => {
        const shown: string[] = []
        const editor = createSendAndHear((text) => shown.push(text), () => 'unused')
        editor.hear('from another editor')
        expect(shown).toEqual(['from another editor'])
    })

    it('ends showing what the store holds when another editor writes while it is still sending', () => {
        const store = createInMemoryDocumentStore({ Doc: '- Parent\n  first\n  second\n- Next' })
        const doc = store.open('Doc')
        // Editor A's buffer already shows its whole transaction, as CodeMirror's does when the
        // listener that sends it runs: "  first" removed, then "!" typed at the end.
        let shownByA = '- Parent\n  second\n- Next!'
        const a = createSendAndHear((text) => (shownByA = text), () => doc.getText())
        const hearA = (text: string) => a.hear(text)
        doc.subscribe(hearA)
        // Editor B writes back the first time it hears A, as a held reveal's tidy once did.
        let wrote = false
        const hearB = (text: string) => {
            if (wrote) return
            wrote = true
            doc.applyChange({ from: text.length, to: text.length, insert: '\n' }, 'editor', hearB)
        }
        doc.subscribe(hearB)
        // Each change is expressed against the text the ones before it leave (sequential-text-changes.ts).
        const changes: TextChange[] = [
            { from: 9, to: 17, insert: '' },
            { from: 24, to: 24, insert: '!' },
        ]
        a.send(changes, (change) => doc.applyChange(change, 'editor', hearA))
        expect(wrote).toBe(true)
        expect(shownByA).toBe(doc.getText())
    })
})
