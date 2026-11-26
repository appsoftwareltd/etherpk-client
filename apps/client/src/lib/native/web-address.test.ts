import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ installed: false }))
vi.mock('./bridge.js', () => ({ isNativeApp: () => state.installed }))

import { linkAddress } from './launches'
import { openingAddress, webClientAddress, webClientOrigin } from './web-address'

afterEach(() => {
    state.installed = false
    vi.unstubAllGlobals()
})

describe('addresses written for someone else', () => {
    it('are the Client’s own in a browser', () => {
        vi.stubGlobal('location', { origin: 'https://notes.example.com' })
        expect(webClientOrigin()).toBe('https://notes.example.com')
        expect(webClientAddress('/demo')).toBe('https://notes.example.com/demo')
        expect(openingAddress('/graph/sync/abc?settings=agents')).toBe('https://notes.example.com/graph/sync/abc?settings=agents')
    })

    it('are the web Client’s in a Native App built with one', () => {
        vi.stubGlobal('location', { origin: 'app://etherpk' })
        vi.stubGlobal('__INSTALLED_BUILD__', { accountIssuer: null, webClientUrl: 'https://notes.example.com' })
        state.installed = true
        expect(webClientAddress('/demo')).toBe('https://notes.example.com/demo')
    })

    it('are none in a Native App built without one, and never the app’s own', () => {
        vi.stubGlobal('location', { origin: 'https://installed.app.etherpk.com' })
        state.installed = true
        expect(webClientOrigin()).toBeNull()
        expect(webClientAddress('/graphs')).toBeNull()
    })

    it('that the person opens from another program open the Native App, at the page they name', () => {
        state.installed = true
        const address = openingAddress('/graph/folder/Garden?settings=agents')
        expect(address).toBe('etherpk:/graph/folder/Garden?settings=agents')
        expect(linkAddress(address)).toBe('/graph/folder/Garden?settings=agents')
    })
})
