<script lang="ts">
    import { onMount } from "svelte";

    import { page } from "$app/state";
    import { env } from "$env/dynamic/public";
    import { currentReturnPath, managedSignInHref, syncConnectHref } from "$lib/auth/sign-in-links";
    import { ManagedTokenError, clearManagedAccessToken } from "$lib/auth/managed-token";
    import {
        SYNC_CONNECTIONS_CHANGED_EVENT,
        SYNC_CONNECTIONS_STORAGE_KEY,
        SyncApiError,
        clearSyncAccount,
        forgetSyncConnection,
        isManagedSyncConfigured,
        listSyncConnections,
        lockVault,
        MANAGED_DEVICE_DISCONNECT_HELP,
        primarySyncConnection,
        saveManagedSyncConnection,
        serverHost,
        setSyncAccount,
        STANDALONE_DEVICE_DISCONNECT_HELP,
        syncApiFor,
        type ResolvedSyncConnection,
    } from "$lib/sync";
    import { announceAccountSignal, onAccountSignal } from "$lib/sync/account-signal";
    import { buildAccountMenu, dismissibleMenu, truncateNavigationEmail, type SyncAccountSummary } from "@appsoftwareltd/etherpk-shared";

    type AccountState = "checking" | "authenticated" | "signed-out" | "unavailable" | "disconnected";

    interface Props {
        managedSessionAvailable?: boolean;
        managedAccountUrl?: string | null;
        /** Corporate's Billing page, where Sync+ is paid for: offered on a managed connection. */
        managedBillingUrl?: string | null;
    }

    let {
        managedSessionAvailable = false,
        managedAccountUrl = null,
        managedBillingUrl = null,
    }: Props = $props();

    let accountState = $state<AccountState>("checking");
    let account = $state.raw<SyncAccountSummary | null>(null);
    /**
     * The primary Sync Connection's kind and origin (ADR 0111): Managed Sync, the EtherPK account,
     * when the device holds it, else the first server added. The header speaks for that one.
     */
    let connectionMode = $state<ResolvedSyncConnection["kind"] | null>(null);
    let serverBaseUrl = $state<string | null>(null);
    /**
     * The other servers this device holds, by origin. The menu names the primary's server and lists
     * these, each linking to its sub-tab on the Sync tab, where its account and keys are.
     */
    let otherServers = $state.raw<string[]>([]);
    let refreshGeneration = 0;

    const managedSyncAvailable = isManagedSyncConfigured(env);
    const accountLabel = $derived(account?.principal.email ?? account?.principal.name ?? "Authenticated");
    const displayedAccountLabel = $derived(truncateNavigationEmail(accountLabel));
    const accountUrl = $derived(
        connectionMode === "managed"
            ? managedAccountUrl
            : serverBaseUrl
              ? `${serverBaseUrl}/account`
              : null,
    );
    const accessTokensUrl = $derived(serverBaseUrl ? `${serverBaseUrl}/account/tokens` : null);
    // Access tokens in both modes: a managed user mints a Personal Access Token for the Headless
    // Client at the Server portal, which is where tokens live whoever signed the session in (ADR 0072).
    const menuItems = $derived(buildAccountMenu({
        home: { label: "Graphs", href: "/graphs" },
        accountUrl,
        billingUrl: connectionMode === "managed" ? managedBillingUrl : null,
        accessTokensUrl,
    }));
    const disconnectHelp = $derived(
        connectionMode === "managed"
            ? MANAGED_DEVICE_DISCONNECT_HELP
            : STANDALONE_DEVICE_DISCONNECT_HELP,
    );

    /**
     * `announce`: tell the other tabs when this check finds a signed-in account signed out. Off
     * when the check was itself prompted by another tab's announcement, so two tabs never keep
     * answering each other.
     */
    async function refreshAccount(options: { announce?: boolean } = {}): Promise<void> {
        const generation = ++refreshGeneration;
        const wasAuthenticated = accountState === "authenticated";
        // An unreadable stored connection never resolves, so it reads as none: the Graphs page's
        // Sync tab replaces it with a validated server and credential.
        const connection = primarySyncConnection();

        connectionMode = connection?.kind ?? null;
        serverBaseUrl = connection?.origin ?? null;
        otherServers = listSyncConnections()
            .filter((held) => held.origin !== connection?.origin)
            .map((held) => held.origin);
        account = null;

        if (!connection) {
            accountState = "disconnected";
            return;
        }

        accountState = "checking";
        try {
            const confirmedAccount = await syncApiFor(connection).me();
            if (generation !== refreshGeneration) return;

            account = confirmedAccount;
            accountState = "authenticated";
            setSyncAccount({ serverOrigin: connection.origin, principalId: confirmedAccount.principal.id });
        } catch (error) {
            if (generation !== refreshGeneration) return;
            account = null;
            if ((error instanceof SyncApiError || error instanceof ManagedTokenError)
                && error.status === 401) {
                accountState = "signed-out";
                // Signed out, or the token revoked, somewhere this tab could not see: that
                // server's keys lock too, as a sign-out here locks them. Locking needs the
                // account's scope, so it comes before the account is forgotten.
                lockVault(connection.origin);
                clearSyncAccount(connection.origin);
                // Signed out somewhere this tab could not see (on the account site, or a revoked
                // token): open graphs on that server, in every tab, stop syncing and say so.
                if (wasAuthenticated && options.announce !== false) {
                    announceAccountSignal({
                        type: "ended",
                        reason: connection.kind === "managed" ? "signed-out" : "refused",
                        serverOrigin: connection.origin,
                    });
                }
            } else {
                // A failed reachability check is not evidence that the credential is invalid.
                // Keep the last account partition for offline work, but do not present it as
                // current authentication in the navigation bar.
                accountState = "unavailable";
            }
        }
    }

    function connectManagedSync(): void {
        // Added beside any custom server this device holds, and the header's account from then on.
        saveManagedSyncConnection();
        // Back to this page once signed in: a document someone was about to open, not /graphs.
        window.location.href = managedSignInHref(currentReturnPath(window.location));
    }

    async function disconnectThisDevice(): Promise<void> {
        ++refreshGeneration;
        const origin = serverBaseUrl;
        if (!origin) return;
        lockVault(origin);
        clearSyncAccount(origin);
        // Every other tab's open graph on this server stops syncing now, not at its next reconnect.
        announceAccountSignal({ type: "ended", reason: "disconnected", serverOrigin: origin });

        if (connectionMode === "managed") {
            clearManagedAccessToken();
            // End only the Client-origin refresh session. Corporate and Server portal sessions
            // deliberately remain signed in for this narrower device action.
            await fetch("/auth/logout", { method: "POST" });
            window.location.href = "/graphs?managed=disconnected";
            return;
        }

        // A standalone Client authenticates with a device-local PAT, not the Server portal's
        // browser session. Forgetting it disconnects this Client from that server alone; token
        // revocation remains an explicit action in the Server's Access tokens page.
        forgetSyncConnection(origin);
        account = null;
        connectionMode = null;
        serverBaseUrl = null;
        accountState = "disconnected";
        window.location.href = "/graphs?sync=disconnected";
    }

    function prepareManagedSignOut(): void {
        // The form continues through all three managed origins. Clear volatile Client state
        // before navigation so the current page cannot retain authenticated UI while it leaves.
        // Only Managed Sync's keys lock: a custom server's account has nothing to do with it.
        ++refreshGeneration;
        clearManagedAccessToken();
        const managed = listSyncConnections().find((held) => held.kind === "managed");
        if (managed) {
            lockVault(managed.origin);
            clearSyncAccount(managed.origin);
        }
        announceAccountSignal({ type: "ended", reason: "signed-out", ...(managed ? { serverOrigin: managed.origin } : {}) });
    }

    function refreshFromStorage(event: StorageEvent): void {
        if (event.key === SYNC_CONNECTIONS_STORAGE_KEY || event.key === null) void refreshAccount();
    }

    function refreshWhenVisible(): void {
        if (document.visibilityState === "visible") void refreshAccount();
    }

    onMount(() => {
        const refresh = () => void refreshAccount();

        window.addEventListener(SYNC_CONNECTIONS_CHANGED_EVENT, refresh);
        // Another tab ended the account, or something saw a refusal and asks for a re-check.
        const stopAccountSignals = onAccountSignal((signal) =>
            void refreshAccount({ announce: signal.type === "check" }),
        );
        // The HTTP-only Client session is authoritative for managed mode. Restore the browser's
        // non-secret Managed Sync connection after silent SSO or when local storage has been
        // cleared. Added beside any custom server the device already holds.
        if (managedSessionAvailable && managedSyncAvailable && !listSyncConnections().some((held) => held.kind === "managed")) {
            saveManagedSyncConnection();
        }
        refresh();

        return () => {
            ++refreshGeneration;
            window.removeEventListener(SYNC_CONNECTIONS_CHANGED_EVENT, refresh);
            stopAccountSignals();
        };
    });
