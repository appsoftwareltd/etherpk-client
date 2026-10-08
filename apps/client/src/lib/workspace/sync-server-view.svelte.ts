/**
 * What the Graphs page knows about one Sync Server this device holds a connection to
 * (ADR 0111): the account signed in there, its plan, whether its vault exists and is unlocked here,
 * its graphs and its pending invites. The page keeps one per connection and shows them all at
 * once, the Graphs tab as a group per server and the Sync tab as a sub-tab per server, so nothing
 * here is "the current server": every action names the one it acts on.
 *
 * The page owns the reads that need the device registry or its dialogs (the membership list, the
 * invites, the name reads); this owns the account check and the plan's re-checks, which need
 * nothing but the server. No `$effect` anywhere: an instance is made whenever a connection appears,
 * outside any component's setup, so its timers are plain ones that `dispose` stops.
 */
import {
    displayedPlanNotice,
    nextPlanRecheckMs,
    ownerCanWrite,
    syncPlanNotice,
    type SyncAccountSummary,
} from '@appsoftwareltd/etherpk-shared'
import { ManagedTokenError } from '$lib/auth/managed-token'
import type { HandoutOutcome } from '$lib/sync/key-handouts'
import type { PendingInvite } from '$lib/sync/sync-api'
import { SyncApiError, type OwnedStorageTotals, type SyncApi } from '$lib/sync/sync-api'
import { clearSyncAccount, setSyncAccount } from '$lib/sync/account-scope'
import { DevicePasscodeLockedError } from '$lib/sync/device-passcode'
import { syncApiFor, type ResolvedSyncConnection } from '$lib/sync/sync-connection'
import { serverHost } from '$lib/sync/sync-connections'
import { getVaultWrapKey, lockVault, setVaultWrapKey } from '$lib/sync/vault-session'
import { serverPlanGate, type ServerAuthState, type SyncedGraphView } from './graph-picker-helpers'

export type { ServerAuthState } from './graph-picker-helpers'

/** How reading an unlabelled graph's name from its root document went. */
export type NameRead = 'reading' | 'unnamed' | 'unreachable'

/** The Client session or a Sync Server refused the credential, rather than failing to answer. */
export function refusedCredential(error: unknown): boolean {
    return (error instanceof SyncApiError || error instanceof ManagedTokenError) && error.status === 401
}

export class SyncServerView {
    readonly connection: ResolvedSyncConnection
    readonly origin: string
    readonly host: string
    readonly api: SyncApi

    authState = $state<ServerAuthState>('checking')
    /** The first account check has answered, one way or the other. */
    checked = $state(false)
    account = $state.raw<SyncAccountSummary | null>(null)
    /**
     * Whether the account has a vault at all: false on a brand-new or just-reset account, where
     * an unlock prompt would ask for a Recovery Code that does not exist; null while unknown.
     */
    vaultExists = $state<boolean | null>(null)
    /** Whether this device holds the account's vault key: what the Sync tab's keys line says. */
    vaultUnlocked = $state(false)

    /** The account's memberships, each cross-referenced with this device's copy for its name. */
    graphs = $state.raw<SyncedGraphView[]>([])
    /** The server answered with its memberships: the list is the server's, not only this device's. */
    listed = $state(false)
    loading = $state(false)
    error = $state<string | null>(null)
    /** The quota-anticipating rollup over graphs this account owns (ADR 0033). */
    ownedStorage = $state.raw<OwnedStorageTotals | null>(null)

    invites = $state.raw<PendingInvite[]>([])
    /** Each invite's graph name, read from its sealed keyring while the keys are unlocked here. */
    inviteNames = $state<Record<string, string>>({})
    /** Per row, how reading an unlabelled graph's name from its root document went. */
    nameReads = $state<Record<string, NameRead>>({})
    /** Rows already read this visit, so a refresh does not reconnect to them. */
    readonly nameReadsDone = new Set<string>()

    /** The account's own identity fingerprint, revealed on request: reading it needs the vault open. */
    fingerprint = $state<string | null>(null)
    fingerprintPending = $state(false)

    /**
     * Per graph, a copy of its newest key this account was handed and did not take in (ADR 0127):
     * signed with keys other than the ones pinned for the owner, or not signed by the owner at all.
     */
    keyCopies = $state.raw<Record<string, HandoutOutcome>>({})
    /** Per graph, a change of an owned graph's key running from this page. */
    rotating = $state.raw<ReadonlySet<string>>(new Set())

