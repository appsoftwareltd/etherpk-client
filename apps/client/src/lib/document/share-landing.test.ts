import { describe, expect, it } from 'vitest'

import type { GraphKeyring } from '$lib/crypto'
import type { GraphRecord } from '$lib/storage/graph-registry'
import type { QuickNoteSessionDeps } from '$lib/sync/quick-note-session'
import type { SyncedGraphConnection } from '$lib/sync/synced-graph-access'

import { landShareDirectly, type ShareLandingDeps } from './share-landing'

const note = { id: 'n1', text: 'Ring the dentist', createdAt: 1_700_000_000_000 }
const keyring: GraphKeyring = { graphId: 'g1', epochs: [{ epochId: 1, key: new Uint8Array(32) }] }
const connection = {
    api: {} as SyncedGraphConnection['api'],
    serverBaseUrl: 'https://sync.example.com',
    relayUrl: 'wss://sync.example.com/sync',
    token: async () => 't',
} satisfies SyncedGraphConnection

const synced: GraphRecord = { id: 'g1', name: 'Synced', backend: 'server', createdAt: 1, handle: { rootDocId: 'root-1' } }
const folder: GraphRecord = { id: 'f1', name: 'Folder', backend: 'filesystem', createdAt: 1, handle: {} }

function deps(overrides: Partial<ShareLandingDeps> = {}): ShareLandingDeps & { sessions: QuickNoteSessionDeps[] } {
    const sessions: QuickNoteSessionDeps[] = []
    return {
        sessions,
        connection: () => connection,
        keyring: async () => keyring,
        session: async (sessionDeps) => {
            sessions.push(sessionDeps)
            return { synced: true }
        },
        ...overrides,
    }
}

describe('landShareDirectly: the direct write, or the hand-off to the workspace', () => {
    it('hands a folder graph to the workspace: its notes file has one writer, and that is the open folder', async () => {
        const d = deps()
        expect(await landShareDirectly(folder, note, d)).toEqual({ kind: 'handoff', reason: 'folder' })
        expect(d.sessions).toEqual([])
    })

    it('hands over when the device has no sync connection', async () => {
        expect(await landShareDirectly(synced, note, deps({ connection: () => null }))).toEqual({ kind: 'handoff', reason: 'no-sync' })
    })

    it('hands over when the vault is locked here or holds no keyring for the graph, so the workspace can prompt', async () => {
        expect(await landShareDirectly(synced, note, deps({ keyring: async () => null }))).toEqual({ kind: 'handoff', reason: 'locked' })
    })

    it('writes over a session built from the record and the connection, and reports how far it got', async () => {
        const d = deps()
        const saved: string[] = []
        const landing = await landShareDirectly(synced, note, d, { onSaved: () => saved.push('saved') })
        expect(landing).toEqual({ kind: 'added', synced: true })
        expect(d.sessions).toHaveLength(1)
        expect(d.sessions[0]).toMatchObject({ graphId: 'g1', rootDocId: 'root-1', keyring, relayUrl: 'wss://sync.example.com/sync' })
        expect(typeof d.sessions[0].token).toBe('function')
    })

    it('hands the caller\'s abort signal to the session, so Open graph can end the sync wait', async () => {
        const d = deps()
        const controller = new AbortController()
        await landShareDirectly(synced, note, d, { signal: controller.signal })
        expect(d.sessions[0].signal).toBe(controller.signal)
    })

    it('carries a saved-but-not-synced outcome through unchanged', async () => {
        expect(await landShareDirectly(synced, note, deps({ session: async () => ({ synced: false }) }))).toEqual({ kind: 'added', synced: false })
    })

    it('hands over on any failure before the note is saved, naming the failure', async () => {
        const failing = deps({
            session: async () => {
                throw new Error('relay refused')
            },
        })
        expect(await landShareDirectly(synced, note, failing)).toEqual({ kind: 'handoff', reason: 'failed', error: 'relay refused' })
        const lockedByError = deps({
            keyring: async () => {
                throw new Error('envelope authentication failed')
            },
        })
        expect(await landShareDirectly(synced, note, lockedByError)).toEqual({ kind: 'handoff', reason: 'failed', error: 'envelope authentication failed' })
    })

    it('never hands over once the note is saved: a failure after that point is a sync problem, not a lost share', async () => {
        const savedThenFailed = deps({
            session: async (_deps, _note, hooks) => {
                hooks?.onSaved?.()
                throw new Error('ack timed out')
            },
        })
        expect(await landShareDirectly(synced, note, savedThenFailed)).toEqual({ kind: 'added', synced: false })
    })

    it('refuses a synced record whose handle carries no root doc id, rather than opening nothing', async () => {
        const broken: GraphRecord = { ...synced, handle: {} }
        expect(await landShareDirectly(broken, note, deps())).toEqual({ kind: 'handoff', reason: 'failed', error: 'The graph record names no root document.' })
    })
})
