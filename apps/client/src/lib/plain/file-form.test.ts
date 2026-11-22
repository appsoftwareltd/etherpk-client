import { describe, expect, it } from 'vitest'

import { decodeFile, encodeFile, placeEdits } from './file-form'

const bytes = (...parts: Array<string | number[]>) => {
    const chunks = parts.map((part) => (typeof part === 'string' ? new TextEncoder().encode(part) : new Uint8Array(part)))
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
    let at = 0
    for (const chunk of chunks) {
        out.set(chunk, at)
        at += chunk.length
    }
    return out
}
const BOM = [0xef, 0xbb, 0xbf]

describe('reading a file as it is', () => {
    it('keeps the line endings in the text and names the commonest one', () => {
        const file = decodeFile(bytes('beans\r\npeas\r\n'))
        expect(file).toEqual({ ok: true, text: 'beans\r\npeas\r\n', form: { bom: false, eol: '\r\n' } })
    })

    it('notes a byte order mark and keeps it out of the text', () => {
        expect(decodeFile(bytes(BOM, '# Garden\n'))).toEqual({ ok: true, text: '# Garden\n', form: { bom: true, eol: '\n' } })
    })

    it('uses line feeds for a file with no line ending of its own', () => {
        expect(decodeFile(bytes('one line'))).toEqual({ ok: true, text: 'one line', form: { bom: false, eol: '\n' } })
    })

    it('refuses bytes that are not UTF-8, so nothing is replaced unseen', () => {
        expect(decodeFile(bytes('caf', [0xe9], ' menu\n'))).toEqual({ ok: false, reason: 'not-utf8' })
    })

    it('writes the same bytes back for the same text', () => {
        const original = bytes(BOM, 'beans\r\npeas\r\n')
        const file = decodeFile(original)
        if (!file.ok) throw new Error('expected a readable file')
        expect(encodeFile(file.text, file.form)).toEqual(original)
    })
})

describe('placing the edited lines into the file', () => {
    const crlf = { bom: false, eol: '\r\n' } as const
    const lf = { bom: false, eol: '\n' } as const

    it('changes nothing when nothing was edited', () => {
        const disk = 'beans\r\npeas\rroots\nend'
        expect(placeEdits(disk, 'beans\npeas\nroots\nend', crlf)).toBe(disk)
    })

    it('keeps every other line as it was, with its own ending', () => {
        expect(placeEdits('beans\r\npeas\r\nroots\r\n', 'beans\nsweet peas\nroots\n', crlf)).toBe('beans\r\nsweet peas\r\nroots\r\n')
        // A file with mixed endings: the untouched lines keep theirs.
        expect(placeEdits('beans\npeas\r\nroots\n', 'beans\npeas\ncarrots\n', lf)).toBe('beans\npeas\r\ncarrots\n')
    })

    it('gives a new line the file’s own ending', () => {
        expect(placeEdits('beans\r\npeas\r\n', 'beans\nleeks\npeas\n', crlf)).toBe('beans\r\nleeks\r\npeas\r\n')
        expect(placeEdits('beans\r\npeas', 'beans\npeas\nleeks', crlf)).toBe('beans\r\npeas\r\nleeks')
    })

    it('leaves the final newline as the buffer has it', () => {
        expect(placeEdits('beans\npeas', 'beans\npeas\n', lf)).toBe('beans\npeas\n')
        expect(placeEdits('beans\npeas\n', 'beans\npeas', lf)).toBe('beans\npeas')
    })

    it('keeps the endings of untouched lines between two separate edits', () => {
        const disk = 'one\r\ntwo\nthree\r\nfour\nfive\r\n'
        expect(placeEdits(disk, 'ONE\ntwo\nthree\nfour\nFIVE\n', crlf)).toBe('ONE\r\ntwo\nthree\r\nfour\nFIVE\r\n')
    })

    it('handles a removed line and an emptied file', () => {
        expect(placeEdits('beans\r\npeas\r\nroots\r\n', 'beans\nroots\n', crlf)).toBe('beans\r\nroots\r\n')
        expect(placeEdits('beans\r\npeas\r\n', '', crlf)).toBe('')
    })
})
