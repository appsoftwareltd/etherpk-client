import { describe, expect, it } from 'vitest'

import type { GraphRecord } from '$lib/storage/graph-registry'

import { MAX_QUICK_NOTE_LENGTH } from './quick-notes'
import {
    clearPendingShare,
    composeSharedNote,
    orderShareTargets,
    peekPendingShare,
    stashPendingShare,
    takePendingShare,
} from './share-target'

/** A `Storage` in memory: what `sessionStorage` is to the browser, minus the browser. */
function memoryStorage(): Storage {
    const map = new Map<string, string>()
    return {
        get length() {
            return map.size
        },
        clear: () => map.clear(),
        getItem: (k) => map.get(k) ?? null,
        key: (i) => [...map.keys()][i] ?? null,
        removeItem: (k) => void map.delete(k),
        setItem: (k, v) => void map.set(k, String(v)),
    }
}

describe('composeSharedNote: the text a share becomes', () => {
    it('makes a page shared with its title one markdown link, so the journal shows the name', () => {
        expect(composeSharedNote({ title: 'Example Domain', url: 'https://example.com/' })).toEqual({
            text: '[Example Domain](https://example.com/)',
            truncated: false,
        })
    })

    it('treats text that is nothing but a web address as the url - how Chrome shares a page', () => {
        expect(composeSharedNote({ title: 'Example Domain', text: 'https://example.com/a?b=1' })?.text).toBe(
            '[Example Domain](https://example.com/a?b=1)',
        )
        expect(composeSharedNote({ text: 'https://example.com/' })?.text).toBe('https://example.com/')
    })

    it('treats a bare-url text as the url even when the url field says the same, so the title is not lost', () => {
        expect(
            composeSharedNote({ title: 'Example Domain', text: 'https://example.com/', url: 'https://example.com/' })?.text,
        ).toBe('[Example Domain](https://example.com/)')
        // Two different addresses: the text is text, and autolinks; the url follows it.
        expect(composeSharedNote({ text: 'https://a.example/', url: 'https://b.example/' })?.text).toBe(
            'https://a.example/\nhttps://b.example/',
        )
    })

    it('leaves a lone web address bare: the editor autolinks it', () => {
        expect(composeSharedNote({ url: 'https://example.com/' })?.text).toBe('https://example.com/')
    })

    it('puts text above its source link, one line each', () => {
        expect(
            composeSharedNote({ title: 'Page', text: 'A quoted line', url: 'https://example.com/p' })?.text,
        ).toBe('A quoted line\n[Page](https://example.com/p)')
        expect(composeSharedNote({ text: 'A quoted line', url: 'https://example.com/p' })?.text).toBe(
            'A quoted line\nhttps://example.com/p',
        )
    })

    it('keeps plain text as it came, inner line breaks included', () => {
        expect(composeSharedNote({ text: '  first\nsecond  ' })?.text).toBe('first\nsecond')
    })

    it('puts a title above text when there is no url', () => {
        expect(composeSharedNote({ title: 'Idea', text: 'dark mode toggle' })?.text).toBe('Idea\ndark mode toggle')
    })

    it('does not repeat a title the text already begins with (YouTube shares "Title https://…")', () => {
        expect(composeSharedNote({ title: 'A talk', text: 'A talk https://youtu.be/x' })?.text).toBe(
            'A talk https://youtu.be/x',
        )
        expect(composeSharedNote({ title: 'Same', text: 'Same' })?.text).toBe('Same')
        expect(composeSharedNote({ title: 'Same', text: 'Same\nagain' })?.text).toBe('Same\nagain')
    })

    it('keeps a title that is merely a prefix of the first word', () => {
        expect(composeSharedNote({ title: 'Note', text: 'Notes from the meeting' })?.text).toBe(
            'Note\nNotes from the meeting',
        )
    })

    it('does not append a url the text already holds, but still puts the title above', () => {
        expect(
            composeSharedNote({ text: 'See https://example.com/p for details', url: 'https://example.com/p' })?.text,
        ).toBe('See https://example.com/p for details')
        expect(
            composeSharedNote({ title: 'A talk', text: 'Watch this https://youtu.be/x', url: 'https://youtu.be/x' })?.text,
        ).toBe('A talk\nWatch this https://youtu.be/x')
    })

    it('never makes a link out of a scheme the editor would not open', () => {
        expect(composeSharedNote({ title: 'Bad', url: 'javascript:alert(1)' })?.text).toBe('Bad\njavascript:alert(1)')
        expect(composeSharedNote({ text: 'javascript:alert(1)' })?.text).toBe('javascript:alert(1)')
    })

    it('falls back to plain lines when the link syntax cannot carry the title or the url', () => {
        expect(composeSharedNote({ title: 'A [1] note]', url: 'https://example.com/' })?.text).toBe(
            'A [1] note]\nhttps://example.com/',
        )
        // The shared grammar allows a `[` in a label; the editor's parser reads `[Notes [draft](…)`
        // as the link "draft" with "[Notes " as prose. Brackets in a title mean plain lines.
        expect(composeSharedNote({ title: 'Notes [draft', url: 'https://example.com/' })?.text).toBe(
            'Notes [draft\nhttps://example.com/',
        )
        expect(composeSharedNote({ title: 'Two\nlines', url: 'https://example.com/' })?.text).toBe(
            'Two\nlines\nhttps://example.com/',
        )
        expect(composeSharedNote({ title: 'Wiki', url: 'https://example.com/a_(b' })?.text).toBe(
            'Wiki\nhttps://example.com/a_(b',
        )
    })

    it('carries a url with balanced parentheses as a link (Wikipedia titles have them)', () => {
        expect(composeSharedNote({ title: 'Mercury', url: 'https://en.wikipedia.org/wiki/Mercury_(planet)' })?.text).toBe(
            '[Mercury](https://en.wikipedia.org/wiki/Mercury_(planet))',
        )
    })

    it('cuts the text field to the cap, flags it, and keeps the link whole', () => {
        const long = 'x'.repeat(MAX_QUICK_NOTE_LENGTH + 50)
        const composed = composeSharedNote({ title: 'Long', text: long, url: 'https://example.com/' })
        expect(composed?.truncated).toBe(true)
        expect(composed?.text).toBe(`${'x'.repeat(MAX_QUICK_NOTE_LENGTH)}…\n[Long](https://example.com/)`)
        expect(composeSharedNote({ text: 'x'.repeat(MAX_QUICK_NOTE_LENGTH) })?.truncated).toBe(false)
    })

    it('never cuts through a surrogate pair', () => {
        const text = `${'x'.repeat(MAX_QUICK_NOTE_LENGTH - 1)}😀y`
        const composed = composeSharedNote({ text })
        expect(composed?.truncated).toBe(true)
        expect(composed?.text).toBe(`${'x'.repeat(MAX_QUICK_NOTE_LENGTH - 1)}…`)
        expect(composed?.text.isWellFormed()).toBe(true)
    })

    it('is null when nothing usable arrived', () => {
        expect(composeSharedNote({})).toBeNull()
        expect(composeSharedNote({ title: '  ', text: '\n', url: '' })).toBeNull()
        expect(composeSharedNote({ title: null, text: undefined, url: null })).toBeNull()
    })
})

