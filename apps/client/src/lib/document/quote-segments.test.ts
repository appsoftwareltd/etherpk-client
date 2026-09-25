import { describe, expect, it } from 'vitest'

import { lineText, quoteSegments } from './quote-segments'

describe('quoteSegments', () => {
    describe('lines', () => {
        it('gives each line of plain text a segment of its own', () => {
            expect(quoteSegments('see [[X]]\nsecond line')).toEqual([
                { kind: 'line', text: 'see [[X]]' },
                { kind: 'line', text: 'second line' },
            ])
        })

        it('reads an ATX heading at its level, the markers gone', () => {
            expect(quoteSegments('## h2')).toEqual([{ kind: 'line', text: 'h2', heading: 2 }])
            expect(quoteSegments('# Title ##')).toEqual([{ kind: 'line', text: 'Title', heading: 1 }])
        })

        it('reads a setext heading, its underline gone', () => {
            expect(quoteSegments('Title\n===')).toEqual([{ kind: 'line', text: 'Title', heading: 1 }])
            expect(quoteSegments('Sub\n---')).toEqual([{ kind: 'line', text: 'Sub', heading: 2 }])
        })

        it('keeps an underline of one or two characters as text, as the editor does', () => {
            expect(quoteSegments('a\n--')).toEqual([
                { kind: 'line', text: 'a' },
                { kind: 'line', text: '--' },
            ])
        })

        it('reads a thematic break as a rule', () => {
            expect(quoteSegments('***')).toEqual([{ kind: 'rule' }])
            expect(quoteSegments('a\n***')).toEqual([{ kind: 'line', text: 'a' }, { kind: 'rule' }])
        })

        it('leaves a line the parser reads as code, inside an unterminated fence, as it is', () => {
            expect(quoteSegments('a\n```ts\n# not a heading')).toEqual([
                { kind: 'line', text: 'a' },
                { kind: 'line', text: '```ts' },
                { kind: 'line', text: '# not a heading' },
            ])
        })
    })

    describe('quotes', () => {
        it('gathers a quote into one segment, its markers gone', () => {
            expect(quoteSegments('> Block quote')).toEqual([{ kind: 'quote', lines: [{ text: 'Block quote' }] }])
        })

        it('takes a lazy continuation line into the quote, as the parser does', () => {
            expect(quoteSegments('> a\nb')).toEqual([{ kind: 'quote', lines: [{ text: 'a' }, { text: 'b' }] }])
        })

        it('draws a nested quote inside the one panel', () => {
            expect(quoteSegments('> a\n> > deep')).toEqual([{ kind: 'quote', lines: [{ text: 'a' }, { text: 'deep' }] }])
        })

        it('keeps a heading inside a quote a heading', () => {
            expect(quoteSegments('> ## h')).toEqual([{ kind: 'quote', lines: [{ text: 'h', heading: 2 }] }])
        })

        it('lets a quote interrupt prose', () => {
            expect(quoteSegments('intro\n> q')).toEqual([
                { kind: 'line', text: 'intro' },
                { kind: 'quote', lines: [{ text: 'q' }] },
            ])
        })
    })

    describe('code', () => {
        it('lifts a complete fence out as code: its language, and its body without the fence lines', () => {
            expect(quoteSegments('see [[X]]:\n```ts\nlet a\n\nlet b\n```\nafter')).toEqual([
                { kind: 'line', text: 'see [[X]]:' },
                { kind: 'code', lang: 'ts', code: 'let a\n\nlet b' },
                { kind: 'line', text: 'after' },
            ])
        })

        it('reads a bare fence as code with no language', () => {
            expect(quoteSegments('```\nx\n```')).toEqual([{ kind: 'code', lang: '', code: 'x' }])
        })

        it('keeps an empty fence as an empty code block', () => {
            expect(quoteSegments('```sh\n```')).toEqual([{ kind: 'code', lang: 'sh', code: '' }])
        })

        it('dedents the body by the fence column, keeping the code’s own indentation', () => {
            expect(quoteSegments('a\n  ```py\n  def f():\n      return 1\n  ```')).toEqual([
                { kind: 'line', text: 'a' },
                { kind: 'code', lang: 'py', code: 'def f():\n    return 1' },
            ])
        })

        it('holds a shorter fence inside a longer one as code', () => {
            expect(quoteSegments('````md\n```\nx\n```\n````')).toEqual([{ kind: 'code', lang: 'md', code: '```\nx\n```' }])
        })

        it('keeps two fences apart', () => {
            expect(quoteSegments('```a\n1\n```\n```b\n2\n```')).toEqual([
                { kind: 'code', lang: 'a', code: '1' },
                { kind: 'code', lang: 'b', code: '2' },
            ])
        })
    })

    describe('tables', () => {
        it('lifts a table out with its cells and alignment, as the editor’s grid reads it', () => {
            expect(quoteSegments('see:\n| a | b |\n| :- | -: |\n| 1 | 2 |\nafter')).toEqual([
                { kind: 'line', text: 'see:' },
                { kind: 'table', header: ['a', 'b'], align: ['left', 'right'], rows: [['1', '2']] },
                { kind: 'line', text: 'after' },
            ])
        })
    })
})

describe('lineText', () => {
    it('is a line as a breadcrumb shows it: its heading and quote markers gone, nothing else', () => {
        expect(lineText('## h2 [[X]]')).toBe('h2 [[X]]')
        expect(lineText('> quoted')).toBe('quoted')
        expect(lineText('plain **bold**')).toBe('plain **bold**')
    })
})
