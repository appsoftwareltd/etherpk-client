/**
 * Property tests for [[Fold]]s (Editor Content Rules → Folds, ADR 0191): what a fold covers, that
 * no key types into hidden text or leaves the caret there, that a fold follows its branch through
 * the person's own keys and through a peer's edits arriving over Yjs, and that kept folds come back
 * on the bullets they were made on.
 *
 * The peer is a second headless editor joined to the first through two `Y.Doc`s, the way
 * y-codemirror.next joins a synced editor to its `Y.Text` (`y-sync.js`): a local transaction's
 * changes are written into the Y.Text, the update travels to the other document when the test
 * delivers it, and the other side's observer turns the Y.Text delta back into one CodeMirror
 * transaction. Holding updates back makes edits concurrent.
 *
 * A property the code breaks is kept and marked `it.fails`, with the shrunk counterexample in its
 * comment, so the suite stays green and turns red the day the code is fixed.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { blockRange, caretSpec, deleteBlockSpec, duplicateBlockSpec, outdentBlockSpec, structureSpec } from '../block-actions'
import { indentBranch, moveBranchDown, moveBranchUp, outdentBranch } from '../outliner-keymap'
import { minimalReplacement } from '../minimal-replacement'
import { editorFixture, type HeadlessEditor } from '../testing/editor-state-fixture'
import { pair } from '../testing/yjs-devices'
import { keptFoldsOf, resolveKeptFolds } from './fold-persistence'
import { allFolds, bulletFoldRange, type FoldRange, foldedBulletLines, toggleBulletFoldSpec } from './outline-folds'

/**
 * Fixed seeds keep the suite deterministic in CI. To hunt, run with `EDITOR_FUZZ_SEED=<n>` and
 * optionally `EDITOR_FUZZ_RUNS=<n>`.
 */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.EDITOR_FUZZ_SEED
    return {
        numRuns: Number(process.env.EDITOR_FUZZ_RUNS ?? runs),
        seed: seed === undefined ? 20261116 : Number(seed),
    }
}

// ── Generators ───────────────────────────────────────────────────────────────────────────────

/** One bullet of an outline: its depth relative to the one before, and what it carries. */
interface Item {
    step: number
    task: boolean
    text: string
    soft: boolean
    code: boolean
    blankAfter: boolean
}

/** Repeated words on purpose: a journal has many bullets called "Comments". */
const repeatedWords = ['Garden', 'Comments', 'water the beans', 'Kitchen', 'Comments']

function itemArb(words: fc.Arbitrary<string>): fc.Arbitrary<Item> {
    return fc.record({
        step: fc.constantFrom(-2, -1, 0, 1, 1, 1),
        task: fc.boolean(),
        text: words,
        soft: fc.boolean(),
        code: fc.constantFrom(false, false, false, true),
        blankAfter: fc.constantFrom(false, false, false, false, true),
    })
}

/** Render items to lines, each bullet at most one level below the one before. */
function render(items: readonly Item[]): string[] {
    const lines: string[] = []
    let level = -1
    for (const item of items) {
        level = level < 0 ? 0 : Math.max(0, Math.min(level + 1, level + item.step))
        const indent = '  '.repeat(level)
        const col = indent + '  '
        lines.push(`${indent}- ${item.task ? '[ ] ' : ''}${item.text}`)
        if (item.soft) lines.push(`${col}a note`)
        if (item.code) lines.push(`${col}\`\`\``, `${col}dig()`, `${col}\`\`\``)
        // A blank line ends the group only at the margin; deeper it stays in the branch.
        if (item.blankAfter && level === 0) lines.push('')
    }
    return lines
}

const outlineArb = fc.array(itemArb(fc.constantFrom(...repeatedWords)), { minLength: 2, maxLength: 9 })

/** Unique words, so a bullet can be found again by its text. */
const uniqueOutlineArb = fc.integer({ min: 2, max: 9 }).chain((n) =>
    fc.tuple(...Array.from({ length: n }, (_, i) => itemArb(fc.constant(`item ${i + 1}`)))),
)

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

/** The 1-based lines of every bullet that can fold. */
function foldableLines(editor: HeadlessEditor): number[] {
    const out: number[] = []
    for (let line = 1; line <= editor.state.doc.lines; line++) if (bulletFoldRange(editor.state, line)) out.push(line)
    return out
}

