import { describe, expect, it, vi } from 'vitest'

import { createCommandRegistry, createContributionRegistry, listContextMenuItems } from '$lib/surface'
import type { AssetContextMenuTarget } from '$lib/surface'

import {
    ASSET_COPY_IMAGE,
    ASSET_DELETE,
    ASSET_DOWNLOAD,
    ASSET_OPEN,
    type AssetCommandDeps,
    type AssetDeleteChoice,
    assetViewTarget,
    registerAssetCommands,
} from './asset-commands'

const REF = '../assets/q3-report.a1b2c3d4.pdf'
const ASSET_ID = 'q3-report.a1b2c3d4.pdf'
const target: AssetContextMenuTarget = { kind: 'asset', ref: REF, line: 3, occurrence: 0 }
const IMAGE_REF = '../assets/chart.a1b2c3d4.png'
const imageTarget: AssetContextMenuTarget = { kind: 'asset', ref: IMAGE_REF, line: 5, occurrence: 0 }

function harness(overrides: Partial<AssetCommandDeps> = {}, choice: AssetDeleteChoice = 'delete') {
    const removed: string[][] = []
    const deps = {
        store: () => ({ resolve: async () => ({ url: 'blob:x', name: 'Q3 Report.pdf', type: 'application/pdf' }) }),
        tools: () => ({
            identify: (ref: string) => (ref === REF ? ASSET_ID : null),
            readyToDeleteBytes: async () => ({ ready: true }),
            remove: async (ids: string[]) => {
                removed.push(ids)
                return ids.length
            },
            scan: async () => ({ orphans: [], totalAssets: 0, scannedDocuments: 0 }),
        }),
        index: () => ({
            isBuilding: () => false,
            assetUsage: async () => ({ references: 1, documents: [{ concept: 'Alpha', kind: 'page', references: 1 }] }),
        }),
        download: vi.fn(),
        copyImage: vi.fn(async () => {}),
        openAsset: vi.fn(),
        canOpen: () => true,
        canCopyImage: (ref: string) => ref.endsWith('.png'),
        onNotice: vi.fn(),
        applyToEditor: vi.fn(() => true),
        promptDelete: vi.fn(async () => choice),
        onError: vi.fn(),
        ...overrides,
    } as unknown as AssetCommandDeps & Record<string, ReturnType<typeof vi.fn>>

    const commands = createCommandRegistry()
    const contributions = createContributionRegistry()
    const dispose = registerAssetCommands(commands, contributions, deps)
    return { commands, contributions, deps, removed, dispose }
}

describe('asset.download', () => {
    it('hands the browser the resolved bytes under the asset\'s own name', async () => {
        const h = harness()

        await h.commands.execute(ASSET_DOWNLOAD, target)

        expect(h.deps.download).toHaveBeenCalledWith('blob:x', 'Q3 Report.pdf')
    })

    it('reports a missing asset rather than downloading an empty file', async () => {
        const h = harness({ store: () => ({ resolve: async () => null }) as never })

        await h.commands.execute(ASSET_DOWNLOAD, target)

        expect(h.deps.download).not.toHaveBeenCalled()
        expect(h.deps.onError).toHaveBeenCalledWith('That file is no longer in this graph.')
    })

    it('ignores a target that is not an asset', async () => {
        const h = harness()

        await h.commands.execute(ASSET_DOWNLOAD, { kind: 'favourite', concept: 'Physics' })

        expect(h.deps.download).not.toHaveBeenCalled()
    })
})

