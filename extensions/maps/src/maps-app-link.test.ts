import { describe, expect, it } from 'vitest'

import { isAppleDevice, mapsAppUrl } from './maps-app-link'

import { readPlaceInput } from './place-input'

// Open in maps app: the person's own maps app does the directions, so EtherPK needs no routing.

describe('opening a place in a maps app', () => {
    const point = { lat: 50.7486, lon: -4.0789 }

    it('opens Apple Maps on an Apple device, with the place named', () => {
        expect(mapsAppUrl(point, 'Pebble Cove', true)).toBe('https://maps.apple.com/?ll=50.7486%2C-4.0789&q=Pebble+Cove')
    })

    it('opens Google Maps everywhere else', () => {
        expect(mapsAppUrl(point, 'Pebble Cove', false)).toBe('https://www.google.com/maps/search/?api=1&query=50.7486%2C-4.0789')
    })

    it('gives addresses the search box reads back to the same place', () => {
        expect(readPlaceInput(mapsAppUrl(point, 'Pebble Cove', true))?.point).toEqual(point)
        expect(readPlaceInput(mapsAppUrl(point, 'Pebble Cove', false))?.point).toEqual(point)
    })

    it('knows an Apple device by its browser', () => {
        expect(isAppleDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X)')).toBe(true)
        expect(isAppleDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6)')).toBe(true)
        expect(isAppleDevice('Mozilla/5.0 (Linux; Android 15; Pixel 9)')).toBe(false)
    })
})
