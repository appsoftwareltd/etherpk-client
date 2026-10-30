import { afterEach, describe, expect, it, vi } from 'vitest'

import { getNotices, resetNotices } from '$lib/activity/notices'
import { createCommandRegistry, createContributionRegistry, listContextMenuItems } from '$lib/surface'
import type { ContextMenuTarget } from '$lib/surface'

import { getFavourites, resetFavourites, setFavourites } from '../favourites'
import {
    BACKLINKS_SHOW,
    DOCUMENT_COPY_FILE_PATH,
    DOCUMENT_COPY_NAME,
    DOCUMENT_OPEN_TO_THE_RIGHT,
    FAVOURITE_ADD,
    FAVOURITE_MOVE,
    FAVOURITE_REMOVE,
    FAVOURITES_NOTICE,
    registerDocumentCommands,
    TASKS_SHOW,
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

describe('Show Backlinks', () => {
    it('is not offered where the workspace has no Backlinks panel to show (a harness)', () => {
        const { labels } = setup()
        expect(labels(tab('Alpha'))).not.toContain('Show Backlinks')
        expect(labels({ kind: 'wikilink', concept: 'Alpha' })).not.toContain('Show Backlinks')
    })

    it('is the first row on a document tab and on a wikilink, and shows the target concept', async () => {
        const showBacklinks = vi.fn()
        const { commands, labels } = setup({ showBacklinks })

        expect(labels(tab('Alpha'))[0]).toBe('Show Backlinks')
        expect(labels({ kind: 'wikilink', concept: 'Physics' })[0]).toBe('Show Backlinks')

        await commands.execute(BACKLINKS_SHOW, tab('Alpha'))
        expect(showBacklinks).toHaveBeenLastCalledWith('Alpha')
        // The link's concept as the click resolves it: the innermost link is what the target carries.
        await commands.execute(BACKLINKS_SHOW, { kind: 'wikilink', concept: 'Physics', panelId: 'document:Notes' })
        expect(showBacklinks).toHaveBeenLastCalledWith('Physics')
    })

    it('carries the backlinks icon, the one on the Backlinks View’s tab', () => {
        const { contributions } = setup({ showBacklinks: vi.fn() })
        const row = listContextMenuItems(contributions, tab('Alpha')).find((r) => r.label === 'Show Backlinks')
        expect(row?.icon).toBe('backlinks')
    })

    it('is a tab and link row: the Sidebar rows of the same document do not carry it', () => {
        const { labels } = setup({ showBacklinks: vi.fn() })
        expect(labels({ kind: 'favourite', concept: 'Alpha' })).not.toContain('Show Backlinks')
        expect(labels({ kind: 'recent', concept: 'Alpha' })).not.toContain('Show Backlinks')
        expect(labels({ kind: 'document-row', concept: 'Alpha' })).not.toContain('Show Backlinks')
        expect(labels({ kind: 'tab', panelId: 'asset:x' })).not.toContain('Show Backlinks')
    })

    it('does nothing for a target that names no concept', async () => {
        const showBacklinks = vi.fn()
        const { commands } = setup({ showBacklinks })
        await commands.execute(BACKLINKS_SHOW, { kind: 'tab', panelId: 'asset:x' })
        await commands.execute(BACKLINKS_SHOW, undefined)
        expect(showBacklinks).not.toHaveBeenCalled()
    })
})

describe('Show Tasks', () => {
    it('is not offered where the workspace has no Tasks View to show (a harness)', () => {
        const { labels } = setup()
        expect(labels(tab('Alpha'))).not.toContain('Show Tasks')
        expect(labels({ kind: 'wikilink', concept: 'Alpha' })).not.toContain('Show Tasks')
    })

    it('follows Show Backlinks on a document tab and on a wikilink, and filters the Tasks View to the target concept', async () => {
        const showTasks = vi.fn()
        const { commands, labels } = setup({ showBacklinks: vi.fn(), showTasks })

        // The extensions' rows (6 to 8) sit between the two; none is registered here.
        expect(labels({ kind: 'wikilink', concept: 'Physics' })).toEqual(['Show Backlinks', 'Show Tasks', 'Add to favourites', 'Rename…'])
        expect(labels(tab('Alpha')).slice(0, 2)).toEqual(['Show Backlinks', 'Show Tasks'])

        await commands.execute(TASKS_SHOW, tab('Alpha'))
        expect(showTasks).toHaveBeenLastCalledWith('Alpha')
        await commands.execute(TASKS_SHOW, { kind: 'wikilink', concept: 'Physics', panelId: 'document:Notes' })
        expect(showTasks).toHaveBeenLastCalledWith('Physics')
    })

    it('carries the checkbox a task is drawn with in the editor', () => {
        const { contributions } = setup({ showTasks: vi.fn() })
        const row = listContextMenuItems(contributions, tab('Alpha')).find((r) => r.label === 'Show Tasks')
        expect(row?.icon).toBe('task')
    })

    it('is a tab and link row: the Sidebar rows of the same document do not carry it', () => {
        const { labels } = setup({ showTasks: vi.fn() })
        expect(labels({ kind: 'favourite', concept: 'Alpha' })).not.toContain('Show Tasks')
        expect(labels({ kind: 'recent', concept: 'Alpha' })).not.toContain('Show Tasks')
        expect(labels({ kind: 'document-row', concept: 'Alpha' })).not.toContain('Show Tasks')
        expect(labels({ kind: 'tab', panelId: 'asset:x' })).not.toContain('Show Tasks')
    })

    it('does nothing for a target that names no concept', async () => {
        const showTasks = vi.fn()
        const { commands } = setup({ showTasks })
        await commands.execute(TASKS_SHOW, { kind: 'tab', panelId: 'asset:x' })
        await commands.execute(TASKS_SHOW, undefined)
        expect(showTasks).not.toHaveBeenCalled()
    })
})

describe('Open in pane to the right (ADR 0155)', () => {
    const OPEN_RIGHT = 'Open in pane to the right'
    const link = (concept: string, panelId?: string): ContextMenuTarget =>
        panelId === undefined ? { kind: 'wikilink', concept } : { kind: 'wikilink', concept, panelId }

    it('leads the menu on a wikilink in a Pane the Layout can open beside, and opens the link from that Pane', async () => {
        const openToTheRight = vi.fn()
        const { commands, labels } = setup({ showBacklinks: vi.fn(), showTasks: vi.fn(), openToTheRight, canOpenToTheRight: () => true })

        expect(labels(link('Garden', 'document:Notes'))).toEqual([OPEN_RIGHT, 'Show Backlinks', 'Show Tasks', 'Add to favourites', 'Rename…'])

        await commands.execute(DOCUMENT_OPEN_TO_THE_RIGHT, link('Garden', 'document:Notes'))
        expect(openToTheRight).toHaveBeenCalledWith('Garden', 'document:Notes')
    })

    it('is not offered where the link\'s Pane has nothing beside it to open into (the phone, a Sidebar)', () => {
        const canOpenToTheRight = vi.fn((panelId: string) => panelId !== 'document:Sidebar')
        const { labels } = setup({ openToTheRight: vi.fn(), canOpenToTheRight })
        expect(labels(link('Garden', 'document:Sidebar'))).not.toContain(OPEN_RIGHT)
        expect(canOpenToTheRight).toHaveBeenCalledWith('document:Sidebar')
    })

    it('is not offered for a link with no Pane to start from, nor where the workspace cannot open beside', () => {
        expect(setup({ openToTheRight: vi.fn(), canOpenToTheRight: () => true }).labels(link('Garden'))).not.toContain(OPEN_RIGHT)
        expect(setup().labels(link('Garden', 'document:Notes'))).not.toContain(OPEN_RIGHT)
    })

    it('is a link row: a tab or a Sidebar row of the same document does not carry it', () => {
        const { labels } = setup({ openToTheRight: vi.fn(), canOpenToTheRight: () => true })
        expect(labels(tab('Garden'))).not.toContain(OPEN_RIGHT)
        expect(labels({ kind: 'favourite', concept: 'Garden' })).not.toContain(OPEN_RIGHT)
        expect(labels({ kind: 'document-row', concept: 'Garden' })).not.toContain(OPEN_RIGHT)
    })

    it('carries the icon of a frame opening to its right', () => {
        const { contributions } = setup({ openToTheRight: vi.fn(), canOpenToTheRight: () => true })
        const row = listContextMenuItems(contributions, link('Garden', 'document:Notes')).find((r) => r.label === OPEN_RIGHT)
        expect(row?.icon).toBe('pane-right')
    })

    it('does nothing for a target that is not a link from a Pane', async () => {
        const openToTheRight = vi.fn()
        const { commands } = setup({ openToTheRight, canOpenToTheRight: () => true })
        await commands.execute(DOCUMENT_OPEN_TO_THE_RIGHT, tab('Garden'))
        await commands.execute(DOCUMENT_OPEN_TO_THE_RIGHT, link('Garden'))
        await commands.execute(DOCUMENT_OPEN_TO_THE_RIGHT, undefined)
        expect(openToTheRight).not.toHaveBeenCalled()
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

describe('Add to favourites and Remove from favourites', () => {
    const ADD = 'Add to favourites'
    const REMOVE = 'Remove from favourites'
    const link = (concept: string): ContextMenuTarget => ({ kind: 'wikilink', concept, panelId: 'document:Notes' })
    /** `Veg Patch` is an alias of `Garden`; everything else names itself. */
    const canonicalName = (concept: string) => (concept.toLowerCase() === 'veg patch' ? 'Garden' : concept)

    afterEach(() => {
        resetFavourites()
        resetNotices()
    })

    const favouritesNotice = () => getNotices().find((n) => n.id === FAVOURITES_NOTICE)

    it('sits in the same place on a wikilink as on a document tab: after Show Tasks, before Rename…', () => {
        setFavourites([], async () => {})
        const { labels } = setup({ showBacklinks: vi.fn(), showTasks: vi.fn() })

        expect(labels(link('Garden'))).toEqual(['Show Backlinks', 'Show Tasks', ADD, 'Rename…'])
        const onTab = labels(tab('Garden'))
        expect(onTab.indexOf(ADD)).toBe(onTab.indexOf('Show Tasks') + 1)
        expect(onTab.indexOf('Rename…')).toBe(onTab.indexOf(ADD) + 1)
    })

    it('is offered on a link whether or not its concept has a page, and on a journal day', () => {
        // A favourite opens its concept page or no page, as a Draft tab's favourite does.
        setFavourites([], async () => {})
        const { labels } = setup()
        expect(labels(link('Not Written Yet'))).toContain(ADD)
        expect(labels(link('2026-10-29'))).toContain(ADD)
    })

    it('offers Remove on a link whose concept is a favourite, and exactly one of the pair', () => {
        setFavourites(['Garden'], async () => {})
        const { labels } = setup()
        expect(labels(link('garden'))).toContain(REMOVE)
        expect(labels(link('garden'))).not.toContain(ADD)
    })

    it('adds and removes the concept a link names', async () => {
        setFavourites(['Kitchen'], async () => {})
        const { commands } = setup()

        await commands.execute(FAVOURITE_ADD, link('Garden'))
        expect(getFavourites()).toEqual(['Kitchen', 'Garden'])
        await commands.execute(FAVOURITE_REMOVE, link('Garden'))
        expect(getFavourites()).toEqual(['Kitchen'])
    })

    it('acts on the page an alias names: Remove when the page is a favourite, and the page name stored', async () => {
        setFavourites(['Garden'], async () => {})
        const { commands, labels } = setup({ canonicalName })
        expect(labels(link('Veg Patch'))).toContain(REMOVE)

        await commands.execute(FAVOURITE_REMOVE, link('Veg Patch'))
        expect(getFavourites()).toEqual([])
        expect(labels(link('Veg Patch'))).toContain(ADD)

        await commands.execute(FAVOURITE_ADD, link('Veg Patch'))
        expect(getFavourites()).toEqual(['Garden'])
    })

    it('says what it added, by the stored name, with nothing to undo', async () => {
        setFavourites([], async () => {})
        const { commands } = setup({ canonicalName })

        await commands.execute(FAVOURITE_ADD, link('Veg Patch'))

        expect(favouritesNotice()).toMatchObject({ tone: 'info', dismissal: 'auto', text: 'Added "Garden" to favourites' })
        expect(favouritesNotice()?.actions ?? []).toEqual([])
    })

    it('says what it removed, from any surface, and its Undo puts the favourite back where it stood', async () => {
        setFavourites(['Kitchen', 'Garden', 'Hallway'], async () => {})
        const { commands } = setup()

        // A Sidebar row's Remove: the row vanishes in place, but the notice carries the way back.
        await commands.execute(FAVOURITE_REMOVE, { kind: 'favourite', concept: 'Garden' })
        const notice = favouritesNotice()
        expect(notice).toMatchObject({ tone: 'info', dismissal: 'auto', text: 'Removed "Garden" from favourites' })
        expect(notice?.actions?.map((a) => a.label)).toEqual(['Undo'])

        await notice?.actions?.[0].run()

        expect(getFavourites()).toEqual(['Kitchen', 'Garden', 'Hallway'])
        // The card now says what the Undo did, and offers nothing more to run.
        expect(favouritesNotice()).toMatchObject({ text: '"Garden" is back in favourites' })
        expect(favouritesNotice()?.actions ?? []).toEqual([])
    })

    it('tells a refused write through onError and claims no success', async () => {
        setFavourites(['Garden'], async () => {
            throw new Error('offline')
        })
        const onError = vi.fn()
        const { commands } = setup({ onError })

        await commands.execute(FAVOURITE_REMOVE, link('Garden'))
        await commands.execute(FAVOURITE_ADD, link('Kitchen'))

        expect(onError).toHaveBeenCalledWith('offline')
        expect(onError).toHaveBeenCalledTimes(2)
        expect(favouritesNotice()).toBeUndefined()
    })

    it('tells a refused Undo through onError, and leaves its card to try again', async () => {
        let refuse = false
        setFavourites(['Garden'], async () => {
            if (refuse) throw new Error('offline')
        })
        const onError = vi.fn()
        const { commands } = setup({ onError })
        await commands.execute(FAVOURITE_REMOVE, link('Garden'))

        refuse = true
        await favouritesNotice()?.actions?.[0].run()

        expect(getFavourites()).toEqual([])
        expect(onError).toHaveBeenCalledWith('offline')
        expect(favouritesNotice()?.actions?.map((a) => a.label)).toEqual(['Undo'])
    })

    it('says nothing when there was nothing to remove: a peer got there first', async () => {
        setFavourites([], async () => {})
        const { commands } = setup()
        await commands.execute(FAVOURITE_REMOVE, link('Garden'))
        expect(favouritesNotice()).toBeUndefined()
    })
})
