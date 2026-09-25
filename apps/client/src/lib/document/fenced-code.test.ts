import { describe, expect, it } from 'vitest'

import {
    buildFenceCompletion,
    codeLineText,
    defangFence,
    fencedBlocks,
    fenceLineInfo,
    isUnterminatedOpener,
    normaliseFenceLines,
    parseFenceOpener,
} from './fenced-code'

describe('fencedBlocks — balance-aware, outliner-block-scoped pairing', () => {
    const ranges = (text: string) => fencedBlocks(text.split('\n')).map((b) => [b.start, b.end])

    it('pairs a simple opener and closer', () => {
        expect(ranges('```js\ncode\n```')).toEqual([[0, 2]])
    })

    it('omits an unterminated opener (no closer yet)', () => {
        expect(ranges('```js\nstill typing\nmore prose')).toEqual([])
    })

    it('an unterminated opener does NOT steal the closer of a completed block below it', () => {
        // ```js (incomplete) above a real ```python…``` block: only the python block is complete.
        expect(ranges('```js\nsome\n```python\ncode\n```')).toEqual([[2, 4]])
    })

    it('an info-bearing fence is always an opener, never a closer', () => {
        // The second ```ts must not be read as closing the first.
        expect(ranges('```ts\na\n```ts\nb')).toEqual([])
    })

    it('a shorter fence inside a longer one is literal content (4-backtick contains 3-backtick)', () => {
        expect(ranges('````\n```js\ncode\n```\n````')).toEqual([[0, 4]])
    })

    it('two independent top-level blocks pair separately', () => {
        expect(ranges('```js\na\n```\n\n```py\nb\n```')).toEqual([
            [0, 2],
            [4, 6],
        ])
    })

    it('a bullet fence is closed only within its own block, not by a sibling bullet below', () => {
        // Bullet "a" opens a fence with no closer; bullet "b" has its own complete block — they must
        // not pair across the block boundary (the dedent to "- b" ends bullet a's fence).
        const doc = ['- a', '  ```js', '  code', '- b', '  ```py', '  more', '  ```'].join('\n')
        expect(ranges(doc)).toEqual([[4, 6]])
    })

    it('a complete fence inside a bullet pairs at the content column', () => {
        expect(ranges('- a\n  ```js\n  code\n  ```')).toEqual([[1, 3]])
    })

    it('an unterminated top-level fence does not swallow a deeper completed bullet block', () => {
        const doc = ['```', 'prose', '- item', '  ```js', '  code', '  ```'].join('\n')
        expect(ranges(doc)).toEqual([[3, 5]])
    })
})

describe('fence opener detection', () => {
    it('detects bare backticks (3+)', () => {
        expect(parseFenceOpener('```')).toEqual({ ticks: '```', info: '' })
        expect(parseFenceOpener('````')).toEqual({ ticks: '````', info: '' })
    })
    it('detects an opener with an info-string', () => {
        expect(parseFenceOpener('```ts')).toEqual({ ticks: '```', info: 'ts' })
        expect(parseFenceOpener('```c++')).toEqual({ ticks: '```', info: 'c++' })
    })
    it('ignores leading indent and trailing whitespace', () => {
        expect(parseFenceOpener('   ```py')).toEqual({ ticks: '```', info: 'py' })
        expect(parseFenceOpener('```ts   ')).toEqual({ ticks: '```', info: 'ts' })
    })
    it('rejects non-openers', () => {
        expect(parseFenceOpener('``')).toBeNull()
        expect(parseFenceOpener('text')).toBeNull()
        expect(parseFenceOpener('``` not a clean opener```')).toBeNull()
    })
})

describe('fence completion', () => {
    it('prose: bare backticks get default lang, blank middle, balanced closer', () => {
        expect(buildFenceCompletion({ indent: '', ticks: '```', info: '', defaultLang: 'text' })).toEqual({
            insert: 'text\n\n```',
            caretOffset: 'text\n'.length,
        })
    })
    it('keeps a user-typed info-string (no default injected)', () => {
        expect(buildFenceCompletion({ indent: '', ticks: '```', info: 'ts', defaultLang: 'text' })).toEqual({
            insert: '\n\n```',
            caretOffset: '\n'.length,
        })
    })
    it('mirrors the backtick count (4 → 4)', () => {
        expect(buildFenceCompletion({ indent: '', ticks: '````', info: '', defaultLang: 'text' })).toEqual({
            insert: 'text\n\n````',
            caretOffset: 'text\n'.length,
        })
    })
    it('bullet: indents the middle line + closer to the content column', () => {
        expect(buildFenceCompletion({ indent: '  ', ticks: '```', info: '', defaultLang: 'text' })).toEqual({
            insert: 'text\n  \n  ```',
            caretOffset: 'text\n  '.length,
        })
    })
})

