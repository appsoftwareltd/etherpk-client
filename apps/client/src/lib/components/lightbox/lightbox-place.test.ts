import { describe, expect, it } from 'vitest'

import { lightboxPlace } from './lightbox-place'

// The Lightbox steps through the images it was given, in the order given, and stops at either end.

describe('the place of an image in the Lightbox', () => {
    it('is its position counted from one, with the images either side of it', () => {
        expect(lightboxPlace(3, 1)).toEqual({ position: 2, count: 3, previous: 0, next: 2 })
    })

    it('has no previous image at the start and no next image at the end: stepping stops there', () => {
        expect(lightboxPlace(3, 0)).toEqual({ position: 1, count: 3, previous: null, next: 1 })
        expect(lightboxPlace(3, 2)).toEqual({ position: 3, count: 3, previous: 1, next: null })
    })

    it('is alone when there is one image', () => {
        expect(lightboxPlace(1, 0)).toEqual({ position: 1, count: 1, previous: null, next: null })
    })

    it('is held inside the images when asked for one outside them', () => {
        expect(lightboxPlace(3, 7)).toEqual({ position: 3, count: 3, previous: 1, next: null })
        expect(lightboxPlace(3, -2)).toEqual({ position: 1, count: 3, previous: null, next: 1 })
        expect(lightboxPlace(3, Number.NaN)).toEqual({ position: 1, count: 3, previous: null, next: 1 })
    })
})
