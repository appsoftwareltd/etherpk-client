/**
 * A Formatting Scan over a graph's documents (ADR 0109), against a fake source: what it lists,
 * skips and reports, how Cancel keeps what was checked, and what approving an issue does to the
 * page's issues afterwards.
 */

import { describe, expect, it } from 'vitest'

import type { SpliceOutcome } from '../types'
import type { TextSplice } from '../wikilink/rename'
import { type DocumentRead, type FormattingIssue, type FormattingSource, approveAll, approveEverything, approveIssue, recheckPage, revealLineOf, scanGraph } from './scan'

type Page = string | { unread: 'syncing' | 'unreadable' }

/** A graph in memory, written the way the stores write: only when the text is as expected. */
function fakeSource(
    pages: Record<string, Page>,
    options: { chunkSize?: number; outcome?: (key: string) => SpliceOutcome | Error | undefined; syncingAfterWrite?: boolean } = {},
) {
    const written = new Set<string>()
    const store = new Map<string, Page>(Object.entries(pages))
    const reads: string[][] = []
    const source: FormattingSource & { store: Map<string, Page>; reads: string[][] } = {
        store,
        reads,
        chunkSize: options.chunkSize ?? 2,
        async list() {
            return Object.keys(pages).map((key) => ({ key, concept: `Page ${key}`, kind: 'page' as const }))
        },
        async read(keys) {
            reads.push([...keys])
            const out = new Map<string, DocumentRead>()
            for (const key of keys) {
                const page = store.get(key)
                // A synced store that cannot yet confirm its own write says the page is still syncing.
                if (options.syncingAfterWrite && written.has(key)) out.set(key, { kind: 'unread', reason: 'syncing' })
                else if (page === undefined) out.set(key, { kind: 'gone' })
                else if (typeof page === 'string') out.set(key, { kind: 'text', text: page })
                else out.set(key, { kind: 'unread', reason: page.unread })
            }
            return out
        },
        async write(key: string, expected: string, splices: readonly TextSplice[]) {
            const forced = options.outcome?.(key)
            if (forced instanceof Error) throw forced
            if (forced) return forced
            const page = store.get(key)
            if (typeof page !== 'string') return 'gone'
            if (page.includes('```etherpk-cipher')) return 'protected'
            if (page !== expected) return 'changed'
            let text = page
            for (const s of [...splices].reverse()) text = text.slice(0, s.from) + s.insert + text.slice(s.to)
            store.set(key, text)
            written.add(key)
            return 'written'
        },
    }
    return source
}

const never = new AbortController().signal

const issue = (issues: readonly FormattingIssue[], check: string, key: string) => issues.find((i) => i.check === check && i.document.key === key)!

describe('scanGraph', () => {
    it("lists each page's issues in registry order, page by page", async () => {
        const source = fakeSource({ a: '- a\r\n\t- b', b: '* x', c: '- clean' })
        const report = await scanGraph(source, { signal: never })
        expect(report.issues.map((i) => `${i.document.key}:${i.check}`)).toEqual(['a:indentation', 'a:line-endings', 'b:bullet-marker'])
        expect(report).toMatchObject({ total: 3, checked: 3, protectedCount: 0, unread: [], stopped: false })
        expect(issue(report.issues, 'indentation', 'a')).toMatchObject({ status: 'pending', scannedText: '- a\r\n\t- b', id: 'indentation:a' })
    })

    it('skips and counts Protected Documents, and lists the pages it could not read', async () => {
        const source = fakeSource({
            a: '```etherpk-cipher\nx\n```\n\t- b',
            b: { unread: 'syncing' },
            c: { unread: 'unreadable' },
            d: '* x',
        })
        const report = await scanGraph(source, { signal: never })
        expect(report.protectedCount).toBe(1)
        expect(report.checked).toBe(1)
        expect(report.unread.map((u) => [u.document.key, u.reason])).toEqual([
            ['b', 'syncing'],
            ['c', 'unreadable'],
        ])
        expect(report.issues.map((i) => i.document.key)).toEqual(['d'])
    })

    it('reads in chunks and reports progress after each', async () => {
        const source = fakeSource({ a: '- a', b: '- b', c: '- c', d: '- d', e: '- e' })
        const progress: [number, number][] = []
        await scanGraph(source, { signal: never, onProgress: (done, total) => progress.push([done, total]) })
        expect(source.reads).toEqual([['a', 'b'], ['c', 'd'], ['e']])
        expect(progress).toEqual([
            [0, 5],
            [2, 5],
            [4, 5],
            [5, 5],
        ])
    })

    it('keeps what it checked when cancelled, and says it stopped', async () => {
        const controller = new AbortController()
        const source = fakeSource({ a: '* a', b: '- b', c: '* c', d: '* d' })
        const report = await scanGraph(source, {
            signal: controller.signal,
            onProgress: (done) => {
                if (done === 2) controller.abort()
            },
        })
        expect(report).toMatchObject({ stopped: true, checked: 2, total: 4 })
        expect(report.issues.map((i) => i.document.key)).toEqual(['a'])
    })

    it('leaves out a page deleted between the listing and the read', async () => {
        const source = fakeSource({ a: '* a', b: '* b' })
        source.store.delete('b')
        const report = await scanGraph(source, { signal: never })
        expect(report).toMatchObject({ total: 2, checked: 1 })
        expect(report.issues.map((i) => i.document.key)).toEqual(['a'])
    })
})

