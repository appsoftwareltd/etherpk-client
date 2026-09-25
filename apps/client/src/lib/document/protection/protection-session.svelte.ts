/**
 * The live protection session for the open graph: one {@link ProtectionService}, the browser
 * events that drive it, and reactive state the UI reads.
 *
 * The service and the lock machine are deliberately pure and clock-injected, so everything here
 * is plumbing: attach listeners, run a timer, and re-expose the status as runes. Anything worth
 * testing lives one layer down and is unit-tested there.
 *
 * The two clocks of ADR 0058 arrive here as different events:
 *
 * - **Masking** comes from `visibilitychange`, `pagehide` and `blur` on `window`. All three are
 *   listened for, because they fire in different situations - switching tabs, switching
 *   applications, and the OS taking the window away - and missing any one of them leaves a case
 *   where plaintext stays on screen.
 * - **Locking** comes from a single timer re-armed to `service.wakeAt`. One timer, not two: the
 *   machine already knows which deadline is nearer, and a `setInterval` polling every second
 *   would keep a backgrounded tab awake for no reason.
 */
import { browser } from '$app/environment'

import { type LockSettings, type LockStatus } from './lock-machine'
import { ProtectionService, type ProtectionServiceDeps, type RecordProblem } from './protection-service'
import { readLockSettings } from './protection-settings'
import type { ProtectionRecordStore } from './protection-store'

/** How long a UI action waits for the record read before saying it could not be reached. */
const READY_TIMEOUT_MS = 8_000

export interface ProtectionSessionOptions {
    store: ProtectionRecordStore
    /** Flush any pending protected plaintext. Runs before the key is discarded. */
    commit: () => Promise<void>
    /** Called whenever the status changes, so the editor can redraw its fence widgets. */
    onChange?: () => void
    /** Overrides for tests; production reads the per-device settings. */
    settings?: () => LockSettings
}

export class ProtectionSession {
    #service: ProtectionService
    #timer: ReturnType<typeof setTimeout> | undefined
    #detach: (() => void)[] = []
    #onChange?: () => void

    /** Reactive mirror of the service, so components re-render on a lock transition. */
    status = $state<LockStatus>('locked')
    isConfigured = $state(false)
    fingerprint = $state<string | null>(null)

    /**
     * Resolves once the graph's record has been read.
     *
     * `start()` is fired off rather than awaited during a graph open, so for a short window
     * `isConfigured` is false because the answer has not arrived — not because there is no key.
     * Anything that would act on that difference must await {@link ready} first, or a user who
     * reaches the menu quickly is offered "set a passphrase" for a graph that already has one.
     */
    #ready: Promise<void> = Promise.resolve()
    #loaded = false

    constructor(options: ProtectionSessionOptions) {
        this.#onChange = options.onChange
        const deps: ProtectionServiceDeps = {
            store: options.store,
            now: () => Date.now(),
            settings: options.settings ?? (() => readLockSettings()),
            commit: options.commit,
        }
        this.#service = new ProtectionService(deps)
    }

    /** The underlying service, for the encrypt / decrypt / classify calls the UI needs. */
    get service(): ProtectionService {
        return this.#service
    }

    /** The key is held - masked included. What the lock controls and the protect commands ask. */
    get isUnlocked(): boolean {
        return this.status === 'unlocked' || this.status === 'masked'
    }

    /** Plaintext may be on screen. What the padlocks and the projections ask. */
    get isReadable(): boolean {
        return this.status === 'unlocked'
    }

    /**
     * The last record read threw, so `isConfigured` means "could not see", not "none". Not a rune:
     * it is asked on the action paths, after {@link ready}, never by a template.
     */
    get isUnreadable(): boolean {
        return this.#service.isUnreadable
    }

    /**
     * Why the record cannot be believed, with the sentence to show; null once it is known. Not a
     * rune, for the same reason as {@link isUnreadable}.
     */
    get recordProblem(): RecordProblem | null {
        return this.#service.recordProblem
    }

    /**
     * Attach the browser listeners and read the graph's record. Safe to call once per graph.
     *
     * **Listeners first, deliberately.** Everything up to the first `await` runs synchronously, so
     * a caller that fires this off without awaiting it still has the lock lifecycle armed the
     * moment it returns. Reading the record is the slow half — on a [[Server Backend]] it is a
     * vault fetch over the network — and nothing at graph-open time needs its answer: an unloaded
     * record reads as **locked**, which is the safe default and the state a graph opens in anyway.
     * Awaiting it on the critical path put a whole network round trip in front of the index open.
     */
    async start(): Promise<void> {
        this.#attach()
        this.#ready = this.#service.load().then(() => void (this.#loaded = true))
        await this.#ready
        this.#sync()
    }

