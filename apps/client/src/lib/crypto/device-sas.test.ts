import { describe, expect, it } from 'vitest'
import { DEVICE_APPROVAL_COMMIT_LABEL as SHARED_COMMIT_LABEL } from '@appsoftwareltd/etherpk-shared'
import { lengthPrefixed } from './bytes'
import {
    DEVICE_APPROVAL_COMMIT_LABEL,
    approvalCode,
    approvalCommitment,
    approvalReplyKey,
    approvalTranscript,
    commitmentMatches,
    openApprovalReply,
    sealApprovalReply,
} from './device-sas'
import { generateIdentityKeyPair } from './identity'

/** One exchange as both devices see it when nothing interferes (ADR 0125). */
async function honestExchange(approvalId = 'approval-1') {
    const requester = generateIdentityKeyPair()
    const approver = generateIdentityKeyPair()
    const commitment = await approvalCommitment(requester.publicKey)
    const transcript = await approvalTranscript({
        approvalId,
        commitment,
        approverPublicKey: approver.publicKey,
        requesterPublicKey: requester.publicKey,
    })
    return { requester, approver, commitment, transcript }
}

describe('device approval code (ADR 0125)', () => {
    it('is the same on both devices and formatted for comparison', async () => {
        const { transcript } = await honestExchange()
        const code = approvalCode(transcript)
        expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/) // Crockford: no I, L, O, U
        expect(approvalCode(transcript)).toBe(code)
    })

    it('changes when the server substitutes either device key', async () => {
        const { requester, approver, commitment, transcript } = await honestExchange()
        const intruder = generateIdentityKeyPair()
        const swappedApprover = await approvalTranscript({
            approvalId: 'approval-1',
            commitment,
            approverPublicKey: intruder.publicKey,
            requesterPublicKey: requester.publicKey,
        })
        const swappedRequester = await approvalTranscript({
            approvalId: 'approval-1',
            commitment: await approvalCommitment(intruder.publicKey),
            approverPublicKey: approver.publicKey,
            requesterPublicKey: intruder.publicKey,
        })
        expect(approvalCode(swappedApprover)).not.toBe(approvalCode(transcript))
        expect(approvalCode(swappedRequester)).not.toBe(approvalCode(transcript))
    })

    it('binds the request id, so one exchange cannot stand in for another', async () => {
        const { requester, approver, commitment, transcript } = await honestExchange('approval-1')
        const other = await approvalTranscript({
            approvalId: 'approval-2',
            commitment,
            approverPublicKey: approver.publicKey,
            requesterPublicKey: requester.publicKey,
        })
        expect(approvalCode(other)).not.toBe(approvalCode(transcript))
    })

    it('accepts only the key the new device committed to', async () => {
        const { requester, commitment } = await honestExchange()
        expect(await commitmentMatches(commitment, requester.publicKey)).toBe(true)
        expect(await commitmentMatches(commitment, generateIdentityKeyPair().publicKey)).toBe(false)
    })

    it('uses the commitment label the Sync Server checks against', () => {
        expect(DEVICE_APPROVAL_COMMIT_LABEL).toBe(SHARED_COMMIT_LABEL)
    })
})

describe('device approval reply (ADR 0125)', () => {
    it('opens only on the requesting device, under the key both devices derive', async () => {
        const { requester, approver, transcript } = await honestExchange()
        const vaultKey = crypto.getRandomValues(new Uint8Array(32))
        const approverKey = await approvalReplyKey(approver.privateKey, requester.publicKey, transcript)
        const requesterKey = await approvalReplyKey(requester.privateKey, approver.publicKey, transcript)
        expect(Buffer.from(approverKey).equals(Buffer.from(requesterKey))).toBe(true)

        const reply = await sealApprovalReply(approverKey, vaultKey, 'approval-1')
        expect(Buffer.from(await openApprovalReply(requesterKey, reply, 'approval-1')).equals(Buffer.from(vaultKey))).toBe(true)
    })

    it('a reply forged by a server that holds neither one-time private key does not open', async () => {
        const { requester, approver, transcript } = await honestExchange()
        const server = generateIdentityKeyPair()
        // The best a server can do is derive a key from its own pair and a public key it saw.
        const forgedKey = await approvalReplyKey(server.privateKey, requester.publicKey, transcript)
        const forged = await sealApprovalReply(forgedKey, new Uint8Array(32).fill(7), 'approval-1')
        const requesterKey = await approvalReplyKey(requester.privateKey, approver.publicKey, transcript)
        await expect(openApprovalReply(requesterKey, forged, 'approval-1')).rejects.toThrow()
    })

    it('a reply for one request does not open as another', async () => {
        const { requester, approver, transcript } = await honestExchange()
        const key = await approvalReplyKey(approver.privateKey, requester.publicKey, transcript)
        const reply = await sealApprovalReply(key, new Uint8Array(32).fill(1), 'approval-1')
        await expect(openApprovalReply(key, reply, 'approval-2')).rejects.toThrow()
    })

    it('refuses a peer key that would make the shared secret all zero', async () => {
        const { requester, transcript } = await honestExchange()
        await expect(approvalReplyKey(requester.privateKey, new Uint8Array(32), transcript)).rejects.toThrow()
    })
})

describe('lengthPrefixed', () => {
    it('keeps fields apart, so moving bytes between them changes the result', () => {
        const a = lengthPrefixed(new Uint8Array([1, 2]), new Uint8Array([3]))
        const b = lengthPrefixed(new Uint8Array([1]), new Uint8Array([2, 3]))
        expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false)
        expect([...a]).toEqual([0, 0, 0, 2, 1, 2, 0, 0, 0, 1, 3])
    })
})
