import { describe, expect, it } from 'vitest'

import { MapPictureError } from './map-drawing'
import { copyFailureText, saveFailureText, savedPictureName } from './map-save'

describe('the name of a saved picture', () => {
    it('is the document and the word map, numbered from a document’s second map', () => {
        expect(savedPictureName('Trips', 0)).toBe('Trips map.png')
        expect(savedPictureName('Trips', 1)).toBe('Trips map 2.png')
        expect(savedPictureName('2026-11-06', 2)).toBe('2026-11-06 map 3.png')
    })

    it('is the word map alone with no document to name it', () => {
        expect(savedPictureName(null, 0)).toBe('map.png')
        expect(savedPictureName(null, 1)).toBe('map 2.png')
    })

    it('leaves out what a file name cannot hold', () => {
        expect(savedPictureName('Garden/Shed: plans?', 0)).toBe('Garden Shed plans map.png')
        expect(savedPictureName('"Kitchen" <notes> | a\\b*', 0)).toBe('Kitchen notes a b map.png')
        expect(savedPictureName('Garden\u0007\tShed', 0)).toBe('Garden Shed map.png')
        expect(savedPictureName('  ..Garden..  ', 0)).toBe('Garden map.png')
    })

    it('falls back to the word map when nothing of the document’s name is left', () => {
        expect(savedPictureName('///', 0)).toBe('map.png')
        expect(savedPictureName('...', 1)).toBe('map 2.png')
    })

    it('keeps a long document name within what a file system allows', () => {
        const name = savedPictureName('a'.repeat(300), 0)
        expect(name.length).toBeLessThanOrEqual(120)
        expect(name.endsWith('a map.png')).toBe(true)
    })
})

describe('what a failed save says', () => {
    it('gives a picture’s own reason as a sentence', () => {
        const error = new MapPictureError("some of the map's tiles didn't load. Check your connection, then try again")
        expect(saveFailureText(error)).toBe("Some of the map's tiles didn't load. Check your connection, then try again.")
    })

    it('keeps any other error’s own text to itself', () => {
        expect(saveFailureText(new TypeError('undefined is not an object'))).toBe("The picture couldn't be saved. Try again.")
        expect(saveFailureText('nope')).toBe("The picture couldn't be saved. Try again.")
    })
})

describe('what a failed copy says', () => {
    it('gives a picture’s own reason as a sentence', () => {
        expect(copyFailureText(new MapPictureError("you're offline, and the map's tiles can't be fetched"))).toBe("You're offline, and the map's tiles can't be fetched.")
    })

    it('says when the browser blocked the clipboard, which names nothing a person can act on as it stands', () => {
        expect(copyFailureText(new DOMException('Write permission denied.', 'NotAllowedError'))).toBe('The browser blocked the clipboard.')
    })

    it('keeps any other error’s own text to itself', () => {
        expect(copyFailureText(new TypeError('undefined is not an object'))).toBe("The picture couldn't be copied. Try again.")
    })
})
