import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { HOSTILE_PATHS } from './contract.ts'
import { checkedRelativePath, connectNativeBridge, isSyncServerOrigin, NATIVE_BRIDGE_VERSION, type NativePort, syncServerOriginOf } from './index.ts'

// This package has no Node types: it is read by pages and shells alike.
const RUNS = Number((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.NATIVE_FUZZ_RUNS ?? 500)
const SETTINGS = { seed: 20261125, numRuns: RUNS }

/** A name any platform's folder could hold, as far as the path check is concerned. */
const name = fc.string({ unit: 'grapheme', minLength: 1, maxLength: 12 }).filter((value) => value !== '.' && value !== '..' && !/[\\/\u0000-\u001f]/.test(value)) // eslint-disable-line no-control-regex -- the characters a name must not hold

describe('checkedRelativePath', () => {
    it('refuses each hostile path', () => {
        for (const path of HOSTILE_PATHS) expect([path, checkedRelativePath(path)]).toEqual([path, null])
    })

    it('refuses what is not a string', () => {
        for (const path of [null, undefined, 1, {}, ['a'], Object('a')]) expect(checkedRelativePath(path)).toBe(null)
    })

    it('gives back the names of an ordinary path', () => {
        fc.assert(fc.property(fc.array(name, { maxLength: 6 }), (names) => {
            expect(checkedRelativePath(names.join('/'))).toEqual(names)
        }), SETTINGS)
    })

    it('never gives back a name that climbs, splits or hides, whatever it is sent', () => {
        fc.assert(fc.property(fc.oneof(fc.string({ unit: 'binary' }), fc.array(fc.constantFrom('..', '.', '', 'a', '\\', '/', '\u0000')).map((parts) => parts.join('/'))), (path) => {
            const segments = checkedRelativePath(path)
            if (segments === null) return
            expect(segments.join('/')).toBe(path)
            // Resolving what it accepted never goes above where it started.
            for (const segment of segments) {
                expect(['', '.', '..']).not.toContain(segment)
                expect(segment).not.toMatch(/[\\/\u0000]/) // eslint-disable-line no-control-regex -- the character under test
            }
        }), SETTINGS)
    })
})

describe('connectNativeBridge', () => {
    const port = (bridgeVersion: number): NativePort => ({
        info: { bridgeVersion, platform: 'linux', appVersion: '0', features: { watch: false, showInFileManager: false, print: false, signIn: false, updates: false } },
        call: async () => ({ ok: false, name: 'NotFoundError', message: 'gone' }),
        on: () => () => {},
    })

    it('throws a failure as a DOMException of that name', async () => {
        const bridge = connectNativeBridge(port(NATIVE_BRIDGE_VERSION))
        const error = await bridge.call('folders.get', { folder: 'x' }).catch((thrown: unknown) => thrown)
        expect(error).toBeInstanceOf(DOMException)
        expect((error as DOMException).name).toBe('NotFoundError')
    })

    it('refuses a shell of another version', () => {
        expect(() => connectNativeBridge(port(NATIVE_BRIDGE_VERSION + 1))).toThrow(/version/)
    })
})

describe('the Sync Server a person sets for an app', () => {
    it('is the origin of an https address, or of an http one on this computer', () => {
        expect(syncServerOriginOf('https://sync.example.test')).toBe('https://sync.example.test')
        expect(syncServerOriginOf('https://sync.example.test/')).toBe('https://sync.example.test')
        expect(syncServerOriginOf('  https://Sync.Example.test:8443/ ')).toBe('https://sync.example.test:8443')
        expect(syncServerOriginOf('http://localhost:5274')).toBe('http://localhost:5274')
        expect(syncServerOriginOf('http://127.0.0.1:5274/')).toBe('http://127.0.0.1:5274')
    })

    it('is refused in every other shape', () => {
        for (const value of [
            '', 'sync.example.test', 'http://sync.example.test', 'ftp://sync.example.test', 'wss://sync.example.test',
            'https://sync.example.test/sync', 'https://sync.example.test/?a=1', 'https://sync.example.test/#a',
            'https://person:secret@sync.example.test', 'https://person@sync.example.test', 'http://192.168.1.2:5274',
            'http://localhost.example.test', 'javascript:alert(1)', 'https://', 7, null, undefined, {},
        ]) expect([value, syncServerOriginOf(value)]).toEqual([value, null])
    })

    it('takes only what the shapes allow, and gives back an origin the page check takes', () => {
        const host = fc.oneof(fc.domain(), fc.constantFrom('localhost', '127.0.0.1', '192.168.0.9', '[::1]'))
        const address = fc.record({
            scheme: fc.constantFrom('https', 'http', 'ftp', 'wss', 'file'),
            credentials: fc.constantFrom('', 'person@', 'person:secret@'),
            host,
            port: fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
            path: fc.constantFrom('', '/', '/sync', '/a/b/'),
            query: fc.constantFrom('', '?', '?a=1'),
            hash: fc.constantFrom('', '#', '#a'),
        })
        fc.assert(fc.property(address, (parts) => {
            const value = `${parts.scheme}://${parts.credentials}${parts.host}${parts.port === undefined ? '' : `:${parts.port}`}${parts.path}${parts.query}${parts.hash}`
            const local = parts.host === 'localhost' || parts.host === '127.0.0.1'
            const allowed = (parts.scheme === 'https' || (parts.scheme === 'http' && local))
                && parts.credentials === '' && (parts.path === '' || parts.path === '/') && parts.query === '' && parts.hash === ''
            const origin = syncServerOriginOf(value)
            if (!allowed) return origin === null
            return origin !== null && isSyncServerOrigin(origin) && origin === new URL(value).origin
        }), SETTINGS)
    })

    it('is checked again by the page, which takes an origin and nothing else', () => {
        expect(isSyncServerOrigin('https://sync.example.test')).toBe(true)
        expect(isSyncServerOrigin('https://sync.example.test/')).toBe(false)
        expect(isSyncServerOrigin('http://sync.example.test')).toBe(false)
        expect(isSyncServerOrigin(null)).toBe(false)
    })
})
