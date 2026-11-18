/**
 * Properties of approving Formatting Scan fixes (ADR 0109), over random graphs and a fake store
 * that writes the way the real ones do (a compare-and-set), with someone else editing pages between
 * the scan's writes, a synced store that cannot confirm its own writes at once, and writes that fail
 * or cannot be confirmed. Approve all can rewrite every page of a graph, so what it may change is
 * pinned down here rather than by examples alone:
 *
 * - it changes only whitespace and list markers: every word on every page, and every word someone
 *   typed while it ran, is still there and in the same order;
 * - it never writes over an edit it did not see;
 * - it reports a page as changed since the scan only when someone did change it, and not when the
 *   page was only opened in the editor, which reads its line endings as line feeds;
 * - on a page nobody touched and every write went through, it leaves nothing it could fix.
 *
 * Fixed seeds keep the suite deterministic in CI. To hunt for new counterexamples, run with
 * `EDITOR_FUZZ_SEED=<n>` (any integer) and optionally `EDITOR_FUZZ_RUNS=<n>`.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { SpliceOutcome } from '../types'
import type { TextSplice } from '../wikilink/rename'
import { FORMATTING_CHECKS, findIssues } from './checks'
import { documentText } from './document-text.arbitrary'
import { approveAll, approveEverything, approveIssue, type DocumentRead, type FormattingSource, scanGraph } from './scan'

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.EDITOR_FUZZ_SEED
    return { numRuns: Number(process.env.EDITOR_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261118 : Number(seed) }
}

/** What happens around one write the scan makes. */
type Event =
    | { kind: 'quiet' }
    | { kind: 'edit'; page: number; line: string } // someone appends a line to a page just before the write
    | { kind: 'open'; page: number } // the page is opened in the editor, whose buffer holds every line ending as \n
    | { kind: 'fail' } // the write throws
    | { kind: 'unconfirmed' } // the store cannot bring the page current

const event: fc.Arbitrary<Event> = fc.oneof(
    { weight: 6, arbitrary: fc.constant({ kind: 'quiet' as const }) },
    {
        weight: 2,
        arbitrary: fc.record({
            kind: fc.constant('edit' as const),
            page: fc.nat(4),
            line: fc.constantFrom('- beans', '* north bed', 'shed', '\t- water', '-', '  - '),
        }),
    },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant('open' as const), page: fc.nat(4) }) },
    { weight: 1, arbitrary: fc.constant({ kind: 'fail' as const }) },
    { weight: 1, arbitrary: fc.constant({ kind: 'unconfirmed' as const }) },
)

const scenario = fc.record({
    pages: fc.array(documentText, { minLength: 1, maxLength: 5 }),
    events: fc.array(event, { maxLength: 30 }),
    // A synced store whose read right after its own write says the page is still syncing.
    syncingAfterWrite: fc.boolean(),
})

/**
 * The words of a text in order, with the list markers a fix may rewrite read as one: a fix may
 * change whitespace and turn `*` or `+` into `-`, and nothing else.
 */
function words(text: string): string[] {
    return text
        .split(/\s+/u)
        .filter((word) => word !== '')
        .map((word) => (word === '*' || word === '+' ? '-' : word))
}

