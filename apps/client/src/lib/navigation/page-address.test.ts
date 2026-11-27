import { describe, expect, it } from 'vitest'

import { type AddressPlace, addressInWorkspace, pageLink, pageWebAddress, readableAddress, readAddress, workspaceBase } from './page-address'

const BROWSER: AddressPlace = { origin: 'https://app.example.test', webOrigin: null, native: false }
const NATIVE: AddressPlace = { origin: 'app://etherpk', webOrigin: 'https://app.example.test', native: true }
const NATIVE_ALONE: AddressPlace = { origin: 'app://etherpk', webOrigin: null, native: true }

const GARDEN = '/graph/sync/0f4e2a/d/Garden%20Beds'

describe('the link a person copies', () => {
    it('is the web address in a browser and an installed web app', () => {
        expect(pageLink(GARDEN, BROWSER)).toBe('https://app.example.test/graph/sync/0f4e2a/d/Garden%20Beds')
    })

    it('is an EtherPK Link in a Native App, whose own address leads nowhere outside it', () => {
        expect(pageLink(GARDEN, NATIVE)).toBe('etherpk:/graph/sync/0f4e2a/d/Garden%20Beds')
    })

    it('keeps the query and the fragment', () => {
        expect(pageLink('/graph/folder/Notes/d/Kitchen#task=3-0123456789ab', NATIVE)).toBe('etherpk:/graph/folder/Notes/d/Kitchen#task=3-0123456789ab')
    })
})

describe('the web address a Native App offers beside its link', () => {
    it('is the web Client page of a synced graph', () => {
        expect(pageWebAddress(GARDEN, NATIVE)).toBe('https://app.example.test/graph/sync/0f4e2a/d/Garden%20Beds')
    })

    it('is none for a folder graph or a graph kept inside the app, which no web Client holds', () => {
        expect(pageWebAddress('/graph/folder/Notes/d/Kitchen', NATIVE)).toBeNull()
        expect(pageWebAddress('/graph/browser/0f4e2a/d/Kitchen', NATIVE)).toBeNull()
    })

    it('is none where the build names no web Client', () => {
        expect(pageWebAddress(GARDEN, NATIVE_ALONE)).toBeNull()
    })

    it('is none in a browser, where the link is the web address already', () => {
        expect(pageWebAddress(GARDEN, BROWSER)).toBeNull()
    })
})

describe('the address as a person reads it', () => {
    it('shows spaces and letters, not their escapes', () => {
        expect(readableAddress('etherpk:/graph/sync/0f4e2a/d/Caf%C3%A9%20Notes')).toBe('etherpk:/graph/sync/0f4e2a/d/Café Notes')
    })

    it('keeps the escapes that would change where it leads', () => {
        // A slash, a question mark or a hash inside a name, a percent sign, and a backslash, which a web address reads as a slash.
        expect(readableAddress('/graph/sync/a/d/Beds%2FRows%3F%23%25%5C')).toBe('/graph/sync/a/d/Beds%2FRows%3F%23%25%5C')
    })

    it('keeps escaped line breaks and tabs, and a space at the very end, which a paste would lose', () => {
        expect(readableAddress('/graph/sync/a/d/Beds%0A%09Rows%20')).toBe('/graph/sync/a/d/Beds%0A%09Rows%20')
    })

    it('leaves an escape that is not text as it is', () => {
        expect(readableAddress('/graph/sync/a/d/Beds%E0%A4')).toBe('/graph/sync/a/d/Beds%E0%A4')
    })
})

