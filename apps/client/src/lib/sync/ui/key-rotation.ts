/**
 * Graph Key epochs as the app runs them (ADR 0127). The owner's Client starts an epoch that is due
 * (after a member left, was removed or reset their account) without being asked, from the Graphs
 * page or when the graph opens, and tells the owner only what they have to act on.
 */
import { rotateGraphKey, type RotationResult } from '../epoch-rotation'
import type { SyncApi } from '../sync-api'

type RotationApi = Parameters<typeof rotateGraphKey>[0]

/** Rotations running on this page, by server and graph, so two surfaces never start one each. */
const running = new Map<string, Promise<RotationResult>>()

/**
 * Start a new epoch for `graphId` on `origin`, or join the one this page is already running for it.
 * Rejects as {@link rotateGraphKey} does.
 */
export function rotateGraphKeyOnce(api: RotationApi, heldKey: Uint8Array, origin: string, graphId: string): Promise<RotationResult> {
    const key = `${origin}|${graphId}`
    let run = running.get(key)
    if (!run) {
        run = rotateGraphKey(api, graphId, heldKey).finally(() => running.delete(key))
        running.set(key, run)
    }
    return run
}

/** Whether `graphId` is owned by this account and due a new epoch, by the server's graph list. */
export async function rotationDue(api: Pick<SyncApi, 'listGraphs'>, graphId: string): Promise<boolean> {
    const record = (await api.listGraphs()).find((graph) => graph.id === graphId)
    return record?.role === 'owner' && record.rotationDue === true
}

function names(emails: readonly string[]): string {
    if (emails.length <= 1) return emails.join('')
    return `${emails.slice(0, -1).join(', ')} and ${emails.at(-1)}`
}

/** What the owner is told about a rotation that finished, or null when there is nothing to say. */
export function describeRotation(result: RotationResult, graphName: string): { tone: 'info' | 'error'; text: string } | null {
    if (result.kind === 'member-key-changed') {
        return {
            tone: 'error',
            text: `${graphName} still has its old key, because ${result.member.email}’s security key changed. Compare security fingerprints with them, then select Verify beside them in the member list. EtherPK then changes the key.`,
        }
    }
    if (result.kind === 'member-signing-key-missing') {
        const { email } = result.member
        return {
            tone: 'error',
            text: `${graphName} still has its old key, because the server no longer shows the signing key EtherPK checked for ${email}. Their EtherPK never removes it, so ask whoever runs the server about it. To change the key without them, remove ${email} from the graph.`,
        }
    }
    const notes: string[] = []
    if (result.firstUse.length > 0) {
        notes.push(
            `You have not compared security fingerprints with ${names(result.firstUse)}, so EtherPK sent it to the keys the server gives for them. Select Verify beside them in the member list when you can.`,
        )
    }
    if (result.unchecked.length > 0) {
        // Their identity has no signing key yet, so there was nothing to pin and nothing to verify.
        const one = result.unchecked.length === 1
        notes.push(
            `${names(result.unchecked)} ${one ? 'has' : 'have'} not opened EtherPK since it was updated, so EtherPK sent it to ${one ? 'a key' : 'keys'} it could not check. Compare security fingerprints with them once they have.`,
        )
    }
    if (notes.length === 0) return null
    return { tone: 'info', text: `${graphName} has a new key. ${notes.join(' ')}` }
}
