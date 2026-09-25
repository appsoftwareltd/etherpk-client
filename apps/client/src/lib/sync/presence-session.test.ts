import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { PRESENCE_PALETTE } from './presence-identity'
import { createPresenceSession, type PresenceUser } from './presence-session'

/**
 * The session allocator owns the colour a client actually advertises (live, 2026-07-30:
 * four collaborators all blue). The rules under test: the device preference is kept when
 * free; on a collision the LATER session deterministically moves to a free palette colour;
 * earlier sessions never move; a cleared awareness state is resurrected, never silently
 * ignored (setLocalStateField no-ops on null — the invisible-collaborator bug).
 */

const BLUE = PRESENCE_PALETTE[0]
const AMBER = PRESENCE_PALETTE[1]

function awarenessPair() {
    const doc = new Y.Doc()
    return new Awareness(doc)
}

/** Inject a remote peer's user state into `target`, exactly as receivePresence would. */
function injectPeer(target: Awareness, user: Record<string, unknown>): Awareness {
    const peer = awarenessPair()
    peer.setLocalState({ user })
    applyAwarenessUpdate(target, encodeAwarenessUpdate(peer, [peer.clientID]), 'test-remote')
    return peer
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve))

describe('presence session', () => {
    it('advertises the preferred colour with session ordering fields when it is free', () => {
        const session = createPresenceSession(
            { name: 'Amber Fox', ...BLUE },
            { now: () => 1000, seat: 'seat-a' },
        )
        const awareness = awarenessPair()
        session.attach(awareness)
        const user = awareness.getLocalState()?.user as PresenceUser
        expect(user).toMatchObject({ name: 'Amber Fox', color: BLUE.color, since: 1000, seat: 'seat-a' })
    })

    it('resurrects a cleared local state instead of silently no-opping', () => {
        // setLocalStateField is a no-op once the state is null — exactly the state a
        // released document is in. Attaching must advertise again regardless.
        const session = createPresenceSession({ name: 'Keen Owl', ...BLUE })
        const awareness = awarenessPair()
        awareness.setLocalState(null)
        session.attach(awareness)
        expect((awareness.getLocalState()?.user as PresenceUser)?.color).toBe(BLUE.color)
    })

    it('moves the later session to the first free palette colour on a collision', async () => {
        const session = createPresenceSession(
            { name: 'Late Fox', ...BLUE },
            { now: () => 2000, seat: 'seat-late' },
        )
        const awareness = awarenessPair()
        session.attach(awareness)
        injectPeer(awareness, { name: 'Early Fox', ...BLUE, since: 1000, seat: 'seat-early' })
        await vi.waitFor(async () => {
            await flush()
            expect((awareness.getLocalState()?.user as PresenceUser).color).toBe(AMBER.color)
        })
        expect((awareness.getLocalState()?.user as PresenceUser).colorLight).toBe(AMBER.colorLight)
    })

    it('keeps its colour when the colliding peer arrived later', async () => {
        const session = createPresenceSession(
            { name: 'Early Fox', ...BLUE },
            { now: () => 1000, seat: 'seat-early' },
        )
        const awareness = awarenessPair()
        session.attach(awareness)
        injectPeer(awareness, { name: 'Late Fox', ...BLUE, since: 2000, seat: 'seat-late' })
        await flush()
        await flush()
        expect((awareness.getLocalState()?.user as PresenceUser).color).toBe(BLUE.color)
    })

    it('treats a peer without ordering fields as senior and moves off its colour', async () => {
        const session = createPresenceSession(
            { name: 'New Client', ...BLUE },
            { now: () => 2000, seat: 'seat-new' },
        )
        const awareness = awarenessPair()
        session.attach(awareness)
        injectPeer(awareness, { name: 'Old Client', color: BLUE.color, colorLight: BLUE.colorLight })
        await vi.waitFor(async () => {
            await flush()
            expect((awareness.getLocalState()?.user as PresenceUser).color).toBe(AMBER.color)
        })
    })

    it('breaks a same-millisecond tie deterministically by seat', async () => {
        const session = createPresenceSession(
            { name: 'Seat B', ...BLUE },
            { now: () => 1000, seat: 'seat-b' },
        )
        const awareness = awarenessPair()
        session.attach(awareness)
        // seat-a < seat-b, so the peer keeps the colour and this session moves.
        injectPeer(awareness, { name: 'Seat A', ...BLUE, since: 1000, seat: 'seat-a' })
        await vi.waitFor(async () => {
            await flush()
            expect((awareness.getLocalState()?.user as PresenceUser).color).toBe(AMBER.color)
        })
    })

    it('keeps its colour steady when every palette entry is visible', async () => {
        const session = createPresenceSession(
            { name: 'Ninth', ...BLUE },
            { now: () => 9000, seat: 'seat-nine' },
        )
        const awareness = awarenessPair()
        session.attach(awareness)
        PRESENCE_PALETTE.forEach((entry, index) => {
            injectPeer(awareness, { name: `Peer ${index}`, ...entry, since: 1000 + index, seat: `seat-${index}` })
        })
        await flush()
        await flush()
        // Uniqueness is impossible with more collaborators than palette entries; the
        // session must not flap between occupied colours.
        expect((awareness.getLocalState()?.user as PresenceUser).color).toBe(BLUE.color)
    })

    it('applies a colour change to every attached document awareness', async () => {
        const session = createPresenceSession(
            { name: 'Multi Doc', ...BLUE },
            { now: () => 2000, seat: 'seat-multi' },
        )
        const first = awarenessPair()
        const second = awarenessPair()
        session.attach(first)
        session.attach(second)
        injectPeer(first, { name: 'Early', ...BLUE, since: 1000, seat: 'seat-early' })
        await vi.waitFor(async () => {
            await flush()
            expect((first.getLocalState()?.user as PresenceUser).color).toBe(AMBER.color)
            expect((second.getLocalState()?.user as PresenceUser).color).toBe(AMBER.color)
        })
    })

    it('stops reacting after detach', async () => {
        const session = createPresenceSession(
            { name: 'Detached', ...BLUE },
            { now: () => 2000, seat: 'seat-detached' },
        )
        const awareness = awarenessPair()
        const detach = session.attach(awareness)
        detach()
        injectPeer(awareness, { name: 'Early', ...BLUE, since: 1000, seat: 'seat-early' })
        await flush()
        await flush()
        expect((awareness.getLocalState()?.user as PresenceUser).color).toBe(BLUE.color)
    })
})
