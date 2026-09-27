/**
 * What the workspace toolbar's [[Local Mirror]] dot says (ADR 0008).
 *
 * A module rather than a type inside the component, for the same reason as `sync/ui/mirror-tab.ts`:
 * both the toolbar and the workspace that fills it name the shape, and a Svelte instance script
 * cannot export a type.
 *
 * Four states, and the two that matter are the quiet ones. `current` is the answer to "is my copy
 * up to date?", which nothing on screen could answer before. `paused` is a backup that has
 * stopped, which after a browser restart is the normal state until the folder's permission is
 * given back - and with the Settings tab as its only home, that looked identical to working.
 */
import { MIRROR_PHASE_LABELS, type MirrorStatus } from '$lib/storage/server/local-mirror'

export type MirrorIndicator =
    | { state: 'hidden' }
    | {
          /**
           * `writing` a pass is running, shown amber because the folder does not match the graph
           * yet; `current` it does; `paused` mirroring has stopped and needs the user; `waiting`
           * another tab of this browser owns the folder.
           */
          state: 'writing' | 'current' | 'paused' | 'waiting'
          /** The whole story in one sentence, as the tooltip and the accessible name. */
          title: string
          onclick: () => void
      }

/** The dot without its click, which only the workspace can give it. */
export type MirrorIndicatorView = { state: 'hidden' } | { state: 'writing' | 'current' | 'paused' | 'waiting'; title: string }

/**
 * What the dot says for a mirror's status. `current` only after a completed pass with nothing
 * outstanding: a mirror still starting, or waiting to retry a failed pass, may be behind the graph,
 * so it shows amber and says why rather than claiming the folder matches.
 */
export function mirrorIndicatorView(status: MirrorStatus | null, heldElsewhere: boolean): MirrorIndicatorView {
    if (heldElsewhere && !status) {
        return { state: 'waiting', title: 'Another tab of this browser is mirroring this graph to its folder.' }
    }
    if (!status) return { state: 'hidden' }
    if (status.paused) {
        return { state: 'paused', title: `Mirroring to “${status.folder}” has stopped. ${status.paused.message}` }
    }
    if (status.syncing) {
        const phase = status.pass?.progress
        const detail = phase && phase.total > 0 ? ` ${MIRROR_PHASE_LABELS[phase.phase]}: ${phase.done} of ${phase.total}.` : ''
        return { state: 'writing', title: `Writing to “${status.folder}”.${detail}` }
    }
    if (status.retrying) {
        return { state: 'writing', title: `Waiting to mirror to “${status.folder}”. ${status.retrying.message}` }
    }
    if (status.lastSyncAt === undefined) {
        return { state: 'writing', title: `Getting ready to mirror to “${status.folder}”.` }
    }
    const waiting = status.skipped.length + status.missingAssets.length
    return {
        state: 'current',
        title: waiting
            ? `Mirroring to “${status.folder}”. ${waiting} ${waiting === 1 ? 'item is' : 'items are'} still to be written.`
            : status.changesElsewhereUnchecked
              ? `Mirroring to “${status.folder}”. Could not check the server for edits made on other devices, so some may not be in the folder yet.`
              : `“${status.folder}” matches this graph.`,
    }
}
