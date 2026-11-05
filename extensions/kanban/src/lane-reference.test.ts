import { describe, expect, it } from 'vitest'

import { registerAgentInstructionCommands, TASK_COPY_LANE_REFERENCE } from '#lib/document/commands/agent-instruction-commands.js'

import packageJson from '../package.json'
import { KANBAN_VIEW_KIND, KANBAN_WHOLE_KIND } from './board-model'
import { kanbanContext } from './testing'

// A [[Lane Reference]] carries the board's address, which the Client writes out itself so the
// Headless Client, which has no manifest, can read it. This keeps that address under the segments
// this manifest declares, so a reference names the board a person would open.

/** The reference the Client's Copy agent instruction writes for a lane of the board over `concept`. */
async function copiedReference(concept: string | null): Promise<string> {
    const { services } = kanbanContext()
    const copied: string[] = []
    registerAgentInstructionCommands(services.commands, services.contributions, {
        graphId: () => 'g-1',
        reach: async () => ({ kind: 'synced', graphName: 'Home', agentsUrl: 'https://app.example.com/g/g-1?settings=agents' }),
        writeClipboard: async (text) => void copied.push(text),
        notify: () => {},
    })
    await services.commands.execute(TASK_COPY_LANE_REFERENCE, { concept, status: 'doing', label: 'Doing', count: 1 })
    const line = copied[0]?.split('\n').find((l) => l.startsWith('Reference: '))
    return line?.slice('Reference: '.length) ?? ''
}

const segmentOf = (kind: string) => packageJson.etherpk.views.find((view) => view.kind === kind)?.address.segment

describe("a lane reference's board address", () => {
    it("is under the segment of a concept's board", async () => {
        expect(await copiedReference('Garden')).toBe(`etherpk:/g/g-1/${segmentOf(KANBAN_VIEW_KIND)}/Garden#lane=doing`)
    })

    it("is the Graph Kanban's address", async () => {
        expect(await copiedReference(null)).toBe(`etherpk:/g/g-1/${segmentOf(KANBAN_WHOLE_KIND)}#lane=doing`)
    })
})
