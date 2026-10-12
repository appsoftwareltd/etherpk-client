/**
 * The Extension Directory extensions a person installed, kept in step on every device (ADR 0123,
 * amended 2026-10-12).
 *
 * **Which extensions** the person has is one entry each in their settings (ADR 0134),
 * `extensions.installed.<id>`, set when they install one and cleared when they remove it. The
 * settings follow the person through their account's vault, so a new device installs their
 * extensions as it starts, a removal on one device removes the extension on the others, and when
 * the account ends on a device its extensions leave with its settings. A device with no account
 * keeps the entries on the device.
 *
 * **Which release** each device runs is its own (installed.ts): the newest listed release its
 * Client can run. Updates are automatic, being how a fix reaches every device. The directory's list
 * is read as the Client starts and every hour. A newer release is fetched and checked then, and runs
 * from the next start, so nothing being drawn is torn down. A release taken out of the list stops at
 * once, and the newest listed one takes its place. One that needs a newer Client waits, and
 * Settings says which.
 *
 * `planInstalled` decides, purely, so every rule is tested in Node. `createInstalledSync` reads the
 * list, carries the plan out and says what it could not do.
 */
import type { PersonSettings } from '$lib/person-settings/person-settings'

import { compareVersions } from './catalogue'
import type { ExtensionDirectory } from './directory'
import { type DirectoryExtension, type DirectoryListing, type DirectoryRelease, newestRelease } from './directory-format'
import type { InstalledExtensions, InstalledRelease } from './installed'

/** The prefix of the person's setting that says they installed an extension. */
export const INSTALLED_SETTING_PREFIX = 'extensions.installed.'

/** The value the setting holds while the extension is installed; cleared when it is removed. */
export const INSTALLED_SETTING_VALUE = 'installed'

export function installedSettingKey(id: string): string {
    return `${INSTALLED_SETTING_PREFIX}${id}`
}

/** The ids of the extensions the person installed, as their settings say. */
export function installedIds(settings: Pick<PersonSettings, 'keys'>): string[] {
    return settings.keys(INSTALLED_SETTING_PREFIX).map((key) => key.slice(INSTALLED_SETTING_PREFIX.length))
}

/** A listed release of an extension. */
export interface ListedRelease {
    extension: DirectoryExtension
    release: DirectoryRelease
}

/** A newer release waiting for a newer Client. */
export interface WaitingRelease {
    id: string
    version: string
    /** The Client version it needs. */
    needs: string
}

export interface InstalledPlan {
    /** Installed by the person, not on this device: install now. */
    install: ListedRelease[]
    /** Its release here was taken out of the list: replace it now. */
    replace: ListedRelease[]
    /** A newer release is listed: fetch and check it now, to run from the next start. */
    stage: ListedRelease[]
    /** Its release here was taken out of the list and nothing listed can run here: stop it, keeping what it holds. */
    withdraw: string[]
    /** On this device, no longer the person's: remove it and what it holds. */
    remove: string[]
    /** A release that would be newer needs a newer Client. */
    waiting: WaitingRelease[]
    /** Installed by the person, and not in the list at all. */
    unlisted: string[]
}

export interface PlanInput {
    /** The ids the person installed. */
    intended: readonly string[]
    /** The releases on this device. */
    device: readonly InstalledRelease[]
    /** The directory's list, or null while it cannot be read (or the Client has none). */
    listing: DirectoryListing | null
    clientVersion: string
    /** The ids the Client's own extensions have, which no directory extension takes. */
    builtIns: readonly string[]
}

/** The listed release with the highest version, whatever Client it needs. */
function newestListed(extension: DirectoryExtension): DirectoryRelease | null {
    return [...extension.releases].sort((a, b) => compareVersions(b.version, a.version))[0] ?? null
}

/** What this device does about the person's extensions, given the list as it is now. */
export function planInstalled(input: PlanInput): InstalledPlan {
    const plan: InstalledPlan = { install: [], replace: [], stage: [], withdraw: [], remove: [], waiting: [], unlisted: [] }
    const intended = new Set(input.intended.filter((id) => !input.builtIns.includes(id)))
    const device = new Map(input.device.map((release) => [release.id, release]))

    // What the person no longer has goes, whether or not the list can be read.
    for (const id of device.keys()) if (!intended.has(id)) plan.remove.push(id)
    if (!input.listing) return plan

    for (const id of intended) {
        const extension = input.listing.extensions.find((candidate) => candidate.id === id)
        const here = device.get(id)
        if (!extension) {
            plan.unlisted.push(id)
            if (here) plan.withdraw.push(id)
            continue
        }
        const runnable = newestRelease(extension, input.clientVersion)
        const newest = newestListed(extension)
        // A newer release than this device can have, and the Client it needs.
        const waiting = (than: string | null) => {
            if (newest && newest !== runnable && (than === null || compareVersions(newest.version, than) > 0)) plan.waiting.push({ id, version: newest.version, needs: newest.minClientVersion })
        }
        if (!here) {
            if (runnable) plan.install.push({ extension, release: runnable })
            else waiting(null)
            continue
        }
        const stillListed = extension.releases.some((release) => release.integrity === here.integrity)
        if (!stillListed) {
            if (runnable) plan.replace.push({ extension, release: runnable })
            else {
                plan.withdraw.push(id)
                waiting(null)
            }
            continue
        }
        if (runnable && runnable.integrity !== here.integrity && compareVersions(runnable.version, here.version) > 0 && here.next?.integrity !== runnable.integrity) {
            plan.stage.push({ extension, release: runnable })
        }
        waiting(runnable?.version ?? here.version)
    }
    return plan
}

