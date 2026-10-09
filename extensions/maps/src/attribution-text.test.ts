import { describe, expect, it } from 'vitest'

import { attributionText } from './attribution-text'

describe('a basemap credit as plain text, for a picture of a map', () => {
    it('keeps the words of a linked credit and drops its markup', () => {
        expect(attributionText('<a href="https://openstreetmap.org/copyright">© OpenStreetMap</a>')).toBe('© OpenStreetMap')
        expect(attributionText('<a href="https://github.com/protomaps/basemaps">Protomaps</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>')).toBe(
            'Protomaps © OpenStreetMap',
        )
    })

    it('reads the character references credits are written with', () => {
        expect(attributionText('&copy; OpenMapTiles &amp; contributors')).toBe('© OpenMapTiles & contributors')
        expect(attributionText('&#169; one&nbsp;two &#xA9; &lt;three&gt; &quot;four&quot; &#39;five&#39;')).toBe('© one two © <three> "four" \'five\'')
    })

    it('leaves a reference it does not know as it was written', () => {
        expect(attributionText('Tiles &unknown; here')).toBe('Tiles &unknown; here')
    })

    it('runs its spaces together, as a page would show them', () => {
        expect(attributionText('  <b>Data</b>\n   from <i>OSM</i>  ')).toBe('Data from OSM')
    })

    it('keeps a less-than sign that starts no tag', () => {
        expect(attributionText('zoom < 15 > 3')).toBe('zoom < 15 > 3')
        expect(attributionText('a<!-- a note -->b')).toBe('ab')
    })
})