describe('approveIssue', () => {
    it("writes the fix, marks it fixed, and re-checks the page's other issues against its new text", async () => {
        const source = fakeSource({ a: '\u{a0}\u{a0}- a\r\n\t- b\r\n' })
        const { issues } = await scanGraph(source, { signal: never })
        const noBreak = issue(issues, 'no-break-space-indent', 'a')
        await approveIssue(source, issues, noBreak)

        expect(noBreak.status).toBe('fixed')
        const fixed = '  - a\r\n\t- b\r\n'
        expect(source.store.get('a')).toBe(fixed)
        expect(issue(issues, 'indentation', 'a')).toMatchObject({ status: 'pending', scannedText: fixed })
        expect(issue(issues, 'line-endings', 'a')).toMatchObject({ status: 'pending', scannedText: fixed })
    })

    it('shows the re-checked diff when the page changed after the scan, and writes nothing', async () => {
        const source = fakeSource({ a: '* a' })
        const { issues } = await scanGraph(source, { signal: never })
        source.store.set('a', '* a\n* typed later')
        const bullets = issue(issues, 'bullet-marker', 'a')
        await approveIssue(source, issues, bullets)

        expect(source.store.get('a')).toBe('* a\n* typed later')
        expect(bullets).toMatchObject({ status: 'changed', scannedText: '* a\n* typed later' })
        expect(bullets.finding.fixed).toBe('- a\n- typed later')
    })

    it('says so when the page changed and no longer has the issue', async () => {
        const source = fakeSource({ a: '* a' })
        const { issues } = await scanGraph(source, { signal: never })
        source.store.set('a', '- a')
        const bullets = issue(issues, 'bullet-marker', 'a')
        await approveIssue(source, issues, bullets)
        expect(bullets.status).toBe('resolved')
    })

    it('adds an issue a fix brings to light', async () => {
        // The bullet fix makes `    * b` a `-` bullet four columns under its parent: off the grid.
        const source = fakeSource({ a: '- a\n    * b' })
        const { issues } = await scanGraph(source, { signal: never })
        expect(issues.map((i) => i.check)).toEqual(['bullet-marker']) // to the outline, `* b` is a soft line
        await approveIssue(source, issues, issue(issues, 'bullet-marker', 'a'))
        expect(issue(issues, 'indentation', 'a')).toMatchObject({ status: 'pending', scannedText: '- a\n    - b' })
    })

    it('marks every open issue on a page gone or protected when the write says so', async () => {
        const gone = fakeSource({ a: '* a\r\n' })
        const found = await scanGraph(gone, { signal: never })
        gone.store.delete('a')
        await approveIssue(gone, found.issues, issue(found.issues, 'bullet-marker', 'a'))
        expect(found.issues.map((i) => i.status)).toEqual(['gone', 'gone'])

        const sealed = fakeSource({ a: '* a\r\n' })
        const scanned = await scanGraph(sealed, { signal: never })
        sealed.store.set('a', '```etherpk-cipher\nx\n```')
        await approveIssue(sealed, scanned.issues, issue(scanned.issues, 'bullet-marker', 'a'))
        expect(scanned.issues.map((i) => i.status)).toEqual(['protected', 'protected'])
    })

    it('keeps the issue ready to try again when the page is still syncing, or the write fails', async () => {
        const source = fakeSource({ a: '* a', b: '* b' }, { outcome: (key) => (key === 'a' ? 'unconfirmed' : new Error('The disk is full')) })
        const { issues } = await scanGraph(source, { signal: never })
        await approveIssue(source, issues, issue(issues, 'bullet-marker', 'a'))
        await approveIssue(source, issues, issue(issues, 'bullet-marker', 'b'))
        expect(issue(issues, 'bullet-marker', 'a').status).toBe('unconfirmed')
        expect(issue(issues, 'bullet-marker', 'b')).toMatchObject({ status: 'failed', error: 'The disk is full' })
    })

    it('does nothing for an issue that is only reported', async () => {
        const source = fakeSource({ a: '```js\nx' })
        const { issues } = await scanGraph(source, { signal: never })
        const unclosed = issue(issues, 'unclosed-fence', 'a')
        await approveIssue(source, issues, unclosed)
        expect(unclosed.status).toBe('pending')
        expect(source.store.get('a')).toBe('```js\nx')
    })
})

