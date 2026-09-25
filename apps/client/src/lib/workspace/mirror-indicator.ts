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
