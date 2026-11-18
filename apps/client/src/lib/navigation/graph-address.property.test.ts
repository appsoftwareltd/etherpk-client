/**
 * Properties of a [[Graph Address]] in the places that have to agree on it (ADR 0192):
 *
 * - **References.** A Task Reference or a Lane Reference written for any graph, document and
 *   task reads back as itself, alone or inside the text an Agent Instruction puts around it. The
 *   Client writes it and the Headless Client reads it, so a name one writes and the other cannot
 *   read is a task an agent is handed and cannot find.
 * - **Logs.** No address a route accepts leaves a person's words in a request log: a document's
 *   name, a board's concept, a folder's name. A rule missed here shows on no screen.
 *
 * Fixed seeds keep the suite deterministic in CI. To hunt for new counterexamples, run with
 * `DOCUMENT_FUZZ_SEED=<n>` (any integer) and optionally `DOCUMENT_FUZZ_RUNS=<n>`.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { redactPath, redactQueryString, redactUrl } from '@appsoftwareltd/etherpk-shared'

import { TASK_STATUSES } from '../document/index-db'
import { laneReferenceId, parseLaneReference, type LaneReference } from '../document/lane-reference'
import { parseTaskReference, taskReferenceId, taskReferenceUrl, type TaskReference } from '../document/task-reference'
import { assetUrl, documentUrl, graphUrl, themeUrl } from './document-url'
import { encodeConceptPath } from './concept-path'
import { graphAddressPath, type GraphAddress, type ReferencedGraph } from './graph-address'

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261118 : Number(seed) }
}

/** Text a person could name a folder or a page: any characters, brackets, spaces and marks included. */
const words = fc.oneof(
    fc.string({ minLength: 1, maxLength: 24, unit: 'grapheme' }),
    fc.constantFrom('Garden Notes', '[[Garden]] Beds', 'a#b', 'a?b=c', '100%', 'été', '园子', 'x.y', ' padded ', "it's (1)"),
)
/** One path segment: no slash, and not the two names a URL takes as "here" and "up". */
const segment = words.filter((text) => !text.includes('/') && text !== '.' && text !== '..')
/** A document's name: a scoped concept can hold slashes, which stay slashes in its address. */
const documentName = fc.array(segment, { minLength: 1, maxLength: 3 }).map((parts) => parts.join('/'))

const address: fc.Arbitrary<GraphAddress> = fc.record({ where: fc.constantFrom('folder' as const, 'sync' as const, 'browser' as const), name: segment })
const referenced: fc.Arbitrary<ReferencedGraph> = fc.oneof(address, fc.record({ where: fc.constant('legacy' as const), name: segment }))
const fingerprint = fc.stringMatching(/^[0-9a-f]{12}$/)

const taskReference: fc.Arbitrary<TaskReference> = fc.record({ graph: referenced, document: documentName, line: fc.nat(100_000), fingerprint })
const laneReference: fc.Arbitrary<LaneReference> = fc.record({
    graph: referenced,
    concept: fc.option(documentName, { nil: null }),
    status: fc.constantFrom(...TASK_STATUSES),
})

/** What an Agent Instruction, or a person's note, can put around a reference: never a reference itself. */
const around = fc.constantFrom('', 'Reference: ', 'EtherPK task from the graph "Garden"\nTask: water the beans\nReference: ', 'see ')
const after = fc.constantFrom('', '\nUse the EtherPK MCP server.', ' and then stop', '.')

describe('a reference reads back as it was written', () => {
    it('a Task Reference, for any graph, document, line and fingerprint', () => {
        fc.assert(
            fc.property(taskReference, around, after, (reference, before, behind) => {
                expect(parseTaskReference(taskReferenceId(reference))).toEqual(reference)
                expect(parseTaskReference(`${before}${taskReferenceId(reference)}${behind}`)).toEqual(reference)
            }),
            fuzz(500),
        )
    })

    it('the address a browser shows for a task, with any origin and a query', () => {
        fc.assert(
            fc.property(taskReference, fc.constantFrom('', 'https://app.example.test', 'http://localhost:5285'), (reference, origin) => {
                const url = taskReferenceUrl(reference, origin)
                expect(parseTaskReference(url)).toEqual(reference)
                expect(parseTaskReference(url.replace('#task=', '?settings=agents&autosaveMs=150#task='))).toEqual(reference)
            }),
            fuzz(300),
        )
    })

    it('a Lane Reference, for any graph, board and lane', () => {
        fc.assert(
            fc.property(laneReference, around, after, (reference, before, behind) => {
                expect(parseLaneReference(laneReferenceId(reference))).toEqual(reference)
                expect(parseLaneReference(`${before}${laneReferenceId(reference)}${behind}`)).toEqual(reference)
            }),
            fuzz(500),
        )
    })

    it('a Task Reference is never read as a Lane Reference, nor the other way', () => {
        fc.assert(
            fc.property(taskReference, laneReference, (task, lane) => {
                expect(parseLaneReference(taskReferenceId(task))).toBeNull()
                expect(parseTaskReference(laneReferenceId(lane))).toBeNull()
            }),
            fuzz(300),
        )
    })
})

