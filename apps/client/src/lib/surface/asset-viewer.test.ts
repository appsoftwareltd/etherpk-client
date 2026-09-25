import { describe, expect, it } from 'vitest'

import { assetExtension, assetViewerFor, canViewAsset, registerAssetViewer } from './asset-viewer'
import { createContributionRegistry } from './contribution-registry'

const component = (() => {}) as never
const pdf = { extensions: ['pdf'], component, label: 'PDF' }
const image = { extensions: ['png', 'jpg', 'jpeg'], component, label: 'Image' }

describe('assetExtension', () => {
    it('reads the extension off a name or a reference', () => {
        expect(assetExtension('q3-report.pdf')).toBe('pdf')
        expect(assetExtension('../assets/q3-report.a1b2c3d4.PDF')).toBe('pdf')
        expect(assetExtension('../assets/chart.7f3a1b2c-0000-4000-8000-000000000001.png')).toBe('png')
    })

    it('strips a query or hash before judging', () => {
        expect(assetExtension('../assets/x.a1b2c3d4.pdf?v=2')).toBe('pdf')
    })

    it('is empty when there is nothing to judge by', () => {
        expect(assetExtension('README')).toBe('')
        expect(assetExtension('.gitignore')).toBe('')
        expect(assetExtension('')).toBe('')
    })
})

describe('asset viewers', () => {
    it('resolves a registered viewer by extension, case-insensitively', () => {
        const registry = createContributionRegistry()
        registerAssetViewer(registry, pdf)

        expect(assetViewerFor(registry, '../assets/q3.a1b2c3d4.pdf')?.label).toBe('PDF')
        expect(assetViewerFor(registry, 'Q3.PDF')?.label).toBe('PDF')
    })

    it('covers every extension a single registration names', () => {
        const registry = createContributionRegistry()
        registerAssetViewer(registry, image)

        for (const name of ['a.png', 'b.jpg', 'c.jpeg']) expect(canViewAsset(registry, name)).toBe(true)
    })

    it('cannot show a type nothing registered for', () => {
        const registry = createContributionRegistry()
        registerAssetViewer(registry, pdf)

        expect(canViewAsset(registry, 'archive.a1b2c3d4.zip')).toBe(false)
        expect(canViewAsset(registry, 'README')).toBe(false)
    })

    it('stops covering its extensions once disposed', () => {
        const registry = createContributionRegistry()
        const dispose = registerAssetViewer(registry, image)

        dispose()

        expect(canViewAsset(registry, 'a.png')).toBe(false)
        expect(canViewAsset(registry, 'c.jpeg')).toBe(false)
    })
})
