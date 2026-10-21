import { describe, expect, it } from 'vitest'

import { launchTarget } from './launch-target'

const origin = 'https://app.test'
const opened = 'https://app.test/g/garden/d/Kitchen'

describe('launchTarget', () => {
    it('carries out a shortcut or a share that arrives in an open window', () => {
        expect(launchTarget('https://app.test/?shortcut=today&source=pwa', origin, opened)).toBe('/?shortcut=today&source=pwa')
        expect(launchTarget('https://app.test/share?text=water%20the%20beans', origin, opened)).toBe('/share?text=water%20the%20beans')
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
