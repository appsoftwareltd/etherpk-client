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