describe('a workspace address leaves no words of a person in a log', () => {
    /** A word that cannot appear in an address by accident, so finding it means it was not cut. */
    const secret = fc.stringMatching(/^[a-z]{6,10}$/).map((text) => `zq${text}qz`)
    /** The segments a route accepts after the Graph Address, each followed by something a person named. */
    const named = fc.constantFrom('d', 'a', 't', 'k', 'm', 'x', 'day', 'x/some-extension/board')

    /** Every way a secret can stand in an address that carries it after its Graph Address. */
    function carrying(graph: GraphAddress, lead: string, word: string): string[] {
        return [
            documentUrl(graph, word),
            documentUrl(graph, `Garden/${word}`),
            documentUrl(graph, `${word}/Beds`),
            assetUrl(graph, `${word}.a1b2c3d4.pdf`),
            themeUrl(graph, word),
            `${graphUrl(graph)}/${lead}/${encodeConceptPath(word)}`,
            `${graphUrl(graph)}/${lead}/${encodeConceptPath(`Garden/${word}`)}`,
        ]
    }

    it('on a synced graph and a graph kept in the browser, after the first segment', () => {
        fc.assert(
            fc.property(fc.constantFrom('sync' as const, 'browser' as const), fc.uuid(), named, secret, (where, id, lead, word) => {
                for (const path of carrying({ where, name: id }, lead, word)) {
                    const logged = redactPath(path)
                    expect(logged, path).not.toContain(word)
                    // The graph and what kind of place it was stay, for whoever reads the log.
                    expect(logged.startsWith(`/graph/${where}/${id}/`), logged).toBe(true)
                    expect(redactPath(path.toUpperCase()), path).not.toContain(word.toUpperCase())
                    expect(redactUrl(`https://app.example.test${path}?x=1`)).not.toContain(word)
                    expect(redactQueryString(`?redirect=${encodeURIComponent(path)}`)).not.toContain(word)
                }
            }),
            fuzz(300),
        )
    })

    it("on a folder graph, where the folder's name is the person's too", () => {
        fc.assert(
            fc.property(secret, secret, named, (folder, word, lead) => {
                fc.pre(folder !== word)
                const graph: GraphAddress = { where: 'folder', name: `Private ${folder}` }
                for (const path of [graphUrl(graph), ...carrying(graph, lead, word)]) {
                    const logged = redactPath(path)
                    expect(logged, path).toBe('/graph/folder/[redacted]')
                    expect(redactUrl(`https://app.example.test${path}`)).not.toContain(folder)
                    expect(redactQueryString(`?return=${encodeURIComponent(path)}`)).not.toContain(folder)
                }
            }),
            fuzz(300),
        )
    })

    it('for any name at all a person could give, encoded as the address encodes it', () => {
        fc.assert(
            fc.property(address, documentName, (graph, name) => {
                const encoded = encodeConceptPath(name)
                const logged = redactPath(documentUrl(graph, name))
                // What is left is the address up to `/d/`, or up to `/folder/`, and the mark.
                const kept = graph.where === 'folder' ? '/graph/folder/' : `${graphAddressPath(graph)}/d/`
                expect(logged).toBe(`${kept}[redacted]`)
                expect(logged.endsWith(encoded) && encoded !== '[redacted]').toBe(false)
            }),
            fuzz(500),
        )
    })

    it('an address that names a graph and nothing in it is kept, so a log still says which graph', () => {
        fc.assert(
            fc.property(fc.constantFrom('sync' as const, 'browser' as const), fc.uuid(), fc.constantFrom('', '/kanban', '/graph-view', '/map'), (where, id, rest) => {
                const path = `${graphUrl({ where, name: id })}${rest}`
                expect(redactPath(path)).toBe(path)
            }),
            fuzz(100),
        )
    })
})
