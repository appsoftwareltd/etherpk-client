import { describe, expect, it } from 'vitest'

import { visibleWindow } from './keyboard-inset'

/**
 * What a phone's soft keyboard leaves of the window (keyboard-inset.ts), from the visual viewport:
 * how much of the window's foot is covered, and how far the browser has moved the page up under
 * what is left. A window 844px tall, and a keyboard of 340px.
 */

const WINDOW = 844

describe('the part of the window a soft keyboard leaves', () => {
    it('is all of it with no keyboard', () => {
        expect(visibleWindow(WINDOW, { height: 844, offsetTop: 0, scale: 1 })).toEqual({ top: 0, bottom: 0 })
    })

    it('ends above the keyboard', () => {
        expect(visibleWindow(WINDOW, { height: 504, offsetTop: 0, scale: 1 })).toEqual({ top: 0, bottom: 340 })
    })

    it('starts where the browser moved the page to, to show the caret', () => {
        // The window's top 200px are above the screen: what shows is from 200 to 704.
        expect(visibleWindow(WINDOW, { height: 504, offsetTop: 200, scale: 1 })).toEqual({ top: 200, bottom: 140 })
    })

    it('is all of the window where the keyboard resizes the page itself', () => {
        // The window is as tall as what the keyboard leaves, and the visual viewport is all of it.
        expect(visibleWindow(504, { height: 504, offsetTop: 0, scale: 1 })).toEqual({ top: 0, bottom: 0 })
    })

    it('is all of the window while the page is zoomed: a pinch shows part of the page, and no keyboard did that', () => {
        expect(visibleWindow(WINDOW, { height: 422, offsetTop: 150, scale: 2 })).toEqual({ top: 0, bottom: 0 })
    })

    it('never has less than nothing covered', () => {
        // A browser reports a fraction of a px more than the window while its bars move.
        expect(visibleWindow(WINDOW, { height: 844.5, offsetTop: 0, scale: 1 })).toEqual({ top: 0, bottom: 0 })
        expect(visibleWindow(WINDOW, { height: 504, offsetTop: -3, scale: 1 })).toEqual({ top: 0, bottom: 340 })
    })
})
