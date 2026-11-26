/** What an AppImage has to see to itself: its menu entry, and saying when it runs without its sandbox. */
import { app, dialog } from 'electron'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { COPY } from '../copy.ts'
import { type DesktopEntryPlaces, entryState, removeEntry, writeEntry } from '../linux/desktop-entry.ts'
import type { Told } from './told.ts'

export const REMOVE_MENU_ENTRY = '--remove-menu-entry'

/** `XDG_DATA_HOME`, or where the specification says it is. A relative one is to be ignored. */
export function dataHome(env: NodeJS.ProcessEnv): string {
    return env.XDG_DATA_HOME?.startsWith('/') ? env.XDG_DATA_HOME : join(homedir(), '.local/share')
}

/** Desktops read new entries by themselves. These make it soon, where they are installed. */
function refresh({ data }: DesktopEntryPlaces): void {
    execFile('update-desktop-database', [join(data, 'applications')], () => {})
}

export async function offerMenuEntry(appImage: string, icon: string, told: Told, log: (message: string, error?: unknown) => void): Promise<void> {
    const places = { data: dataHome(process.env) }
    try {
        const state = await entryState(places, appImage)
        if (state === 'theirs' || state === 'current') return
        // Moved or renamed: the person said yes once already.
        if (state === 'none') {
            if (!(await told.once('menu-entry'))) return
            const { response } = await dialog.showMessageBox({
                type: 'question', message: COPY.menuEntryTitle, detail: COPY.menuEntryDetail, buttons: [COPY.menuEntryAdd, COPY.notNow], defaultId: 0, cancelId: 1, noLink: true,
            })
            if (response !== 0) return
        }
        await writeEntry(places, appImage, await readFile(icon))
        refresh(places)
    } catch (error) {
        log('The menu entry could not be written.', error)
    }
}

export async function removeMenuEntry(appImage: string): Promise<void> {
    const places = { data: dataHome(process.env) }
    await removeEntry(places, appImage)
    refresh(places)
}

/**
 * Whether Chromium's namespaces are off, the half of its sandbox that hides the system's files and
 * processes. An AppImage's starter turns them off where the system does not let an ordinary program
 * create them (Ubuntu 23.10 and later). The other half, the filter on system calls, stays on, because
 * the app asks for the sandbox itself (`app.enableSandbox`).
 */
export function runsWithoutSandbox(): boolean {
    return app.commandLine.hasSwitch('no-sandbox')
}

export async function sayNoSandbox(told: Told, log: (message: string) => void): Promise<void> {
    log('Chromium’s sandbox has no namespaces.')
    if (!(await told.once('no-sandbox'))) return
    await dialog.showMessageBox({ type: 'warning', message: COPY.noSandboxTitle, detail: COPY.noSandboxDetail, buttons: [COPY.ok], noLink: true })
}
