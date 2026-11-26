/**
 * The header's account, for this page: which Sync Connection the header speaks for, and whether
 * its server confirms the account. One copy for the page, shared by every account control drawn
 * from it: the header bar's dropdown, and on a phone the row at the top of the navigation drawer
 * (`AccountPlacement`). The drawer's copy mounts each time the drawer opens, so a copy of its own
 * would show "Checking Sync…" and ask the server again on every open.
 *
 * `start` begins listening the first time any control mounts and keeps listening for the life of
 * the page. A header bar's control mounting again (a move between the marketing and app layouts)
 * checks the account again, as it did when each control held its own copy; the drawer's does not.
 */
import * as env from '$app/env/public'
import { signOutOfInstalledApp } from '#lib/auth/managed-sign-in.js'
import { ManagedTokenError } from '#lib/auth/managed-token.js'
import {
    DevicePasscodeLockedError,
    SYNC_CONNECTIONS_CHANGED_EVENT,
    SYNC_CONNECTIONS_STORAGE_KEY,
    SyncApiError,
    devicePasscode,
    clearSyncAccount,
    forgetSyncConnection,
    isManagedSyncConfigured,
    listSyncConnections,
    lockVault,
    primarySyncConnection,
    saveManagedSyncConnection,
    setSyncAccount,
    syncApiFor,
    type ResolvedSyncConnection,
} from '#lib/sync/index.js'
import { announceAccountSignal, onAccountSignal } from '#lib/sync/account-signal.js'
import { endManagedSessionInThisBrowser } from '#lib/sync/managed-sign-out.js'
import type { SyncAccountSummary } from '@appsoftwareltd/etherpk-shared'

/** `locked`: the server's access token waits for this device's passcode (ADR 0129). */
export type AccountState = 'checking' | 'authenticated' | 'signed-out' | 'unavailable' | 'disconnected' | 'locked'

class ClientAccount {
    state = $state<AccountState>('checking')
    account = $state.raw<SyncAccountSummary | null>(null)
    /**
     * The primary Sync Connection's kind and origin (ADR 0111): Managed Sync, the EtherPK account,
     * when the device holds it, else the first server added. The header speaks for that one.
     */
    connectionMode = $state<ResolvedSyncConnection['kind'] | null>(null)
    serverBaseUrl = $state<string | null>(null)
    /**
     * The other servers this device holds, by origin. The menu names the primary's server and lists
     * these, each linking to its sub-tab on the Sync tab, where its account and keys are.
     */
    otherServers = $state.raw<string[]>([])

    /**
     * Whether someone is signed in to EtherPK here, once a sign-in or a sign-out on this page has said so;
     * null before that, when the page's own data says it. Only an installed app signs in without a load.
     */
    managedSession = $state<boolean | null>(null)
    signingOut = $state(false)

    readonly managedSyncAvailable = isManagedSyncConfigured(env)
    #generation = 0
    #started = false

    /**
     * `announce`: tell the other tabs when this check finds a signed-in account signed out. Off
     * when the check was itself prompted by another tab's announcement, so two tabs never keep
     * answering each other.
     */
    async refresh(options: { announce?: boolean } = {}): Promise<void> {
        const generation = ++this.#generation
        const wasAuthenticated = this.state === 'authenticated'
        // An unreadable stored connection never resolves, so it reads as none: the Graphs page's
        // Sync tab replaces it with a validated server and credential.
        const connection = primarySyncConnection()
        this.#showConnections(connection)

        if (!connection) {
            this.state = 'disconnected'
            return
        }

        this.state = 'checking'
        try {
            const confirmedAccount = await syncApiFor(connection).me()
            if (generation !== this.#generation) return

            this.account = confirmedAccount
            this.state = 'authenticated'
            setSyncAccount({ serverOrigin: connection.origin, principalId: confirmedAccount.principal.id })
        } catch (error) {
            if (generation !== this.#generation) return
            this.account = null
            this.#settleFailedCheck(error, connection, wasAuthenticated && options.announce !== false)
        }
    }

    /** The connection the header speaks for, and the device's other servers, before any check answers. */
    #showConnections(connection: ResolvedSyncConnection | null): void {
        this.connectionMode = connection?.kind ?? null
        this.serverBaseUrl = connection?.origin ?? null
        this.otherServers = listSyncConnections()
            .filter((held) => held.origin !== connection?.origin)
            .map((held) => held.origin)
        this.account = null
    }

    /** What a failed `me()` means for the header: signed out, waiting for the passcode, or unreachable. */
    #settleFailedCheck(error: unknown, connection: ResolvedSyncConnection, announce: boolean): void {
        if ((error instanceof SyncApiError || error instanceof ManagedTokenError) && error.status === 401) {
            this.state = 'signed-out'
            // Signed out, or the token revoked, somewhere this tab could not see: that server's
            // keys lock too, as a sign-out here locks them. Locking needs the account's scope, so
            // it comes before the account is forgotten.
            lockVault(connection.origin)
            clearSyncAccount(connection.origin)
            // Open graphs on that server, in every tab, stop syncing and say so.
            if (announce) {
                announceAccountSignal({
                    type: 'ended',
                    reason: connection.kind === 'managed' ? 'signed-out' : 'refused',
                    serverOrigin: connection.origin,
                })
            }
        } else if (error instanceof DevicePasscodeLockedError) {
            // Nothing was asked: the token waits for the passcode, which the graph list asks for.
            this.state = 'locked'
        } else {
            // A failed reachability check is not evidence that the credential is invalid. Keep
            // the last account partition for offline work, but do not present it as current
            // authentication in the navigation bar.
            this.state = 'unavailable'
        }
    }