/** Fold the bullets picked by `picks` (indices into the foldable ones), in that order. */
function foldSome(editor: HeadlessEditor, picks: readonly number[]): void {
    for (const pick of picks) {
        const lines = foldableLines(editor)
        if (lines.length === 0) return
        const line = lines[pick % lines.length]
        if (foldedBulletLines(editor.state).includes(line)) continue
        const spec = toggleBulletFoldSpec(editor.state, line)
        if (spec) editor.dispatch(editor.state.update(spec))
    }
}

const sameRange = (a: FoldRange, b: FoldRange) => a.from === b.from && a.to === b.to

/**
 * The rules every state must keep: each fold is exactly its bullet's children (Only a bullet with a
 * child bullet folds; A fold follows its branch), no two folds are the same or cross, and the caret is
 * not in hidden text (Anything that puts the caret in a fold opens it).
 */
function checkFolds(editor: HeadlessEditor, info: string): void {
    const { state } = editor
    const folds = allFolds(state)
    const bullets = foldedBulletLines(state)
    expect(bullets.length, `${info}: a fold that belongs to no bullet`).toBe(folds.length)
    for (const line of bullets) {
        const range = bulletFoldRange(state, line)
        expect(range, `${info}: line ${line} is folded but has no child`).not.toBeNull()
        expect(
            folds.some((f) => sameRange(f, range!)),
            `${info}: line ${line}'s fold ${JSON.stringify(folds)} is not its branch ${JSON.stringify(range)}`,
        ).toBe(true)
    }
    for (let i = 0; i < folds.length; i++) {
        for (let j = i + 1; j < folds.length; j++) {
            const [a, b] = [folds[i], folds[j]]
            expect(sameRange(a, b), `${info}: the same fold twice`).toBe(false)
            const disjoint = a.to <= b.from || b.to <= a.from
            const nested = (a.from <= b.from && b.to <= a.to) || (b.from <= a.from && a.to <= b.to)
            expect(disjoint || nested, `${info}: folds ${JSON.stringify(a)} and ${JSON.stringify(b)} cross`).toBe(true)
        }
    }
    const head = state.selection.main.head
    for (const f of folds) expect(head > f.from && head <= f.to, `${info}: the caret ${head} is hidden in ${JSON.stringify(f)}`).toBe(false)
}

/** What each fold hides, as its lines without their indentation, so a whole-branch move compares equal. */
function hiddenTexts(editor: HeadlessEditor): string[] {
    return allFolds(editor.state).map((f) =>
        editor.state.doc
            .sliceString(f.from, f.to)
            .split('\n')
            .map((l) => l.trim())
            .join('\n'),
    )
}

/** A description of the editor for a failure message. */
const shown = (editor: HeadlessEditor) => JSON.stringify({ text: editor.fixture(), folded: foldedBulletLines(editor.state) })

/** The keys a person presses, and where the caret can be put first. */
const KEYS = ['Enter', 'Shift-Enter', 'Backspace', 'Delete', 'Tab', 'Shift-Tab', 'Alt-ArrowUp', 'Alt-ArrowDown', 'Mod-.', 'Mod-z', 'Mod-y', 'Mod-Enter', 'x'] as const
type Key = (typeof KEYS)[number]

/** Press `key`, or type it when it is a character. */
function press(editor: HeadlessEditor, key: Key): void {
    if (key === 'x') editor.type('x')
    else editor.key(key)
}

/** Put the caret at the start, the text start or the end of 1-based `line` (clamped to the document). */
function placeCaret(editor: HeadlessEditor, lineNumber: number, where: number): void {
    const line = editor.state.doc.line(Math.max(1, Math.min(editor.state.doc.lines, lineNumber)))
    const textStart = line.from + (line.text.length - line.text.trimStart().length)
    const at = [line.from, textStart, line.to, Math.min(line.to, textStart + 3)][where % 4]
    editor.select(at)
}

// ── The person's own keys ────────────────────────────────────────────────────────────────────

