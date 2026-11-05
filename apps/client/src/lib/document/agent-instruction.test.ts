import { describe, expect, it } from 'vitest'

import { type AgentReach, formatLaneInstruction, formatTaskInstruction, laneSelectionInFiles } from './agent-instruction'
import { parseLaneReference, type LaneReference } from './lane-reference'
import { parseTaskReference, taskFingerprint, taskWords, type TaskReference } from './task-reference'
import type { TaskStatus } from './index-db'

// An [[Agent Instruction]]: what a person copies to hand an agent a task or a lane. It says how to
// reach the graph, which depends on where the graph is, and the Headless Client reads the
// reference out of the whole text, so every variant must read back.

const AGENTS_URL = 'https://app.example.com/g/g-1?settings=agents'
const synced: AgentReach = { kind: 'synced', graphName: 'Home', agentsUrl: AGENTS_URL }
const browser: AgentReach = { kind: 'browser', graphName: 'Demo', agentsUrl: AGENTS_URL }
const folder = (over: Partial<Extract<AgentReach, { kind: 'folder' }>> = {}): AgentReach => ({
    kind: 'folder',
    folderName: 'notes',
    folderPath: '/path/to/notes',
    file: { subdir: 'pages', fileName: 'Garden.md' },
    ...over,
})

const STOP = `If you have no EtherPK MCP server for this graph, stop. Do not search this device for it or work from a folder copy, which EtherPK overwrites. Tell the user to connect you from the Agents tab in EtherPK's Settings, which they can open at ${AGENTS_URL}`
const OUT_OF_REACH = `This graph is kept inside this browser, so an agent cannot reach it. Tell the user that the Agents tab in EtherPK's Settings explains how to work with an agent. They can open it at ${AGENTS_URL}`

describe('the instruction for a task', () => {
    const reference: TaskReference = { graphId: 'g-1', document: 'Garden', line: 14, fingerprint: '3fa9c1e07b2d' }
    const id = 'etherpk:/g/g-1/d/Garden#task=14-3fa9c1e07b2d'
    const label = '#P1 water the beans'

    it('tells an agent on a synced graph to use its MCP server, and to stop without one', () => {
        expect(formatTaskInstruction(reference, label, synced).split('\n')).toEqual([
            'EtherPK task from the graph "Home" (g-1)',
            'Task: water the beans',
            `Reference: ${id}`,
            'This is not a web address. Use the EtherPK MCP server connected to "Home": read_task with this whole text to read the task and its detail, set_task if you are asked to change its status, add_task_note to record what you did.',
            STOP,
        ])
    })

    it('names a synced graph by its id alone when it has no name', () => {
        const lines = formatTaskInstruction(reference, label, { kind: 'synced', graphName: null, agentsUrl: AGENTS_URL }).split('\n')
        expect(lines[0]).toBe('EtherPK task from the graph g-1')
        expect(lines[3]).toContain('Use the EtherPK MCP server connected to that graph:')
    })

    it('gives an agent on a local graph the file, and the tools only if it has them', () => {
        expect(formatTaskInstruction(reference, label, folder()).split('\n')).toEqual([
            'EtherPK task from the graph folder "notes"',
            'Task: water the beans',
            'File: /path/to/notes/pages/Garden.md',
            `Reference: ${id}`,
            'This is not a web address. If an EtherPK MCP server for this graph is connected, use it: read_task with this whole text to read the task and its detail, set_task if you are asked to change its status, add_task_note to record what you did. Otherwise open the file and find the task by its words. If it is not there, search the graph folder. If none or several match, ask the user. Follow AGENTS.md at the top of the graph folder, and change the status only if you are asked.',
        ])
    })

    it('places the file inside the folder when the full path is not known', () => {
        expect(formatTaskInstruction(reference, label, folder({ folderPath: null })).split('\n')[2]).toBe('File: pages/Garden.md, inside the graph folder')
    })

    it('joins a Windows folder path with its own separator', () => {
        expect(formatTaskInstruction(reference, label, folder({ folderPath: 'C:\\notes' })).split('\n')[2]).toBe('File: C:\\notes\\pages\\Garden.md')
    })

    it('sends the agent to the folder when the file cannot be named', () => {
        const known = formatTaskInstruction(reference, label, folder({ file: null })).split('\n')
        expect(known[2]).toBe('Folder: /path/to/notes')
        expect(known[4]).toContain('Otherwise search the graph folder for the task by its words. If none or several match, ask the user.')

        const unknown = formatTaskInstruction(reference, label, folder({ file: null, folderPath: null })).split('\n')
        expect(unknown[2]).toBe(`Reference: ${id}`)
    })

    it('says a graph kept in the browser is out of reach, with no reference to chase', () => {
        expect(formatTaskInstruction(reference, label, browser).split('\n')).toEqual(['EtherPK task from the graph "Demo"', 'Task: water the beans', OUT_OF_REACH])
    })

    it('keeps a Free Tag in the words it shows, so a sentence still reads, and leaves it out of the fingerprint', async () => {
        const tagged = '#P1 #D Filter by tag, e.g. #bug. Then stop'
        expect(formatTaskInstruction(reference, tagged, synced).split('\n')[1]).toBe('Task: Filter by tag, e.g. #bug. Then stop')
        expect(taskWords(tagged)).toBe('Filter by tag, e.g.. Then stop')
        expect(await taskFingerprint(tagged)).toBe(await taskFingerprint('Filter by tag, e.g.. Then stop'))
    })

    it.each([
        ['synced', synced],
        ['local, with a full path', folder()],
        ['local, without one', folder({ folderPath: null })],
    ])('reads back from the whole text on a %s graph, and from the reference line', (_name, reach) => {
        const copied = formatTaskInstruction(reference, 'water the beans', reach)
        expect(parseTaskReference(copied)).toEqual(reference)
        expect(parseTaskReference(copied.split('\n').find((line) => line.startsWith('Reference: '))!)).toEqual(reference)
    })

    it("reads the etherpk: reference before anything shaped like one in the task's words", () => {
        const words = 'Compare /g/g-2/d/Other#task=1-aaaaaaaaaaaa with the plan'
        expect(parseTaskReference(formatTaskInstruction(reference, words, synced))).toEqual(reference)
    })
})

