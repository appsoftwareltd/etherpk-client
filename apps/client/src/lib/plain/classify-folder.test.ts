import { describe, expect, it } from 'vitest'

import { AGENTS_MD_BEGIN, AGENTS_MD_END } from '../storage/fs/agents-md'
import type { FolderOwner } from '../storage/synced/mirror-takeover'

import { classifyFolder, probeFolder } from './classify-folder'
import { createMemoryTreeAdapter } from './memory-tree-adapter'

const folder = (seed: Record<string, string>) => createMemoryTreeAdapter({ now: () => 1000, seed })
const verdictFor = async (seed: Record<string, string>, owner: FolderOwner | null = null) => classifyFolder(await probeFolder(folder(seed)), owner)

describe('looking inside a chosen folder', () => {
    it('counts what it holds and leaves out other tools’ directories', async () => {
        const probe = await probeFolder(
            folder({
                'README.md': '# Garden',
                'guide/watering.md': 'water',
                'guide/images/bed.png': 'x',
                'manuals/pump.pdf': 'x',
                'books/compost.epub': 'x',
                'sizes.csv': 'x',
                '.git/config': 'x',
                'node_modules/left/index.js': 'x',
                '.DS_Store': 'x',
            }),
        )
        expect(probe.counts).toEqual({ markdown: 2, images: 1, pdfs: 1, ebooks: 1, other: 1 })
        expect(probe.skipped).toEqual(['.git', 'node_modules'])
        expect(probe).toMatchObject({ empty: false, format: 'markdown', truncated: false })
    })

    it('reads a folder holding only a file manager’s leavings as empty', async () => {
        expect((await probeFolder(folder({ '.DS_Store': 'x' }))).empty).toBe(true)
        expect((await probeFolder(folder({}))).empty).toBe(true)
    })

    it('sees the marks another notes tool leaves', async () => {
        expect((await probeFolder(folder({ '.obsidian/app.json': '{}', 'Garden.md': 'x' }))).format).toBe('obsidian')
        expect((await probeFolder(folder({ 'logseq/config.edn': '', 'pages/Garden.md': 'x' }))).format).toBe('logseq')
        expect((await probeFolder(folder({ 'notes/.asnotes/index.db': '', 'notes/Garden.md': 'x' }))).format).toBe('asnotes')
    })
})

describe('what EtherPK makes of a chosen folder', () => {
    it('opens a folder with a graph’s own directory as a Folder graph, without asking', async () => {
        expect(await verdictFor({ 'etherpk/settings.json': '{}', 'pages/Garden.md': 'x' })).toEqual({ kind: 'graph-folder' })
        expect(await verdictFor({ 'journals/2026-11-21.md': 'x', 'pages/Garden.md': 'x', 'AGENTS.md': `mine\n${AGENTS_MD_BEGIN}\nrules\n${AGENTS_MD_END}\n` })).toEqual({
            kind: 'graph-folder',
        })
    })

    it('asks about journals and pages that EtherPK never wrote its section beside, offering a graph first', async () => {
        const verdict = await verdictFor({ 'journals/2026-11-21.md': 'x', 'pages/Garden.md': 'x', 'AGENTS.md': 'my own rules' })
        expect(verdict).toMatchObject({ kind: 'ask', empty: false, choices: ['plain', 'graph', 'import'], preferred: 'graph' })
    })

    it('asks about an empty folder, offering a new graph first', async () => {
        expect(await verdictFor({})).toMatchObject({ kind: 'ask', empty: true, choices: ['graph', 'plain'], preferred: 'graph' })
    })

    it('asks about an ordinary folder, offering a Plain Folder first', async () => {
        expect(await verdictFor({ 'README.md': '# Garden', 'guide/watering.md': 'water' })).toMatchObject({
            kind: 'ask',
            empty: false,
            choices: ['plain', 'graph', 'import'],
            preferred: 'plain',
        })
    })

    it('offers an import first for another tool’s notes', async () => {
        expect(await verdictFor({ '.obsidian/app.json': '{}', 'Garden.md': 'x' })).toMatchObject({ kind: 'ask', preferred: 'import' })
    })

    it('opens the graph this device already has there', async () => {
        const owner: FolderOwner = { kind: 'folder-graph', graphId: 'g1', name: 'recipes', relation: 'same' }
        expect(await verdictFor({ 'etherpk/settings.json': '{}' }, owner)).toEqual({ kind: 'known-graph', graphId: 'g1' })
    })

    it('refuses a Local Mirror’s folder and a folder inside a graph’s own', async () => {
        const mirror: FolderOwner = { kind: 'mirror', graphId: 'g2', name: 'Home notes', relation: 'same' }
        expect(await verdictFor({ 'pages/Garden.md': 'x' }, mirror)).toEqual({ kind: 'refuse', reason: 'mirror', owner: mirror })
        const inside: FolderOwner = { kind: 'folder-graph', graphId: 'g1', name: 'recipes', relation: 'inside' }
        expect(await verdictFor({ 'Garden.md': 'x' }, inside)).toEqual({ kind: 'refuse', reason: 'inside-graph', owner: inside })
    })
})
