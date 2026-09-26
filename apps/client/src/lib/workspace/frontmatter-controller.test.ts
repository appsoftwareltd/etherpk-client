import { describe, expect, it, vi } from 'vitest'

import { createFrontmatterController, type DocumentIdentity, type FrontmatterControllerDeps } from './frontmatter-controller'

function harness(text: string, registry: DocumentIdentity = { kind: 'page', concept: 'Kanban', aliases: [] }) {
    const log: string[] = []
    let current = text
    let renameAnswer: string | null = 'Kanban 2'
    const deps: FrontmatterControllerDeps = {
        backend: () => 'server',
        textOf: () => current,
        identityOf: () => registry,
        applyAliases: vi.fn(async (target, aliases) => {
            log.push(`aliases:${target}:${aliases.join(',')}`)
        }),
        writeBack: vi.fn((target, patch) => {
            log.push(`writeBack:${target}:${JSON.stringify(patch)}`)
        }),
        promptRename: vi.fn(async (concept, initialName) => {
            log.push(`rename:${concept}→${initialName}`)
            return renameAnswer
        }),
    }
    const controller = createFrontmatterController(deps)
    return {
        controller,
        log,
        deps,
        setText: (t: string) => (current = t),
        answerRename: (a: string | null) => (renameAnswer = a),
    }
}

