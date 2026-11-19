/**
 * Properties of the Agents tab's commands: whatever a graph is called and whichever agent is
 * chosen, the step that removes a graph from the agent names the server its registration added.
 * A removal under another name leaves the agent with the graph and the person believing it gone.
 *
 * Fixed seeds keep the suite deterministic in CI. To hunt for new counterexamples, run with
 * `DOCUMENT_FUZZ_SEED=<n>` (any integer) and optionally `DOCUMENT_FUZZ_RUNS=<n>`.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { AGENT_TOOLS, HEADLESS_CLIENT_PACKAGE, registerCommand, registerFolderCommand, unregisterStep, type AgentTool } from './agents-tab'

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261119 : Number(seed) }
}

/** A graph's name as a person could type it, marks, symbols and other scripts included, or none. */
const graphName = fc.option(
    fc.oneof(fc.string({ maxLength: 48, unit: 'grapheme' }), fc.constantFrom('Garden Notes', 'Café & Plans!', '园子', '--', 'a very long graph name indeed that goes on')),
    { nil: null },
)
const tool = fc.constantFrom(...AGENT_TOOLS.map((option) => option.id))

/** The server name a registration adds: the word after `add` in a command, or the JSON block's one key. */
function registeredName(tool: AgentTool, registration: string): string {
    if (tool === 'claude' || tool === 'codex') return registration.split(' -- ')[0].split(' ').at(-1)!
    const block = JSON.parse(registration) as { servers?: object; mcpServers?: object }
    return Object.keys(block.servers ?? block.mcpServers ?? {})[0]
}

/** The server name a removal step takes out: the last word of a command, or the quoted name in a note. */
function removedName(step: { command: string | null; note: string }): string {
    if (step.command) return step.command.split(' ').at(-1)!
    return /"([^"]+)"/.exec(step.note)![1]
}

describe('removing a graph from an agent', () => {
    it('names the server its registration added, for a synced graph and a folder alike', () => {
        fc.assert(
            fc.property(tool, graphName, (chosen, name) => {
                const removed = removedName(unregisterStep(chosen, name))
                expect(removed).toBe(registeredName(chosen, registerCommand(chosen, 'g-1', 'https://sync.example.test', HEADLESS_CLIENT_PACKAGE, name)))
                if (name !== null) expect(removed).toBe(registeredName(chosen, registerFolderCommand(chosen, '/home/me/notes', HEADLESS_CLIENT_PACKAGE, name)))
            }),
            fuzz(500),
        )
    })
})