</script>

<svelte:window onstorage={refreshFromStorage} />
<svelte:document onvisibilitychange={refreshWhenVisible} />

{#if accountState === "authenticated" && account}
    <details class="group relative min-w-0" {@attach dismissibleMenu}>
        <summary
            data-testid="client-user-menu-trigger"
            aria-label={`Signed in as ${accountLabel}`}
            title={accountLabel}
            class="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg border border-gray-950/10 bg-white px-2.5 py-1.5 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 hover:text-gray-950 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10 dark:hover:text-white [&::-webkit-details-marker]:hidden"
        >
            <span class="min-w-0 max-w-36 truncate whitespace-nowrap sm:max-w-none">{displayedAccountLabel}</span>
            <svg class="h-3.5 w-3.5 shrink-0 motion-safe:transition-transform group-open:rotate-180" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fill-rule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" />
            </svg>
        </summary>

        <div class="absolute right-0 z-40 mt-2 w-64 overflow-hidden rounded-xl border border-gray-950/10 bg-white shadow-xl dark:border-white/10 dark:bg-[#202023]">
            <div class="border-b border-gray-950/5 px-4 py-3 dark:border-white/10">
                <p class="break-all text-sm text-gray-500 dark:text-gray-400">{accountLabel}</p>
                {#if otherServers.length > 0 && serverBaseUrl}
                    <p data-testid="client-user-menu-server" class="break-all text-sm text-gray-500 dark:text-gray-400">
                        on {serverHost(serverBaseUrl)}
                    </p>
                {/if}
            </div>
            {#if otherServers.length > 0}
                <!-- Each other server's account and keys are on its own sub-tab of the Sync tab. -->
                <div data-testid="client-user-menu-other-servers" class="border-b border-gray-950/5 p-2 dark:border-white/10">
                    <p class="px-3 pb-1 pt-1 text-sm text-gray-500 dark:text-gray-400">Also connected to</p>
                    {#each otherServers as origin (origin)}
                        <a
                            href={`/graphs?tab=sync&server=${encodeURIComponent(serverHost(origin))}`}
                            class="block break-all rounded-lg px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-950 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white"
                            >{serverHost(origin)}</a
                        >
                    {/each}
                </div>
            {/if}
            <nav class="p-2" aria-label="Account navigation">
                {#each menuItems as item (item.label)}
                    <a href={item.href} class="block rounded-lg px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-950 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white">{item.label}</a>
                {/each}
            </nav>
            <div class="border-t border-gray-950/5 p-2 dark:border-white/10">
                {#if connectionMode === "managed"}
                    <!-- A top-level form navigation follows the fixed Corporate and Server
                         continuations which clear every managed host-only session. -->
                    <form method="POST" action="/auth/logout/managed" onsubmit={prepareManagedSignOut}>
                        <button type="submit" class="w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-950 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white">
                            Sign out of EtherPK
                        </button>
                    </form>
                {/if}
                <p class="px-3 pb-1 pt-2 text-sm leading-4 text-gray-500 dark:text-gray-400">
                    {disconnectHelp}
                </p>
                <button type="button" onclick={disconnectThisDevice} class="w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-950 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white">
                    Disconnect this device
                </button>
            </div>
        </div>
    </details>
{:else if accountState === "checking"}
    <span data-testid="client-auth-status" class="hidden text-sm font-medium text-gray-500 sm:inline dark:text-gray-400">Checking Sync…</span>
{:else if accountState !== "unavailable" && managedSyncAvailable && (connectionMode === "managed" || connectionMode === null)}
    <button
        type="button"
        onclick={connectManagedSync}
        class="rounded-lg border border-gray-950/10 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 shadow-sm transition-colors hover:bg-gray-50 hover:text-gray-950 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10 dark:hover:text-white"
    >
        Sign in
    </button>
{:else}
    <a
        href={syncConnectHref(page.url.pathname === "/graphs" ? null : currentReturnPath(page.url))}
        class="rounded-lg border border-gray-950/10 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 shadow-sm transition-colors hover:bg-gray-50 hover:text-gray-950 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10 dark:hover:text-white"
    >
        {accountState === "unavailable" ? "Sync unavailable" : "Connect Sync"}
    </a>
{/if}
