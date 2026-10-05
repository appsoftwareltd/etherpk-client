import { describe, expect, it, vi } from 'vitest'
import type { RotationResult } from '../epoch-rotation'
import { describeRotation, rotateGraphKeyOnce, rotationDue } from './key-rotation'
import type { ServerGraphRecord } from '../sync-api'

const rotateGraphKey = vi.hoisted(() => vi.fn())
vi.mock('../epoch-rotation', () => ({ rotateGraphKey }))

describe('rotateGraphKeyOnce', () => {
    it('runs one rotation per graph at a time, however many surfaces ask', async () => {
        let finish!: (result: RotationResult) => void
        rotateGraphKey.mockImplementationOnce(() => new Promise<RotationResult>((resolve) => (finish = resolve)))
        const api = {} as Parameters<typeof rotateGraphKeyOnce>[0]

        const first = rotateGraphKeyOnce(api, new Uint8Array(32), 'https://sync.example', 'g1')
        const second = rotateGraphKeyOnce(api, new Uint8Array(32), 'https://sync.example', 'g1')
        finish({ kind: 'rotated', epoch: 2, firstUse: [], unchecked: [] })

        expect(await first).toEqual(await second)
        expect(rotateGraphKey).toHaveBeenCalledTimes(1)
    })
})

describe('rotationDue', () => {
    const graphs = (records: Partial<ServerGraphRecord>[]) => ({
        listGraphs: async () => records.map((r) => ({ id: 'g1', rootDocId: 'r', role: 'owner', ...r }) as ServerGraphRecord),
    })

    it('is true only for a graph this account owns that the server marks due', async () => {
        expect(await rotationDue(graphs([{ rotationDue: true }]), 'g1')).toBe(true)
        expect(await rotationDue(graphs([{ rotationDue: false }]), 'g1')).toBe(false)
        expect(await rotationDue(graphs([{ role: 'player', rotationDue: true }]), 'g1')).toBe(false)
        expect(await rotationDue(graphs([{ id: 'g2', rotationDue: true }]), 'g1')).toBe(false)
    })
})

describe('describeRotation', () => {
    it('says nothing when every member had been verified', () => {
        expect(describeRotation({ kind: 'rotated', epoch: 2, firstUse: [], unchecked: [] }, 'Garden')).toBeNull()
    })

    it('names the members the new key went to by the server’s word alone', () => {
        expect(describeRotation({ kind: 'rotated', epoch: 2, firstUse: ['a@example.com', 'b@example.com'], unchecked: [] }, 'Garden')).toEqual({
            tone: 'info',
            text: 'Garden has a new key. You have not compared security fingerprints with a@example.com and b@example.com, so EtherPK sent it to the keys the server gives for them. Select Verify beside them in the member list when you can.',
        })
    })

    it('tells the owner what to do when the server shows a pinned member without a signing key', () => {
        expect(describeRotation({ kind: 'member-signing-key-missing', member: { userId: 'p1', email: 'c@example.com' } }, 'Garden')).toEqual({
            tone: 'error',
            text: 'Garden still has its old key, because the server no longer shows the signing key EtherPK checked for c@example.com. Their EtherPK never removes it, so ask whoever runs the server about it. To change the key without them, remove c@example.com from the graph.',
        })
    })

    it('names the members whose keys could not be checked at all, because they predate signing keys', () => {
        expect(describeRotation({ kind: 'rotated', epoch: 2, firstUse: [], unchecked: ['c@example.com'] }, 'Garden')).toEqual({
            tone: 'info',
            text: 'Garden has a new key. c@example.com has not opened EtherPK since it was updated, so EtherPK sent it to a key it could not check. Compare security fingerprints with them once they have.',
        })
        expect(
            describeRotation({ kind: 'rotated', epoch: 2, firstUse: ['a@example.com'], unchecked: ['c@example.com', 'd@example.com'] }, 'Garden')?.text,
        ).toBe(
            'Garden has a new key. You have not compared security fingerprints with a@example.com, so EtherPK sent it to the keys the server gives for them. Select Verify beside them in the member list when you can. c@example.com and d@example.com have not opened EtherPK since it was updated, so EtherPK sent it to keys it could not check. Compare security fingerprints with them once they have.',
        )
    })

    it('says the key is unchanged, and what to do, when a member’s key changed', () => {
        const told = describeRotation({ kind: 'member-key-changed', member: { userId: 'p1', email: 'a@example.com' } }, 'Garden')
        expect(told?.tone).toBe('error')
        expect(told?.text).toContain('Garden still has its old key, because a@example.com’s security key changed.')
    })
})
