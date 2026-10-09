import { describe, expect, it } from 'vitest'

import { publishSettings, withPublishSettings } from './host-protocol'

// A graph's host was started from another environment, an agent's, so the command line that asks
// it to publish decides the settings a publish reads.
describe('the settings a publish run by the graph host reads', () => {
    const host = { ETHERPK_MAP_STYLE_URL: 'https://maps.example.com/host.json', HOME: '/home/someone' }

    it("draws a map over the style the command line names, not the host's", () => {
        const env = withPublishSettings(host, publishSettings({ ETHERPK_MAP_STYLE_URL: 'https://maps.example.com/own.json' }))
        expect(env.ETHERPK_MAP_STYLE_URL).toBe('https://maps.example.com/own.json')
        expect(env.HOME).toBe('/home/someone')
    })

    it('passes an empty style on as it is, which draws maps on a plain background', () => {
        expect(withPublishSettings(host, publishSettings({ ETHERPK_MAP_STYLE_URL: '' })).ETHERPK_MAP_STYLE_URL).toBe('')
    })

    it("leaves the style to its default when the command line names none, whatever the host's was", () => {
        expect(withPublishSettings(host, publishSettings({})).ETHERPK_MAP_STYLE_URL).toBeUndefined()
    })
})
