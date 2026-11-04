import { afterEach, describe, expect, it, vi } from 'vitest'

import { createContributionRegistry, registerAssetViewer, setActiveContributionRegistry } from '#lib/surface/index.js'

import { assetActions, canCopyImageAsset, canOpenAsset, assetClickCommand, assetExtension, assetExtensionAction } from './asset-affordances'

/**
 * The action set is what three surfaces render, so what belongs in it is worth pinning: open only
 * where a viewer exists, download only where there are bytes, delete only where the reference can
 * actually be edited.
 */

const PDF = '../assets/q3-report.a1b2c3d4.pdf'
const ZIP = '../assets/backup.a1b2c3d4.zip'
const PNG = '../assets/chart.a1b2c3d4.png'

/** A browser whose clipboard takes images: the node environment has neither global. */
function withImageClipboard() {
    vi.stubGlobal('ClipboardItem', class {})
    vi.stubGlobal('navigator', { clipboard: { write: async () => {} } })
}

/** A registry with a viewer for PDFs and nothing else, published as the active one. */
function withPdfViewer() {
    const contributions = createContributionRegistry()
    registerAssetViewer(contributions, {
        extensions: ['pdf'],
        component: (() => {}) as never,
        label: 'PDF',
    })
    setActiveContributionRegistry(contributions)
}

afterEach(() => {
    setActiveContributionRegistry(null)
    vi.unstubAllGlobals()
})

describe('canOpenAsset', () => {
    it('is true only for a type something registered can show', () => {
        withPdfViewer()

        expect(canOpenAsset(PDF)).toBe(true)
        expect(canOpenAsset(ZIP)).toBe(false)
    })

    it('is false with no graph open, rather than throwing', () => {
        expect(canOpenAsset(PDF)).toBe(false)
    })
})

describe('canCopyImageAsset', () => {
    it('is true only for an image, and only where the clipboard takes one', () => {
        withImageClipboard()

        expect(canCopyImageAsset(PNG)).toBe(true)
        expect(canCopyImageAsset(PDF)).toBe(false)
    })

    it('is false in a browser with no image clipboard, rather than offering a dead button', () => {
        expect(canCopyImageAsset(PNG)).toBe(false)
    })
})

describe('assetActions', () => {
    it('leads with copy on an image and puts View larger just before open, among the three every asset has', () => {
        withImageClipboard()
        withPdfViewer()

        expect(assetActions(PNG).map((a) => a.command)).toEqual([
            'asset.copy-image',
            'asset.download',
            'asset.view-image',
            'asset.delete',
        ])
    })

    it('never offers copy for a file that is not an image', () => {
        withImageClipboard()
        withPdfViewer()

        expect(assetActions(PDF).map((a) => a.command)).not.toContain('asset.copy-image')
    })

    it('offers View larger on an image even where the clipboard takes none, and never on another file', () => {
        expect(assetActions(PNG).map((a) => a.command)).toEqual(['asset.download', 'asset.view-image', 'asset.delete'])
        expect(assetActions(PDF).map((a) => a.command)).not.toContain('asset.view-image')
    })

    it('drops copy and View larger with download when the bytes are gone: there is nothing to show or hand over', () => {
        withImageClipboard()

        expect(assetActions(PNG, { canDownload: false }).map((a) => a.command)).toEqual(['asset.delete'])
    })

    it('gives copy a confirmation to show, since a copy leaves nothing visible behind', () => {
        withImageClipboard()

        expect(assetActions(PNG).find((a) => a.command === 'asset.copy-image')?.confirm).toEqual({ icon: 'check', label: 'Copied' })
    })

    it('offers all three where the type can be shown', () => {
        withPdfViewer()

        expect(assetActions(PDF).map((a) => a.command)).toEqual(['asset.download', 'asset.open', 'asset.delete'])
    })

    it('drops open for a type nothing can show', () => {
        withPdfViewer()

        expect(assetActions(ZIP).map((a) => a.command)).toEqual(['asset.download', 'asset.delete'])
    })

    it('keeps delete when the bytes are gone: clearing a dead reference is the point', () => {
        withPdfViewer()

        expect(assetActions(PDF, { canDownload: false }).map((a) => a.command)).toEqual([
            'asset.open',
            'asset.delete',
        ])
    })

    it('drops delete on a surface that only shows the reference', () => {
        withPdfViewer()

        expect(assetActions(PDF, { canDelete: false }).map((a) => a.command)).toEqual([
            'asset.download',
            'asset.open',
        ])
    })

    it('names every action, so a button always has a label to read', () => {
        withPdfViewer()

        expect(assetActions(PDF).every((a) => a.label.length > 0 && a.icon.length > 0)).toBe(true)
    })
})

describe('a plain click on a link to a file', () => {
    it('opens a PDF in its tab when a viewer can show it', () => {
        withPdfViewer()
        expect(assetClickCommand('../assets/guide.a1b2c3d4.pdf')).toBe('asset.open')
        expect(assetClickCommand('../assets/GUIDE.a1b2c3d4.PDF')).toBe('asset.open')
        expect(assetClickCommand('../assets/guide.a1b2c3d4.pdf#page=4')).toBe('asset.open')
    })

    it('downloads a PDF when nothing can show it', () => {
        expect(assetClickCommand('../assets/guide.a1b2c3d4.pdf')).toBe('asset.download')
    })

    it('downloads any other file', () => {
        withPdfViewer()
        expect(assetClickCommand('../assets/plans.a1b2c3d4.zip')).toBe('asset.download')
    })
})

describe('the file extension a link shows', () => {
    it.each([
        ['../assets/garden-guide.a1b2c3d4.pdf', '.pdf'],
        ['../assets/garden-guide.a1b2c3d4.pdf#page=4', '.pdf'],
        ['../assets/GARDEN.a1b2c3d4.PDF', '.pdf'],
        ['../assets/seed%20list.a1b2c3d4.tar.gz', '.gz'],
        ['../assets/notes', null],
        ['../assets/.hidden', null],
    ])('%s reads as %s', (ref, shown) => {
        expect(assetExtension(ref)).toBe(shown)
    })
})

describe('what the extension pill does', () => {
    it('leaves a picture alone', () => {
        expect(assetExtensionAction('../assets/chart.a1b2c3d4.png')).toBeNull()
    })

    it('downloads a file nothing can show', () => {
        expect(assetExtensionAction('../assets/seed-list.a1b2c3d4.csv')).toBe('Download')
    })
})
