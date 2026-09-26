import { describe, expect, it } from 'vitest'
import { ManagedTokenError } from '$lib/auth/managed-token'
import { AccountEnded } from './account-signal'
import { describeAccessLoss, workspaceAccessLoss } from './access-loss'
import { SyncApiError } from './sync-api'

const managed = { managed: true, server: 'https://sync.etherpk.com', unsentDocuments: 0 }
const custom = { managed: false, server: 'https://sync.example.org', unsentDocuments: 0 }

describe('workspaceAccessLoss', () => {
    it('keeps a membership loss with the count of changes that will not be sent', () => {
        expect(workspaceAccessLoss({ kind: 'membership' }, { ...managed, unsentDocuments: 3 })).toEqual({
            reason: 'membership',
            unsentDocuments: 3,
        })
    })

    it('reads a refused Client session as signed out, and a refused Sync credential as refused', () => {
        expect(workspaceAccessLoss({ kind: 'credentials', cause: new ManagedTokenError('no session', 401) }, managed)).toEqual({
            reason: 'signed-out',
        })
        expect(workspaceAccessLoss({ kind: 'credentials', cause: new SyncApiError('Unauthorized', 401) }, custom)).toEqual({
            reason: 'refused',
            managed: false,
            server: 'https://sync.example.org',
        })
    })

    it('takes the reason another tab gave', () => {
        expect(workspaceAccessLoss({ kind: 'credentials', cause: new AccountEnded('disconnected') }, custom)).toEqual({
            reason: 'disconnected',
            server: 'https://sync.example.org',
        })
        expect(workspaceAccessLoss({ kind: 'credentials', cause: new AccountEnded('signed-out') }, managed)).toEqual({
            reason: 'signed-out',
        })
    })
})

describe('describeAccessLoss', () => {
    it('says what happened and offers the download only when changes were not sent', () => {
        const kept = describeAccessLoss({ reason: 'membership', unsentDocuments: 0 })
        expect(kept.title).toBe('You no longer have access to this graph')
        expect(kept.body).toMatch(/left it in another tab, the owner removed you, or the owner deleted it/)
        expect(kept.canDownload).toBe(false)

        const unsent = describeAccessLoss({ reason: 'membership', unsentDocuments: 2 })
        expect(unsent.body).toMatch(/Changes made on this device to 2 documents were not saved/)
        expect(unsent.canDownload).toBe(true)
    })

    it('sends a managed account to sign in again, and a custom server to connect again', () => {
        expect(describeAccessLoss({ reason: 'signed-out' }).primary).toEqual({ label: 'Sign in again', href: '/auth/login' })
        expect(describeAccessLoss({ reason: 'refused', managed: true, server: null }).primary).toEqual({
            label: 'Sign in again',
            href: '/auth/login',
        })
        const token = describeAccessLoss({ reason: 'refused', managed: false, server: 'https://sync.example.org' })
        expect(token.title).toBe('The access token on this device no longer works')
        expect(token.body).toMatch(/https:\/\/sync\.example\.org/)
        expect(token.primary).toEqual({ label: 'Connect again', href: '/graphs?sync=connect' })
    })
})