    /**
     * A custom server's way out: Managed Sync has only Sign out of EtherPK, which signs every app
     * out (ADR 0048, amended 2026-10-07).
     */
    disconnectThisDevice(): void {
        ++this.#generation
        const origin = this.serverBaseUrl
        if (!origin) return
        lockVault(origin)
        clearSyncAccount(origin)
        // Every other tab's open graph on this server stops syncing now, not at its next reconnect.
        announceAccountSignal({ type: 'ended', reason: 'disconnected', serverOrigin: origin })

        // A standalone Client authenticates with a device-local PAT, not the Server portal's
        // browser session. Forgetting it disconnects this Client from that server alone; token
        // revocation remains an explicit action in the Server's Access tokens page.
        forgetSyncConnection(origin)
        this.account = null
        this.connectionMode = null
        this.serverBaseUrl = null
        this.state = 'disconnected'
        window.location.href = '/graphs?sync=disconnected'
    }

    prepareManagedSignOut(): void {
        // The form continues through all three managed origins. Clear this browser's part before
        // the page leaves, so it cannot keep showing a signed-in account while it goes.
        ++this.#generation
        endManagedSessionInThisBrowser()
    }

    /** A sign-in on this page finished, in an installed app. The other windows check again too. */
    signedIn(): void {
        this.managedSession = true
        announceAccountSignal({ type: 'check' })
        void this.refresh()
    }

    /**
     * Sign out of an installed app: its own sign-in only, where a browser's way out goes on to every
     * EtherPK site. The shell forgets the sign-in before this page or another window is told, so that
     * the check each then makes is answered signed out.
     */
    async signOutOfInstalledApp(): Promise<void> {
        if (this.signingOut) return
        this.signingOut = true
        ++this.#generation
        try {
            // A sign-out the shell could not finish has said so, and the person stays signed in here.
            if (!(await signOutOfInstalledApp())) return
            endManagedSessionInThisBrowser()
            this.managedSession = false
            await this.refresh({ announce: false })
        } finally {
            this.signingOut = false
        }
    }

    /**
     * Starts checking the account and listening for changes to it, once for the page. A later call
     * checks the account again only when `recheck` asks for it.
     */
    start(options: { managedSessionAvailable: boolean; recheck?: boolean }): void {
        if (this.#started) {
            if (options.recheck) void this.refresh()
            return
        }
        this.#started = true
        const refresh = () => void this.refresh()

        window.addEventListener(SYNC_CONNECTIONS_CHANGED_EVENT, refresh)
        window.addEventListener('storage', (event) => {
            if (event.key === SYNC_CONNECTIONS_STORAGE_KEY || event.key === null) refresh()
        })
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') refresh()
        })
        // Another tab ended the account, or something saw a refusal and asks for a re-check.
        onAccountSignal((signal) => void this.refresh({ announce: signal.type === 'check' }))
        // The passcode entered or turned off, in this tab or another: the token can be read now.
        devicePasscode.onChange((state) => {
            if (state !== 'locked' && this.state === 'locked') refresh()
        })
        // The HTTP-only Client session is authoritative for managed mode. Restore the browser's
        // non-secret Managed Sync connection after silent SSO or when local storage has been
        // cleared. Added beside any custom server the device already holds.
        if (
            options.managedSessionAvailable &&
            this.managedSyncAvailable &&
            !listSyncConnections().some((held) => held.kind === 'managed')
        ) {
            saveManagedSyncConnection()
        }
        refresh()
    }
}

export const clientAccount = new ClientAccount()
