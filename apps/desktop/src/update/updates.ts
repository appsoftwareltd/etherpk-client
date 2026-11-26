/**
 * Keeping the app current: read the signed feed, offer a newer version, fetch it when the person asks,
 * check it, and hand it to the installer of this platform.
 *
 * Off when the build has no feed address or no key to trust, or when the app was not installed in a
 * way it can tell.
 */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { UpdateStatus } from '@appsoftwareltd/etherpk-native-bridge'
import { replaceFile } from '../fs/atomic-write.ts'
import { NativeFailure } from '../failure.ts'
import { downloadRelease, type Fetcher, isRelease } from './download.ts'
import { compareVersions, FeedError, LONGEST_FEED, newerRelease, type PlatformKey, readFeed, type Release, type UpdateKey } from './feed.ts'

/** What puts a checked file in the place of the running app. */
export interface Installer {
    platform: PlatformKey
    /** False where the person installs it themselves, from the release's page. */
    installs: boolean
    /** Close the app and install. Resolves false when the app stayed open, because a window has unsaved work. */
    install(path: string): Promise<boolean>
}

export interface UpdatesParts {
    feedUrl: string | null
    keys: readonly UpdateKey[]
    channel: string
    current: string
    installer: Installer | null
    /** Where downloads and what was last seen are kept. */
    dir: string
    fetch: Fetcher
    changed(status: UpdateStatus): void
    log(message: string, error: unknown): void
    now?: () => number
}

const FEED_BUDGET_MS = 30_000
/** What a person reads when an update could not be fetched. The log has the reason. */
export const CHECK_FAILED = 'Could not check for an update. Check your connection and try again.'
export const DOWNLOAD_FAILED = 'The update could not be downloaded. Check your connection and try again.'
export const INSTALL_FAILED = 'The update could not be installed. Try again, or download it from the EtherPK website.'
export const INSTALLER_NOT_STARTED = 'The update could not be started. Security software on this device may have stopped it. Try again, or download the update from the EtherPK website.'

/** The installer did not start, so the app is still the one running. */
export class InstallerNotStarted extends Error {}

export class AppUpdates {
    private current: UpdateStatus
    private release: Release | null = null
    private path: string | null = null
    private busy: Promise<UpdateStatus> | null = null
    private applying: Promise<void> | null = null

    constructor(private readonly parts: UpdatesParts) {
        this.current = { state: this.isOn ? 'idle' : 'off' }
    }

    private get isOn(): boolean {
        return this.parts.feedUrl !== null && this.parts.keys.length > 0 && this.parts.installer !== null
    }

    status(): UpdateStatus {
        return this.current
    }

    private set(status: UpdateStatus): UpdateStatus {
        this.current = status
        this.parts.changed(status)
        return status
    }

    /** One check or download at a time. A second asker gets the first one's answer. */
    private alone(task: () => Promise<UpdateStatus>): Promise<UpdateStatus> {
        this.busy ??= task().finally(() => { this.busy = null })
        return this.busy
    }

    async check(): Promise<UpdateStatus> {
        if (!this.isOn) return this.current
        // Something fetched and waiting stays so. The next start checks again.
        if (this.current.state === 'ready') return this.current
        return this.alone(() => this.look())
    }

    private async look(): Promise<UpdateStatus> {
        const before = this.current
        this.set({ state: 'checking' })
        try {
            const release = await this.newer()
            this.release = release
            return this.set(release ? this.available(release) : { state: 'idle' })
        } catch (error) {
            this.parts.log('The update feed was not taken.', error)
            // An update already on offer stays on offer when a later look fails.
            if (before.state === 'available') return this.set(before)
            return this.set({ state: 'failed', message: CHECK_FAILED })
        }
    }

    private available(release: Release): UpdateStatus {
        const required = compareVersions(this.parts.current, release.minimumVersion) < 0
        return { state: 'available', version: release.version, install: this.parts.installer!.installs, required, page: release.page }
    }

