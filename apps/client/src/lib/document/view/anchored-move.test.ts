import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { fencedBlocks } from '../fenced-code'
import { branchRange, computeMove, isBulletLine } from '../outliner'
import { anchoredMove, applyMoveChanges } from './anchored-move'

/** The move of the bullet on `index`, as the replace `computeMove` gives and as anchored changes. */
function move(lines: string[], index: number, dir: 'up' | 'down') {
    const blocks = fencedBlocks(lines)
    const edit = computeMove(lines, index, index, 0, dir, blocks)
    if (!edit) return null
    const text = lines.join('\n')
    const starts = lines.reduce<number[]>((acc, line, i) => [...acc, i === 0 ? 0 : acc[i - 1] + lines[i - 1].length + 1], [])
    const replaced = text.slice(0, starts[edit.fromLine]) + edit.text + text.slice(starts[edit.toLine] + lines[edit.toLine].length)
    const branch = branchRange(lines, index, blocks)
    const changes = anchoredMove(lines, edit.fromLine, edit.toLine, edit.text, branch.start, branch.end)
    return { text, replaced, changes, branch, starts }
}

describe('a branch move that leaves the moved branch in place', () => {
    it('Alt+Down over a sibling deletes and re-inserts the sibling only', () => {
        const m = move(['- Garden', '  - Beans', '- Kitchen', '- Shed'], 0, 'down')!
        expect(m.changes).toEqual([
            { from: 0, to: 0, insert: '- Kitchen\n' },
            { from: 19, to: 29, insert: '' },
        ])
        expect(applyMoveChanges(m.text, m.changes!)).toBe('- Kitchen\n- Garden\n  - Beans\n- Shed')
    })

    it('Alt+Up out of a parent re-indents the branch a line at a time', () => {
        const m = move(['- Kitchen', '  - Garden', '    - Beans'], 1, 'up')!
        expect(applyMoveChanges(m.text, m.changes!)).toBe(m.replaced)
        // No change deletes a character of the moved branch's words.
        for (const change of m.changes!) expect(m.text.slice(change.from, change.to)).not.toMatch(/Garden|Beans/)
    })

    it('gives the same text as the replace for every move of every bullet, and never deletes the moved branch’s text', () => {
        const item = fc.record({ step: fc.constantFrom(-2, -1, 0, 1, 1), text: fc.constantFrom('Garden', 'Kitchen', 'Beans'), soft: fc.boolean(), code: fc.boolean(), blank: fc.constantFrom(false, false, true) })
        fc.assert(
            fc.property(fc.array(item, { minLength: 2, maxLength: 9 }), fc.nat(), fc.constantFrom<'up' | 'down'>('up', 'down'), (items, pick, dir) => {
                const lines: string[] = []
                let level = -1
                for (const it of items) {
                    level = level < 0 ? 0 : Math.max(0, Math.min(level + 1, level + it.step))
                    const indent = '  '.repeat(level)
                    lines.push(`${indent}- ${it.text}`)
                    if (it.soft) lines.push(`${indent}  a note`)
                    if (it.code) lines.push(`${indent}  \`\`\``, `${indent}  dig()`, `${indent}  \`\`\``)
                    if (it.blank && level === 0) lines.push('')
                }
                const blocks = fencedBlocks(lines)
                const bullets = lines.flatMap((l, i) => (isBulletLine(l) && !blocks.some((b) => i > b.start && i <= b.end) ? [i] : []))
                const m = move(lines, bullets[pick % bullets.length], dir)
                if (!m) return
                expect(m.changes, JSON.stringify(lines)).not.toBeNull()
                expect(applyMoveChanges(m.text, m.changes!), JSON.stringify(lines)).toBe(m.replaced)
                const from = m.starts[m.branch.start]
                const to = m.starts[m.branch.end] + lines[m.branch.end].length
                // Inside the moved branch only indentation is deleted.
                for (const change of m.changes!) {
                    if (change.to <= from || change.from >= to) continue
                    expect(m.text.slice(Math.max(change.from, from), Math.min(change.to, to)), JSON.stringify(lines)).toMatch(/^ *$/)
                }
            }),
            { numRuns: 500, seed: 20261116 },
        )
    })
})
