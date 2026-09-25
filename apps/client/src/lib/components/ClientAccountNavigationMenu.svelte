<script lang="ts">
    import { onMount } from "svelte";

    import { env } from "$env/dynamic/public";
    import { ManagedTokenError, clearManagedAccessToken } from "$lib/auth/managed-token";
    import {
        SYNC_CONFIG_CHANGED_EVENT,
        SYNC_CONFIG_STORAGE_KEY,
        SyncApiError,
        clearActiveSyncAccount,
        clearSyncConfig,
        createSyncApi,
        isManagedSyncConfigured,
        lockVault,
        MANAGED_DEVICE_DISCONNECT_HELP,
        normaliseServerOrigin,
        readSyncConfig,
        resolveSyncConnection,
        setActiveSyncAccount,
        STANDALONE_DEVICE_DISCONNECT_HELP,
        writeSyncConfig,
        type ResolvedSyncConnection,
        type SyncConfig,
    } from "$lib/sync";
    import { truncateNavigationEmail, type SyncAccountSummary } from "@appsoftwareltd/etherpk-shared";

    type AccountState = "checking" | "authenticated" | "signed-out" | "unavailable" | "disconnected";

    interface Props {
        managedSessionAvailable?: boolean;
        managedAccountUrl?: string | null;
    }

    let {
        managedSessionAvailable = false,
        managedAccountUrl = null,
    }: Props = $props();

    let accountState = $state<AccountState>("checking");
    let account = $state.raw<SyncAccountSummary | null>(null);
    let connectionMode = $state<SyncConfig["mode"] | null>(null);
    let serverBaseUrl = $state<string | null>(null);
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
    const disconnectHelp = $derived(
        connectionMode === "managed"
            ? MANAGED_DEVICE_DISCONNECT_HELP
            : STANDALONE_DEVICE_DISCONNECT_HELP,
    );
    const accountModeLabel = $derived(
        connectionMode === "managed"
            ? "Managed account"
            : account?.authentication.mode === "standalone"
              ? "Standalone account"
              : "Custom server account",
    );

    async function refreshAccount(): Promise<void> {
        const generation = ++refreshGeneration;
        const config = readSyncConfig();
        let connection: ResolvedSyncConnection | null;

        connectionMode = config?.mode ?? null;
        account = null;

        try {
            connection = config ? resolveSyncConnection(config) : null;
            serverBaseUrl = connection ? normaliseServerOrigin(connection.serverBaseUrl) : null;
        } catch {
            // Treat malformed browser-held configuration as disconnected. The Graphs connection
            // form remains available to replace it with a validated Server origin and credential.
            serverBaseUrl = null;
            accountState = "disconnected";
            clearActiveSyncAccount();
            return;
        }

        if (!config || !connection) {
            accountState = "disconnected";
            clearActiveSyncAccount();
            return;
        }

        accountState = "checking";
        try {
            const confirmedAccount = await createSyncApi({
                baseUrl: connection.serverBaseUrl,
                token: connection.token,
            }).me();
            if (generation !== refreshGeneration) return;

            account = confirmedAccount;
            accountState = "authenticated";
            setActiveSyncAccount({
                serverOrigin: normaliseServerOrigin(connection.serverBaseUrl),
                principalId: confirmedAccount.principal.id,
            });
        } catch (error) {
            if (generation !== refreshGeneration) return;
            account = null;
            if ((error instanceof SyncApiError || error instanceof ManagedTokenError)
                && error.status === 401) {
                accountState = "signed-out";
                clearActiveSyncAccount();
            } else {
                // A failed reachability check is not evidence that the credential is invalid.
                // Keep the last account partition for offline work, but do not present it as
                // current authentication in the navigation bar.
                accountState = "unavailable";
            }
        }
    }

    function connectManagedSync(): void {
        clearActiveSyncAccount();
        writeSyncConfig({ mode: "managed" });
        window.location.href = "/auth/login";
    }

    async function disconnectThisDevice(): Promise<void> {
        ++refreshGeneration;
        clearManagedAccessToken();
        lockVault();
        clearActiveSyncAccount();

        if (connectionMode === "managed") {
            // End only the Client-origin refresh session. Corporate and Server portal sessions
            // deliberately remain signed in for this narrower device action.
            await fetch("/auth/logout", { method: "POST" });
            window.location.href = "/graphs?managed=signed-out";
            return;
        }

        // A standalone Client authenticates with a device-local PAT, not the Server portal's
        // browser session. Forgetting it disconnects this Client; token revocation remains an
        // explicit action in the Server's Access tokens page.
        clearSyncConfig();
        account = null;
        connectionMode = null;
        serverBaseUrl = null;
        accountState = "disconnected";
        window.location.href = "/graphs?sync=disconnected";
    }

    function prepareManagedSignOut(): void {
        // The form continues through all three managed origins. Clear volatile Client state
        // before navigation so the current page cannot retain authenticated UI while it leaves.
        ++refreshGeneration;
        clearManagedAccessToken();
        lockVault();
        clearActiveSyncAccount();
    }

    function refreshFromStorage(event: StorageEvent): void {
        if (event.key === SYNC_CONFIG_STORAGE_KEY || event.key === null) void refreshAccount();
    }

    function refreshWhenVisible(): void {
        if (document.visibilityState === "visible") void refreshAccount();
    }

    onMount(() => {
        const refresh = () => void refreshAccount();

        window.addEventListener(SYNC_CONFIG_CHANGED_EVENT, refresh);
        // The HTTP-only Client session is authoritative for managed mode. Restore the browser's
        // non-secret connection choice after silent SSO or when local storage has been cleared.
        if (managedSessionAvailable && managedSyncAvailable && readSyncConfig() === null) {
            writeSyncConfig({ mode: "managed" });
        }
        refresh();

        return () => {
            ++refreshGeneration;
            window.removeEventListener(SYNC_CONFIG_CHANGED_EVENT, refresh);
        };
    });