describe('reading what a person typed or pasted', () => {
    it('reads this Client’s web address, with its query and fragment', () => {
        expect(readAddress('https://app.example.test/graph/sync/0f4e2a/d/Garden?settings=general#task=1-0123456789ab', BROWSER)).toEqual({
            ok: true,
            path: '/graph/sync/0f4e2a/d/Garden?settings=general#task=1-0123456789ab',
        })
    })

    it('reads the readable form back to the address the app writes', () => {
        expect(readAddress('etherpk:/graph/sync/0f4e2a/d/Café Notes', NATIVE)).toEqual({ ok: true, path: '/graph/sync/0f4e2a/d/Caf%C3%A9%20Notes' })
    })

    it('writes each part of the path as the app does, whichever way it was escaped', () => {
        expect(readAddress('/graph/folder/Notes/d/Ann@Home', BROWSER)).toEqual({ ok: true, path: '/graph/folder/Notes/d/Ann%40Home' })
    })

    it('reads an EtherPK Link with one, two or three slashes', () => {
        for (const link of ['etherpk:/graph/sync/0f4e2a/d/Garden', 'etherpk://graph/sync/0f4e2a/d/Garden', 'etherpk:///graph/sync/0f4e2a/d/Garden']) {
            expect(readAddress(link, BROWSER)).toEqual({ ok: true, path: '/graph/sync/0f4e2a/d/Garden' })
        }
    })

    it('reads an EtherPK Link in a browser tab too', () => {
        expect(readAddress('etherpk:/graph/sync/0f4e2a/d/Garden', BROWSER)).toEqual({ ok: true, path: '/graph/sync/0f4e2a/d/Garden' })
    })

    it('finds the reference in a whole Agent Instruction, ahead of any web address in it', () => {
        const instruction = [
            'EtherPK task from the graph "Home" (0f4e2a)',
            '',
            'Task: water the beans',
            '',
            'Reference: etherpk:/graph/sync/0f4e2a/d/2026-11-26#task=1-0123456789ab',
            '',
            'Connect from https://app.example.test/graph/sync/0f4e2a?settings=agents',
        ].join('\n')
        expect(readAddress(instruction, BROWSER)).toEqual({ ok: true, path: '/graph/sync/0f4e2a/d/2026-11-26#task=1-0123456789ab' })
    })

    it('reads a bare path', () => {
        expect(readAddress('/graph/folder/Notes/d/Kitchen', NATIVE)).toEqual({ ok: true, path: '/graph/folder/Notes/d/Kitchen' })
    })

    it('reads an address typed without its scheme, as a browser does', () => {
        expect(readAddress('app.example.test/graph/sync/0f4e2a/d/Garden', BROWSER)).toEqual({ ok: true, path: '/graph/sync/0f4e2a/d/Garden' })
    })

    it('reads the web Client’s address in a Native App as the same page in the app', () => {
        expect(readAddress('https://app.example.test/graph/sync/0f4e2a/d/Garden', NATIVE)).toEqual({ ok: true, path: '/graph/sync/0f4e2a/d/Garden' })
    })

    it('reads the app’s own address', () => {
        expect(readAddress('app://etherpk/graph/sync/0f4e2a/d/Garden', NATIVE)).toEqual({ ok: true, path: '/graph/sync/0f4e2a/d/Garden' })
    })

    it('trims the spaces around a paste', () => {
        expect(readAddress('  /graph/sync/0f4e2a/d/Garden \n', BROWSER)).toEqual({ ok: true, path: '/graph/sync/0f4e2a/d/Garden' })
    })

    it('refuses nothing at all', () => {
        expect(readAddress('   ', BROWSER)).toEqual({ ok: false, refusal: 'empty' })
    })

    it('refuses another site, which belongs in a browser', () => {
        expect(readAddress('https://elsewhere.example.test/graph/sync/0f4e2a', BROWSER)).toEqual({ ok: false, refusal: 'other-site' })
        expect(readAddress('https://elsewhere.example.test/graph/sync/0f4e2a', NATIVE)).toEqual({ ok: false, refusal: 'other-site' })
    })

    it('refuses an address of this Client that shows no notes', () => {
        for (const input of ['https://app.example.test/graphs', '/graphs', '/', 'etherpk:/settings', '/graph/elsewhere/abc', '/graph/sync']) {
            expect(readAddress(input, BROWSER)).toEqual({ ok: false, refusal: 'not-a-page' })
        }
    })

    it('refuses a page name, which Search finds, and any other scheme', () => {
        for (const input of ['Garden', 'javascript:alert(1)', 'mailto:someone@example.test', 'etherpk:', 'etherpk:Garden']) {
            expect(readAddress(input, BROWSER)).toEqual({ ok: false, refusal: 'not-a-page' })
        }
    })

    it('refuses a malformed escape rather than guess at it', () => {
        expect(readAddress('/graph/sync/0f4e2a/d/Beds%E0%A4', BROWSER)).toEqual({ ok: false, refusal: 'not-a-page' })
    })
})

