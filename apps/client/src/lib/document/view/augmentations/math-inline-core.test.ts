import { describe, expect, it } from 'vitest'

import { scanInlineMath } from './math-inline-core'

const spans = (line: string) => scanInlineMath(line).map((s) => line.slice(s.from, s.to))
const texes = (line: string) => scanInlineMath(line).map((s) => s.tex)

describe('scanInlineMath', () => {
    it('finds a single span with delimiters and tex', () => {
        expect(spans('the mass–energy relation $E=mc^2$ holds')).toEqual(['$E=mc^2$'])
        expect(texes('the mass–energy relation $E=mc^2$ holds')).toEqual(['E=mc^2'])
    })

    it('finds multiple spans', () => {
        expect(texes('$a$ and $b$')).toEqual(['a', 'b'])
    })

    it('leaves an unclosed dollar (currency) as text', () => {
        expect(spans('the price is $5')).toEqual([])
    })

    it('leaves escaped dollars as text', () => {
        expect(spans('costs \\$5 and \\$10')).toEqual([])
        expect(texes('escaped \\$ then $x$')).toEqual(['x'])
    })

    it('rejects empty and whitespace-only content', () => {
        expect(spans('a $$ b')).toEqual([])
        expect(spans('a $ $ b')).toEqual([])
    })

    it('degrades $$x$$ (no block-math syntax) to plain text', () => {
        expect(spans('$$x$$')).toEqual([])
    })

    it('skips inline code spans', () => {
        expect(spans('`$x$`')).toEqual([])
        expect(texes('code `$a$` then $b$')).toEqual(['b'])
    })

    it('never captures without a closing dollar on the line', () => {
        expect(spans('open $x')).toEqual([])
    })

    it('reports correct offsets', () => {
        const line = 'a $x$ b'
        expect(scanInlineMath(line)).toEqual([{ from: 2, to: 5, tex: 'x' }])
    })
})