</script>

<svelte:window onstorage={refreshFromStorage} />
<svelte:document onvisibilitychange={refreshWhenVisible} />

{#if accountState === "authenticated" && account}
    <details class="group relative min-w-0">
        <summary
            data-testid="client-user-menu-trigger"
            aria-label={`Signed in as ${accountLabel}`}
            title={accountLabel}
            class="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg border border-gray-950/10 bg-white px-2.5 py-1.5 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 hover:text-gray-950 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10 dark:hover:text-white [&::-webkit-details-marker]:hidden"
        >
            <span class="h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-hidden="true"></span>
            <span class="min-w-0 max-w-36 truncate whitespace-nowrap sm:max-w-none">{displayedAccountLabel}</span>
            <svg class="h-3.5 w-3.5 shrink-0 motion-safe:transition-transform group-open:rotate-180" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fill-rule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" />
            </svg>
        </summary>

        <div class="absolute right-0 z-40 mt-2 w-64 overflow-hidden rounded-xl border border-gray-950/10 bg-white shadow-xl dark:border-white/10 dark:bg-[#202023]">
            <div class="border-b border-gray-950/5 px-4 py-3 dark:border-white/10">
                <p class="text-sm font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                    {accountModeLabel}
                </p>
                <p class="mt-1 break-all text-sm text-gray-500 dark:text-gray-400">{accountLabel}</p>
            </div>
            <nav class="p-2" aria-label="Account navigation">
                <a href="/graphs" class="block rounded-lg px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-950 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white">Graphs</a>
                {#if accountUrl}
                    <a href={accountUrl} class="block rounded-lg px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-950 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white">Account</a>
                {/if}
                <!-- Both modes: a managed user mints a Personal Access Token for the Headless
                     Client at the Server portal, which is where tokens live whoever signed the
                     session in (ADR 0072). -->
                {#if accessTokensUrl}
                    <a href={accessTokensUrl} class="block rounded-lg px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-950 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white">Access tokens</a>
                {/if}
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
        href="/graphs?sync=connect"
        class="rounded-lg border border-gray-950/10 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 shadow-sm transition-colors hover:bg-gray-50 hover:text-gray-950 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10 dark:hover:text-white"
    >
        {accountState === "unavailable" ? "Sync unavailable" : "Connect Sync"}
    </a>
{/if}