describe('after a fix is written', () => {
    it("re-checks the page's other issues against the fix, even while the store cannot confirm its write", async () => {
        const source = fakeSource({ a: '* a\r\n' }, { syncingAfterWrite: true })
        const { issues } = await scanGraph(source, { signal: never })
        await approveIssue(source, issues, issue(issues, 'bullet-marker', 'a'))
        expect(issue(issues, 'line-endings', 'a')).toMatchObject({ status: 'pending', scannedText: '- a\r\n' })

        await approveIssue(source, issues, issue(issues, 'line-endings', 'a'))
        expect(issue(issues, 'line-endings', 'a').status).toBe('fixed')
        expect(source.store.get('a')).toBe('- a\n')
    })

    it('puts a fixed issue back to pending, not changed, when another of the scan\'s own fixes brings it back', () => {
        const document = { key: 'a', concept: 'Page a', kind: 'page' as const }
        const fixed: FormattingIssue = { id: 'bullet-marker:a', check: 'bullet-marker', document, scannedText: '* a', finding: { lines: [0], fixed: '- a', reason: '' }, status: 'fixed' }
        const issues = [fixed]
        recheckPage(issues, document, '- a\n* b')
        expect(fixed).toMatchObject({ status: 'pending', scannedText: '- a\n* b' })
    })

    it('does not call a page changed when opening it in the editor only turned its line endings into line feeds', async () => {
        // The editor's buffer holds every line ending as \n, and an open page is read and written through it.
        const source = fakeSource({ a: '* a\r\n* b\r\n' })
        const { issues } = await scanGraph(source, { signal: never })
        source.store.set('a', '* a\n* b\n')
        const bullets = issue(issues, 'bullet-marker', 'a')
        await approveIssue(source, issues, bullets)
        expect(bullets).toMatchObject({ status: 'pending', scannedText: '* a\n* b\n' })
        expect(issue(issues, 'line-endings', 'a').status).toBe('resolved')

        await approveIssue(source, issues, bullets)
        expect(bullets.status).toBe('fixed')
        expect(source.store.get('a')).toBe('- a\n- b\n')
    })

    it('marks a fixed issue changed when a refused write shows someone else brought it back', () => {
        const document = { key: 'a', concept: 'Page a', kind: 'page' as const }
        const fixed: FormattingIssue = { id: 'bullet-marker:a', check: 'bullet-marker', document, scannedText: '* a', finding: { lines: [0], fixed: '- a', reason: '' }, status: 'fixed' }
        const refused: FormattingIssue = { id: 'line-endings:a', check: 'line-endings', document, scannedText: '- a\r\n', finding: { lines: [0], fixed: '- a\n', reason: '' }, status: 'pending' }
        const issues = [fixed, refused]
        recheckPage(issues, document, '- a\r\n* typed later\r\n', refused)
        expect(fixed.status).toBe('changed')
        expect(refused.status).toBe('changed')
    })
})

