import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Two words the Headless Client's output avoids, checked over every line of its source that is
 * not a comment: what it prints, its errors, and the tool descriptions and instructions agents
 * read. The same rule is in the repository's AGENTS.md, under the prose instructions.
 *
 * - "device", not "computer": EtherPK calls every place it runs a device, phones included, and
 *   the Client's approval prompts say device too.
 * - "create" a token, key or code, not "make" one.
 */
const SOURCE = new URL('.', import.meta.url).pathname

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return sourceFiles(path)
        return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
    })
}

/** Lines of code, without the comment lines that explain them. */
function codeLines(path: string): { line: number; text: string }[] {
    return readFileSync(path, 'utf8')
        .split('\n')
        .map((text, index) => ({ line: index + 1, text }))
        .filter(({ text }) => !/^\s*(\*|\/\/|\/\*)/.test(text))
}

const RULES = [
    { pattern: /\bcomputers?\b/i, fix: 'say "device" instead of "computer"' },
    { pattern: /\bmak(?:e|es|ing)\s+(?:a\s+|an\s+|the\s+|new\s+)*(?:\w+\s+)?(?:tokens?|keys?|codes?)\b/i, fix: 'say "create" a token, key or code, not "make" one' },
]

describe('Headless Client output wording', () => {
    it('says device, not computer, and creates tokens, keys and codes', () => {
        const found = sourceFiles(SOURCE).flatMap((path) =>
            codeLines(path).flatMap(({ line, text }) =>
                RULES.filter((rule) => rule.pattern.test(text)).map((rule) => `${path.slice(SOURCE.length)}:${line}: ${rule.fix}`),
            ),
        )
        expect(found).toEqual([])
    })
})
