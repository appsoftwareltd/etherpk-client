import { describe, expect, it } from 'vitest'

import {
    clampedMapSize,
    COLUMN_SNAP,
    dragMapSize,
    dragStart,
    MAP_HEIGHT_NARROW,
    MAP_HEIGHT_WIDE,
    MAP_MAX_HEIGHT,
    MAP_MIN_HEIGHT,
    MAP_MIN_WIDTH,
    mapHeight,
    PICTURE_MAX_WIDTH,
    pictureSize,
    writtenMapSize,
} from './map-size'

// A Map Block's Display Size (ADR 0118, amended 2026-11-06): the limits a size is drawn within, what
// a drag of the handle shows and writes, and the line changes that write it.

const garden = 'Garden @ 50.74860, -4.07890'
const column = 760

describe('the limits a size is drawn within', () => {
    it('holds a typed size within them, the line staying as written', () => {
        expect(clampedMapSize({ width: 20, height: 20 })).toEqual({ width: MAP_MIN_WIDTH, height: MAP_MIN_HEIGHT })
        expect(clampedMapSize({ width: 200, height: 99999 })).toEqual({ width: MAP_MIN_WIDTH, height: MAP_MAX_HEIGHT })
    })

    it('leaves a width of any size to the column to hold', () => {
        expect(clampedMapSize({ width: 2360, height: 380 })).toEqual({ width: 2360, height: 380 })
    })

    it('leaves a size within them, and a map that fills its column, alone', () => {
        expect(clampedMapSize({ width: 640, height: 380 })).toEqual({ width: 640, height: 380 })
        expect(clampedMapSize({ width: null, height: 500 })).toEqual({ width: null, height: 500 })
    })
})

describe('the room a map takes', () => {
    it('is the default for the screen when it has no size', () => {
        expect(mapHeight(null, false)).toBe(MAP_HEIGHT_WIDE)
        expect(mapHeight(null, true)).toBe(MAP_HEIGHT_NARROW)
    })

    it('is the height the size says, on any screen', () => {
        expect(mapHeight({ width: 640, height: 500 }, false)).toBe(500)
        expect(mapHeight({ width: 640, height: 500 }, true)).toBe(500)
    })

    it('stays within the limits', () => {
        expect(mapHeight({ width: null, height: 20 }, false)).toBe(MAP_MIN_HEIGHT)
        expect(mapHeight({ width: null, height: 5000 }, false)).toBe(MAP_MAX_HEIGHT)
    })
})

describe('where a drag starts', () => {
    it('is the map’s size in whole pixels', () => {
        expect(dragStart({ width: 600.4, height: 380.4 }, column)).toEqual({ width: 600, height: 380 })
    })

    it('is no wider than the widest a drag can show, so a press on a map filling a fractional column changes nothing', () => {
        const start = dragStart({ width: 1239.59, height: 380 }, 1239.59)
        expect(start.width).toBe(1239)
        expect(dragMapSize(start, { x: 0, y: 0 }, 1239.59, false)).toEqual(start)
        expect(dragMapSize(start, { x: 1, y: 0 }, 1239.59, false)).toEqual(start)
    })
})

describe('what a drag of the handle shows', () => {
    const start = { width: 600, height: 380 }

    it('follows the pointer in both directions, in whole pixels', () => {
        expect(dragMapSize(start, { x: -100.4, y: 50.4 }, column, false)).toEqual({ width: 500, height: 430 })
    })

    it('stops at the smallest map and the tallest', () => {
        expect(dragMapSize(start, { x: -9999, y: -9999 }, column, false)).toEqual({ width: MAP_MIN_WIDTH, height: MAP_MIN_HEIGHT })
        expect(dragMapSize(start, { x: 0, y: 9999 }, column, false).height).toBe(MAP_MAX_HEIGHT)
    })

    it('never passes the column, and takes all of it from just short of it', () => {
        expect(dragMapSize(start, { x: 9999, y: 0 }, column, false).width).toBe(column)
        expect(dragMapSize(start, { x: column - COLUMN_SNAP - start.width, y: 0 }, column, false).width).toBe(column)
        expect(dragMapSize(start, { x: column - COLUMN_SNAP - 1 - start.width, y: 0 }, column, false).width).toBe(column - COLUMN_SNAP - 1)
    })

    it('lets a column narrower than the smallest map hold the map', () => {
        expect(dragMapSize({ width: 200, height: 380 }, { x: -50, y: 0 }, 200, false).width).toBe(200)
    })

    it('changes only the height on a narrow screen', () => {
        expect(dragMapSize({ width: 300, height: 380 }, { x: -100, y: 40 }, 360, true)).toEqual({ width: 300, height: 420 })
    })
})

describe('what a drag writes', () => {
    it('writes the width and the height the map ended at', () => {
        expect(writtenMapSize({ width: 640, height: 380 }, null, column, false)).toEqual({ width: 640, height: 380 })
    })

    it('leaves the width out of a map that fills its column, so it fills any column', () => {
        expect(writtenMapSize({ width: column, height: 500 }, null, column, false)).toEqual({ width: null, height: 500 })
    })

    it('keeps the stored width on a narrow screen, so a phone never narrows a map on a desktop', () => {
        expect(writtenMapSize({ width: 360, height: 500 }, { width: 640, height: 380 }, 360, true)).toEqual({ width: 640, height: 500 })
        expect(writtenMapSize({ width: 360, height: 500 }, null, 360, true)).toEqual({ width: null, height: 500 })
    })
})

describe('the size of a picture of a map', () => {
    const fallback = { width: 800, height: 450 }

    it('is the default with no size line', () => {
        expect(pictureSize([garden], fallback)).toEqual(fallback)
    })

    it('follows the size line', () => {
        expect(pictureSize(['size 640x380', garden], fallback)).toEqual({ width: 640, height: 380 })
    })

    it('takes the default width for a map that fills its column', () => {
        expect(pictureSize(['size x500', garden], fallback)).toEqual({ width: 800, height: 500 })
    })

    it('stays within the limits, as nothing else stops a typed number reaching the canvas', () => {
        expect(pictureSize(['size 99999x99999'], fallback)).toEqual({ width: PICTURE_MAX_WIDTH, height: MAP_MAX_HEIGHT })
    })
})