/** What could not be done for an extension, for its row in Settings. */
export interface InstalledReport {
    /** A newer release that needs a newer Client. */
    waiting?: { version: string; needs: string }
    /** Not in the directory's list. */
    unlisted?: boolean
    /** Its release was taken out of the list and stopped here. */
    withdrawn?: boolean
    /** Why installing or updating it failed. */
    failure?: string
    /** The version of a newer release fetched and checked, which runs from the next start. */
    staged?: string
    /** When the release running here took the place of an earlier one, in ms since 1970. */
    updatedAt?: number
}

export interface InstalledSync {
    /** Read the list and bring this device in step with the person's extensions. Resolves when done. */
    run(): Promise<void>
    /** Each extension's report, by id. */
    reports(): Readonly<Record<string, InstalledReport>>
    /** Called after each run. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void
    /** Run as the Client starts, whenever the person's extensions change, and every hour. Returns the stop. */
    start(): () => void
}

export interface InstalledSyncOptions {
    directory: Pick<ExtensionDirectory, 'load' | 'installRelease' | 'stageRelease' | 'removeFromDevice'>
    installed: Pick<InstalledExtensions, 'list'>
    settings: Pick<PersonSettings, 'keys' | 'subscribe'>
    clientVersion: string
    builtIns: readonly string[]
    /** Say, once, which extensions were installed from the person's account. */
    notify(text: string): void
    /** How often the list is read again while the Client runs. */
    intervalMs?: number
    setInterval?: (run: () => void, ms: number) => unknown
    clearInterval?: (handle: unknown) => void
}

const HOUR = 60 * 60 * 1000

/** "A", "A and B", "A, B and C". */
function names(list: readonly string[]): string {
    return list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

export function createInstalledSync(options: InstalledSyncOptions): InstalledSync {
    const { directory, installed, settings } = options
    let reports: Record<string, InstalledReport> = {}
    const listeners = new Set<() => void>()
    /** The run under way, so runs never overlap: a run asked for meanwhile follows it. */
    let running: Promise<void> | null = null
    let again = false

    async function once(): Promise<void> {
        let state: Awaited<ReturnType<typeof directory.load>>
        try {
            state = await directory.load()
        } catch {
            state = { state: 'unavailable', error: "The Client's server could not be reached." }
        }
        const listing = state.state === 'ok' ? state.listing : null
        const plan = planInstalled({ intended: installedIds(settings), device: installed.list(), listing, clientVersion: options.clientVersion, builtIns: options.builtIns })
        const next: Record<string, InstalledReport> = {}
        const report = (id: string, entry: InstalledReport) => (next[id] = { ...next[id], ...entry })

        for (const id of plan.remove) directory.removeFromDevice(id, { clearStorage: true })
        for (const id of plan.withdraw) {
            directory.removeFromDevice(id, { clearStorage: false })
            report(id, { withdrawn: true })
        }
        for (const id of plan.unlisted) report(id, { unlisted: true })
        for (const waiting of plan.waiting) report(waiting.id, { waiting: { version: waiting.version, needs: waiting.needs } })

        const fromAccount: string[] = []
        for (const { extension, release } of [...plan.install, ...plan.replace]) {
            try {
                await directory.installRelease(extension, release)
                if (plan.install.some((item) => item.extension.id === extension.id)) fromAccount.push(extension.displayName)
            } catch (error) {
                report(extension.id, { failure: error instanceof Error ? error.message : String(error) })
            }
        }
        for (const { extension, release } of plan.stage) {
            try {
                await directory.stageRelease(extension, release)
            } catch (error) {
                report(extension.id, { failure: error instanceof Error ? error.message : String(error) })
            }
        }
        if (fromAccount.length > 0) options.notify(`Installed from your account: ${names(fromAccount)}.`)
        // What the device now holds of each: a release waiting for the next start, and when the
        // running one last changed.
        for (const kept of installed.list()) {
            if (kept.next) report(kept.id, { staged: kept.next.version })
            if (kept.updatedAt !== undefined) report(kept.id, { updatedAt: kept.updatedAt })
        }
        reports = next
        for (const listener of listeners) listener()
    }

    function run(): Promise<void> {
        if (running) {
            again = true
            return running
        }
        running = (async () => {
            do {
                again = false
                await once()
            } while (again)
        })().finally(() => {
            running = null
        })
        return running
    }

    return {
        run,
        reports: () => reports,
        subscribe(listener) {
            listeners.add(listener)
            return () => void listeners.delete(listener)
        },
        start() {
            let known = installedIds(settings).sort().join('\n')
            const unsubscribe = settings.subscribe(() => {
                // Only a change to which extensions the person has: their other settings change too.
                const now = installedIds(settings).sort().join('\n')
                if (now === known) return
                known = now
                void run()
            })
            const every = options.setInterval ?? ((callback, ms) => globalThis.setInterval(callback, ms))
            const clear = options.clearInterval ?? ((handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>))
            const timer = every(() => void run(), options.intervalMs ?? HOUR)
            void run()
            return () => {
                unsubscribe()
                clear(timer)
            }
        },
    }
}