    private async newer(): Promise<Release | null> {
        const response = await this.parts.fetch(this.parts.feedUrl!, { signal: AbortSignal.timeout(FEED_BUDGET_MS), headers: { 'cache-control': 'no-cache' } })
        if (!response.ok) throw new Error(`The feed was answered with ${response.status}.`)
        if (Number(response.headers.get('content-length') ?? 0) > LONGEST_FEED) throw new FeedError('format', 'The feed is too long.')
        const kept = await this.highestSequence()
        const payload = readFeed(await response.text(), { keys: this.parts.keys, highestSequence: kept ?? 0, now: (this.parts.now ?? Date.now)() })
        if (kept === null || payload.sequence > kept) await this.keepSequence(payload.sequence)
        // With the highest sequence lost, this feed could be an old one served again, and nothing here
        // can tell. Its sequence is the new floor, and only a later look offers an update.
        if (kept === null) return null
        return newerRelease(payload, this.parts.channel, this.parts.installer!.platform, this.parts.current)
    }

    private get sequenceFile(): string {
        return join(this.parts.dir, '..', 'update-sequence.json')
    }

    /** The highest sequence seen, 0 before the first, and null when the file that keeps it cannot be read. */
    private async highestSequence(): Promise<number | null> {
        let text: string
        try {
            text = await readFile(this.sequenceFile, 'utf8')
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
            this.parts.log('The highest update sequence could not be read.', error)
            return null
        }
        try {
            const kept = JSON.parse(text) as { sequence?: unknown } | null
            if (Number.isSafeInteger(kept?.sequence) && (kept!.sequence as number) >= 0) return kept!.sequence as number
        } catch {
            // Told below.
        }
        this.parts.log('The highest update sequence is not readable.', text.slice(0, 100))
        return null
    }

    private async keepSequence(sequence: number): Promise<void> {
        await mkdir(dirname(this.sequenceFile), { recursive: true })
        await replaceFile(this.sequenceFile, Buffer.from(JSON.stringify({ sequence })))
    }

    /** From `available`: fetch it. From `ready`: close and install it. */
    async install(): Promise<void> {
        // One install at a time: a second press, or another window's, waits for the first.
        if (this.applying) return this.applying
        if (this.current.state === 'ready') {
            this.applying = this.apply().finally(() => { this.applying = null })
            return this.applying
        }
        if (!this.parts.installer?.installs) throw new NativeFailure('NotSupportedError', 'The person installs this one.')
        if (!this.release) throw new NativeFailure('InvalidStateError', 'There is no update to install.')
        await this.alone(() => this.fetchRelease(this.release!))
    }

    private async fetchRelease(release: Release): Promise<UpdateStatus> {
        const downloading = (received: number): UpdateStatus => ({ state: 'downloading', version: release.version, received, total: release.size })
        let told = 0
        this.set(downloading(0))
        try {
            this.path = await downloadRelease(release, this.parts.dir, this.parts.fetch, (received) => {
                // Four times a second is as often as anyone can read.
                if (Date.now() - told < 250) return
                told = Date.now()
                this.set(downloading(received))
            })
            return this.set({ state: 'ready', version: release.version })
        } catch (error) {
            this.parts.log('The update was not downloaded.', error)
            return this.set({ state: 'failed', message: DOWNLOAD_FAILED })
        }
    }

    private async apply(): Promise<void> {
        try {
            // Checked again at the last moment: the file has been lying in a folder since.
            if (!this.path || !this.release || !(await isRelease(this.path, this.release))) throw new Error('The downloaded file has changed.')
            await this.parts.installer!.install(this.path)
        } catch (error) {
            this.parts.log('The update was not installed.', error)
            this.path = null
            this.set({ state: 'failed', message: error instanceof InstallerNotStarted ? INSTALLER_NOT_STARTED : INSTALL_FAILED })
        }
    }
}
