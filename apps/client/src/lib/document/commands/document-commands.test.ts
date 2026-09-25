import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCommandRegistry, createContributionRegistry, listContextMenuItems } from '$lib/surface'
import type { ContextMenuTarget } from '$lib/surface'

import { getFavourites, resetFavourites, setFavourites } from '../favourites'
import {
    BACKLINKS_SHOW,
    DOCUMENT_COPY_FILE_PATH,
    DOCUMENT_COPY_NAME,
    FAVOURITE_MOVE,
    registerDocumentCommands,
} from './document-commands'

const tab = (concept: string): ContextMenuTarget => ({ kind: 'document-tab', concept, panelId: `document:${concept}` })

function setup(deps: Partial<Parameters<typeof registerDocumentCommands>[2]> = {}) {
    const commands = createCommandRegistry()
    const contributions = createContributionRegistry()
    registerDocumentCommands(commands, contributions, {
        promptRename: vi.fn(),
        promptDelete: vi.fn(),
        ...deps,
    })
    const labels = (target: ContextMenuTarget) => listContextMenuItems(contributions, target).map((r) => r.label)
    return { commands, contributions, labels }
}

describe('Copy full file path', () => {
    it('is not offered when the workspace has no file paths to give (a Server graph)', () => {
        const { labels } = setup()
        expect(labels(tab('Alpha'))).not.toContain('Copy full file path to clipboard')
    })

    it('is offered last on a document tab whose file is known, and runs the copy with the concept', () => {
        const copyFilePath = vi.fn()
        const { commands, labels } = setup({
            hasFilePath: (concept) => concept === 'Alpha',
            copyFilePath,
        })
        const rows = labels(tab('Alpha'))
        expect(rows.at(-1)).toBe('Copy full file path to clipboard')
        expect(labels(tab('Ghost'))).not.toContain('Copy full file path to clipboard')

        commands.execute(DOCUMENT_COPY_FILE_PATH, tab('Alpha'))
        expect(copyFilePath).toHaveBeenCalledWith('Alpha')
    })

    it('is a tab row: a Favourites or Recents row of the same document does not carry it', () => {
        const { labels } = setup({ hasFilePath: () => true, copyFilePath: vi.fn() })
        expect(labels({ kind: 'favourite', concept: 'Alpha' })).not.toContain('Copy full file path to clipboard')
        expect(labels({ kind: 'recent', concept: 'Alpha' })).not.toContain('Copy full file path to clipboard')
    })
})

describe('Copy name', () => {
    const COPY_NAME = 'Copy name to clipboard'

    function stubClipboard(writeText: (text: string) => Promise<void>) {
        vi.stubGlobal('navigator', { clipboard: { writeText } })
    }

    afterEach(() => vi.unstubAllGlobals())

    it('is offered on a document tab with no file behind it: a synced graph, or a document not written yet', () => {
        // No `hasFilePath` is what a Server graph supplies; a Filesystem graph answers false for
        // a Draft, which has no file until its first edit. Either way the tab has a name.
        const { labels } = setup()
        expect(labels(tab('Alpha')).at(-1)).toBe(COPY_NAME)
        const folder = setup({ hasFilePath: () => false, copyFilePath: vi.fn() })
        expect(folder.labels(tab('Not Yet Written')).at(-1)).toBe(COPY_NAME)
    })

    it('sits directly above Copy full file path, the two sharing one group', () => {
        const { contributions } = setup({ hasFilePath: () => true, copyFilePath: vi.fn() })
        const rows = listContextMenuItems(contributions, tab('Alpha'))
        expect(rows.slice(-2).map((r) => [r.label, r.separatorBefore])).toEqual([
            [COPY_NAME, true],
            ['Copy full file path to clipboard', false],
        ])
    })

    it('copies the name exactly as the tab shows it and says what it copied', async () => {
        const writeText = vi.fn(async () => {})
        stubClipboard(writeText)
        const onCopied = vi.fn()
        const { commands } = setup({ onCopied })

        expect(await commands.execute(DOCUMENT_COPY_NAME, tab('Project Plan'))).toBe(true)
        expect(writeText).toHaveBeenCalledWith('Project Plan')
        expect(onCopied).toHaveBeenCalledWith('Copied "Project Plan"')
    })

    it('tells a refused write with the name in it, so it can be copied by hand', async () => {
        stubClipboard(async () => {
            throw new Error('Write permission denied.')
        })
        const onError = vi.fn()
        const onCopied = vi.fn()
        const { commands } = setup({ onError, onCopied })

        expect(await commands.execute(DOCUMENT_COPY_NAME, tab('Alpha'))).toBe(false)
        expect(onError).toHaveBeenCalledWith('Could not copy the name: Write permission denied. Copy it by hand: Alpha')
        expect(onCopied).not.toHaveBeenCalled()
    })

    it('says why when the origin has no clipboard at all', async () => {
        vi.stubGlobal('navigator', {})
        const onError = vi.fn()
        const { commands } = setup({ onError })

        expect(await commands.execute(DOCUMENT_COPY_NAME, tab('Alpha'))).toBe(false)
        expect(onError.mock.calls[0][0]).toContain('https or localhost')
    })

    it('is a tab row: the Sidebar rows and a wikilink do not carry it', () => {
        const { labels } = setup()
        expect(labels({ kind: 'favourite', concept: 'Alpha' })).not.toContain(COPY_NAME)
        expect(labels({ kind: 'recent', concept: 'Alpha' })).not.toContain(COPY_NAME)
        expect(labels({ kind: 'document-row', concept: 'Alpha' })).not.toContain(COPY_NAME)
        expect(labels({ kind: 'wikilink', concept: 'Alpha' })).not.toContain(COPY_NAME)
        expect(labels({ kind: 'tab', panelId: 'asset:x' })).not.toContain(COPY_NAME)
    })
})

