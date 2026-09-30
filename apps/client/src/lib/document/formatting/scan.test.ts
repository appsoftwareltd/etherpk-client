/**
 * A Formatting Scan over a graph's documents (ADR 0109), against a fake source: what it lists,
 * skips and reports, how Cancel keeps what was checked, and what approving an issue does to the
 * page's issues afterwards.
 */

import { describe, expect, it } from 'vitest'

import type { SpliceOutcome } from '../types'
import type { TextSplice } from '../wikilink/rename'
import { type DocumentRead, type FormattingIssue, type FormattingSource, approveAll, approveIssue, revealLineOf, scanGraph } from './scan'

type Page = string | { unread: 'syncing' | 'unreadable' }

/** A graph in memory, written the way the stores write: only when the text is as expected. */
function fakeSource(pages: Record<string, Page>, options: { chunkSize?: number; outcome?: (key: string) => SpliceOutcome | Error | undefined } = {}) {
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
                if (page === undefined) out.set(key, { kind: 'gone' })
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

describe('revealLineOf', () => {
    it("gives the issue's first line below the frontmatter, as the editor's reveal counts lines", async () => {
        const source = fakeSource({ a: '---\ntitle: A\n---\n- a\n* b', b: '---\r\ntitle: B\r\n---\r\n- b' })
        const { issues } = await scanGraph(source, { signal: never })
        expect(revealLineOf(issue(issues, 'bullet-marker', 'a'))).toBe(1)
        // A line-endings fix starts in the frontmatter, which the editor shows from the top.
        expect(revealLineOf(issue(issues, 'line-endings', 'b'))).toBe(0)
    })
})