    /**
     * Wait for the record read, so `isConfigured` can be trusted. **False means the answer never
     * arrived** — a vault fetch that failed or is still hanging — and the caller must say so rather
     * than acting on `isConfigured`, which in that state means "we do not know".
     *
     * Bounded, because the read is a network call on a [[Server Backend]] and a menu action that
     * waits on an unreachable server is a hang with no explanation.
     */
    async ready(timeoutMs = READY_TIMEOUT_MS): Promise<boolean> {
        if (this.#loaded) return true
        let timer: ReturnType<typeof setTimeout> | undefined
        const expiry = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs)
        })
        try {
            await Promise.race([this.#ready.catch(() => {}), expiry])
        } finally {
            if (timer !== undefined) clearTimeout(timer)
        }
        return this.#loaded
    }

    /**
     * Read the record again, for the moment a user acts on a graph whose record could not be
     * read when it opened - the vault was locked, the server unreachable. The message they were
     * shown says "try again", so the button they press must actually do that rather than act on
     * the stale answer. Resolves to whether the record can now be trusted.
     */
    async refresh(): Promise<boolean> {
        await this.#service.load()
        this.#loaded = true
        this.#sync()
        return this.#service.isRecordKnown
    }

    #attach(): void {
        if (!browser) return

        const onVisibility = () => (document.visibilityState === 'hidden' ? this.hidden() : this.shown())
        const onBlur = () => this.blurred()
        const onFocus = () => this.shown()
        // The tab going away is the one event with no "coming back": lock, unconditionally
        // (ADR 0058), rather than mask and leave the key in a bfcache'd page.
        const onPageHide = () => this.lockNow()
        // Passive and capturing: activity must be noticed wherever it happens, including inside
        // the editor, without any handler being able to stop it reaching us.
        const onActivity = () => this.activity()

        document.addEventListener('visibilitychange', onVisibility)
        window.addEventListener('blur', onBlur)
        window.addEventListener('focus', onFocus)
        window.addEventListener('pagehide', onPageHide)
        for (const type of ['keydown', 'pointerdown', 'wheel'] as const) {
            window.addEventListener(type, onActivity, { passive: true, capture: true })
        }

        this.#detach.push(() => document.removeEventListener('visibilitychange', onVisibility))
        this.#detach.push(() => window.removeEventListener('blur', onBlur))
        this.#detach.push(() => window.removeEventListener('focus', onFocus))
        this.#detach.push(() => window.removeEventListener('pagehide', onPageHide))
        for (const type of ['keydown', 'pointerdown', 'wheel'] as const) {
            this.#detach.push(() => window.removeEventListener(type, onActivity, { capture: true }))
        }
    }

    async enable(passphrase: string): Promise<void> {
        await this.#service.enable(passphrase)
        this.#sync()
    }

    async unlock(passphrase: string): Promise<void> {
        await this.#service.unlock(passphrase)
        this.#sync()
    }

    unlockWithKey(key: Uint8Array): void {
        this.#service.unlockWithKey(key)
        this.#sync()
    }

    async changePassphrase(current: string, next: string): Promise<void> {
        await this.#service.changePassphrase(current, next)
        this.#sync()
    }

    lockNow(): void {
        this.#service.lockNow()
        this.#sync()
    }

    hidden(): void {
        this.#service.onHidden()
        this.#sync()
    }

    blurred(): void {
        this.#service.onBlurred()
        this.#sync()
    }

    shown(): void {
        this.#service.onShown()
        this.#sync()
    }

    navigatedAway(): void {
        this.#service.onNavigatedAway()
        this.#sync()
    }

    activity(): void {
        // Only meaningful while a key is held; a locked graph must not re-arm a timer on every
        // keystroke of ordinary editing.
        if (this.status === 'locked') return
        this.#service.onActivity()
        this.#sync()
    }

    dispose(): void {
        // Lock before letting go: a graph switch must not leave a key in memory for a graph the
        // user has navigated away from.
        //
        // Through `#sync`, not by calling the service directly, so the host's `onChange` runs —
        // that is what drops every projected body from memory. Locking without
        // it left the previous graph's plaintext in memory after a graph switch.
        this.#service.lockNow()
        this.#sync()
        if (this.#timer !== undefined) clearTimeout(this.#timer)
        this.#timer = undefined
        for (const detach of this.#detach) detach()
        this.#detach = []
    }

    /** Adopt the service's state, tell the host, and re-arm the single deadline timer. */
    #sync(): void {
        this.status = this.#service.status
        this.isConfigured = this.#service.isConfigured
        this.fingerprint = this.#service.fingerprint
        this.#onChange?.()
        this.#arm()
    }

    #arm(): void {
        if (this.#timer !== undefined) clearTimeout(this.#timer)
        this.#timer = undefined
        const wakeAt = this.#service.wakeAt
        if (wakeAt === null || !browser) return
        // Never negative, and never zero — a zero-delay timer that immediately re-arms itself is
        // a spin loop if the machine ever declines to advance.
        const delay = Math.max(50, wakeAt - Date.now())
        this.#timer = setTimeout(() => {
            this.#service.tick()
            this.#sync()
        }, delay)
    }
}