describe('folds under the person’s own keys', { timeout: 60_000 }, () => {
    it('a fold covers exactly its bullet’s children, and folding changes no text', () => {
        fc.assert(
            fc.property(outlineArb, fc.array(fc.nat(), { minLength: 1, maxLength: 4 }), (items, picks) => {
                const text = render(items).join('\n')
                const editor = editorFixture('|' + text)
                foldSome(editor, picks)
                expect(editor.text()).toBe(text)
                checkFolds(editor, shown(editor))
            }),
            fuzz(300),
        )
    })

    it('no key leaves the caret in hidden text, types into it, or leaves a fold that is not its bullet’s branch', () => {
        // "Anything that puts the caret in a fold opens it … No key types into hidden text", "A fold
        // follows its branch", "A fold ends with its bullet", "Moving keeps a fold".
        fc.assert(
            fc.property(
                outlineArb,
                fc.array(fc.nat(), { minLength: 1, maxLength: 3 }),
                fc.array(fc.tuple(fc.nat(), fc.nat(), fc.constantFrom(...KEYS)), { minLength: 1, maxLength: 8 }),
                (items, picks, steps) => {
                    const editor = editorFixture('|' + render(items).join('\n'))
                    foldSome(editor, picks)
                    const trail: string[] = [shown(editor)]
                    for (const [line, where, key] of steps) {
                        placeCaret(editor, line % editor.state.doc.lines + 1, where)
                        checkFolds(editor, `after placing the caret: ${trail.join(' → ')} → ${shown(editor)}`)
                        const before = new Set(hiddenTexts(editor))
                        const was = shown(editor)
                        press(editor, key)
                        trail.push(`${key} at ${was}`)
                        const info = trail.join(' → ') + ` → ${shown(editor)}`
                        checkFolds(editor, info)
                        // A fold the key made (Mod+.) hides what was shown; every other fold hides what it hid.
                        if (key !== 'Mod-.') for (const hidden of hiddenTexts(editor)) expect(before.has(hidden), `${info}: hidden text changed to ${JSON.stringify(hidden)}`).toBe(true)
                    }
                },
            ),
            fuzz(400),
        )
    })

    // Was MOVE_ACROSS_DEPTH: Alt+Up on a folded bullet that is its parent's first child (or Alt+Down
    // on a last child) moves it out of the parent and one level shallower, and the fold is lost, or
    // lands on the bullet that took the moved one's old line, hiding children that were showing (a hunt:
    // "- Garden\n\n  - |Garden\n    - Garden\n- Garden\n  - Comments" with line 3 folded, Alt+Down
    // folds the "Garden" that holds "Comments"). The
    // fold is found again only where the branch's text comes back unchanged, and a move out of a parent
    // re-indents it. Shrunk: "- item 1\n- item 2\n- item 3\n- item 4\n  - |item 5\n    - item 6" with
    // line 5 folded; Alt+Up gives "…\n- item 5\n  - item 6\n- item 4" with no fold. The same on a
    // peer's device when the peer presses it.
    it('Alt+Up and Alt+Down keep a folded bullet folded, also when the move takes it out of its parent', () => {
        // "Moving keeps a fold. Indent, outdent, Alt+Up and Alt+Down take the hidden children with the
        // bullet, and it stays folded."
        fc.assert(
            fc.property(uniqueOutlineArb, fc.nat(), fc.constantFrom('Alt-ArrowUp', 'Alt-ArrowDown'), (items, pick, key) => {
                const editor = editorFixture('|' + render(items).join('\n'))
                const foldable = foldableLines(editor)
                if (foldable.length === 0) return
                const line = foldable[pick % foldable.length]
                const words = editor.state.doc.line(line).text.replace(/^\s*- (\[[ xX]\] )?/, '')
                editor.dispatch(editor.state.update(toggleBulletFoldSpec(editor.state, line)!))
                placeCaret(editor, line, 2)
                const was = shown(editor)
                press(editor, key)
                const now = lineOf(editor, words)!
                expect(foldedBulletLines(editor.state), `${key} on ${was} → ${shown(editor)}`).toContain(now)
            }),
            fuzz(300),
        )
    })

    // Was OUTDENT_ADOPTS_INTO_FOLD (the fold now opens): Shift+Tab on a folded bullet makes the siblings below it its
    // children (the outliner's outdent), and the fold, found again from the branch, now hides them too.
    // Lines the person could see vanish. Shrunk: "- a\n  - |b\n    - c\n  - d\n    - e" with "b" folded;
    // Shift+Tab gives "- a\n- b\n  - c\n  - d\n    - e" with "b" still folded, so "d" and "e" are hidden.
    it('Shift+Tab on a folded bullet hides nothing that was shown', () => {
        fc.assert(
            fc.property(outlineArb, fc.nat(), (items, pick) => {
                const editor = editorFixture('|' + render(items).join('\n'))
                const foldable = foldableLines(editor)
                if (foldable.length === 0) return
                const line = foldable[pick % foldable.length]
                editor.dispatch(editor.state.update(toggleBulletFoldSpec(editor.state, line)!))
                placeCaret(editor, line, 2)
                const before = new Set(hiddenTexts(editor))
                const was = shown(editor)
                editor.key('Shift-Tab')
                for (const hidden of hiddenTexts(editor)) expect(before.has(hidden), `Shift+Tab on ${was} → ${shown(editor)}: now hidden ${JSON.stringify(hidden)}`).toBe(true)
            }),
            fuzz(300),
        )
    })

    // Was MOVE_PREFIX_MATCH: after Alt+Up or Alt+Down the fold is found again at the first place
    // the moved text holds the folded branch's lines, and a sibling whose lines START with them matches
    // first. Shrunk from a hunt: "- |Garden\n  - Beans\n- Garden\n  - Beans\n    - water the beans" with
    // line 1 folded; Alt+Down moves it below its sibling, and the fold stays on line 1, now the OTHER
    // "Garden", whose children were showing. The bullet just moved shows its children.
    it('Alt+Down moves the fold with its bullet when the sibling below starts with the same lines', () => {
        const editor = editorFixture('- |Garden\n  - Beans\n- Garden\n  - Beans\n    - water the beans')
        editor.dispatch(editor.state.update(toggleBulletFoldSpec(editor.state, 1)!))
        editor.key('Alt-ArrowDown')
        expect(editor.text()).toBe('- Garden\n  - Beans\n    - water the beans\n- Garden\n  - Beans')
        expect(foldedBulletLines(editor.state)).toEqual([4])
    })

    // Was UNDO_REDO_KEEPS_FOLD: an undo or redo opens a fold only when it leaves the caret inside,
    // so one that changes hidden text with the caret elsewhere leaves the fold shut over changed text.
    // From a hunt: "Kitchen" folded over "  - Beans"; Mod+Enter at the start of "Beans" (which opens the
    // fold) gives "  - \nBeans"; Mod+Z; fold "Kitchen" again with Mod+.; the caret on "Garden"; Mod+Y
    // splits the hidden line again and "Kitchen" stays folded over an empty "  - ", with "Beans" now a
    // paragraph below it.
    it('an undo or redo that changes text inside a fold opens it', () => {
        // "Anything that puts the caret in a fold opens it: … an undo or redo that changes text inside".
        const editor = editorFixture('|- Garden\n- Kitchen\n  - Beans\n- Peas')
        editor.dispatch(editor.state.update(toggleBulletFoldSpec(editor.state, 2)!))
        editor.select(editor.state.doc.line(3).from + 4)
        editor.key('Mod-Enter')
        editor.select(2)
        editor.key('Mod-z')
        editor.select(editor.state.doc.line(2).from + 2)
        editor.key('Mod-.')
        expect(foldedBulletLines(editor.state)).toEqual([2])
        editor.select(2)
        editor.key('Mod-y')
        expect(editor.text()).toBe('- Garden\n- Kitchen\n  - \nBeans\n- Peas')
        expect(foldedBulletLines(editor.state)).toEqual([])
    })

    it('the block menu’s Indent, Outdent, Move up and Move down leave the folds as the keys do', () => {
        // "Indent, Outdent, Move up, Move down: as Tab, Shift+Tab, Alt+↑, Alt+↓ with the caret in the
        // bullet". The row runs the key's command against a copy of the state and dispatches its
        // changes and effects, so the fold rules run on both.
        const rows = { Indent: indentBranch, Outdent: outdentBranch, 'Move up': moveBranchUp, 'Move down': moveBranchDown } as const
        fc.assert(
            fc.property(uniqueOutlineArb, fc.array(fc.nat(), { minLength: 1, maxLength: 3 }), fc.nat(), fc.constantFrom(...(Object.keys(rows) as (keyof typeof rows)[])), (items, picks, which, row) => {
                const text = render(items).join('\n')
                const byMenu = editorFixture('|' + text)
                foldSome(byMenu, picks)
                // A hidden bullet's dot cannot be clicked, so the menu opens on shown bullets only.
                const folds = allFolds(byMenu.state)
                const hidden = (l: number) => folds.some((f) => byMenu.state.doc.line(l).from > f.from && byMenu.state.doc.line(l).from <= f.to)
                const bullets = Array.from({ length: byMenu.state.doc.lines }, (_, i) => i + 1).filter((l) => blockRange(byMenu.state, l) && !hidden(l))
                const line = bullets[which % bullets.length]
                const spec = row === 'Outdent' ? outdentBlockSpec(byMenu.state, line, rows[row]) : structureSpec(byMenu.state, line, rows[row])
                if (!spec) return
                const was = shown(byMenu)
                byMenu.dispatch(byMenu.state.update(spec))
                checkFolds(byMenu, `${row} on line ${line} of ${was} → ${shown(byMenu)}`)
                // The same key with the caret at the start of the bullet's text.
                const byKey = editorFixture('|' + text)
                foldSome(byKey, picks)
                byKey.dispatch(byKey.state.update(caretSpec(byKey.state, line, 'start')!))
                byKey.key({ Indent: 'Tab', Outdent: 'Shift-Tab', 'Move up': 'Alt-ArrowUp', 'Move down': 'Alt-ArrowDown' }[row])
                expect(byMenu.text(), `${row} on line ${line} of ${was}`).toBe(byKey.text())
                expect([...foldedBulletLines(byMenu.state)].sort(), `${row} on line ${line} of ${was}`).toEqual([...foldedBulletLines(byKey.state)].sort())
            }),
            fuzz(300),
        )
    })

    it('Delete block on a folded bullet ends its fold, and never folds the bullet that takes its line', () => {
        // "A fold ends with its bullet." The browser hunt of 2026-11-16: Garden folded, then Delete
        // block, left Kitchen folded. A deletion that starts exactly at the bullet did not read as
        // deleting it.
        fc.assert(
            fc.property(uniqueOutlineArb, fc.nat(), (items, pick) => {
                const editor = editorFixture('|' + render(items).join('\n'))
                const foldable = foldableLines(editor)
                if (foldable.length === 0) return
                const line = foldable[pick % foldable.length]
                editor.dispatch(editor.state.update(toggleBulletFoldSpec(editor.state, line)!))
                const was = shown(editor)
                editor.dispatch(editor.state.update(deleteBlockSpec(editor.state, line)!))
                expect(foldedBulletLines(editor.state), `Delete block on line ${line} of ${was} → ${shown(editor)}`).toEqual([])
            }),
            fuzz(300),
        )
    })

    it('folding with the caret inside the branch changes no text, whatever tidy on leave would do to the caret’s line', () => {
        // "A fold changes no text." The fold moves the caret out of the branch, and tidy on leave
        // rewrote the line it left (a task's tags to the front, trailing spaces), as an undo step.
        for (const hidden of ['  - [ ] water the beans #P2', '  - water the beans  ']) {
            const text = `- Garden\n${hidden}\n- Kitchen`
            const editor = editorFixture(text.replace(hidden, hidden + '|'))
            editor.key('Mod-.')
            expect(foldedBulletLines(editor.state)).toEqual([1])
            expect(editor.text()).toBe(text)
        }
    })

    it('a block menu row for Move up works when the caret’s own line would be tidied as the caret leaves it', () => {
        // The browser hunt: the row threw "Applying change set to a document with the wrong length".
        const editor = editorFixture('- Garden\n  - water the beans  |\n- Kitchen\n  - wash pans')
        const spec = structureSpec(editor.state, 3, moveBranchUp)
        expect(spec).not.toBeNull()
        editor.dispatch(editor.state.update(spec!))
        expect(editor.text().split('\n')[0]).toBe('- Kitchen')
    })

    it('Duplicate and Delete block on a folded bullet keep every other fold on its branch', () => {
        // The block menu's rows act on the Block and every Block under it; the folds elsewhere follow.
        fc.assert(
            fc.property(outlineArb, fc.array(fc.nat(), { minLength: 1, maxLength: 3 }), fc.nat(), fc.boolean(), (items, picks, which, duplicate) => {
                const editor = editorFixture('|' + render(items).join('\n'))
                foldSome(editor, picks)
                const bullets = Array.from({ length: editor.state.doc.lines }, (_, i) => i + 1).filter((l) => blockRange(editor.state, l))
                const line = bullets[which % bullets.length]
                const was = shown(editor)
                const spec = duplicate ? duplicateBlockSpec(editor.state, line) : deleteBlockSpec(editor.state, line)
                editor.dispatch(editor.state.update(spec!))
                checkFolds(editor, `${duplicate ? 'Duplicate' : 'Delete block'} on line ${line} of ${was} → ${shown(editor)}`)
            }),
            fuzz(300),
        )
    })
})

