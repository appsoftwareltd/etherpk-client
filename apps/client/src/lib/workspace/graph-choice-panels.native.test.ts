import { describe, expect, it, vi } from 'vitest'

// In a Native App the folder is opened by the app, so no point sends the person to a browser.
vi.mock('../native/bridge.js', async (original) => ({ ...(await original<object>()), isNativeApp: () => true }))

const { graphChoicePanels } = await import('./graph-choice-panels')

describe('the Synced Graph panel in a Native App', () => {
    it('offers the Local Mirror without naming a browser', () => {
        const bullets = graphChoicePanels({
            folderSupported: true, managedOffered: true, servers: [], trialUrl: null, billingUrl: null, pricingUrl: null, offer: null,
        }).synced.bullets
        expect(bullets).toContain('Keep a Local Mirror as plain Markdown files')
        expect(bullets.join(' ')).not.toMatch(/browser that/)
    })
})