/** A graph in a map, written only by compare-and-set, with someone else's edits played in between. */
function graphOf(pages: readonly string[], events: readonly Event[], syncingAfterWrite: boolean) {
    const store = new Map(pages.map((text, i) => [`p${i}`, text]))
    /** Each page's own text plus everything appended to it: the words that must survive. */
    const expectedWords = new Map(pages.map((text, i) => [`p${i}`, text]))
    const touched = new Set<string>() // pages someone else edited
    const troubled = new Set<string>() // pages with a write that failed or could not be confirmed
    const written = new Set<string>()
    let next = 0
    const source: FormattingSource = {
        chunkSize: 2,
        async list() {
            return pages.map((_, i) => ({ key: `p${i}`, concept: `Page ${i}`, kind: 'page' as const }))
        },
        async read(keys) {
            const out = new Map<string, DocumentRead>()
            for (const key of keys) {
                if (syncingAfterWrite && written.has(key)) out.set(key, { kind: 'unread', reason: 'syncing' })
                else out.set(key, { kind: 'text', text: store.get(key)! })
            }
            return out
        },
        async write(key: string, expected: string, splices: readonly TextSplice[]): Promise<SpliceOutcome> {
            const happening = events[next++] ?? { kind: 'quiet' }
            if (happening.kind === 'edit') {
                const target = `p${happening.page % pages.length}`
                const appended = `${store.get(target)!}\n${happening.line}`
                store.set(target, appended)
                expectedWords.set(target, `${expectedWords.get(target)!}\n${happening.line}`)
                touched.add(target)
                written.delete(target) // the next read sees the edit, as a store that has received it would
            }
            if (happening.kind === 'open') {
                const target = `p${happening.page % pages.length}`
                store.set(target, store.get(target)!.replace(/\r\n?/g, '\n'))
                written.delete(target)
            }
            if (happening.kind === 'fail') {
                troubled.add(key)
                throw new Error('disk full')
            }
            if (happening.kind === 'unconfirmed') {
                troubled.add(key)
                return 'unconfirmed'
            }
            const page = store.get(key)!
            if (page !== expected) return 'changed'
            let text = page
            for (const s of [...splices].reverse()) text = text.slice(0, s.from) + s.insert + text.slice(s.to)
            store.set(key, text)
            written.add(key)
            return 'written'
        },
    }
    return { source, store, expectedWords, touched, troubled }
}

describe('approving fixes', () => {
    it('Approve all keeps every word, overwrites no edit, reports changes honestly and leaves an untouched page settled', async () => {
        await fc.assert(
            fc.asyncProperty(scenario, async ({ pages, events, syncingAfterWrite }) => {
                const graph = graphOf(pages, events, syncingAfterWrite)
                const { issues } = await scanGraph(graph.source, { signal: new AbortController().signal })
                const tally = await approveEverything(graph.source, issues)

                for (const [key, text] of graph.store) {
                    // Nothing lost, nothing invented, nothing reordered: only whitespace and markers moved.
                    expect(words(text), key).toEqual(words(graph.expectedWords.get(key)!))
                    const onPage = issues.filter((issue) => issue.document.key === key)
                    if (!graph.touched.has(key)) {
                        // Only someone else's edit makes a page "changed since the scan".
                        expect(onPage.filter((issue) => issue.status === 'changed'), key).toEqual([])
                    }
                    if (!graph.touched.has(key) && !graph.troubled.has(key)) {
                        // Every write went through, so nothing Approve all could fix is left.
                        expect(findIssues(text).filter((found) => found.finding.fixed !== null).map((found) => found.check), key).toEqual([])
                        expect(onPage.filter((issue) => issue.status === 'pending' && issue.finding.fixed !== null), key).toEqual([])
                    }
                }
                expect(tally.fixed + tally.changed).toBeLessThanOrEqual(tally.total)
            }),
            fuzz(300),
        )
    })

    it('one issue at a time, or one check at a time, keeps every word too', async () => {
        await fc.assert(
            fc.asyncProperty(scenario, fc.array(fc.nat(), { maxLength: 12 }), fc.boolean(), async ({ pages, events, syncingAfterWrite }, picks, byCheck) => {
                const graph = graphOf(pages, events, syncingAfterWrite)
                const { issues } = await scanGraph(graph.source, { signal: new AbortController().signal })
                // A person approving in any order: a single issue, or a check's Approve all.
                for (const pick of picks) {
                    if (byCheck) await approveAll(graph.source, issues, FORMATTING_CHECKS[pick % FORMATTING_CHECKS.length].id)
                    else if (issues.length > 0) await approveIssue(graph.source, issues, issues[pick % issues.length])
                }
                for (const [key, text] of graph.store) {
                    expect(words(text), key).toEqual(words(graph.expectedWords.get(key)!))
                    if (!graph.touched.has(key)) expect(issues.filter((issue) => issue.document.key === key && issue.status === 'changed'), key).toEqual([])
                }
            }),
            fuzz(300),
        )
    })
})