// ── A peer's edits over Yjs ──────────────────────────────────────────────────────────────────

/** The 1-based line whose text, less its indentation and marker, is exactly `words`, or null. */
function lineOf(editor: HeadlessEditor, words: string): number | null {
    for (let n = 1; n <= editor.state.doc.lines; n++) {
        if (editor.state.doc.line(n).text.replace(/^\s*- (\[[ xX]\] )?/, '') === words) return n
    }
    return null
}

const PEER_KEYS = ['Alt-ArrowUp', 'Alt-ArrowDown', 'Tab', 'Shift-Tab', 'Enter', 'Backspace', 'Delete', 'x'] as const

describe('folds under a peer’s edits', { timeout: 60_000 }, () => {
    it('whatever a peer does, the folds on this device stay well formed and both devices end with the same text', () => {
        fc.assert(
            fc.property(
                uniqueOutlineArb,
                fc.array(fc.nat(), { minLength: 1, maxLength: 3 }),
                fc.array(fc.tuple(fc.nat(), fc.nat(), fc.constantFrom(...PEER_KEYS), fc.boolean()), { minLength: 1, maxLength: 6 }),
                (items, picks, steps) => {
                    const [me, peer] = pair(render(items).join('\n'))
                    foldSome(me.editor, picks)
                    const trail: string[] = [shown(me.editor)]
                    for (const [line, where, key, deliver] of steps) {
                        placeCaret(peer.editor, (line % peer.editor.state.doc.lines) + 1, where)
                        press(peer.editor, key)
                        trail.push(`peer ${key} → ${JSON.stringify(peer.editor.text())}`)
                        if (deliver) {
                            peer.deliverTo(me)
                            checkFolds(me.editor, trail.join(' → ') + ` → mine ${shown(me.editor)}`)
                        }
                    }
                    peer.deliverTo(me)
                    me.deliverTo(peer)
                    checkFolds(me.editor, trail.join(' → ') + ` → mine ${shown(me.editor)}`)
                    expect(me.editor.text(), trail.join(' → ')).toBe(peer.editor.text())
                },
            ),
            fuzz(300),
        )
    })

    it('a folded branch a peer moves, indents, outdents or adds a child to stays folded on this device', () => {
        // "A fold follows its branch. After every change, the person's own or a peer's, each fold is
        // found again from its bullet's branch"; "Moving keeps a fold. Indent, outdent, Alt+Up and
        // Alt+Down take the hidden children with the bullet, and it stays folded."
        fc.assert(
            fc.property(uniqueOutlineArb, fc.nat(), fc.constantFrom('Alt-ArrowUp', 'Alt-ArrowDown', 'Tab', 'Shift-Tab', 'child'), (items, pick, key) => {
                const [me, peer] = pair(render(items).join('\n'))
                const foldable = foldableLines(me.editor)
                if (foldable.length === 0) return
                const line = foldable[pick % foldable.length]
                const words = me.editor.state.doc.line(line).text.replace(/^\s*- (\[[ xX]\] )?/, '')
                me.editor.dispatch(me.editor.state.update(toggleBulletFoldSpec(me.editor.state, line)!))
                const before = shown(me.editor)
                const branchBefore = blockRange(me.editor.state, line)!
                const branchLines = branchBefore.end - branchBefore.start
                const peerLine = lineOf(peer.editor, words)!
                if (key === 'child') {
                    // A child at the foot of the branch: after the branch's last line, one level under the bullet.
                    const range = blockRange(peer.editor.state, peerLine)!
                    const last = peer.editor.state.doc.line(range.end + 1)
                    const indent = peer.editor.state.doc.line(peerLine).text.match(/^\s*/)![0]
                    peer.editor.dispatch(peer.editor.state.update({ changes: { from: last.to, insert: `\n${indent}  - pick the peas` } }))
                } else {
                    placeCaret(peer.editor, peerLine, 2)
                    press(peer.editor, key)
                }
                peer.deliverTo(me)
                const info = `peer ${key} on ${JSON.stringify(words)}: ${before} → ${shown(me.editor)}`
                checkFolds(me.editor, info)
                const now = lineOf(me.editor, words)
                if (now === null || !bulletFoldRange(me.editor.state, now)) return
                // A bullet that still has children keeps its fold, unless its branch took in lines that
                // were showing (an outdent adopts the siblings below): then the fold opens.
                const branchNow = blockRange(me.editor.state, now)!
                const grew = branchNow.end - branchNow.start > branchLines
                if (grew && key !== 'child') expect(foldedBulletLines(me.editor.state), info).not.toContain(now)
                else expect(foldedBulletLines(me.editor.state), info).toContain(now)
            }),
            fuzz(300),
        )
    })

    // Was CONCURRENT_MOVE_MISPLACES_EDIT: a move was one replace of every line it rearranged, which
    // Yjs sends as a delete and an insert, and a word typed into the moved bullet at the same moment
    // came out at the start of the next line, breaking that bullet's marker. The moved branch now stays
    // in the document (anchored-move.ts). The lines it passes are still deleted and written again, so a
    // word typed into THOSE at the same moment is still misplaced: a text CRDT has no move.
    it('a word typed on this device while a peer moves its branch is not lost', () => {
        // A move written as a replace of the lines it carries deletes them for the peer: an edit made
        // to those lines at the same time lands in deleted text.
        fc.assert(
            fc.property(uniqueOutlineArb, fc.nat(), fc.constantFrom('Alt-ArrowUp', 'Alt-ArrowDown', 'Tab', 'Shift-Tab'), (items, pick, key) => {
                const [me, peer] = pair(render(items).join('\n'))
                const bullets = Array.from({ length: me.editor.state.doc.lines }, (_, i) => i + 1).filter((l) => blockRange(me.editor.state, l))
                const line = bullets[pick % bullets.length]
                const words = me.editor.state.doc.line(line).text.replace(/^\s*- (\[[ xX]\] )?/, '')
                // I type at the end of the bullet; at the same time the peer moves it.
                me.editor.select(me.editor.state.doc.line(line).to)
                me.editor.type('zz')
                placeCaret(peer.editor, lineOf(peer.editor, words)!, 2)
                const moved = peer.editor.text()
                press(peer.editor, key)
                if (peer.editor.text() === moved) return
                // The moved bullet's branch ends the document and lines from above go below it: they can
                // only be written at the document's end, where the word is being typed, and which of the
                // two comes first is Yjs's to choose. The word lands whole, in one line or the other.
                const range = blockRange(me.editor.state, line)!
                if (key === 'Alt-ArrowUp' && range.end === me.editor.state.doc.lines - 1) return
                me.deliverTo(peer)
                peer.deliverTo(me)
                const info = `I typed "zz" after ${JSON.stringify(words)} while the peer pressed ${key}: ${JSON.stringify(me.editor.text())}`
                expect(me.editor.text(), info).toBe(peer.editor.text())
                expect(me.editor.text(), info).toContain(`${words}zz`)
            }),
            fuzz(300),
        )
    })
})

