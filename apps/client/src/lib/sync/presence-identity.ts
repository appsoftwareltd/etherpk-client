/**
 * Who a caret belongs to. y-codemirror renders every remote cursor from the awareness
 * `user` field — nothing in the app ever SET that field, so every collaborator was an
 * identical default-blue "Anonymous" bar (live, 2026-07-28: read as "presence is broken").
 *
 * The sync layer has no account identity to draw on (the client authenticates with a PAT;
 * the portal session lives on another origin), so the identity is per-device: a friendly
 * pseudonym and a stable colour, minted once and kept in localStorage. Replacing this with
 * the real account name when an identity endpoint exists only means changing `mint()`.
 *
 * The colour here is only this device's PREFERENCE. Tabs share localStorage, and eight
 * palette entries collide across devices, so the per-session allocator in
 * presence-session.ts owns the colour actually advertised: it keeps the preference when it
 * is free and deterministically moves to a free palette entry when an earlier live session
 * in the same graph already shows it.
 */

const KEY = 'etherpk.presence-identity'

export interface PresenceIdentity {
    name: string
    color: string
    /** Selection-highlight tint; y-codemirror falls back to color + '33' without one. */
    colorLight: string
}

/**
 * Pastels: soft enough not to shout beside the prose, saturated enough that a 2px caret bar
 * still reads on a white surface, and light enough that dark label text works on all of them
 * in both themes. The selection tint is the same colour at 40% alpha (`66`) — the old 20%
 * tint of a primary was already faint; a pastel at 20% disappears on white.
 *
 * The same eight are offered as the ready-made toolbar colours in Graph Settings (ADR 0071):
 * one palette, so a graph's bar and a member's caret speak the same language. The label is
 * for a swatch there; presence itself never shows it (`label`, not `name`: an entry is
 * spread into a {@link PresenceIdentity}, whose `name` is the pseudonym).
 */
export const PRESENCE_PALETTE: ReadonlyArray<{ label: string; color: string; colorLight: string }> = [
    { label: 'Sky', color: '#7dd3fc', colorLight: '#7dd3fc66' },
    { label: 'Amber', color: '#fcd34d', colorLight: '#fcd34d66' },
    { label: 'Mint', color: '#6ee7b7', colorLight: '#6ee7b766' },
    { label: 'Salmon', color: '#fca5a5', colorLight: '#fca5a566' },
    { label: 'Lavender', color: '#c4b5fd', colorLight: '#c4b5fd66' },
    { label: 'Pink', color: '#f9a8d4', colorLight: '#f9a8d466' },
    { label: 'Peach', color: '#fdba74', colorLight: '#fdba7466' },
    { label: 'Lime', color: '#bef264', colorLight: '#bef26466' },
]

const ADJECTIVES = ['Amber', 'Bold', 'Calm', 'Deft', 'Eager', 'Fleet', 'Keen', 'Quiet', 'Swift', 'Vivid']
const ANIMALS = ['Fox', 'Owl', 'Wren', 'Hare', 'Lynx', 'Newt', 'Ibis', 'Mole', 'Swan', 'Toad']

function mint(): PresenceIdentity {
    const pick = (list: readonly string[]) => list[Math.floor(Math.random() * list.length)]
    const paletteEntry = PRESENCE_PALETTE[Math.floor(Math.random() * PRESENCE_PALETTE.length)]
    return { name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, ...paletteEntry }
}

/** This device's presence identity, minted on first use and stable thereafter. */
export function presenceIdentity(): PresenceIdentity {
    try {
        const stored = localStorage.getItem(KEY)
        if (stored) {
            const parsed = JSON.parse(stored) as Partial<PresenceIdentity>
            if (typeof parsed.name === 'string' && typeof parsed.color === 'string' && typeof parsed.colorLight === 'string') {
                // Only a palette colour is advertised: the allocator in presence-session.ts can
                // only de-duplicate against palette entries, so a colour from an earlier palette
                // (or a hand-edited one) is re-minted while the name stays the device's.
                if (PRESENCE_PALETTE.some((entry) => entry.color === parsed.color)) return parsed as PresenceIdentity
                return remember({ ...mint(), name: parsed.name })
            }
        }
    } catch {
        // Unreadable storage or corrupt JSON — mint a fresh one below.
    }
    return remember(mint())
}

function remember(identity: PresenceIdentity): PresenceIdentity {
    try {
        localStorage.setItem(KEY, JSON.stringify(identity))
    } catch {
        // Private mode: a per-session identity is still better than "Anonymous".
    }
    return identity
}