describe('the instruction for a lane', () => {
    const lane = { laneLabel: 'Doing', count: 3 }
    const board: LaneReference = { graphId: 'g-1', concept: 'Kitchen Garden', status: 'doing' }
    const whole: LaneReference = { graphId: 'g-1', concept: null, status: 'open' }

    it("names the graph, the board, the lane and how to list the lane's tasks, and to stop without an MCP server", () => {
        expect(formatLaneInstruction(board, lane, synced).split('\n')).toEqual([
            'EtherPK Kanban lane from the graph "Home" (g-1)',
            'Board: Kitchen Garden',
            'Lane: Doing (3 tasks)',
            'Reference: etherpk:/g/g-1/k/Kitchen%20Garden#lane=doing',
            'This is not a web address. Use the EtherPK MCP server connected to "Home": tasks with concept "Kitchen Garden" and statuses ["doing"] lists the lane\'s tasks (or pass this whole text as reference); read_task, set_task and add_task_note work on each task.',
            STOP,
        ])
    })

    it('names the Graph Kanban, which lists by status alone', () => {
        const lines = formatLaneInstruction(whole, { laneLabel: 'Open', count: 1 }, synced).split('\n')
        expect(lines.slice(1, 4)).toEqual(['Board: Graph Kanban', 'Lane: Open (1 task)', 'Reference: etherpk:/g/g-1/kanban#lane=open'])
        expect(lines[4]).toContain('tasks with statuses ["open"] lists')
    })

    it('names a synced graph by its id alone when it has no name', () => {
        const lines = formatLaneInstruction(board, { laneLabel: 'Test', count: 0 }, { kind: 'synced', graphName: null, agentsUrl: AGENTS_URL }).split('\n')
        expect(lines[0]).toBe('EtherPK Kanban lane from the graph g-1')
        expect(lines[2]).toBe('Lane: Test (0 tasks)')
        expect(lines[4]).toMatch(/^This is not a web address\. Use the EtherPK MCP server connected to that graph: /)
    })

    it('tells an agent on a local graph which tasks to find in the files', () => {
        expect(formatLaneInstruction(board, lane, folder({ file: null })).split('\n')).toEqual([
            'EtherPK Kanban lane from the graph folder "notes"',
            'Board: Kitchen Garden',
            'Lane: Doing (3 tasks)',
            'Folder: /path/to/notes',
            'Reference: etherpk:/g/g-1/k/Kitchen%20Garden#lane=doing',
            'This is not a web address. If an EtherPK MCP server for this graph is connected, use it: tasks with concept "Kitchen Garden" and statuses ["doing"] lists the lane\'s tasks (or pass this whole text as reference); read_task, set_task and add_task_note work on each task. Otherwise, in the graph folder, find the unticked tasks tagged #D that are about [[Kitchen Garden]]. AGENTS.md at the top of the folder says what makes a task about a concept.',
        ])
    })

    it('leaves the concept out on the Graph Kanban, and the folder line when its path is not known', () => {
        const lines = formatLaneInstruction(whole, { laneLabel: 'Open', count: 1 }, folder({ file: null, folderPath: null })).split('\n')
        expect(lines[3]).toBe('Reference: etherpk:/g/g-1/kanban#lane=open')
        expect(lines[4]).toContain('Otherwise, in the graph folder, find the unticked tasks with no #W, #D or #T. Follow AGENTS.md at the top of the folder.')
    })

    it('says a graph kept in the browser is out of reach', () => {
        expect(formatLaneInstruction(board, lane, browser).split('\n')).toEqual(['EtherPK Kanban lane from the graph "Demo"', 'Board: Kitchen Garden', 'Lane: Doing (3 tasks)', OUT_OF_REACH])
    })

    it.each([
        ['synced', synced],
        ['local', folder({ file: null })],
    ])('reads back from the whole text on a %s graph', (_name, reach) => {
        expect(parseLaneReference(formatLaneInstruction(board, lane, reach))).toEqual(board)
        expect(parseLaneReference(formatLaneInstruction(whole, lane, reach))).toEqual(whole)
    })
})

describe('a lane in the files', () => {
    it.each<[TaskStatus, string]>([
        ['open', 'unticked tasks with no #W, #D or #T'],
        ['doing', 'unticked tasks tagged #D'],
        ['waiting', 'unticked tasks tagged #W'],
        ['test', 'unticked tasks tagged #T'],
        ['done', 'ticked tasks with no #C or #A'],
        ['cancelled', 'ticked tasks tagged #C'],
        ['archived', 'ticked tasks tagged #A'],
    ])('describes %s by its checkbox and task tags', (status, words) => {
        expect(laneSelectionInFiles(status)).toBe(words)
    })
})
