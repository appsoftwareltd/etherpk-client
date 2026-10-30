import { describe, expect, it } from 'vitest'
import { refusedRequestPath } from './request-path'

// A path that starts with `//` reads as another host once a page puts it back into a link or a
// form action (`//example.com/garden`), so no route of the apps answers one.
describe('refusedRequestPath', () => {
    it('answers a path that starts with two slashes with 404', async () => {
        const response = refusedRequestPath(new URL('https://app.example.test//example.com/garden'))

        expect(response?.status).toBe(404)
        expect(await response?.text()).toBe('Not found')
    })

    it('leaves every other path to the app, two slashes later in the path included', () => {
        for (const path of ['/', '/garden', '/garden//kitchen', '/api/v1/sync']) {
            expect(refusedRequestPath(new URL(`https://app.example.test${path}`))).toBeNull()
        }
    })
})
