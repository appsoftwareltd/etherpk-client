/** The real shell over a scratch directory, with the person's part played by a test. */
import { watch } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Launch, NativeEventName, NativePort } from '@appsoftwareltd/etherpk-native-bridge'
import { NATIVE_BRIDGE_VERSION } from '@appsoftwareltd/etherpk-native-bridge'
import { Grants } from '../fs/grants.ts'
import { NativeShell } from '../port/shell.ts'

export interface NodePort {
    port: NativePort
    shell: NativeShell
    /** Where the person's files are. */
    disk: string
    /** Where the app keeps its own. */
    data: string
    grants: Grants
    folderAnswers: (string | null)[]
    saveAnswers: (string | null)[]
    opened: string[]
    launches: Launch[]
    logged: string[]
    dispose(): Promise<void>
}

const CALLER = 1

/** False on a computer whose programs already use every file watch it allows, where the shell says it cannot watch. */
export function canWatch(dir: string): boolean {
    try {
        watch(dir).close()
        return true
    } catch {
        console.warn('No file watches are left on this computer, so nothing about watching was tested.')
        return false
    }
}

export async function createNodePort(): Promise<NodePort> {
    const scratch = await mkdtemp(join(tmpdir(), 'etherpk-desktop-'))
    const disk = join(scratch, 'disk')
    const data = join(scratch, 'data')
    await mkdir(disk)
    const listeners = new Set<(event: NativeEventName, detail: unknown) => void>()
    const folderAnswers: (string | null)[] = []
    const saveAnswers: (string | null)[] = []
    const opened: string[] = []
    const logged: string[] = []
    const launches: Launch[] = []
    const grants = await Grants.open(join(data, 'grants.json'), (message) => logged.push(message))
    const shell = new NativeShell({
        grants,
        host: {
            pickFolder: async () => folderAnswers.shift() ?? null,
            pickSave: async () => saveAnswers.shift() ?? null,
            openExternal: async (url) => { opened.push(url) },
            showInFileManager: () => {},
            print: () => {},
            setTheme: () => {},
            closeAnswer: () => {},
            readClipboard: () => '',
            takeLaunches: () => launches.splice(0),
            emit: (_caller, event, detail) => { for (const listener of listeners) listener(event, structuredClone(detail)) },
            log: (message) => logged.push(message),
        },
        signIn: { signIn: async () => { throw new Error('unused') }, accessToken: async () => null, signedIn: () => false, signOut: async () => {} },
        updates: { status: () => ({ state: 'off' }), check: async () => ({ state: 'off' }), install: async () => {} },
    })
    const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
    return {
        shell, disk, data, grants, folderAnswers, saveAnswers, opened, logged, launches,
        port: {
            info: {
                bridgeVersion: NATIVE_BRIDGE_VERSION, platform, appVersion: '0.0.0',
                features: { watch: canWatch(disk), showInFileManager: true, print: false, signIn: false, updates: false },
            },
            // Through a structured clone both ways, as Electron's messages go.
            call: async (method, args) => structuredClone(await shell.call(CALLER, method, structuredClone(args))),
            on: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
        },
        async dispose() {
            await shell.release(CALLER)
            await rm(scratch, { recursive: true, force: true })
        },
    }
}