describe('Show backlinks', () => {
    it('is not offered where the workspace has no Backlinks panel to show (a harness)', () => {
        const { labels } = setup()
        expect(labels(tab('Alpha'))).not.toContain('Show backlinks')
        expect(labels({ kind: 'wikilink', concept: 'Alpha' })).not.toContain('Show backlinks')
    })

    it('is the first row on a document tab and on a wikilink, and shows the target concept', async () => {
        const showBacklinks = vi.fn()
        const { commands, labels } = setup({ showBacklinks })

        expect(labels(tab('Alpha'))[0]).toBe('Show backlinks')
        expect(labels({ kind: 'wikilink', concept: 'Physics' })[0]).toBe('Show backlinks')

        await commands.execute(BACKLINKS_SHOW, tab('Alpha'))
        expect(showBacklinks).toHaveBeenLastCalledWith('Alpha')
        // The link's concept as the click resolves it: the innermost link is what the target carries.
        await commands.execute(BACKLINKS_SHOW, { kind: 'wikilink', concept: 'Physics', panelId: 'document:Notes' })
        expect(showBacklinks).toHaveBeenLastCalledWith('Physics')
    })

    it('is a tab and link row: the Sidebar rows of the same document do not carry it', () => {
        const { labels } = setup({ showBacklinks: vi.fn() })
        expect(labels({ kind: 'favourite', concept: 'Alpha' })).not.toContain('Show backlinks')
        expect(labels({ kind: 'recent', concept: 'Alpha' })).not.toContain('Show backlinks')
        expect(labels({ kind: 'document-row', concept: 'Alpha' })).not.toContain('Show backlinks')
        expect(labels({ kind: 'tab', panelId: 'asset:x' })).not.toContain('Show backlinks')
    })

    it('does nothing for a target that names no concept', async () => {
        const showBacklinks = vi.fn()
        const { commands } = setup({ showBacklinks })
        await commands.execute(BACKLINKS_SHOW, { kind: 'tab', panelId: 'asset:x' })
        await commands.execute(BACKLINKS_SHOW, undefined)
        expect(showBacklinks).not.toHaveBeenCalled()
    })
})

describe('favourites.move', () => {
    afterEach(() => resetFavourites())

    it('moves a favourite to the asked-for position', async () => {
        const onError = vi.fn()
        const { commands } = setup({ onError })
        setFavourites(['Gamma', 'Beta', 'Alpha'], async () => {})

        await commands.execute(FAVOURITE_MOVE, { concept: 'Alpha', toIndex: 0 })

        expect(getFavourites()).toEqual(['Alpha', 'Gamma', 'Beta'])
        expect(onError).not.toHaveBeenCalled()
    })

    it('reports a refused write through onError, like the other favourite commands', async () => {
        const onError = vi.fn()
        const { commands } = setup({ onError })
        setFavourites(['Gamma', 'Beta'], async () => {
            throw new Error('offline')
        })

        await commands.execute(FAVOURITE_MOVE, { concept: 'Beta', toIndex: 0 })

        expect(getFavourites()).toEqual(['Gamma', 'Beta'])
        expect(onError).toHaveBeenCalledWith('offline')
    })

    it('ignores an argument that is not a move', async () => {
        const { commands } = setup()
        setFavourites(['Gamma', 'Beta'], async () => {})

        await commands.execute(FAVOURITE_MOVE, { kind: 'favourite', concept: 'Beta' })
        await commands.execute(FAVOURITE_MOVE, undefined)

        expect(getFavourites()).toEqual(['Gamma', 'Beta'])
    })
})