describe('asset.copy-image', () => {
    it('hands the clipboard the resolved asset as a promise, so the write starts inside the click', async () => {
        const h = harness()

        await h.commands.execute(ASSET_COPY_IMAGE, imageTarget)

        expect(h.deps.copyImage).toHaveBeenCalledTimes(1)
        const [handed] = (h.deps.copyImage as ReturnType<typeof vi.fn>).mock.calls[0] as [Promise<unknown>]
        expect(handed).toBeInstanceOf(Promise)
        await expect(handed).resolves.toEqual({ url: 'blob:x', name: 'Q3 Report.pdf', type: 'application/pdf' })
    })

    it('hands over before anything is awaited: the write must begin inside the user activation', async () => {
        const h = harness()

        const run = h.commands.execute(ASSET_COPY_IMAGE, imageTarget)

        // Safari and Firefox check for activation at the clipboard call itself; an `await` ahead of
        // the hand-over would pass every other test here and fail in both browsers.
        expect(h.deps.copyImage).toHaveBeenCalledTimes(1)
        await run
    })

    it('confirms the copy, since nothing on screen changes', async () => {
        const h = harness()

        expect(await h.commands.execute(ASSET_COPY_IMAGE, imageTarget)).toBe(true)
        expect(h.deps.onNotice).toHaveBeenCalledWith('Image copied.')
    })

    it('reports a missing asset in the same words as download, and confirms nothing', async () => {
        const h = harness({
            store: () => ({ resolve: async () => null }) as never,
            // A real clipboard write surfaces whatever the handed promise rejects with.
            copyImage: vi.fn(async (asset: Promise<unknown>) => {
                await asset
            }),
        } as never)

        expect(await h.commands.execute(ASSET_COPY_IMAGE, imageTarget)).toBe(false)
        expect(h.deps.onError).toHaveBeenCalledWith('That file is no longer in this graph.')
        expect(h.deps.onNotice).not.toHaveBeenCalled()
    })

    it('reports a blocked clipboard rather than confirming a copy that did not happen', async () => {
        const h = harness({
            copyImage: vi.fn(async () => {
                throw new Error('Could not copy the image: the browser blocked the clipboard.')
            }),
        } as never)

        expect(await h.commands.execute(ASSET_COPY_IMAGE, imageTarget)).toBe(false)
        expect(h.deps.onError).toHaveBeenCalledWith('Could not copy the image: the browser blocked the clipboard.')
        expect(h.deps.onNotice).not.toHaveBeenCalled()
    })

    it('ignores a target that is not an asset', async () => {
        const h = harness()

        await h.commands.execute(ASSET_COPY_IMAGE, { kind: 'favourite', concept: 'Physics' })

        expect(h.deps.copyImage).not.toHaveBeenCalled()
    })
})

describe('asset.open', () => {
    it('opens the tab on the asset identity, not on the reference text', async () => {
        const h = harness()

        await h.commands.execute(ASSET_OPEN, target)

        // The filesystem identity is already the file name, extension and all.
        expect(h.deps.openAsset).toHaveBeenCalledWith(ASSET_ID, REF)
    })
})

describe('assetViewTarget', () => {
    it('leaves a filesystem identity alone: the file name already carries its type', () => {
        expect(assetViewTarget('q3-report.a1b2c3d4.pdf', '../assets/q3-report.a1b2c3d4.pdf')).toBe(
            'q3-report.a1b2c3d4.pdf',
        )
    })

    it("gives a server uuid the reference's extension, so a viewer can be chosen before the bytes arrive", () => {
        const uuid = '7f3a1b2c-0000-4000-8000-000000000001'

        expect(assetViewTarget(uuid, `../assets/q3-report.${uuid}.pdf`)).toBe(`${uuid}.pdf`)
    })

    it('keeps one Asset to one tab however its references are labelled', () => {
        const uuid = '7f3a1b2c-0000-4000-8000-000000000001'

        expect(assetViewTarget(uuid, `../assets/q3-report.${uuid}.pdf`)).toBe(
            assetViewTarget(uuid, `../assets/report-q3.${uuid}.pdf`),
        )
    })

    it('falls back to the bare identity when the reference names no type', () => {
        const uuid = '7f3a1b2c-0000-4000-8000-000000000001'

        expect(assetViewTarget(uuid, `../assets/${uuid}`)).toBe(uuid)
    })
})

