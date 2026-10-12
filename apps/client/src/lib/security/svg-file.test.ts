import { describe, expect, it } from 'vitest'

import { cleanedSvgFile } from './svg-file'

// The cleaning itself runs in the browser, where extensions publish, and the Client suite's publish
// test reads the file it wrote. Here, with no DOM, the one rule is that nothing passes uncleaned.

describe('an SVG file for a published site', () => {
    it('is not passed on where there is no DOM to clean it against', () => {
        expect(cleanedSvgFile('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')).toBeNull()
    })
})