describe('fence line info (opener/closer detection, bullet-tolerant)', () => {
    it('reads a bare fence, an info fence, an indented fence, and a bullet fence', () => {
        expect(fenceLineInfo('```')).toMatchObject({ col: 0, run: '```', char: '`', len: 3, info: '' })
        expect(fenceLineInfo('```ts')).toMatchObject({ col: 0, info: 'ts' })
        expect(fenceLineInfo('  ```')).toMatchObject({ col: 2, info: '' })
        expect(fenceLineInfo('- ```js')).toMatchObject({ col: 2, info: 'js' })
        expect(fenceLineInfo('````')).toMatchObject({ len: 4 })
    })
    it('rejects non-fences and task bullets', () => {
        expect(fenceLineInfo('text')).toBeNull()
        expect(fenceLineInfo('- a bullet')).toBeNull()
        expect(fenceLineInfo('- [ ] ```')).toBeNull() // task content fences are out of scope
    })
})

describe('the balance check (isUnterminatedOpener): Enter completes only an unterminated opener', () => {
    it('a lone opener — bare, with an info-string, or on a bullet — is unterminated', () => {
        expect(isUnterminatedOpener(['```'], 0)).toBe(true)
        expect(isUnterminatedOpener(['```js'], 0)).toBe(true)
        expect(isUnterminatedOpener(['- ```'], 0)).toBe(true)
        expect(isUnterminatedOpener(['- a', '  ```', '  x'], 1)).toBe(true)
    })
    it('the opener of a complete block is not — whether the block is empty or holds content', () => {
        expect(isUnterminatedOpener(['```', '', '```'], 0)).toBe(false) // the empty block completion just made
        // The reported bug: only the empty shape was recognised, so Enter here grew a second closer.
        expect(isUnterminatedOpener(['```', 'real code', '```'], 0)).toBe(false)
        expect(isUnterminatedOpener(['```js', 'real code', '```'], 0)).toBe(false)
        expect(isUnterminatedOpener(['````', 'real code', '````'], 0)).toBe(false)
        expect(isUnterminatedOpener(['- ```', '  real code', '  ```'], 0)).toBe(false) // …and inside a bullet
        expect(isUnterminatedOpener(['- a', '  ```', '  real code', '  ```'], 1)).toBe(false) // …form-2 too
    })
    it('a longer bare fence never closes a shorter opener: the block below keeps its own opener', () => {
        // Live, 2026-09-12: a stray ``` above a ```` block took that block's opener as its closer,
        // leaving "Test" and the real closer dangling. A closer is exactly the opener's length.
        expect(fencedBlocks(['```', 'x', '````', 'Test', '````'])).toEqual([{ start: 2, end: 4, fenceColumn: 0 }])
        // A longer run is never a shorter block's content: it opens the next block and the shorter
        // opener is a stray (CommonMark would have closed the block with it — either way `y` dangles).
        expect(fencedBlocks(['```', 'x', '````', 'y', '```'])).toEqual([])
        expect(isUnterminatedOpener(['```', 'x', '````', 'Test', '````'], 0)).toBe(true)
        expect(isUnterminatedOpener(['```', 'x', '````', 'Test', '````'], 2)).toBe(false)
    })
    it('the opener of a complete block stays paired when a longer or equal block follows it', () => {
        // Live, 2026-09-11: Enter at the end of the first block's opener grew a second closer. Set
        // aside, its closer paired with the NEXT block's opener (a 4-tick fence closes a 3-tick one),
        // and that block "starting inside the candidate" was misread as a swallowed one.
        expect(isUnterminatedOpener(['```', '', 'Test', '```', '', '````', 'Test', '````'], 0)).toBe(false)
        expect(isUnterminatedOpener(['```', 'a', '```', '```', 'b', '```'], 0)).toBe(false)
        expect(isUnterminatedOpener(['```', 'a', '```', '', '```js', 'b', '```'], 0)).toBe(false)
        // …while a fresh opener above TWO complete blocks is still seen to have swallowed the first.
        expect(isUnterminatedOpener(['```', '', '```', 'code', '```', '```', 'more', '```'], 0)).toBe(true)
    })
    it('a closing fence is not an opener (Enter on it must not generate another pair)', () => {
        expect(isUnterminatedOpener(['```js', 'code', '```'], 2)).toBe(false)
        expect(isUnterminatedOpener(['- ```', '  code', '  ```'], 2)).toBe(false) // …also inside a bullet block
        expect(isUnterminatedOpener(['```', 'x', '```', '```'], 2)).toBe(false) // a stray below never re-opens a real closer
    })
    it('a shorter fence inside a longer block is content, not an opener', () => {
        const lines = ['````', '```', 'inner', '```', '````']
        expect(isUnterminatedOpener(lines, 1)).toBe(false)
        expect(isUnterminatedOpener(lines, 3)).toBe(false)
        expect(isUnterminatedOpener(lines, 4)).toBe(false) // the final ```` is the closer
        expect(isUnterminatedOpener(['````', '```js', '````'], 1)).toBe(false)
    })
    it('a new top-level opener above a complete block is unterminated, whatever that block’s fences are', () => {
        expect(isUnterminatedOpener(['```', '', '```js', 'code', '```'], 0)).toBe(true) // an info opener below can never close it
        // Under first-with-next pairing the fresh opener takes the block's bare opener as its closer; set
        // aside and re-paired, that "closer" heads a complete block again — it was stolen, so line 0 is open.
        expect(isUnterminatedOpener(['```', '', '```', 'code', '```'], 0)).toBe(true)
        expect(isUnterminatedOpener(['```js', '', '```', 'code', '```'], 0)).toBe(true) // a fresh INFO opener steals too
    })
    it('a sibling bullet opener directly below is NOT mistaken for the closer (a bullet fence opens)', () => {
        // The just-typed `- ``` ` (line 0) sits directly above another bullet that opens an already-
        // complete block. No bullet fence can close line 0, so the raw scan runs on to that block's
        // closer and swallows it whole; set aside, the block below is intact — line 0 still completes.
        expect(isUnterminatedOpener(['- ```', '- ```', '  done', '  ```'], 0)).toBe(true)
    })
    it('a stray unterminated fence above never makes a complete block’s opener look fresh', () => {
        expect(isUnterminatedOpener(['```', 'prose', '```js', 'code', '```'], 2)).toBe(false)
    })
    it('a stray unterminated prose fence above never makes a deeper outliner fence a closer', () => {
        // Junk balance anywhere above used to swallow completion inside bullets.
        const lines = ['```', '', '- a', '  - ```'] // col-0 opener left dangling far above
        expect(isUnterminatedOpener(lines, 3)).toBe(true) // the bullet fence still completes
    })
    it('orphaned bullet fences above never make the next bullet fence a closer', () => {
        const lines = ['- Test', '  - ```', '  - ```', '  - ```'] // earlier attempts left orphans
        expect(isUnterminatedOpener(lines, 3)).toBe(true) // the newest `- ``` ` still completes
        expect(isUnterminatedOpener(lines, 2)).toBe(true)
    })
    it('the analysis’s pending fence is set aside, and is itself unterminated', () => {
        const lines = ['```', '', '```', '```']
        // Line 3 was just typed (pending): with it aside, line 0 heads the complete empty block above it.
        expect(isUnterminatedOpener(lines, 0, 3)).toBe(false)
        expect(isUnterminatedOpener(lines, 3, 3)).toBe(true)
        // Line 0 was just typed instead: it is the fresh one, and the block below it is intact.
        expect(isUnterminatedOpener(lines, 0, 0)).toBe(true)
    })
    it('a non-fence line is never an opener', () => {
        expect(isUnterminatedOpener(['code'], 0)).toBe(false)
    })
    it('defangFence neutralises only the fence run, keeping indent, bullet marker and info-string', () => {
        expect(defangFence('  - ```js')).toBe('  - xjs')
        expect(defangFence('~~~')).toBe('x')
    })
})