describe('the pending share: what waits between the picker and the add', () => {
    const share = { graphId: 'g1', text: 'Ring the dentist', createdAt: 1_700_000_000_000, truncated: false }

    it('round-trips through storage and is consumed by the first take for its graph', () => {
        const storage = memoryStorage()
        stashPendingShare(share, storage)
        expect(peekPendingShare(storage)).toEqual(share)
        expect(takePendingShare('g1', storage)).toEqual(share)
        expect(takePendingShare('g1', storage)).toBeNull()
        expect(peekPendingShare(storage)).toBeNull()
    })

    it('is not taken by another graph, so a wrong workspace cannot swallow it', () => {
        const storage = memoryStorage()
        stashPendingShare(share, storage)
        expect(takePendingShare('other', storage)).toBeNull()
        expect(peekPendingShare(storage)).toEqual(share)
    })

    it('reads a corrupt or foreign value as nothing', () => {
        const storage = memoryStorage()
        storage.setItem('etherpk-pending-share', '{not json')
        expect(peekPendingShare(storage)).toBeNull()
        storage.setItem('etherpk-pending-share', JSON.stringify({ graphId: 1, text: 'x' }))
        expect(peekPendingShare(storage)).toBeNull()
        storage.setItem('etherpk-pending-share', JSON.stringify({ graphId: 'g', text: '', createdAt: 1 }))
        expect(peekPendingShare(storage)).toBeNull()
    })

    it('can be cleared, and copes with no storage at all', () => {
        const storage = memoryStorage()
        stashPendingShare(share, storage)
        clearPendingShare(storage)
        expect(peekPendingShare(storage)).toBeNull()
        expect(() => stashPendingShare(share, null)).not.toThrow()
        expect(peekPendingShare(null)).toBeNull()
        expect(takePendingShare('g1', null)).toBeNull()
    })
})

describe('orderShareTargets: the picker list', () => {
    const graph = (id: string, createdAt: number): GraphRecord => ({
        id,
        name: id,
        backend: 'filesystem',
        createdAt,
        handle: null,
    })

    it('lists the last-opened graph first, the rest in the order given, and the demo last', () => {
        // The registry already lists in creation order; the picker takes that order as given, so
        // it cannot drift from the Graphs page.
        const graphs = [graph('demo', 1), graph('a', 2), graph('b', 3), graph('c', 4)]
        const ordered = orderShareTargets(graphs, { lastGraphId: 'c', isDemo: (id) => id === 'demo' })
        expect(ordered.map((g) => g.id)).toEqual(['c', 'a', 'b', 'demo'])
    })

    it('keeps the given order when the pointer names no graph here, and the demo stays last even when pointed at', () => {
        const graphs = [graph('demo', 1), graph('a', 2), graph('b', 3)]
        expect(orderShareTargets(graphs, { lastGraphId: 'gone', isDemo: (id) => id === 'demo' }).map((g) => g.id)).toEqual([
            'a',
            'b',
            'demo',
        ])
        expect(orderShareTargets(graphs, { lastGraphId: 'demo', isDemo: (id) => id === 'demo' }).map((g) => g.id)).toEqual([
            'a',
            'b',
            'demo',
        ])
    })
})