// ── Kept folds ───────────────────────────────────────────────────────────────────────────────

describe('folds in a second pane of the same document', { timeout: 60_000 }, () => {
    it('a key pressed in one pane, heard in the other as the smallest replacement, leaves the same bullets folded in both', () => {
        // Two panes of one document in a tab: the other pane hears a change as the smallest
        // replacement between the two texts, which can cut through any line. The browser hunt of
        // 2026-11-16: Alt+Down on a sibling above a folded bullet unfolded it in the other pane, and
        // the kept folds then carried the loss back.
        fc.assert(
            fc.property(uniqueOutlineArb, fc.array(fc.nat(), { minLength: 1, maxLength: 2 }), fc.nat(), fc.constantFrom('Alt-ArrowUp', 'Alt-ArrowDown', 'Tab', 'Shift-Tab'), (items, picks, which, key) => {
                const text = render(items).join('\n')
                const one = editorFixture('|' + text)
                const two = editorFixture('|' + text)
                foldSome(one, picks)
                foldSome(two, picks)
                const bullets = Array.from({ length: one.state.doc.lines }, (_, i) => i + 1).filter((l) => blockRange(one.state, l))
                // A fold the caret's own pane opens, by the caret being put in it or by the key, is that pane's alone.
                const wordsOf = (editor: HeadlessEditor) => foldedBulletLines(editor.state).map((l) => editor.state.doc.line(l).text.trim()).sort()
                const before = wordsOf(one)
                placeCaret(one, bullets[which % bullets.length], 2)
                const was = shown(one)
                press(one, key)
                const change = minimalReplacement(two.text(), one.text())
                if (!change) return
                two.dispatch(two.state.update({ changes: change }))
                checkFolds(two, `${key} at ${was} heard as ${JSON.stringify(change)} → ${shown(two)}`)
                // The pane that pressed the key and the pane that heard it agree, where the key opened no fold.
                if (JSON.stringify(wordsOf(one)) === JSON.stringify(before)) expect(wordsOf(two), `${key} at ${was} heard as ${JSON.stringify(change)} → ${shown(two)}`).toEqual(wordsOf(one))
            }),
            fuzz(400),
        )
    })
})

