/**
 * The Sync Server a person sets for the desktop app in place of the one it was built with (ADR 0214).
 *
 * A published app opens with Managed Sync. An organisation with a Sync Server of its own points the
 * app at it at run time, with no build of its own: `ETHERPK_SYNC_SERVER` in the environment, or
 * `syncServer` in `settings.json` in the app's data folder, the variable first. The page is then
 * given that server (`ShellInfo.syncServer`) and offers neither Managed Sync nor its sign-in.
 *
 * A setting that is there and wrong is never quietly passed over: it is logged with the detail, the
 * app starts as it was built, and the person is told what was wrong and where (`syncServerProblemDetail`).
 * The file not being there is the usual case and no fault.
 */
import { readFile } from 'node:fs/promises'
import { syncServerOriginOf } from '@appsoftwareltd/etherpk-native-bridge'
import { COPY } from '../copy.ts'

export const SYNC_SERVER_VARIABLE = 'ETHERPK_SYNC_SERVER'
/** The settings file's name, in the app's data folder (`app.getPath('userData')`). */
export const SETTINGS_FILE = 'settings.json'
const SYNC_SERVER_KEY = 'syncServer'

export type SyncServerProblem =
    | { kind: 'not-a-server'; from: 'environment'; value: string }
    | { kind: 'not-a-server'; from: 'file'; value: string; file: string }
    | { kind: 'not-json' | 'unreadable'; from: 'file'; file: string }

export interface SyncServerSetting {
    /** The server's origin, or null to use the one the app was built with. */
    server: string | null
    /** A setting that was there and could not be used, or null. */
    problem: SyncServerProblem | null
}

interface Reading {
    env: Record<string, string | undefined>
    /** The settings file's full path. */
    file: string
    log(message: string, detail?: unknown): void
}

const unset: SyncServerSetting = { server: null, problem: null }

export async function readSyncServerSetting({ env, file, log }: Reading): Promise<SyncServerSetting> {
    const variable = env[SYNC_SERVER_VARIABLE]?.trim()
    if (variable) {
        const server = syncServerOriginOf(variable)
        if (server !== null) return { server, problem: null }
        log(`${SYNC_SERVER_VARIABLE} is "${variable}", which is not a Sync Server's https address. The app starts as it was built.`)
        return { server: null, problem: { kind: 'not-a-server', from: 'environment', value: variable } }
    }
    let text: string
    try {
        text = await readFile(file, 'utf8')
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return unset
        log(`${file} could not be read. The app starts as it was built.`, error)
        return { server: null, problem: { kind: 'unreadable', from: 'file', file } }
    }
    let settings: unknown
    try {
        settings = JSON.parse(text)
    } catch (error) {
        log(`${file} is not JSON. The app starts as it was built.`, error)
        return { server: null, problem: { kind: 'not-json', from: 'file', file } }
    }
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
        log(`${file} holds no object of settings. The app starts as it was built.`)
        return { server: null, problem: { kind: 'not-json', from: 'file', file } }
    }
    const others = Object.keys(settings).filter((key) => key !== SYNC_SERVER_KEY)
    if (others.length > 0) log(`${file} has settings this app does not know, which it leaves alone: ${others.join(', ')}.`)
    if (!(SYNC_SERVER_KEY in settings)) return unset
    const written = (settings as Record<string, unknown>)[SYNC_SERVER_KEY]
    const server = syncServerOriginOf(written)
    if (server !== null) return { server, problem: null }
    const value = typeof written === 'string' ? written : JSON.stringify(written)
    log(`${SYNC_SERVER_KEY} in ${file} is ${value}, which is not a Sync Server's https address. The app starts as it was built.`)
    return { server: null, problem: { kind: 'not-a-server', from: 'file', value, file } }
}

/** What the person is told of a setting that was there and not used. `managed`: the app was built with Managed Sync. */
export function syncServerProblemDetail(problem: SyncServerProblem, managed: boolean): string {
    const instead = managed ? COPY.syncServerStartedManaged : COPY.syncServerStartedWithout
    switch (problem.kind) {
        case 'not-a-server':
            return problem.from === 'environment'
                ? COPY.syncServerVariableWrong(SYNC_SERVER_VARIABLE, problem.value, instead)
                : COPY.syncServerFileValueWrong(SYNC_SERVER_KEY, problem.file, problem.value, instead)
        case 'not-json':
            return COPY.syncServerFileNotJson(problem.file, instead)
        case 'unreadable':
            return COPY.syncServerFileUnreadable(problem.file, instead)
    }
}