// The workspace toolbar shows the address from the graph's or folder's own address on: the part a
// person reads to know which page this is (`/d/Garden Beds`). Copy link still copies the whole link.
describe('the address in its workspace', () => {
    it('is the part after the graph’s own address', () => {
        expect(addressInWorkspace(GARDEN)).toBe('/d/Garden%20Beds')
        expect(readableAddress(addressInWorkspace(GARDEN))).toBe('/d/Garden Beds')
        expect(addressInWorkspace('/graph/browser/0f4e2a/a/c0ffee')).toBe('/a/c0ffee')
    })

    it('is the part after a Plain Folder’s own address', () => {
        expect(addressInWorkspace('/folder/Notes/f/garden/beds.md')).toBe('/f/garden/beds.md')
    })

    it('keeps the query and the fragment', () => {
        expect(addressInWorkspace('/graph/folder/Notes/d/Kitchen#task=3-0123456789ab')).toBe('/d/Kitchen#task=3-0123456789ab')
        expect(addressInWorkspace('/graph/sync/0f4e2a/d/Kitchen?view=raw')).toBe('/d/Kitchen?view=raw')
    })

    it('is a slash for the graph’s or the folder’s own page', () => {
        expect(addressInWorkspace('/graph/sync/0f4e2a')).toBe('/')
        expect(addressInWorkspace('/graph/sync/0f4e2a/')).toBe('/')
        expect(addressInWorkspace('/graph/sync/0f4e2a?settings=agents')).toBe('/?settings=agents')
        expect(addressInWorkspace('/folder/Notes')).toBe('/')
    })

    it('is the path whole where it is no workspace’s', () => {
        expect(addressInWorkspace('/graphs')).toBe('/graphs')
    })

    it('starts from the workspace’s own address', () => {
        expect(workspaceBase(GARDEN)).toBe('/graph/sync/0f4e2a')
        expect(workspaceBase('/graph/sync/0f4e2a?settings=agents')).toBe('/graph/sync/0f4e2a')
        expect(workspaceBase('/folder/Notes/f/garden/beds.md')).toBe('/folder/Notes')
        expect(workspaceBase('/graphs')).toBeNull()
    })
})

describe('reading a path in the workspace', () => {
    const BASE = '/graph/sync/0f4e2a'

    it('reads a path from the graph’s own address on as a page of the same graph', () => {
        expect(readAddress('/d/Kitchen', BROWSER, BASE)).toEqual({ ok: true, path: '/graph/sync/0f4e2a/d/Kitchen' })
        expect(readAddress('/d/Garden Beds', NATIVE, BASE)).toEqual({ ok: true, path: GARDEN })
        expect(readAddress('/d/Kitchen#task=3-0123456789ab', BROWSER, BASE)).toEqual({ ok: true, path: '/graph/sync/0f4e2a/d/Kitchen#task=3-0123456789ab' })
    })

    it('reads a slash as the graph’s own page, with any query', () => {
        expect(readAddress('/', BROWSER, BASE)).toEqual({ ok: true, path: BASE })
        expect(readAddress('/?settings=agents', BROWSER, BASE)).toEqual({ ok: true, path: `${BASE}?settings=agents` })
    })

    it('reads a Plain Folder’s file the same way', () => {
        expect(readAddress('/f/garden/beds.md', BROWSER, '/folder/Notes')).toEqual({ ok: true, path: '/folder/Notes/f/garden/beds.md' })
    })

    it('still reads a whole address, of this graph or another', () => {
        expect(readAddress('/graph/browser/c0ffee/d/Kitchen', BROWSER, BASE)).toEqual({ ok: true, path: '/graph/browser/c0ffee/d/Kitchen' })
        expect(readAddress('https://app.example.test/graph/sync/0f4e2a/d/Kitchen', BROWSER, BASE)).toEqual({ ok: true, path: '/graph/sync/0f4e2a/d/Kitchen' })
    })

    it('refuses the app’s own pages that show no notes, as before', () => {
        expect(readAddress('/graphs', BROWSER, BASE)).toEqual({ ok: false, refusal: 'not-a-page' })
        expect(readAddress('/share', BROWSER, BASE)).toEqual({ ok: false, refusal: 'not-a-page' })
        expect(readAddress('//elsewhere.example.test/d/Kitchen', BROWSER, BASE)).toEqual({ ok: false, refusal: 'not-a-page' })
    })

    it('refuses a path of a graph’s page outside any workspace', () => {
        expect(readAddress('/d/Kitchen', BROWSER)).toEqual({ ok: false, refusal: 'not-a-page' })
    })
})
