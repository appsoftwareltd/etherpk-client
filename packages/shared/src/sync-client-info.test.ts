import { describe, expect, it } from 'vitest'
import { UNDECLARED_SYNC_PROTOCOL_VERSION } from './sync-protocol'
import { readSyncConnect, syncConnectUrl } from './sync-client-info'

const query = (text: string) => new URLSearchParams(text)

describe('what a Client says of itself when it connects', () => {
    it('is its kind, its release and the protocol version it will speak, beside the token', () => {
        expect(syncConnectUrl('wss://sync.garden.example/sync', 'a+b/c', 3, { kind: 'installed', version: '0.52.0' }))
            .toBe('wss://sync.garden.example/sync?token=a%2Bb%2Fc&v=3&client=installed%2F0.52.0')
        // A development build has no release to name.
        expect(syncConnectUrl('ws://localhost:1/sync', 't', 3, null)).toBe('ws://localhost:1/sync?token=t&v=3')
    })

    it.each(['web', 'installed', 'headless'] as const)('reads back as it was said: %s', (kind) => {
        const url = new URL(syncConnectUrl('wss://garden.example/sync', 't', 4, { kind, version: '10.2.33' }))
        expect(readSyncConnect(url.searchParams)).toEqual({ declared: true, version: 4, client: { kind, version: '10.2.33' } })
    })

    it('leaves out a release that is not a plain version, whoever wrote it', () => {
        for (const version of ['', 'dev', '0.52', '0.52.0 (a person)', '0.52.0-garden', '99999.0.0', '0.52.0\n']) {
            expect(syncConnectUrl('wss://g.example/sync', 't', 3, { kind: 'web', version })).toBe('wss://g.example/sync?token=t&v=3')
            expect(readSyncConnect(query(new URLSearchParams({ v: '3', client: `web/${version}` }).toString()))).toEqual({ declared: true, version: 3, client: null })
        }
    })

    it.each(['client=web', 'client=web/', 'client=phone/0.52.0', 'client=web/0.52.0/x', 'client=WEB/0.52.0', 'client=%00'])(
        'reads nothing out of %s',
        (text) => { expect(readSyncConnect(query(`v=3&${text}`)).client).toBeNull() },
    )

    it('is absent from 0.51.0 and earlier, which speak version 3', () => {
        expect(readSyncConnect(query('token=t'))).toEqual({ declared: false, version: UNDECLARED_SYNC_PROTOCOL_VERSION, client: null })
    })

    it.each(['v=', 'v=x', 'v=3.5', 'v=-1', 'v=0', 'v=1e2', 'v=99999999999999999999', 'v= 3'])(
        'is absent when its version is not one: %s',
        (text) => { expect(readSyncConnect(query(`${text}&client=web%2F0.52.0`))).toEqual({ declared: false, version: 3, client: null }) },
    )
})
