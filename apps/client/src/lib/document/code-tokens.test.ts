import { describe, expect, it } from 'vitest'

import { codeTokens } from './code-tokens'

describe('codeTokens', () => {
    it('covers the code exactly, token by token', async () => {
        const code = 'const answer = 42 // why\nfunction f() {}'
        const tokens = await codeTokens('ts', code)
        expect(tokens?.map((token) => token.text).join('')).toBe(code)
    })

    it('styles each token with the colour the editor gives it', async () => {
        const tokens = (await codeTokens('ts', 'const answer = 42 // why'))!
        const style = (text: string) => tokens.find((token) => token.text === text)?.style
        expect(style('const')).toBe('color: var(--gk-code-keyword, #0a7)')
        expect(style('42')).toBe('color: var(--gk-code-number, #905)')
        expect(style('// why')).toBe('color: var(--gk-code-comment, #999); font-style: italic')
        expect(style(' ')).toBeUndefined()
    })

    it('answers the same code with the same promise, so a quote shown again is not re-parsed', () => {
        const first = codeTokens('ts', 'let a = 1')
        expect(codeTokens('ts', 'let a = 1')).toBe(first)
        expect(codeTokens('ts', 'let a = 2')).not.toBe(first)
        expect(codeTokens('js', 'let a = 1')).not.toBe(first)
    })

    it('finds a language by alias, as the editor does', async () => {
        expect(await codeTokens('bash', 'echo hi # there')).not.toBeNull()
    })

    it('has nothing to say for a language the editor does not know, or none', async () => {
        expect(await codeTokens('not-a-language', 'x')).toBeNull()
        // Not LaTeX, whose alias `tex` sits inside the word (code-languages.ts).
        expect(await codeTokens('text', 'C:\\Users 50% done')).toBeNull()
        expect(await codeTokens('', 'x')).toBeNull()
    })
})
