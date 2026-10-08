import { describe, expect, it } from 'vitest'
import { currentReturnPath, managedSignInHref, returnHereSignedIn, syncConnectHref } from './sign-in-links'

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

    // A sign-in started on the Graphs page comes back to the same tab and server sub-tab, marked so
    // the page says it worked, with no notice from an earlier arrival carried along.
    it('comes back to the page a sign-in started on, tab and sub-tab included, marked as signed in', () => {
        expect(returnHereSignedIn(new URL('https://app.example.com/graphs?tab=sync&server=sync.example.com')))
            .toBe('/graphs?tab=sync&server=sync.example.com&managed=connected')
        expect(returnHereSignedIn(new URL('https://app.example.com/graphs'))).toBe('/graphs?managed=connected')
        expect(returnHereSignedIn(new URL('https://app.example.com/graphs?managed=signed-out&sync=disconnected&tab=device')))
            .toBe('/graphs?tab=device&managed=connected')
    })

    it('reads the return path from a location or URL, query included', () => {
        expect(currentReturnPath(new URL('https://app.example.com/g/graph-1?view=a#top'))).toBe('/g/graph-1?view=a')
    })
})
