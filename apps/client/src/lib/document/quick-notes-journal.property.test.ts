import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { quickNoteAssetRefs } from './quick-note-files'
import type { QuickNote } from './quick-notes'
import { quickNotesAsJournalBlocks } from './quick-notes-journal'
import { applyStrayTaskTags, parseTaskLine } from './task-tags'

/**
 * A Quick Note's text is words and, on lines of their own, the references of its files (ADR 0186).
 * The move to the journal writes the words as one bullet and each file as a bullet nested under
 * it. Over any note: no file is lost or written twice, every file is a bullet of its own directly
 * under its note's words, the words keep their order, and a task has no Task Tag left after its
 * words.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261124 : Number(seed) }
}

const WORDS = ['water the beans', 'fix the gate', 'see [plan.pdf](../assets/plan.0a0a0a0a.pdf) first', '[Garden](https://example.com/garden)', 'ring the plumber #P1', 'sow #w the peas #bug']
/** A file's reference as a line of its own: a picture, or any other file. */
const file = fc
    .tuple(fc.constantFrom('beans', 'shed', 'receipt'), fc.integer({ min: 0, max: 0xffff }), fc.boolean())
    .map(([stem, id, image]) => (image ? `![${stem}|400](../assets/${stem}.${id.toString(16).padStart(8, '0')}.webp)` : `[${stem}.pdf](../assets/${stem}.${id.toString(16).padStart(8, '0')}.pdf)`))

const note = fc
    .record({
        lines: fc.array(fc.oneof(fc.constantFrom(...WORDS).map((text) => ({ text, file: false })), file.map((text) => ({ text, file: true }))), { minLength: 1, maxLength: 6 }),
        task: fc.boolean(),
        under: fc.option(fc.constantFrom('Shopping', 'Garden'), { nil: undefined }),
        blank: fc.boolean(),
    })
    .map(({ lines, task, under, blank }) => {
        const hasWords = lines.some((line) => !line.file)
        // A task's checkbox is in front of its first line of words (`shareNoteText`).
        const first = lines.findIndex((line) => !line.file)
        const text = lines.map((line, at) => (task && hasWords && at === first ? `[ ] ${line.text}` : line.text)).join(blank ? '\n\n' : '\n')
        return { text, under, files: lines.filter((line) => line.file).map((line) => line.text), words: lines.filter((line) => !line.file).map((line) => line.text), task: task && hasWords }
    })

const dayOf = () => '2026-09-17'
const indentOf = (line: string) => line.length - line.trimStart().length

describe('a quick note moved into the journal', () => {
    it('keeps every file once, as a bullet of its own nested under the note it came with', () => {
        fc.assert(
            fc.property(note, (written) => {
                const moved: QuickNote = { id: '1', text: written.text, createdAt: 1, ...(written.under ? { under: written.under } : {}) }
                const lines = quickNotesAsJournalBlocks([moved], dayOf).split('\n').filter((line) => line !== '')
                const base = written.under ? 4 : 2
                expect(lines[0]).toBe('- [[2026-09-17]]')
                // The same files, each once: none lost to the move, none doubled by it.
                expect(quickNoteAssetRefs(lines.join('\n')).sort()).toEqual(quickNoteAssetRefs(written.text).sort())
                const fileBullets = lines.filter((line) => written.files.includes(line.trim().replace(/^- /, '')) && line.trim().startsWith('- '))
                expect(fileBullets.map((line) => line.trim().slice(2))).toEqual(written.files)
                if (written.words.length === 0) {
                    // Nothing to nest them under: each file is a bullet at the note's own level.
                    for (const line of fileBullets) expect(indentOf(line)).toBe(base)
                    return
                }
                // One bullet for the note's words, its later lines continuing it, then the files one level in.
                const body = lines.slice(written.under ? 2 : 1)
                expect(indentOf(body[0])).toBe(base)
                expect(body[0].trim().startsWith('- ')).toBe(true)
                const firstFile = body.findIndex((line) => fileBullets.includes(line))
                const wordLines = firstFile === -1 ? body : body.slice(0, firstFile)
                expect(wordLines).toHaveLength(written.words.length)
                for (const line of wordLines.slice(1)) expect(indentOf(line)).toBe(base + 2)
                for (const line of firstFile === -1 ? [] : body.slice(firstFile)) {
                    expect(fileBullets).toContain(line)
                    expect(indentOf(line)).toBe(base + 2)
                }
                // A task keeps its checkbox, and every Task Tag of its first line is in its run.
                if (written.task) {
                    const task = parseTaskLine(body[0])
                    expect(task).not.toBeNull()
                    expect(applyStrayTaskTags(body[0])).toBeNull()
                }
            }),
            fuzz(500),
        )
    })
})