describe('the frontmatter controller', () => {
    it('does nothing when the block agrees with the registry', async () => {
        const h = harness('---\ntitle: Kanban\n---\nbody')
        await h.controller.episodeEnded('Kanban')
        expect(h.log).toEqual([])
    })

    // A synced page renamed with "Keep the old name working" holds its old name as an alias in the
    // registry and has no block. A block typed onto it without an `aliases:` line must not clear
    // that alias; it gains it instead, so the block agrees and later edits to it keep it.
    it('keeps and writes the registry’s aliases into a block the episode created without them', async () => {
        const h = harness('---\ntags: [x]\n---\nbody', { kind: 'page', concept: 'Kanban', aliases: ['Old'] })
        await h.controller.episodeEnded('Kanban', { blockIsNew: true })
        expect(h.log).toEqual(['writeBack:Kanban:{"aliases":["Old"]}'])

        // The same block in a later episode, had nothing written it back, is a block that exists
        // without the key: that still clears, as deleting the line does.
        const later = harness('---\ntags: [x]\n---\nbody', { kind: 'page', concept: 'Kanban', aliases: ['Old'] })
        await later.controller.episodeEnded('Kanban', { blockIsNew: false })
        expect(later.log).toEqual(['aliases:Kanban:'])
    })

    // A local graph's listing reads aliases from the last saved file, so it can still hold ones the
    // person just cut with the old block. The file is the truth there: nothing is carried back.
    it('on a local graph a block the episode created changes nothing unless it names aliases', async () => {
        const h = harness('---\ntags: [x]\n---\nbody', { kind: 'page', concept: 'Kanban', aliases: ['Board'], fileStem: 'Kanban' })
        h.deps.backend = () => 'filesystem'
        await h.controller.episodeEnded('Kanban', { blockIsNew: true })
        expect(h.log).toEqual([])

        h.setText('---\ntags: [x]\naliases: [Desk]\n---\nbody')
        await h.controller.episodeEnded('Kanban', { blockIsNew: true })
        expect(h.log).toEqual(['aliases:Kanban:Desk'])
    })

    // An episode can end while the block it created is still broken (a list left open, the editor
    // blurred mid-line). Nothing is decided then; the next episode, which finds the block already
    // there, must still treat it as new rather than read the missing key as "no aliases".
    it('keeps treating a created block as new until an episode ends with it readable', async () => {
        const h = harness('---\ntags: [work\n---\nbody', { kind: 'page', concept: 'Kanban', aliases: ['Handbook'] })
        await h.controller.episodeEnded('Kanban', { blockIsNew: true })
        expect(h.log).toEqual([])

        h.setText('---\ntags: [work]\n---\nbody')
        await h.controller.episodeEnded('Kanban', { blockIsNew: false })
        expect(h.log).toEqual(['writeBack:Kanban:{"aliases":["Handbook"]}'])

        // Spent once the block has been read: this harness does not apply the write-back, so the
        // block still lacks the key, and an episode on an existing block reads that as the line
        // being deleted.
        await h.controller.episodeEnded('Kanban', { blockIsNew: false })
        expect(h.log).toEqual(['writeBack:Kanban:{"aliases":["Handbook"]}', 'aliases:Kanban:'])
    })

    // The mismatch mark's Apply reports no episode: it asks for what the block says, so a block an
    // earlier episode created unreadable is no longer treated as new once someone presses it.
    it('lets the mark’s Apply do what the block says, even for a block created unreadable', async () => {
        const h = harness('---\ntags: [work\n---\nbody', { kind: 'page', concept: 'Kanban', aliases: ['Handbook'] })
        await h.controller.episodeEnded('Kanban', { blockIsNew: true })
        h.setText('---\ntags: [work]\n---\nbody') // repaired by another member: no local episode
        await h.controller.episodeEnded('Kanban')
        expect(h.log).toEqual(['aliases:Kanban:'])
    })

    it('applies nothing when the episode ends on a block that does not parse, and the aliases once it does', async () => {
        const h = harness('---\ntags: [a]\naliases: [Board]\ntags: [b]\n---\nbody', { kind: 'page', concept: 'Kanban', aliases: ['Board'] })
        await h.controller.episodeEnded('Kanban')
        h.setText('---\naliases: [Board]\nsta\n---\nbody')
        await h.controller.episodeEnded('Kanban')
        expect(h.log).toEqual([])
        expect(h.controller.proposal('Kanban')).toEqual([])

        h.setText('---\naliases: [Board, Bord]\nstatus: draft\n---\nbody')
        await h.controller.episodeEnded('Kanban')
        expect(h.log).toEqual(['aliases:Kanban:Board,Bord'])
    })

    it('applies aliases silently, then asks about the title', async () => {
        const h = harness('---\ntitle: Kanban 2\naliases: [Board]\n---\nbody')
        await h.controller.episodeEnded('Kanban')
        expect(h.log).toEqual(['aliases:Kanban:Board', 'rename:Kanban→Kanban 2'])
    })

    it('puts the title back when the rename is cancelled, keeping the aliases it applied', async () => {
        const h = harness('---\ntitle: Kanban 2\naliases: [Board]\n---\nbody')
        h.answerRename(null)
        await h.controller.episodeEnded('Kanban')
        expect(h.log).toEqual(['aliases:Kanban:Board', 'rename:Kanban→Kanban 2', 'writeBack:Kanban:{"title":"Kanban"}'])
    })

    it('runs one episode at a time per document, so two dialogs never stack', async () => {
        const h = harness('---\ntitle: Kanban 2\n---\nbody')
        let release: (value: string | null) => void = () => {}
        h.deps.promptRename = vi.fn(
            () =>
                new Promise<string | null>((resolve) => {
                    release = resolve
                }),
        )
        const first = h.controller.episodeEnded('Kanban')
        const second = h.controller.episodeEnded('Kanban')
        await Promise.resolve()
        expect(h.deps.promptRename).toHaveBeenCalledTimes(1)

        // The user renames; by then the block agrees with the registry the second run reads.
        h.setText('---\ntitle: Kanban 2\n---\nbody')
        h.deps.identityOf = () => ({ kind: 'page', concept: 'Kanban 2', aliases: [] })
        release('Kanban 2')
        await first
        await second
        expect(h.deps.promptRename).toHaveBeenCalledTimes(1)
    })

    it('restore writes the registry identity back into the block', () => {
        const h = harness('---\ntitle: Kanban 2\n---\nbody', { kind: 'page', concept: 'Kanban', aliases: ['Board'] })
        h.controller.restore('Kanban')
        expect(h.log).toEqual(['writeBack:Kanban:{"title":"Kanban","aliases":["Board"]}'])
    })

    it('restore never writes a title into a journal entry', () => {
        const h = harness('---\ntitle: Xmas\n---\nbody', { kind: 'journal', concept: '2026-12-25', aliases: [] })
        h.controller.restore('2026-12-25')
        expect(h.log).toEqual(['writeBack:2026-12-25:{"aliases":[]}'])
    })

    it('reports the current proposal for the indicator', () => {
        const h = harness('---\ntitle: Kanban 2\n---\nbody')
        expect(h.controller.proposal('Kanban')).toEqual([{ property: 'title', policy: 'confirm', from: 'Kanban', to: 'Kanban 2' }])
    })
})