    /**
     * When this page first saw the plan pending, and the time of the last re-check. A new account's
     * first statement usually arrives within seconds; past a minute the notice says the plan
     * cannot be confirmed, and keeps checking (plan-recheck.ts in the shared package).
     */
    pendingSince = $state<number | null>(null)
    planClock = $state(Date.now())
    /** A Check again the person asked for is in flight. */
    planChecking = $state(false)

    /**
     * The account check in flight, or the last one settled. Actions gated on the plan await it: a
     * click that lands before the first check answers waits for it rather than racing it.
     */
    accountCheck: Promise<void> = Promise.resolve()

    /** What the server says about the plan; re-checks are paced on this, its own answer. */
    readonly planNotice = $derived(
        this.authState === 'authenticated' && this.account ? syncPlanNotice(this.account) : null,
    )
    /** The notice to show: a plan pending past its patience reads as unconfirmed. */
    readonly shownPlanNotice = $derived(displayedPlanNotice(this.planNotice, this.pendingSince, this.planClock))
    /** The gate on a new synced graph here: the Sync+ offer, or why it must wait (graph-picker-helpers.ts). */
    readonly #gate = $derived.by(() =>
        serverPlanGate({
            authState: this.authState,
            kind: this.connection.kind,
            host: this.host,
            account: this.account,
            planNotice: this.planNotice,
            shownPlanNotice: this.shownPlanNotice,
        }),
    )
    /** Owned graphs refuse writes and new Players while the owner's plan is not active. */
    readonly ownedGraphsWritable = $derived(ownerCanWrite(this.account))

    #planTimer: ReturnType<typeof setTimeout> | null = null
    #planRecheckAttempt = 0
    #planRecheck: Promise<void> | null = null
    #disposed = false

    /** `api` is for tests; the page always talks to the connection's own server. */
    constructor(connection: ResolvedSyncConnection, api: SyncApi = syncApiFor(connection)) {
        this.connection = connection
        this.origin = connection.origin
        this.host = serverHost(connection.origin)
        this.api = api
        this.vaultUnlocked = getVaultWrapKey(this.origin) !== null
    }

    /** A managed account on Free: it can own no synced graph (ADR 0068). */
    get syncPlusRequired(): boolean {
        return this.#gate.syncPlusRequired
    }

    /** Why a new synced graph cannot go on this server now, or null when it can. */
    get createBlockedReason(): string | null {
        return this.#gate.createBlockedReason
    }

    /**
     * Whether the Graphs tab's plan line shows for this server: its plan stands in the way of a new
     * graph, or a payment needs fixing. The Sync tab carries the whole notice either way.
     */
    get showsPlanLine(): boolean {
        return (
            this.authState === 'authenticated' &&
            (this.createBlockedReason !== null ||
                this.shownPlanNotice === 'payment_failed' ||
                this.shownPlanNotice === 'payment_overdue')
        )
    }

    /** The account as copy names it: its address, else its name. */
    get accountLabel(): string | null {
        return this.account ? (this.account.principal.email ?? this.account.principal.name ?? 'your account') : null
    }

    /** The key this device holds for this server's account, or null while it is locked here. */
    heldKey(): Uint8Array | null {
        return getVaultWrapKey(this.origin)
    }

    /** Cache a vault key for this server's account and say the keys are unlocked. */
    cacheKey(key: Uint8Array): void {
        setVaultWrapKey(this.origin, key)
        this.vaultUnlocked = true
    }

    /** Lock this server's keys on this device. */
    lock(): void {
        lockVault(this.origin)
        this.vaultUnlocked = false
    }

    /** Read `vaultUnlocked` again: another tab or dialog may have cached or dropped the key. */
    syncUnlocked(): void {
        this.vaultUnlocked = getVaultWrapKey(this.origin) !== null
    }

    /**
     * Ask the server who this device is signed in as. Confirming records the account for the
     * server (the registry shows its graphs from then on); a refusal signs the device out there and
     * locks its keys; a server that does not answer keeps the last partition for offline work. An
     * access token sealed by a Device Passcode not yet entered asks nothing (ADR 0129).
     */
    checkAccount(): Promise<void> {
        this.accountCheck = this.#checkAccount()
        return this.accountCheck
    }

    async #checkAccount(): Promise<void> {
        // A re-check keeps showing the account it confirmed last: the page refreshes after every
        // action, and each refresh would otherwise flash "Checking…" over the account.
        if (this.authState !== 'authenticated') this.authState = 'checking'
        try {
            const account = await this.api.me()
            if (this.#disposed) return
            this.account = account
            setSyncAccount({ serverOrigin: this.origin, principalId: account.principal.id })
            this.authState = 'authenticated'
            this.syncUnlocked()
            this.#notePlan(account)
            this.planClock = Date.now()
            this.#schedulePlanRecheck()
        } catch (error) {
            if (this.#disposed) return
            this.account = null
            if (error instanceof DevicePasscodeLockedError) this.authState = 'locked'
            else if (refusedCredential(error)) this.markSignedOut()
            // Unreachable is not refused: the last verified partition stays for offline local
            // work, and every remote call still presents a current token or PAT.
            else this.authState = 'unavailable'
        } finally {
            if (!this.#disposed) this.checked = true
        }
    }

    /**
     * The server refused this device's credential: signed out there, or its access token revoked.
     * Its keys lock with it, and the account's scope goes second because it says which key to drop.
     * Other servers are untouched.
     */
    markSignedOut(): void {
        lockVault(this.origin)
        clearSyncAccount(this.origin)
        this.account = null
        this.authState = 'signed-out'
        this.vaultUnlocked = false
        this.vaultExists = null
        this.graphs = []
        this.listed = false
        this.invites = []
        this.#stopPlanRechecks()
    }

    /** Whether the account has a vault. An unknown answer never blocks an action. */
    async refreshVault(): Promise<void> {
        try {
            this.vaultExists = (await this.api.getVault()) !== null
        } catch {
            this.vaultExists = null
        }
    }

    /**
     * Ask the server for the plan again, for the same account. `manual` is a Check again the person
     * pressed: it shows busy, and it runs while the tab is hidden, which a scheduled check waits out.
     */
    recheckPlan(options: { manual?: boolean } = {}): Promise<void> {
        // A Check again that joins a scheduled check still shows it is checking.
        if (this.#planRecheck) {
            if (options.manual) this.planChecking = true
            return this.#planRecheck
        }
        if (this.authState !== 'authenticated' || !this.account) return Promise.resolve()
        if (!options.manual && typeof document !== 'undefined' && document.visibilityState !== 'visible') {
            return Promise.resolve()
        }
        const principalId = this.account.principal.id
        if (options.manual) this.planChecking = true
        this.#planRecheck = this.api
            .me()
            .then((account) => {
                if (this.#disposed || this.authState !== 'authenticated' || account.principal.id !== principalId) return
                this.account = account
                this.#notePlan(account)
            })
            // Keeping the last answer is the right outcome for a failed background read.
            .catch(() => undefined)
            .finally(() => {
                this.#planRecheck = null
                this.planChecking = false
                this.planClock = Date.now()
                this.#schedulePlanRecheck()
            })
        return this.#planRecheck
    }

    /** Stop every timer: the connection is gone, or the page is. */
    dispose(): void {
        this.#disposed = true
        this.#stopPlanRechecks()
    }

    /** Remember when the plan was first seen pending, and forget it once the plan is known. */
    #notePlan(account: SyncAccountSummary): void {
        if (syncPlanNotice(account) === 'pending') {
            this.pendingSince ??= Date.now()
        } else {
            this.pendingSince = null
            this.#planRecheckAttempt = 0
        }
    }

    /**
     * Ask again on the shared schedule while the plan is pending or unconfirmed: quickly at first,
     * then every thirty seconds. Nothing is scheduled once the plan is known.
     */
    #schedulePlanRecheck(): void {
        this.#stopPlanRechecks()
        if (this.#disposed || !this.account) return
        const delay = nextPlanRecheckMs(syncPlanNotice(this.account), this.#planRecheckAttempt)
        if (delay === null) return
        this.#planTimer = setTimeout(() => {
            this.#planTimer = null
            this.#planRecheckAttempt += 1
            void this.recheckPlan()
        }, delay)
    }

    #stopPlanRechecks(): void {
        if (this.#planTimer) clearTimeout(this.#planTimer)
        this.#planTimer = null
    }
}
