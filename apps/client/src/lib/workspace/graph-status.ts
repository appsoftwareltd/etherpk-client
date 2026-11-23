/**
 * The one status dot of an open graph: sync and the [[Local Mirror]] together.
 *
 * A synced graph used to say this in two places, a sync row at the foot of the Explorer and a
 * mirror dot in the toolbar, and a person had to read both to learn whether their work was safe.
 * The dot here is green only when every part that applies is working: sync, and the mirror when
 * one is set up. Pressing it opens a dialog with a section for each.
 *
 * A module rather than types inside the components, as `mirror-indicator.ts` is: the workspace,
 * the toolbar, the app's header and the dialog all name these shapes.
 */
import { TURNED_AWAY_NOTICE, type SyncIndicator, type SyncIndicatorState, type SyncStatusAction } from '#lib/sync/sync-indicator.js'

import type { MirrorIndicatorView } from './mirror-indicator'

/** How one part, or the whole, stands. In rising order of how much it asks of the person. */
export type StatusTone = 'ok' | 'idle' | 'busy' | 'stopped'

const TONE_RANK: Record<StatusTone, number> = { ok: 0, idle: 1, busy: 2, stopped: 3 }

/** One section of the dialog. */
export interface StatusSection {
    tone: StatusTone
    /** A word or two, beside the section's dot. */
    label: string
    /** The whole story. */
    detail: string
}

/**
 * A short notice shown beside the dot without a press, for a state the person should hear about:
 * what happened, that their changes are kept, and when they sync. `id` names the state, so a
 * notice closed by the person stays closed until the state has gone and come back.
 */
export interface StatusCallout {
    id: string
    text: string
}

export type GraphStatus =
    | { shown: false }
    | {
          shown: true
          tone: StatusTone
          /** The dot's accessible name and tooltip: both parts in a sentence each. */
          title: string
          /** Null until the session's first sync state has settled. */
          sync: (StatusSection & { state: SyncIndicatorState; unsent: number }) | null
          /** Null when this graph has no Local Mirror. */
          mirror: (StatusSection & { state: Exclude<MirrorIndicatorView['state'], 'hidden'> }) | null
          callout: StatusCallout | null
      }

/** What the dialog offers under each section. */
export interface GraphStatusActions {
    sync: SyncStatusAction[]
    /** Opens Graph Settings on its Mirror tab. */
    openMirrorSettings: () => void
}

const SYNC_TONES: Record<SyncIndicatorState, StatusTone> = {
    synced: 'ok',
    sending: 'busy',
    connecting: 'busy',
    reconnecting: 'busy',
    'waiting-for-key': 'busy',
    offline: 'idle',
    refused: 'stopped',
    'turned-away': 'stopped',
    ended: 'stopped',
}

/**
 * `waiting` is another tab of this browser mirroring the graph, which is the mirror working, so it
 * does not hold the dot back from green.
 */
const MIRROR_TONES: Record<Exclude<MirrorIndicatorView['state'], 'hidden'>, StatusTone> = {
    current: 'ok',
    waiting: 'ok',
    writing: 'busy',
    paused: 'stopped',
}

const MIRROR_LABELS: Record<Exclude<MirrorIndicatorView['state'], 'hidden'>, string> = {
    current: 'Up to date',
    waiting: 'In another tab',
    writing: 'Writing',
    paused: 'Stopped',
}

const KEPT = 'Your changes are kept on this device'

/**
 * The states that get a notice, each with its sentence. Passing states (sending, connecting,
 * reconnecting) get none: they clear by themselves. `ended` has the workspace's own notice.
 */
const CALLOUTS: Partial<Record<SyncIndicatorState, string>> = {
    'turned-away': TURNED_AWAY_NOTICE,
    offline: `Offline. ${KEPT} and sync when the connection returns.`,
    refused: `The sync server is not accepting changes to this graph. ${KEPT} and sync once it does.`,
    'waiting-for-key': `Waiting for this graph's new key. ${KEPT} and sync once it arrives.`,
}

/** The more pressing of two tones. */
export function worseTone(a: StatusTone, b: StatusTone): StatusTone {
    return TONE_RANK[a] >= TONE_RANK[b] ? a : b
}

type Shown = Extract<GraphStatus, { shown: true }>

function syncSection(sync: SyncIndicator | null): Shown['sync'] {
    if (!sync) return null
    return { tone: SYNC_TONES[sync.state], label: sync.label, detail: sync.detail, state: sync.state, unsent: sync.unsent }
}

function mirrorSection(mirror: MirrorIndicatorView): Shown['mirror'] {
    if (mirror.state === 'hidden') return null
    return { tone: MIRROR_TONES[mirror.state], label: MIRROR_LABELS[mirror.state], detail: mirror.title, state: mirror.state }
}

/** Both parts in a sentence each, for the dot's tooltip and accessible name. */
function statusTitle(sync: Shown['sync'], mirror: Shown['mirror']): string {
    const parts = [sync ? `Sync: ${sync.label}. ${sync.detail}` : 'Sync: checking.']
    if (mirror) parts.push(`Mirroring: ${mirror.label}. ${mirror.detail}`)
    return parts.join(' ')
}

function calloutFor(sync: SyncIndicator | null): StatusCallout | null {
    if (!sync) return null
    const text = CALLOUTS[sync.state]
    return text ? { id: sync.state, text } : null
}

/**
 * @param synced Whether the graph is a synced graph at all. A folder graph has neither part, and no dot.
 * @param sync The settled sync status, or null while the first state is still settling.
 */
export function graphStatus(synced: boolean, sync: SyncIndicator | null, mirror: MirrorIndicatorView): GraphStatus {
    if (!synced) return { shown: false }
    const syncPart = syncSection(sync)
    const mirrorPart = mirrorSection(mirror)
    return {
        shown: true,
        // Sync not settled yet counts as busy: the dot must not show green before anything is known.
        tone: worseTone(syncPart?.tone ?? 'busy', mirrorPart?.tone ?? 'ok'),
        title: statusTitle(syncPart, mirrorPart),
        sync: syncPart,
        mirror: mirrorPart,
        callout: calloutFor(sync),
    }
}

/**
 * Which notice to show, given the one the person last closed. A closed notice stays closed while
 * its state lasts; `nextDismissed` forgets it once the state has gone, so it shows again the next
 * time the state comes back.
 */
export function calloutToShow(callout: StatusCallout | null, dismissed: string | null): { show: StatusCallout | null; nextDismissed: string | null } {
    if (!callout) return { show: null, nextDismissed: null }
    if (callout.id === dismissed) return { show: null, nextDismissed: dismissed }
    return { show: callout, nextDismissed: null }
}