describe('approveAll', () => {
    it("fixes a check's pending issues one by one, leaves skipped ones, and counts what changed", async () => {
        const source = fakeSource({ a: '* a', b: '* b', c: '* c', d: '- d\r\n' })
        const { issues } = await scanGraph(source, { signal: never })
        issue(issues, 'bullet-marker', 'b').status = 'skipped'
        source.store.set('c', '* c\n* typed later')

        const tally = await approveAll(source, issues, 'bullet-marker')

        expect(tally).toEqual({ total: 2, fixed: 1, changed: 1 })
        expect(source.store.get('a')).toBe('- a')
        expect(source.store.get('b')).toBe('* b')
        expect(issue(issues, 'bullet-marker', 'c').status).toBe('changed')
        expect(issue(issues, 'line-endings', 'd').status).toBe('pending')
    })
})

describe('approveEverything', () => {
    it("fixes every check's pending issues in registry order, one page at a time, and leaves what it cannot fix", async () => {
        const source = fakeSource({
            a: '* a\r\n', // bullet-marker, then line-endings, on one page
            b: '- b\n\t- c', // indentation
            c: '* c', // skipped, so left alone
            d: '- d\n  ```js', // only reported
            e: '- e\n    * f', // the bullet fix brings an indentation issue to light, which is fixed too
            f: '* f', // changed after the scan, so shown again rather than written
        })
        const { issues } = await scanGraph(source, { signal: never })
        issue(issues, 'bullet-marker', 'c').status = 'skipped'
        source.store.set('f', '* f\n* typed later')

        const checks: string[] = []
        const progress: [number, number][] = []
        const tally = await approveEverything(source, issues, {
            onCheck: (check) => checks.push(check),
            onProgress: (done, total) => progress.push([done, total]),
        })

        expect(checks).toEqual(['bullet-marker', 'indentation', 'line-endings'])
        expect(source.store.get('a')).toBe('- a\n')
        expect(source.store.get('b')).toBe('- b\n  - c')
        expect(source.store.get('c')).toBe('* c')
        expect(source.store.get('d')).toBe('- d\n  ```js')
        expect(source.store.get('e')).toBe('- e\n  - f')
        expect(source.store.get('f')).toBe('* f\n* typed later')
        expect(issue(issues, 'bullet-marker', 'f').status).toBe('changed')
        expect(tally).toEqual({ total: 6, fixed: 5, changed: 1 })
        // Progress counts up to a total that grows when a fix brings another issue to light.
        expect(progress[0]).toEqual([0, 5])
        expect(progress.at(-1)).toEqual([6, 6])
    })
})

describe('approveEverything until the fixes settle', () => {
    it('goes round again when a fix leaves its own check more to do, and leaves nothing to approve', async () => {
        // The bullet fix makes `*` a `-` bullet, and the parser then reads the `+` after it as an item of its own.
        const source = fakeSource({ a: '-\r\n     * + # b \t\n' })
        const { issues } = await scanGraph(source, { signal: never })
        const tally = await approveEverything(source, issues)
        expect(issues.filter((i) => i.status === 'pending' && i.finding.fixed !== null)).toEqual([])
        expect(issues.filter((i) => i.status === 'changed')).toEqual([])
        expect(tally.changed).toBe(0)
        expect(tally.fixed).toBe(tally.total)
    })
})

describe('revealLineOf', () => {
    it("gives the issue's first line below the frontmatter, as the editor's reveal counts lines", async () => {
        const source = fakeSource({ a: '---\ntitle: A\n---\n- a\n* b', b: '---\r\ntitle: B\r\n---\r\n- b' })
        const { issues } = await scanGraph(source, { signal: never })
        expect(revealLineOf(issue(issues, 'bullet-marker', 'a'))).toBe(1)
        // A line-endings fix starts in the frontmatter, which the editor shows from the top.
        expect(revealLineOf(issue(issues, 'line-endings', 'b'))).toBe(0)
    })
})
