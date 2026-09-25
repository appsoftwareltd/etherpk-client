import { describe, expect, it } from 'vitest'

import { planAssets } from './assets'
import type { SourceFile } from './types'

const file = (path: string, content: string): SourceFile => ({ path, data: new Blob([content]) })

describe('planAssets', () => {
    it('names each asset by kebab stem and content hash', async () => {
        const plan = await planAssets([file('assets/My Chart.png', 'pixels')])

        const planned = plan.byPath.get('assets/My Chart.png')
        expect(planned?.ref).toMatch(/^\.\.\/assets\/my-chart\.[0-9a-f]{8}\.png$/)
        expect(planned?.stem).toBe('my-chart')
        expect(planned?.isImage).toBe(true)
        expect(plan.assets).toHaveLength(1)
    })

    it('de-duplicates identical bytes carried under different names', async () => {
        const plan = await planAssets([
            file('assets/Q3 Report.pdf', '%PDF'),
            file('attachments/Report Q3.pdf', '%PDF'),
        ])

        expect(plan.assets).toHaveLength(1)
        const first = plan.byPath.get('assets/Q3 Report.pdf')
        const second = plan.byPath.get('attachments/Report Q3.pdf')
        expect(second?.ref).toBe(first?.ref)
        expect(second?.asset).toBe(first?.asset)
    })

    it('keeps each source file its own markdown label when the bytes are shared', async () => {
        const plan = await planAssets([
            file('assets/Q3 Report.pdf', '%PDF'),
            file('attachments/Report Q3.pdf', '%PDF'),
        ])

        expect(plan.byPath.get('assets/Q3 Report.pdf')?.stem).toBe('q3-report')
        expect(plan.byPath.get('attachments/Report Q3.pdf')?.stem).toBe('report-q3')
    })

    it('marking either shared reference as referenced clears the one asset', async () => {
        const plan = await planAssets([
            file('assets/Q3 Report.pdf', '%PDF'),
            file('attachments/Report Q3.pdf', '%PDF'),
        ])

        plan.markReferenced(plan.byPath.get('attachments/Report Q3.pdf')!)

        expect(plan.assets[0].unreferenced).toBe(false)
    })

    it('treats the extension as part of identity', async () => {
        const plan = await planAssets([file('a/x.png', 'same'), file('a/x.bin', 'same')])

        expect(plan.assets).toHaveLength(2)
    })

    it('keeps different bytes apart', async () => {
        const plan = await planAssets([file('a/one.png', 'first'), file('a/two.png', 'second')])

        expect(plan.assets).toHaveLength(2)
    })

    it('resolves by lower-cased base name, both paths included', async () => {
        const plan = await planAssets([file('assets/Chart.png', 'a'), file('other/chart.png', 'b')])

        expect(plan.byBaseName.get('chart.png')).toHaveLength(2)
    })

    it('keeps verbatim names and de-duplicates by name for an EtherPK source', async () => {
        const plan = await planAssets(
            [file('assets/chart.a1b2c3d4.png', 'pixels'), file('assets/other.99887766.png', 'pixels')],
            { verbatim: true },
        )

        // Verbatim names are already final and already content-addressed by whoever wrote them,
        // so two distinct names stay two assets even when the bytes match.
        expect(plan.assets.map((a) => a.fileName)).toEqual(['chart.a1b2c3d4.png', 'other.99887766.png'])
        expect(plan.byPath.get('assets/chart.a1b2c3d4.png')?.ref).toBe('../assets/chart.a1b2c3d4.png')
    })
})
