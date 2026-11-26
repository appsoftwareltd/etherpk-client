/**
 * Whether a Native App was opened with something that takes it somewhere (a link, a share, a file,
 * a folder), for the start page, which would otherwise go to the last graph as well.
 */
import { nativeBridge } from './bridge.js'

type Started = { first: Promise<boolean>; stop: () => void }

let started: Promise<Started> | null = null

/** Start what a Native App runs, once for the page. Null in a browser. */
export function startedInstalledApp(): Promise<Started> | null {
    const bridge = nativeBridge()
    if (!bridge) return null
    started ??= import('./start.js').then(({ startInstalledApp }) => startInstalledApp(bridge))
    return started
}

/** Resolves once what the app was opened with is carried out. False in a browser. */
export async function openedByLaunch(): Promise<boolean> {
    return (await (await startedInstalledApp())?.first) ?? false
}
