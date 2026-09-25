/**
 * One live client session's presence identity, applied to every retained document's
 * awareness (live, 2026-07-30: four collaborators all rendered blue, and a client could
 * vanish from its peers entirely).
 *
 * Two separate faults are owned here:
 *
 * - Colour uniqueness. The stored device identity is only a preference — same-profile tabs
 *   share it, and independent eight-entry random picks collide across devices. Each session
 *   advertises `since` (arrival time) and `seat` (a random total-order tiebreak) alongside
 *   its colour. When a session sees its own colour on a peer that arrived earlier, the later
 *   session deterministically moves to the first palette colour no visible collaborator is
 *   using. Earlier sessions never move, so colours are stable within a session, and the rule
 *   converges because movement always goes to a free colour under a total order. With more
 *   visible collaborators than palette entries, uniqueness is impossible; the session then
 *   keeps its colour rather than flap.
 *
 * - Advertisement liveness. y-protocols' `setLocalStateField` is a NO-OP once the local
 *   state has been cleared (`setLocalState(null)` — exactly what releasing a document does),
 *   and the awareness renewal timer also skips null states. Re-applying identity through
 *   `setLocalState` resurrects a cleared state, so a re-retained document advertises again
 *   instead of leaving this client permanently invisible.
 */
import type { Awareness } from 'y-protocols/awareness'
import { PRESENCE_PALETTE, type PresenceIdentity } from './presence-identity'

/** The awareness `user` field this session advertises. y-codemirror reads name/colour. */
export interface PresenceUser extends PresenceIdentity {
    /** Session arrival time; on a colour collision the LATER session moves. */
    since: number
    /** Random total-order tiebreak for sessions arriving in the same millisecond. */
    seat: string
}

/** What a peer's advertised `user` field may carry (absent fields ⇒ an older client). */
interface PeerUser {
    color?: unknown
    since?: unknown
    seat?: unknown
}

export interface PresenceSession {
    /** The identity currently advertised (colour may differ from the preference). */
    user(): PresenceUser
    /**
     * Apply this session's identity to a document's awareness and keep its colour
     * collision-free against that document's visible collaborators. Returns a detach
     * which stops observing; it does NOT clear the awareness state (the doc engine's
     * clearPresence owns the tombstone).
     */
    attach(awareness: Awareness): () => void
}

export function createPresenceSession(
    identity: PresenceIdentity,
    options: { now?: () => number; seat?: string } = {},
): PresenceSession {
    const since = (options.now ?? Date.now)()
    const seat = options.seat ?? crypto.randomUUID()
    let color = identity.color
    let colorLight = identity.colorLight ?? `${identity.color}33`
    const attached = new Set<Awareness>()
    let evaluateQueued = false

    const user = (): PresenceUser => ({ name: identity.name, color, colorLight, since, seat })

    function apply(awareness: Awareness): void {
        // Never setLocalStateField: it silently no-ops on a cleared (null) state, which is
        // precisely the state a released-then-re-retained document is in.
        const state = awareness.getLocalState()
        awareness.setLocalState({ ...(state ?? {}), user: user() })
    }

    /** A peer arrived earlier when its (since, seat) sorts below ours; it keeps the colour. */
    function outranks(peer: PeerUser): boolean {
        const peerSince = typeof peer.since === 'number' ? peer.since : Number.NEGATIVE_INFINITY
        if (peerSince !== since) return peerSince < since
        const peerSeat = typeof peer.seat === 'string' ? peer.seat : ''
        return peerSeat < seat
    }

    function visiblePeers(): PeerUser[] {
        const peers: PeerUser[] = []
        for (const awareness of attached) {
            for (const [clientId, state] of awareness.getStates()) {
                if (clientId === awareness.clientID) continue
                const peer = (state as { user?: PeerUser }).user
                if (peer && typeof peer.color === 'string') peers.push(peer)
            }
        }
        return peers
    }

    function evaluate(): void {
        const peers = visiblePeers()
        const collision = peers.some((peer) => peer.color === color && outranks(peer))
        if (!collision) return
        const inUse = new Set(peers.map((peer) => peer.color))
        const free = PRESENCE_PALETTE.find((entry) => !inUse.has(entry.color))
        // Every palette entry visible ⇒ uniqueness is impossible; keep the colour steady.
        if (!free || free.color === color) return
        color = free.color
        colorLight = free.colorLight
        for (const awareness of attached) {
            if (awareness.getLocalState() !== null) apply(awareness)
        }
    }

    function scheduleEvaluate(): void {
        if (evaluateQueued) return
        evaluateQueued = true
        queueMicrotask(() => {
            evaluateQueued = false
            evaluate()
        })
    }

    return {
        user,
        attach(awareness) {
            attached.add(awareness)
            apply(awareness)
            const onChange = () => scheduleEvaluate()
            awareness.on('change', onChange)
            scheduleEvaluate()
            return () => {
                awareness.off('change', onChange)
                attached.delete(awareness)
            }
        },
    }
}
