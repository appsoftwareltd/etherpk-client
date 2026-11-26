import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { PresentedOrigin } from './origin.ts'

const APP = 'app://etherpk'
const PUBLIC = 'https://installed.app.etherpk.com'
const out = (presented: PresentedOrigin, id: number, requestHeaders: Record<string, string>, url = 'https://sync.example/', resourceType = 'xhr') => presented.outgoing({ id, url, resourceType, requestHeaders })

describe('the origin presented', () => {
    it('is the Native Apps’ for a request of the app’s page, and the answer is turned back', () => {
        const presented = new PresentedOrigin()
        expect(out(presented, 1, { Origin: APP, Accept: '*/*' })).toEqual({ Origin: PUBLIC, Accept: '*/*' })
        expect(presented.incoming({ id: 1, responseHeaders: { 'Access-Control-Allow-Origin': [PUBLIC], Vary: ['Origin'] } })).toEqual({ 'Access-Control-Allow-Origin': [APP], Vary: ['Origin'] })
        presented.ended(1)
        expect(presented.size).toBe(0)
    })
    it('is left alone for any other origin', () => {
        const presented = new PresentedOrigin()
        for (const origin of ['null', 'https://www.youtube-nocookie.com', 'app://elsewhere', PUBLIC]) {
            expect(out(presented, 1, { Origin: origin })).toEqual({ Origin: origin })
            expect(presented.incoming({ id: 1, responseHeaders: { 'access-control-allow-origin': [PUBLIC] } })).toEqual({ 'access-control-allow-origin': [PUBLIC] })
        }
    })
    it('is taken back when a redirect loses it', () => {
        const presented = new PresentedOrigin()
        out(presented, 1, { Origin: APP })
        out(presented, 1, { Origin: 'null' })
        expect(presented.incoming({ id: 1, responseHeaders: { 'access-control-allow-origin': [PUBLIC] } })).toEqual({ 'access-control-allow-origin': [PUBLIC] })
    })
    it('property: an answer is changed only when it names exactly the origin presented, once', () => {
        const value = fc.oneof(fc.constantFrom(PUBLIC, '*', 'null', APP, `${PUBLIC}/`, `${PUBLIC}, ${PUBLIC}`, PUBLIC.toUpperCase(), 'https://installed.app.etherpk.com.evil.example', ''), fc.string())
        fc.assert(fc.property(fc.array(value, { maxLength: 3 }), fc.boolean(), fc.constantFrom('Access-Control-Allow-Origin', 'access-control-allow-origin'), (values, ours, name) => {
            const presented = new PresentedOrigin()
            out(presented, 1, { Origin: ours ? APP : 'https://elsewhere.example' })
            const responseHeaders = values.length ? { [name]: values } : {}
            const answer = presented.incoming({ id: 1, responseHeaders })
            if (ours && values.length === 1 && values[0] === PUBLIC) expect(answer).toEqual({ [name]: [APP] })
            else expect(answer).toEqual(responseHeaders)
        }), { seed: 20261125, numRuns: 500 })
    })
    it('a video player is told the page it is in, and nothing else is', () => {
        const presented = new PresentedOrigin()
        expect(out(presented, 1, {}, 'https://www.youtube-nocookie.com/embed/x', 'subFrame')).toEqual({ Referer: `${PUBLIC}/` })
        expect(out(presented, 1, {}, 'https://player.vimeo.com/video/1', 'subFrame')).toEqual({ Referer: `${PUBLIC}/` })
        expect(out(presented, 1, {}, 'https://elsewhere.example/', 'subFrame')).toEqual({})
        expect(out(presented, 1, {}, 'https://www.youtube-nocookie.com/a.js', 'script')).toEqual({})
    })
})