describe('asset.delete', () => {
    it('removes the reference and destroys the bytes when it is the last one', async () => {
        const h = harness()

        await h.commands.execute(ASSET_DELETE, target)

        expect(h.deps.applyToEditor).toHaveBeenCalled()
        expect(h.removed).toEqual([[ASSET_ID]])
    })

    it('names the asset and the plan to the dialog', async () => {
        const h = harness()

        await h.commands.execute(ASSET_DELETE, target)

        expect(h.deps.promptDelete).toHaveBeenCalledWith({
            name: 'Q3 Report.pdf',
            plan: {
                deleteBytes: true,
                references: 1,
                documents: [{ concept: 'Alpha', kind: 'page', references: 1 }],
            },
        })
    })

    it('does nothing at all when the dialog is cancelled', async () => {
        const h = harness({}, 'cancel')

        await h.commands.execute(ASSET_DELETE, target)

        expect(h.deps.applyToEditor).not.toHaveBeenCalled()
        expect(h.removed).toEqual([])
    })

    it('removes only the reference when the user chose to unlink', async () => {
        const h = harness({}, 'unlink')

        await h.commands.execute(ASSET_DELETE, target)

        expect(h.deps.applyToEditor).toHaveBeenCalled()
        expect(h.removed).toEqual([])
    })

    it('keeps the bytes when the asset is used elsewhere, whatever the dialog returns', async () => {
        const h = harness({
            index: () => ({
                isBuilding: () => false,
                assetUsage: async () => ({
                    references: 3,
                    documents: [{ concept: 'Alpha', kind: 'page', references: 2 }],
                }),
            }),
        } as never)

        await h.commands.execute(ASSET_DELETE, target)

        expect(h.removed).toEqual([])
    })

    it('never destroys bytes without first removing the reference', async () => {
        // The editor moved on: the line was edited away while the dialog was open. Destroying
        // the bytes now would leave a live reference pointing at nothing.
        const h = harness({ applyToEditor: vi.fn(() => false) } as never)

        await h.commands.execute(ASSET_DELETE, target)

        expect(h.removed).toEqual([])
    })

    it('keeps the bytes while the index is still building', async () => {
        const h = harness({
            index: () => ({ isBuilding: () => true, assetUsage: async () => ({ references: 0, documents: [] }) }),
        } as never)

        await h.commands.execute(ASSET_DELETE, target)

        expect(h.deps.promptDelete).toHaveBeenCalledWith(
            expect.objectContaining({ plan: expect.objectContaining({ deleteBytes: false, blockedBy: 'index-building' }) }),
        )
        expect(h.removed).toEqual([])
    })

    it('keeps the bytes when the synced graph cannot prove it is current', async () => {
        const h = harness({
            tools: () => ({
                identify: () => ASSET_ID,
                readyToDeleteBytes: async () => ({ ready: false, reason: 'offline' }),
                remove: async () => 0,
                scan: async () => ({ orphans: [], totalAssets: 0, scannedDocuments: 0 }),
            }),
        } as never)

        await h.commands.execute(ASSET_DELETE, target)

        expect(h.deps.promptDelete).toHaveBeenCalledWith(
            expect.objectContaining({ plan: expect.objectContaining({ deleteBytes: false, blockedBy: 'offline' }) }),
        )
    })

    it('falls back to the reference when the asset cannot be resolved for a name', async () => {
        const h = harness({ store: () => ({ resolve: async () => null }) as never })

        await h.commands.execute(ASSET_DELETE, target)

        expect(h.deps.promptDelete).toHaveBeenCalledWith(expect.objectContaining({ name: REF }))
    })

    it('refuses a reference the surface only shows, having no line to take it out of', async () => {
        // The Backlinks View renders another document's line. Delete edits the ACTIVE editor,
        // which is not that document, so there is nothing here it could correctly remove.
        const h = harness()

        await h.commands.execute(ASSET_DELETE, { kind: 'asset', ref: REF })

        expect(h.deps.promptDelete).not.toHaveBeenCalled()
        expect(h.deps.applyToEditor).not.toHaveBeenCalled()
        expect(h.removed).toEqual([])
    })
})

describe('the context menu rows', () => {
    it('offers all three on an asset, with delete grouped away', () => {
        const h = harness()

        const rows = listContextMenuItems(h.contributions, target)

        expect(rows.map((r) => r.label)).toEqual(['Download', 'Open in a new tab', 'Delete…'])
        expect(rows[2].separatorBefore).toBe(true)
    })

    it('leads with copy on an image, and only on an image', () => {
        const h = harness()

        expect(listContextMenuItems(h.contributions, imageTarget).map((r) => r.label)).toEqual([
            'Copy image',
            'Download',
            'Open in a new tab',
            'Delete…',
        ])
        expect(listContextMenuItems(h.contributions, target).map((r) => r.label)).not.toContain('Copy image')
    })

    it('hides open-in-a-tab when nothing can show the type', () => {
        const h = harness({ canOpen: () => false } as never)

        expect(listContextMenuItems(h.contributions, target).map((r) => r.label)).toEqual([
            'Download',
            'Delete…',
        ])
    })

    it('drops delete on a reference the surface only shows', () => {
        const h = harness()

        expect(listContextMenuItems(h.contributions, { kind: 'asset', ref: REF }).map((r) => r.label)).toEqual([
            'Download',
            'Open in a new tab',
        ])
    })

    it('offers none of them on a document target', () => {
        const h = harness()

        expect(listContextMenuItems(h.contributions, { kind: 'favourite', concept: 'Physics' })).toEqual([])
    })

    it('unregisters cleanly', () => {
        const h = harness()

        h.dispose()

        expect(listContextMenuItems(h.contributions, target)).toEqual([])
        expect(h.commands.has(ASSET_DELETE)).toBe(false)
    })
})
