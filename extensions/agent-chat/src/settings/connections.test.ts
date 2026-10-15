import { describe, expect, it } from 'vitest'

import { defaultConnection, type ModelConnection, readSettings, SETTINGS_KEY, withConnection, withoutConnection, withPrimary } from './connections'

const storageWith = (value: unknown) => ({ get: <T>(key: string) => (key === SETTINGS_KEY ? (value as T) : undefined) })

const anthropic: ModelConnection = { id: 'c1', provider: 'anthropic', name: 'Claude', apiKey: 'sk-test', address: '', defaultModel: 'claude-fake-1' }
const local: ModelConnection = { id: 'c2', provider: 'local', name: 'Ollama', apiKey: '', address: 'http://localhost:11434/v1', defaultModel: 'fake:8b' }

describe("the person's Agent Chat settings (ADR 0147)", () => {
    it('starts with no connections and web search off', () => {
        expect(readSettings(storageWith(undefined))).toEqual({ connections: [], defaultConnection: null, webSearchByDefault: false })
    })

    it('reads stored connections, dropping any that are malformed or repeat an id, and a default that names none', () => {
        const settings = readSettings(storageWith({ connections: [anthropic, { id: 'x', provider: 'unknown' }, 'nope', anthropic, local], defaultConnection: 'gone', webSearchByDefault: true }))
        expect(settings.connections.map((c) => c.id)).toEqual(['c1', 'c2'])
        expect(settings.defaultConnection).toBeNull()
        expect(settings.webSearchByDefault).toBe(true)
    })

    it('starts a new chat on the default connection, or the first', () => {
        const settings = readSettings(storageWith({ connections: [anthropic, local], defaultConnection: 'c2' }))
        expect(defaultConnection(settings)?.id).toBe('c2')
        expect(defaultConnection({ ...settings, defaultConnection: null })?.id).toBe('c1')
        expect(defaultConnection({ connections: [], defaultConnection: null, webSearchByDefault: false })).toBeNull()
    })

    it('makes the first connection added the default, and moves the default on when it is removed', () => {
        let settings = withConnection({ connections: [], defaultConnection: null, webSearchByDefault: false }, anthropic)
        settings = withConnection(settings, local)
        expect(settings.defaultConnection).toBe('c1')
        settings = withConnection(settings, { ...anthropic, name: 'Work' })
        expect(settings.connections.map((c) => c.name)).toEqual(['Work', 'Ollama'])
        settings = withoutConnection(settings, 'c1')
        expect(settings.defaultConnection).toBe('c2')
    })

    it('makes a connection primary: first in every list, and the one a new chat starts on', () => {
        let settings = withConnection(withConnection({ connections: [], defaultConnection: null, webSearchByDefault: false }, anthropic), local)
        settings = withPrimary(settings, 'c2')
        expect(settings.connections.map((c) => c.id)).toEqual(['c2', 'c1'])
        expect(defaultConnection(settings)?.id).toBe('c2')
        expect(withPrimary(settings, 'gone')).toEqual(settings)
    })
})