describe('kept folds', { timeout: 60_000 }, () => {
    it('folds kept and read back on the same text come back on the same bullets', () => {
        fc.assert(
            fc.property(outlineArb, fc.array(fc.nat(), { minLength: 1, maxLength: 4 }), (items, picks) => {
                const editor = editorFixture('|' + render(items).join('\n'))
                foldSome(editor, picks)
                const kept = keptFoldsOf(editor.state)
                // foldedBulletLines follows CodeMirror's range set, which lists nested folds after the others.
                expect(resolveKeptFolds(editor.state, kept), shown(editor)).toEqual([...foldedBulletLines(editor.state)].sort((a, b) => a - b))
            }),
            fuzz(300),
        )
    })

    // Was KEPT_FOLD_BY_TEXT_ONLY: a kept fold is its bullet's line and a fingerprint of the bullet's
    // words alone, and is taken first at its old line when the bullet there has the same words and
    // children. Shrunk: "- Garden\n  - Garden\n    - Garden\n- Garden\n- Garden" with line 2 folded;
    // one line added above, line 2 is the outer "- Garden" (old line 1), which has the same words and
    // children, so the PARENT comes back folded and the whole branch is hidden. A journal repeats
    // bullets such as "Comments" under every task.
    it('folds kept before lines were added above them come back on the same bullets', () => {
        // ADR 0191: a kept fold is found "at its line, or else at the nearest line with the same
        // fingerprint". Another device, or another tool, adds lines above while the document is closed.
        fc.assert(
            fc.property(outlineArb, fc.array(fc.nat(), { minLength: 1, maxLength: 3 }), fc.integer({ min: 1, max: 8 }), (items, picks, added) => {
                const lines = render(items)
                const editor = editorFixture('|' + lines.join('\n'))
                foldSome(editor, picks)
                const kept = keptFoldsOf(editor.state)
                const folded = foldedBulletLines(editor.state)
                const above = Array.from({ length: added }, (_, i) => `- note ${i + 1}`)
                const reopened = editorFixture('|' + [...above, ...lines].join('\n'))
                expect(resolveKeptFolds(reopened.state, kept), `${shown(editor)} with ${added} lines added above`).toEqual(folded.map((l) => l + added).sort((a, b) => a - b))
            }),
            fuzz(300),
        )
    })
})
