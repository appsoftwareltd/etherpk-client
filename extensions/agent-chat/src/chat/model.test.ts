import { describe, expect, it } from 'vitest'

import { composerPlaceholder, needsPrompt, openingGrant, questionText } from './model'

describe('what a new chat reads first (ADR 0147, amended 2026-10-16)', () => {
    it('reads the outline around its bullet when that bullet has siblings or ancestors', () => {
        expect(openingGrant('- water the beans\n- see [[Kitchen]]')).toBe('block')
    })

    it('reads the document when there is no outline around it: no bullet, or a bullet on its own', () => {
        expect(openingGrant(null)).toBe('document')
        expect(openingGrant('')).toBe('document')
        expect(openingGrant('  \n')).toBe('document')
    })
})

describe('sending with no prompt', () => {
    it('is allowed where the context can hold the question: the outline, the document, or the document and its links', () => {
        expect(needsPrompt('block')).toBe(false)
        expect(needsPrompt('document')).toBe(false)
        expect(needsPrompt('links')).toBe(false)
    })

    it('needs a prompt with nothing else sent, or the whole graph, which has no one place the question could be', () => {
        expect(needsPrompt('nothing')).toBe(true)
        expect(needsPrompt('graph')).toBe(true)
    })

    it('says in the field what Send will do', () => {
        expect(composerPlaceholder('block')).toBe('Send block siblings and ancestors')
        expect(composerPlaceholder('document')).toBe('Send this document')
        expect(composerPlaceholder('links')).toBe('Send this document and its links')
        expect(composerPlaceholder('nothing')).toBe('Prompt the agent')
        expect(composerPlaceholder('graph')).toBe('Prompt the agent')
    })

    it('reads, wherever the turn is shown, as what was sent', () => {
        expect(questionText({ question: '  ', grant: 'document', images: [] })).toBe('Sent this document')
        expect(questionText({ question: '', grant: 'block', images: [] })).toBe('Sent block siblings and ancestors')
        expect(questionText({ question: ' What grows in shade? ', grant: 'document', images: [] })).toBe('What grows in shade?')
        // A picture sent on its own is the question: it says nothing in words.
        expect(questionText({ question: '', grant: 'nothing', images: [{ id: 'i1', name: 'leaf.png', blob: new Blob() }] })).toBe('')
    })
})
