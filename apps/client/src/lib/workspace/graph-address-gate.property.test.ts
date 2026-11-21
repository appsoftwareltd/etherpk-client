/**
 * Properties of the gate between a [[Graph Address]] and a workspace (ADR 0192), over any set of
 * registered graphs and any graph a person may have chosen in EtherPK:
 *
 * - **The gate opens only a graph the address names.** A choice carried from another graph, a
 *   forgotten graph or another kind of graph never opens in place of it.
 * - **A choice among folders with one name is honoured**, and without one the gate asks.
 * - **The Graphs menu marks the graph the gate opened**, and with none open, a graph only when the
 *   address names it alone.
 *
 * Fixed seeds keep the suite deterministic in CI. To hunt for new counterexamples, run with
 * `DOCUMENT_FUZZ_SEED=<n>` (any integer) and optionally `DOCUMENT_FUZZ_RUNS=<n>`.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
    currentGraphId,
    graphAddressOf,
    graphsSharingAnAddress,
    sameGraphAddress,
    type AddressedGraph,
    type GraphAddress,
} from '#lib/navigation/graph-address.js'

import { gateFor } from './graph-address-gate'

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261120 : Number(seed) }
}

/** Few names, so folders often share one. */
const folderName = fc.constantFrom('notes', 'Notes', 'reports', 'garden')

/** A registry: graphs of every kind, each with an id of its own. */
const registry: fc.Arbitrary<AddressedGraph[]> = fc
    .array(
        fc.oneof(
            folderName.map((name) => ({ backend: 'filesystem' as const, handle: { kind: 'directory', name } })),
            fc.constant({ backend: 'filesystem' as const, where: 'browser' as const, handle: { kind: 'directory', name: 'graph' } }),
            fc.constant({ backend: 'server' as const, handle: { rootDocId: 'r' } }),
        ),
        { maxLength: 8 },
    )
    .map((graphs) => graphs.map((graph, index) => ({ ...graph, id: `g${index}` })))

/** A registry, an address (a registered graph's, or a folder name that may be nobody's) and a choice (any id, or none). */
const scenario = registry.chain((graphs) => {
    const ids = [...graphs.map((graph) => graph.id), 'gone']
    const addresses: fc.Arbitrary<GraphAddress>[] = [folderName.map((name) => ({ where: 'folder' as const, name }))]
    if (graphs.length > 0) addresses.push(fc.constantFrom(...graphs.map(graphAddressOf)))
    return fc.record({
        graphs: fc.constant(graphs),
        address: fc.oneof(...addresses),
        chosen: fc.option(fc.constantFrom(...ids), { nil: null }),
        dev: fc.boolean(),
    })
})

const named = (graphs: readonly AddressedGraph[], address: GraphAddress) => graphs.filter((graph) => sameGraphAddress(graphAddressOf(graph), address))

describe('the gate, over any registry and choice', () => {
    it('opens only a graph the address names', () => {
        fc.assert(
            fc.property(scenario, ({ graphs, address, chosen, dev }) => {
                const gate = gateFor(address, graphs, dev, chosen)
                if (gate.kind !== 'open' || address.where === 'sync' || gate.createInBrowser) return
                expect(named(graphs, address).map((graph) => graph.id)).toContain(gate.graphId)
            }),
            fuzz(500),
        )
    })

    it('honours a choice among folders with one name, and asks without one', () => {
        fc.assert(
            fc.property(scenario, ({ graphs, address, chosen, dev }) => {
                const candidates = named(graphs, address)
                if (address.where === 'sync' || candidates.length < 2) return
                const gate = gateFor(address, graphs, dev, chosen)
                if (chosen !== null && candidates.some((graph) => graph.id === chosen)) expect(gate).toEqual({ kind: 'open', graphId: chosen, createInBrowser: false })
                else expect(gate).toEqual({ kind: 'choose-graph', graphs: candidates })
            }),
            fuzz(500),
        )
    })

    it('opens the same graph with or without a choice when the address names one graph', () => {
        fc.assert(
            fc.property(scenario, ({ graphs, address, chosen, dev }) => {
                if (named(graphs, address).length >= 2) return
                expect(gateFor(address, graphs, dev, chosen)).toEqual(gateFor(address, graphs, dev))
            }),
            fuzz(500),
        )
    })
})

describe('the open graph in the Graphs menu, over any registry', () => {
    it('is the open graph when one is open, and else the only graph the address names', () => {
        fc.assert(
            fc.property(scenario, ({ graphs, address, chosen }) => {
                const candidates = named(graphs, address)
                // The gate publishes an id only for a graph it opened, so only such an id is tried.
                const open = chosen !== null && candidates.some((graph) => graph.id === chosen) ? chosen : null
                const current = currentGraphId(address, open, graphs)
                if (open !== null) expect(current).toBe(open)
                else expect(current).toBe(candidates.length === 1 ? candidates[0].id : null)
            }),
            fuzz(500),
        )
    })

    it('says a graph shares its address exactly when the gate would ask about it', () => {
        fc.assert(
            fc.property(registry, (graphs) => {
                const sharing = graphsSharingAnAddress(graphs)
                for (const graph of graphs) {
                    const asks = gateFor(graphAddressOf(graph), graphs, false).kind === 'choose-graph'
                    expect(sharing.has(graph.id)).toBe(asks)
                }
            }),
            fuzz(500),
        )
    })
})
