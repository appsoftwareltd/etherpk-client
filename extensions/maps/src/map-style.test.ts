import { describe, expect, it } from 'vitest'

import { DEFAULT_MAP_STYLES, mapStyles } from './map-style'

// Which MapLibre styles a deployment draws its maps with (ADR 0119), set the way the dictionary
// host is: unset means EtherPK's own map host, empty means no basemap, a URL names another.

describe('the map styles', () => {
    it("are EtherPK's own host's when unset: one coloured style, the same in both themes", () => {
        expect(mapStyles(undefined, undefined, false)).toEqual(DEFAULT_MAP_STYLES)
        expect(DEFAULT_MAP_STYLES).toEqual({
            light: 'https://maps.etherpk.com/styles/light.json',
            dark: 'https://maps.etherpk.com/styles/light.json',
        })
    })

    it("are a public host's coloured style in development, the same in both themes, so a map shows tiles with no setup", () => {
        expect(mapStyles(undefined, undefined, true)).toEqual({
            light: 'https://tiles.openfreemap.org/styles/liberty',
            dark: 'https://tiles.openfreemap.org/styles/liberty',
        })
    })

    it('are the configured style, used in the dark too unless a dark one is named', () => {
        expect(mapStyles(' https://maps.example.com/light.json ', undefined, false)).toEqual({
            light: 'https://maps.example.com/light.json',
            dark: 'https://maps.example.com/light.json',
        })
        expect(mapStyles('https://maps.example.com/light.json', 'https://maps.example.com/dark.json', false)?.dark).toBe(
            'https://maps.example.com/dark.json',
        )
    })

    it('are none when set empty: places are drawn with no basemap', () => {
        expect(mapStyles('', undefined, false)).toBeNull()
    })
})
