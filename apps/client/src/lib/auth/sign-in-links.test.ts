import { describe, expect, it } from 'vitest'
import { currentReturnPath, managedSignInHref, syncConnectHref } from './sign-in-links'

describe('sign-in links', () => {
    it('carries the page to come back to through managed sign-in', () => {
        expect(managedSignInHref('/g/graph-1/Meeting%20notes?view=a'))
            .toBe('/auth/login?redirect=%2Fg%2Fgraph-1%2FMeeting%2520notes%3Fview%3Da')
        expect(managedSignInHref()).toBe('/auth/login')
    })

    it('carries the page to come back to through Sync settings', () => {
        expect(syncConnectHref('/g/graph-1')).toBe('/graphs?sync=connect&return=%2Fg%2Fgraph-1')
        expect(syncConnectHref()).toBe('/graphs?sync=connect')
    })

    it('reads the return path from a location or URL, query included', () => {
        expect(currentReturnPath(new URL('https://app.example.com/g/graph-1?view=a#top'))).toBe('/g/graph-1?view=a')
    })
})
