import { describe, expect, it } from 'vitest'

import type { MapItemHit, MapItemsResult } from '$lib/document/index-map-items'
import { readMapLine } from '$lib/document/map-text'

import { engineItems, filterKeys, findSelection, groupByDocument, itemLabel, sameAnswer, sharedName, spotHeading, spotSummary, summarise, touchesMaps } from './map-view-model'

// What a Map View makes of the index's answer: the list beside the map grouped by document, the
// filter, the summary line, and the selection, which has to survive the answer being read again.

function hit(concept: string, line: number, text: string, fenceLine = 0): MapItemHit {
    const item = readMapLine(text)
    if (!item) throw new Error(`not a map line: ${text}`)
    return { concept, kind: 'page', line, fenceLine, text, item }
}

const seal = hit('Campsites', 1, 'Seal Bay @ 50.74860, -1.07890')
const needles = hit('Campsites', 2, 'The Needles @ 50.66230, -1.58870')
const walk = hit('Isle of Wight', 4, 'Coast walk @ 50.7, -1.3 > 50.71, -1.31', 3)
const ship = hit('Pubs', 1, 'The Ship @ 50.5, -1.2')
const hits = [seal, needles, walk, ship]

describe('the list beside the map', () => {
    it('groups items by the document they are written in, in the order the index gave', () => {
        expect(groupByDocument(hits, [0, 1, 2, 3])).toEqual([
            { concept: 'Campsites', kind: 'page', keys: [0, 1] },
            { concept: 'Isle of Wight', kind: 'page', keys: [2] },
            { concept: 'Pubs', kind: 'page', keys: [3] },
        ])
    })

    it('leaves out the documents the filter emptied', () => {
        expect(groupByDocument(hits, [2])).toEqual([{ concept: 'Isle of Wight', kind: 'page', keys: [2] }])
    })

    it('names an unnamed item by what it is', () => {
        expect(itemLabel(seal.item)).toBe('Seal Bay')
        expect(itemLabel(hit('A', 0, '@ 1, 2').item)).toBe('Unnamed place')
        expect(itemLabel(hit('A', 0, '@ 1, 2 > 3, 4').item)).toBe('Unnamed route')
    })
})

describe('filtering', () => {
    it('keeps every item for an empty filter', () => {
        expect(filterKeys(hits, '  ')).toEqual([0, 1, 2, 3])
    })

    it('matches an item by its name or its document, whatever the case', () => {
        expect(filterKeys(hits, 'the')).toEqual([1, 3])
        expect(filterKeys(hits, 'wight')).toEqual([2])
        expect(filterKeys(hits, 'campsites')).toEqual([0, 1])
    })
})

describe('the summary line', () => {
    it('counts places, routes and documents', () => {
        expect(summarise(hits, [0, 1, 2, 3])).toBe('3 places and 1 route in 3 documents')
        expect(summarise(hits, [0])).toBe('1 place in 1 document')
        expect(summarise(hits, [2])).toBe('1 route in 1 document')
        expect(summarise(hits, [])).toBe('Nothing matches')
    })
})

describe('places that share one spot', () => {
    const harbour = (concept: string, line = 1) => hit(concept, line, 'Harbour @ 50.70000, -1.50000')

    it('are headed by the name they share, and say how many documents hold them', () => {
        const spot = [harbour('Trips'), harbour('Walks'), harbour('Weekends')]
        expect(sharedName(spot)).toBe('Harbour')
        expect(spotHeading(spot)).toBe('Harbour')
        expect(spotSummary(spot)).toBe('In 3 documents')
    })

    it('say how one document holds the same place written twice', () => {
        expect(spotSummary([harbour('Trips', 1), harbour('Trips', 4)])).toBe('Written 2 times in Trips')
    })

    it('are counted when their names differ, so each row names its place', () => {
        const spot = [harbour('Trips'), hit('Trips', 2, 'Quay @ 50.70000, -1.50000')]
        expect(sharedName(spot)).toBeNull()
        expect(spotHeading(spot)).toBe('2 places here')
        expect(spotSummary(spot)).toBe('All in Trips')
        expect(spotSummary([harbour('Trips'), hit('Walks', 2, 'Quay @ 50.70000, -1.50000')])).toBe('In 2 documents')
    })
})

describe('the selection', () => {
    it('finds the item again by its document, line and words after the answer is read again', () => {
        const again = [needles, seal]
        expect(findSelection(again, { concept: 'Campsites', line: 1, text: seal.text })).toBe(1)
    })

    it('follows an item whose line moved, and lets go of one that is gone', () => {
        const moved = hit('Campsites', 5, seal.text)
        expect(findSelection([needles, moved], { concept: 'Campsites', line: 1, text: seal.text })).toBe(1)
        expect(findSelection([needles], { concept: 'Campsites', line: 1, text: seal.text })).toBeNull()
    })
})

describe('reading again', () => {
    it('reads again after an update that may have touched a map, and only then', () => {
        expect(touchesMaps({ full: true, mapsChanged: false })).toBe(true)
        expect(touchesMaps({ full: false, mapsChanged: true })).toBe(true)
        expect(touchesMaps({ full: false, mapsChanged: false })).toBe(false)
    })

    it('treats an answer saying the same as the last one as the same, so the map is not drawn again', () => {
        const answer = (items: MapItemHit[], truncated = false): MapItemsResult => ({ items, truncated })
        expect(sameAnswer(answer([seal, needles]), answer([hit('Campsites', 1, seal.text), hit('Campsites', 2, needles.text)]))).toBe(true)
        expect(sameAnswer(answer([seal, needles]), answer([seal]))).toBe(false)
        expect(sameAnswer(answer([seal]), answer([hit('Campsites', 1, 'Seal Bay @ 50.7, -1.0')]))).toBe(false)
        expect(sameAnswer(answer([seal]), answer([hit('Elsewhere', 1, seal.text)]))).toBe(false)
        expect(sameAnswer(answer([seal]), answer([seal], true))).toBe(false)
    })
})

describe('what the map draws', () => {
    it('draws the kept items under their place in the answer, so a click names the item', () => {
        expect(engineItems(hits, [1, 2])).toEqual([
            { ...needles.item, key: 1 },
            { ...walk.item, key: 2 },
        ])
    })
})
