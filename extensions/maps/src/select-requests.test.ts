import { describe, expect, it, vi } from 'vitest'

import { createMapSelectRequests } from './select-requests'

// "Show in document" from a Map View hands the chosen item to its Map Block, which may mount
// after the request is made or be drawn already.
describe('a request to select an item in its Map Block', () => {
    const body = ['Pebble Cove @ 50.74860, -4.07890', 'Chalk Point @ 50.66230, -4.58870']

    it('is taken by a block in that document whose body holds the line, once', () => {
        const requests = createMapSelectRequests()
        requests.request({ document: 'Campsites', text: body[1] })
        expect(requests.take('Pubs', body)).toBeNull()
        expect(requests.take('Campsites', ['Elsewhere @ 1, 2'])).toBeNull()
        expect(requests.take('campsites', body)).toBe(body[1])
        expect(requests.take('Campsites', body)).toBeNull()
    })

    it('is heard by a block that is open already', () => {
        const requests = createMapSelectRequests()
        const heard = vi.fn()
        const unsubscribe = requests.subscribe(heard)
        requests.request({ document: 'Campsites', text: body[0] })
        expect(heard).toHaveBeenCalledTimes(1)
        unsubscribe()
        requests.request({ document: 'Campsites', text: body[0] })
        expect(heard).toHaveBeenCalledTimes(1)
    })

    it('is dropped once it has waited too long, so a block opened later does not jump', () => {
        let now = 0
        const requests = createMapSelectRequests(() => now)
        requests.request({ document: 'Campsites', text: body[0] })
        now = 31_000
        expect(requests.take('Campsites', body)).toBeNull()
    })

    it('is never taken by a block outside any document (the dev harness)', () => {
        const requests = createMapSelectRequests()
        requests.request({ document: 'Campsites', text: body[0] })
        expect(requests.take(null, body)).toBeNull()
    })
})
