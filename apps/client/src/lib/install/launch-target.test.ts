import { describe, expect, it } from 'vitest'

import { launchTarget } from './launch-target'

const origin = 'https://app.test'
const opened = 'https://app.test/graph/sync/garden/d/Kitchen'

describe('launchTarget', () => {
    it('carries out a shortcut or a share that arrives in an open window', () => {
        expect(launchTarget('https://app.test/?shortcut=today&source=pwa', origin, opened)).toBe('/?shortcut=today&source=pwa')
        expect(launchTarget('https://app.test/share?text=water%20the%20beans', origin, opened)).toBe('/share?text=water%20the%20beans')
    })

    it('goes to a link into a graph, with the task its fragment names', () => {
        expect(launchTarget('https://app.test/graph/folder/reports/d/Garden%20Notes', origin, opened)).toBe('/graph/folder/reports/d/Garden%20Notes')
        expect(launchTarget('https://app.test/graph/sync/garden/d/Beans?settings=agents#task=3-0123456789ab', origin, opened)).toBe(
            '/graph/sync/garden/d/Beans?settings=agents#task=3-0123456789ab',
        )
        expect(launchTarget('https://app.test/graph/browser/demo-graph', origin, opened)).toBe('/graph/browser/demo-graph')
        // The shape before ADR 0192 is sent on by its own page.
        expect(launchTarget('https://app.test/g/garden/d/Beans', origin, opened)).toBe('/g/garden/d/Beans')
    })

    it('leaves the person where they are for a page that is no place in a graph', () => {
        expect(launchTarget('https://app.test/graphs', origin, opened)).toBeNull()
        expect(launchTarget('https://app.test/home', origin, opened)).toBeNull()
    })

    it('leaves the person where they are for a plain launch', () => {
        expect(launchTarget('https://app.test/?source=pwa', origin, opened)).toBeNull()
        expect(launchTarget(undefined, origin, opened)).toBeNull()
    })

    it('ignores the launch that opened this page, which the page already carried out', () => {
        expect(launchTarget('https://app.test/?shortcut=search&source=pwa', origin, 'https://app.test/?shortcut=search&source=pwa')).toBeNull()
    })

    it('never navigates to another origin', () => {
        expect(launchTarget('https://elsewhere.test/?shortcut=today', origin, opened)).toBeNull()
    })
})
