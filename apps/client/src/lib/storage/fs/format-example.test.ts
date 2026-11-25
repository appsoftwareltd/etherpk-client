import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { deriveDoc, deriveTitleLinks, documentTaskConcepts } from '../../document/index-derive'
import { freeTagsIn, parseTaskTags, taskStatus } from '../../document/task-tags'
import sectionMarkdown from './agents-md-section.md?raw'
import { parseFrontmatter } from './frontmatter'
import { conceptKey } from './identity'
import { createMemoryDirectoryAdapter } from './memory-adapter'
import { scanGraph } from './scan'

/**
 * The EtherPK Format's example folder, read by the code the app runs, gives the result the format's
 * `expected.json` states. The example and its result are published with the specification
 * (https://docs.etherpk.com/etherpk-format) so that another program can check its own reading against
 * them, which only helps while EtherPK's reading is the one written down. `expected.json` records what
 * this code read when it was written. When this fails, compare both with the specification before
 * changing either.
 */

const REPO = fileURLToPath(new URL('../../../../../../', import.meta.url))

/** The format's folder: under public-repos/client here, at the root of the etherpk-client repository. */
const FORMAT = ['public-repos/client/format', 'format'].map((path) => join(REPO, path)).find((path) => existsSync(join(path, 'expected.json')))

interface ExpectedTask {
    text: string
    status: string
    priority: number | null
    due: string | null
    scheduled: string | null
    completed: string | null
    freeTags: string[]
    subtaskOf: number | null
    about: string[]
}

interface ExpectedDocument {
    kind: string
    name: string
    aliases: string[]
    scopes: string[]
    links: string[]
    tasks: ExpectedTask[]
}

/** Names as `expected.json` lists them: lower-cased, once each, sorted by code unit. */
function names(concepts: readonly string[]): string[] {
    return [...new Set(concepts.map(conceptKey))].sort()
}

/** One document of the example, as the app reads it, in the shape `expected.json` uses. */
function readDocument(kind: string, name: string, aliases: string[], text: string): ExpectedDocument {
    const { links, tasks, taskConcepts } = deriveDoc(parseFrontmatter(text).body)
    const taskIndex = new Map(tasks.map((task, index) => [task.blockLocalId, index]))
    return {
        kind,
        name,
        aliases,
        scopes: names(deriveTitleLinks(name).map((link) => link.concept)),
        links: names(links.map((link) => link.concept)),
        tasks: tasks.map((task) => ({
            text: task.text,
            status: taskStatus(task.done, task),
            priority: task.priority,
            due: task.due,
            scheduled: task.scheduled,
            completed: task.completion,
            freeTags: names(freeTagsIn(parseTaskTags(task.text).text)),
            subtaskOf: task.parentTaskLocalId === null ? null : (taskIndex.get(task.parentTaskLocalId) ?? null),
            about: names([...documentTaskConcepts(name), ...taskConcepts.filter((row) => row.blockLocalId === task.blockLocalId).map((row) => row.concept)]),
        })),
    }
}

describe('the EtherPK Format example folder', () => {
    it('reads as its expected.json says', async () => {
        expect(FORMAT, 'the format folder, with its expected.json').toBeDefined()
        const example = join(FORMAT!, 'example')
        const seed: Record<'journals' | 'pages', Record<string, string>> = { journals: {}, pages: {} }
        for (const subdir of ['journals', 'pages'] as const) {
            for (const file of readdirSync(join(example, subdir))) seed[subdir][file] = readFileSync(join(example, subdir, file), 'utf8')
        }
        let clock = 0
        const adapter = createMemoryDirectoryAdapter({ now: () => ++clock, seed })

        const documents: Record<string, ExpectedDocument> = {}
        for (const entry of await scanGraph(adapter)) {
            const text = seed[entry.subdir as 'journals' | 'pages'][entry.fileName]
            documents[`${entry.subdir}/${entry.fileName}`] = readDocument(entry.kind, entry.concept, entry.aliases, text)
        }

        const expected = JSON.parse(readFileSync(join(FORMAT!, 'expected.json'), 'utf8')) as { format: number; documents: Record<string, ExpectedDocument> }
        expect(expected.format).toBe(1)
        expect(documents).toEqual(expected.documents)
    })

    // A graph folder records no version of its own: the section EtherPK writes into it names one.
    it('is for the version of the format that the AGENTS.md section names', () => {
        const expected = JSON.parse(readFileSync(join(FORMAT!, 'expected.json'), 'utf8')) as { format: number }
        const named = /\*\*EtherPK Format\*\*, version (\d+)\./.exec(sectionMarkdown)
        expect(named, 'the version in agents-md-section.md').not.toBeNull()
        expect(Number(named![1])).toBe(expected.format)
    })

    it('holds a file for every asset its documents reference', () => {
        const example = join(FORMAT!, 'example')
        const referenced = new Set<string>()
        for (const subdir of ['journals', 'pages']) {
            for (const file of readdirSync(join(example, subdir))) {
                for (const match of readFileSync(join(example, subdir, file), 'utf8').matchAll(/\]\(\.\.\/assets\/([^)]+)\)/g)) referenced.add(decodeURIComponent(match[1]))
            }
        }
        expect([...referenced].sort()).toEqual(readdirSync(join(example, 'assets')).sort())
    })
})
