import { describe, expect, it } from 'vitest'

import { createGraphKeyring } from '$lib/crypto'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { fixedSyncToken } from '$lib/sync/sync-token'

import { loadEmbeddingModel } from './embedder'
import { openHeadlessGraph } from './headless-graph'
import { DOCS, JUNK, QUERIES } from './semantic-eval-fixture'
import { search } from './tools'

/**
 * [[Semantic Search]] against the REAL model, over the evaluation set: recall@10 by kind of
 * query, what junk scores, and the build's throughput. A benchmark, not a gate, in the house
 * pattern of `index-rebuild-bench.test.ts`: the numbers are printed and only ceilings that
 * would mean something is broken are asserted. Runs only where `semantic setup` has been done:
 *
 *     ETHERPK_SEMANTIC_EVAL_CACHE=~/.cache/etherpk/mcp pnpm --filter @appsoftwareltd/etherpk-mcp test semantic-eval
 *
 * (any cache root the setup command was pointed at through ETHERPK_MCP_CACHE_DIR).
 */

const cache = process.env.ETHERPK_SEMANTIC_EVAL_CACHE?.trim()
const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde22000'

describe.skipIf(!cache)('semantic search against the real model', () => {
    it('recalls the evaluation set and embeds at a usable rate', async () => {
        const model = await loadEmbeddingModel({ ETHERPK_MCP_CACHE_DIR: cache } as NodeJS.ProcessEnv)
        const relay = createLoopbackRelay()
        const graph = await openHeadlessGraph({
            graphId: 'g-eval',
            rootDocId: ROOT,
            keyring: createGraphKeyring('g-eval'),
            relayUrl: 'ws://loopback/sync',
            token: fixedSyncToken('t'),
            presenceName: 'Agent on eval',
            connect: relay.connect,
            embeddingModel: async () => model,
        })
        try {
            for (const doc of DOCS) {
                if (doc.kind === 'journal') await graph.store.createJournal(doc.concept, doc.text)
                else await graph.store.createPage(doc.concept, doc.text)
                if (doc.aliases.length > 0) await graph.store.setAliases(doc.concept, doc.aliases)
            }
            await graph.settle()
            for (let i = 0; i < 200 && graph.index.allConcepts().filter((c) => c.kind !== 'pageless').length < DOCS.length; i++) {
                await new Promise((r) => setTimeout(r, 50))
            }
            const semantic = await graph.semantic()
            const started = performance.now()
            await semantic.build()
            const buildMs = performance.now() - started
            const status = await semantic.status()
            expect(status.embedded).toBe(status.total)
            expect(status.total).toBeGreaterThan(DOCS.length / 2)

            const rows: string[] = []
            const hits = { lexical: { text: 0, semantic: 0, n: 0 }, meaning: { text: 0, semantic: 0, n: 0 } }
            for (const q of QUERIES) {
                const text = await search(graph, { query: q.query, limit: 10 })
                const sem = await search(graph, { query: q.query, mode: 'semantic', limit: 10 })
                const textHit = text.results.some((r) => q.expect.includes(r.concept))
                const semHit = sem.results.some((r) => q.expect.includes(r.concept))
                const top = sem.results[0]
                hits[q.kind].n++
                if (textHit) hits[q.kind].text++
                if (semHit) hits[q.kind].semantic++
                rows.push(`${q.kind.padEnd(7)} ${semHit ? 'sem✓' : 'sem✗'} ${textHit ? 'txt✓' : 'txt✗'}  ${q.query.padEnd(52)} → ${top ? `${top.concept} (${top.similarity})` : '(nothing)'}`)
            }
            const junk: string[] = []
            let junkAboveFloor = 0
            for (const q of JUNK) {
                const sem = await search(graph, { query: q, mode: 'semantic', limit: 3 })
                if (sem.results.length > 0) junkAboveFloor++
                junk.push(`junk    ${q.padEnd(60)} → ${sem.results[0] ? `${sem.results[0].concept} (${sem.results[0].similarity})` : '(nothing)'}`)
            }
            const recall = (k: 'lexical' | 'meaning', m: 'text' | 'semantic') => (hits[k][m] / hits[k].n).toFixed(2)
            console.info(
                [
                    `model ${model.id}: ${status.total} passages embedded in ${Math.round(buildMs)}ms (${(status.total / (buildMs / 1000)).toFixed(0)} passages/s), rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`,
                    `recall@10  meaning: semantic ${recall('meaning', 'semantic')}  text ${recall('meaning', 'text')}   |   lexical: semantic ${recall('lexical', 'semantic')}  text ${recall('lexical', 'text')}`,
                    `junk queries above the floor: ${junkAboveFloor} of ${JUNK.length}`,
                    ...rows,
                    ...junk,
                ].join('\n'),
            )
            // Ceilings against a broken pipeline, not a quality bar: a wrong tokeniser or
            // pooling puts meaning recall near zero and junk everywhere.
            expect(hits.meaning.semantic / hits.meaning.n).toBeGreaterThanOrEqual(0.6)
            expect(hits.lexical.semantic / hits.lexical.n).toBeGreaterThanOrEqual(0.7)
            expect(junkAboveFloor).toBeLessThanOrEqual(1)
        } finally {
            await graph.dispose()
        }
    }, 300_000)
})
