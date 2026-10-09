import { describe, expect, it } from 'vitest'

import { isAppleDevice, mapsAppUrl } from './maps-app-link'

import { readPlaceInput } from './place-input'

// Open in maps app: the person's own maps app does the directions, so EtherPK needs no routing.

describe('opening a place in a maps app', () => {
    const point = { lat: 50.7486, lon: -1.0789 }

    it('opens Apple Maps on an Apple device, with the place named', () => {
        expect(mapsAppUrl(point, 'Seal Bay', true)).toBe('https://maps.apple.com/?ll=50.7486%2C-1.0789&q=Seal+Bay')
    })

    it('opens Google Maps everywhere else', () => {
        expect(mapsAppUrl(point, 'Seal Bay', false)).toBe('https://www.google.com/maps/search/?api=1&query=50.7486%2C-1.0789')
    })

    it('gives addresses the search box reads back to the same place', () => {
        expect(readPlaceInput(mapsAppUrl(point, 'Seal Bay', true))?.point).toEqual(point)
        expect(readPlaceInput(mapsAppUrl(point, 'Seal Bay', false))?.point).toEqual(point)
    })

    it('knows an Apple device by its browser', () => {
        expect(isAppleDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X)')).toBe(true)
        expect(isAppleDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6)')).toBe(true)
        expect(isAppleDevice('Mozilla/5.0 (Linux; Android 15; Pixel 9)')).toBe(false)
    })
})