describe('codeLineText', () => {
    it('drops the indentation up to the fence column and keeps what lies past it', () => {
        expect(codeLineText('  if (a) {', 2)).toBe('if (a) {')
        expect(codeLineText('      return 1', 2)).toBe('    return 1')
        expect(codeLineText('\t\tx', 1)).toBe('\tx')
    })

    it('reads a blank line, or one short of the column, as its text alone', () => {
        expect(codeLineText('', 4)).toBe('')
        expect(codeLineText(' x', 4)).toBe('x')
    })
})

describe('closerTolerance (guard-only)', () => {
    it('pairs a closer nudged ≤3 columns right; the strict scan does not', () => {
        const lines = ['```js', 'code', '   ```'] // a raw edit pushed the closer right by 3
        expect(fencedBlocks(lines)).toEqual([]) // strict (visual/completion): not a closer
        expect(fencedBlocks(lines, 3)).toEqual([{ start: 0, end: 2, fenceColumn: 0 }]) // guard: repairable
        expect(fencedBlocks(['```js', 'code', '    ```'], 3)).toEqual([]) // 4 columns is past the tolerance
    })
})

describe('fence normalisation (hard guard backstop)', () => {
    it('pads under-indented content and clamps the closer indent', () => {
        expect(normaliseFenceLines(['  ```ts', 'code', '   ```'], 2, '```')).toEqual(['  ```ts', '  code', '  ```'])
    })
    it('rebalances a mismatched closer tick count to the opener', () => {
        expect(normaliseFenceLines(['  ````ts', '  code', '  ```'], 2, '````')).toEqual([
            '  ````ts',
            '  code',
            '  ````',
        ])
    })
    it('leaves a well-formed block untouched', () => {
        const block = ['  ```ts', '  code', '  ```']
        expect(normaliseFenceLines(block, 2, '```')).toEqual(block)
    })
    it('leaves a 3-backtick content line inside a 4-backtick block alone', () => {
        const block = ['  ````md', '  ```', '  inner', '  ```', '  ````']
        expect(normaliseFenceLines(block, 2, '````')).toEqual(block)
    })
    it('does not pad blank middle lines', () => {
        expect(normaliseFenceLines(['  ```ts', '', '  ```'], 2, '```')).toEqual(['  ```ts', '', '  ```'])
    })
})
