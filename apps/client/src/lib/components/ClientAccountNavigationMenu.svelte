<script lang="ts">
    import { onMount } from "svelte";

    import { page } from "$app/state";
    import { signInToEtherPK } from "#lib/auth/managed-sign-in.js";
    import { currentReturnPath, syncConnectHref } from "#lib/auth/sign-in-links.js";
    import { isNativeApp } from "#lib/native/bridge.js";
    import {
        saveManagedSyncConnection,
        serverHost,
        STANDALONE_DEVICE_DISCONNECT_HELP,
    } from "#lib/sync/index.js";
    import { buildAccountMenu, dismissibleMenu, truncateNavigationEmail, type AccountPlacement } from "@appsoftwareltd/etherpk-shared";
    import AccountDrawerSection from "@appsoftwareltd/etherpk-shared/account-drawer-section";
    import AccountMenuLinks from "@appsoftwareltd/etherpk-shared/account-menu-links";
    import InstallEntry from "#lib/install/InstallEntry.svelte";
    import { clientAccount } from "./client-account.svelte.js";

    interface Props {
        managedSessionAvailable?: boolean;
        managedAccountUrl?: string | null;
        /** Corporate's Billing page, where Sync+ is paid for: offered on a managed connection. */
        managedBillingUrl?: string | null;
        /** The header bar's dropdown, or the row at the top of a phone's drawer. */
        placement?: AccountPlacement;
    }

    let {
        managedSessionAvailable = false,
        managedAccountUrl = null,
        managedBillingUrl = null,
        placement = "header",
    }: Props = $props();

    // One copy of the account for the page, whichever placements draw it (client-account.svelte.ts).
    const accountState = $derived(clientAccount.state);
    const account = $derived(clientAccount.account);
    const connectionMode = $derived(clientAccount.connectionMode);
    const serverBaseUrl = $derived(clientAccount.serverBaseUrl);
    const otherServers = $derived(clientAccount.otherServers);
    const managedSyncAvailable = clientAccount.managedSyncAvailable;
    const inDrawer = $derived(placement === "drawer");

    const accountLabel = $derived(account?.principal.email ?? account?.principal.name ?? "Authenticated");
    const displayedAccountLabel = $derived(truncateNavigationEmail(accountLabel));
    const accountUrl = $derived(
        connectionMode === "managed"
            ? managedAccountUrl
            : serverBaseUrl
              ? `${serverBaseUrl}/account`
              : null,
    );
    // The same menu as Corporate's and the Sync Server's. Graphs is in the top navigation, and the
    // Client has no administration pages. Access tokens are the primary connection's server's, managed
    // or custom: a Personal Access Token for the Headless Client is minted there (ADR 0072).
    const menu = $derived(buildAccountMenu({
        accountUrl,
        billingUrl: connectionMode === "managed" ? managedBillingUrl : null,
        accessTokensUrl: serverBaseUrl ? `${serverBaseUrl}/account/tokens` : null,
    }));
    const syncSettingsHref = $derived(syncConnectHref(page.url.pathname === "/graphs" ? null : currentReturnPath(page.url)));

    function connectManagedSync(): void {
        // Added beside any custom server this device holds, and the header's account from then on.
        saveManagedSyncConnection();
        // Back to this page once signed in: a document someone was about to open, not /graphs.
        void signInToEtherPK(currentReturnPath(window.location), { signedIn: () => clientAccount.signedIn() });
    }

    onMount(() => {
        clientAccount.start({ managedSessionAvailable, recheck: !inDrawer });
    });
</script>

<!-- Sign out of EtherPK: a top-level form navigation follows the fixed Corporate and Server
     continuations, which clear every managed host-only session. An installed app has no such
     sessions: its shell holds its sign-in, and the browser's is left as it is. -->
{#snippet signOutOfEtherPK()}
    {#if isNativeApp()}
        <button
            type="button"
            data-testid="sign-out-of-app"
            aria-disabled={clientAccount.signingOut}
            onclick={() => clientAccount.signOutOfInstalledApp()}
            class="gk-menu-item"
        >
            {clientAccount.signingOut ? "Signing out…" : "Sign out of this app"}
        </button>
    {:else}
        <form method="POST" action="/auth/logout/managed" onsubmit={() => clientAccount.prepareManagedSignOut()}>
            <button type="submit" class="gk-menu-item">
                Sign out of EtherPK
            </button>
        </form>
    {/if}
{/snippet}

<!-- What the signed-in account's dropdown holds, and on a phone what its drawer row expands to.
     The dropdown names the account above it; the drawer row names it itself. The drawer has an
     Install row of its own further down, so it leaves this one out. -->
{#snippet authenticatedMenu()}
    {#if !inDrawer || (otherServers.length > 0 && serverBaseUrl)}
        <div class="px-3 py-2">
            {#if !inDrawer}
                <p class="break-all text-sm text-(--gk-text-muted)">{accountLabel}</p>
            {/if}
            {#if otherServers.length > 0 && serverBaseUrl}
                <p data-testid="client-user-menu-server" class="break-all text-sm text-(--gk-text-muted)">
                    on {serverHost(serverBaseUrl)}
                </p>
            {/if}
        </div>
        <hr class="gk-menu-separator" />
    {/if}
    {#if otherServers.length > 0}
        <!-- Each other server's account and keys are on its own sub-tab of the Sync tab. -->
        <div data-testid="client-user-menu-other-servers">
            <p class="px-3 py-1.5 text-sm text-(--gk-text-muted)">Also connected to</p>
            {#each otherServers as origin (origin)}
                <a
                    href={`/graphs?tab=sync&server=${encodeURIComponent(serverHost(origin))}`}
                    class="gk-menu-item break-all"
                    >{serverHost(origin)}</a
                >
            {/each}
        </div>
        <hr class="gk-menu-separator" />
    {/if}
    <AccountMenuLinks {menu} />
    {#if !inDrawer}
        <InstallEntry placement="account" />
    {/if}
    <hr class="gk-menu-separator" />
    <div>
        {#if connectionMode === "managed"}
            {@render signOutOfEtherPK()}
        {:else}
            <p class="px-3 py-1.5 text-sm text-(--gk-text-muted)">
                {STANDALONE_DEVICE_DISCONNECT_HELP}
            </p>
            <button type="button" onclick={() => clientAccount.disconnectThisDevice()} class="gk-menu-item">
                Disconnect this device
            </button>
        {/if}
    </div>
{/snippet}

{#snippet unavailableMenu()}
    <p class="px-3 py-1.5 text-sm text-(--gk-text-muted)">
        The Sync Server is not answering right now.
    </p>
    <hr class="gk-menu-separator" />
    <nav aria-label="Account navigation">
        <a href={syncSettingsHref} class="gk-menu-item">Sync settings</a>
    </nav>
    <hr class="gk-menu-separator" />
    <div>
        {@render signOutOfEtherPK()}
    </div>
{/snippet}

{#snippet chevron()}
    <svg class="h-3.5 w-3.5 shrink-0 motion-safe:transition-transform group-open:rotate-180" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path fill-rule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" />
    </svg>
{/snippet}

{#if accountState === "authenticated" && account}
    {#if inDrawer}
        <AccountDrawerSection label={accountLabel} caption="Signed in as">
            {@render authenticatedMenu()}
        </AccountDrawerSection>
    {:else}
        <details class="group relative min-w-0" {@attach dismissibleMenu}>
            <summary
                data-testid="client-user-menu-trigger"
                aria-label={`Signed in as ${accountLabel}`}
                title={accountLabel}
                class="gk-button min-w-0 list-none [&::-webkit-details-marker]:hidden"
            >
                <span class="min-w-0 max-w-36 truncate whitespace-nowrap sm:max-w-none">{displayedAccountLabel}</span>
                {@render chevron()}
            </summary>

            <div class="gk-menu absolute right-0 z-40 mt-2 w-64 overflow-hidden">
                {@render authenticatedMenu()}
            </div>
        </details>
    {/if}
{:else if accountState === "checking"}
    <span data-testid="client-auth-status" class={inDrawer ? "px-3 py-2 text-sm text-(--gk-text-muted)" : "hidden text-sm font-medium text-neutral-500 sm:inline dark:text-neutral-400"}>Checking Sync…</span>
{:else if accountState === "locked"}
    <!-- The Graphs page asks for the passcode as it loads; on it, the This Device tab's Device
         Passcode section asks. -->
    <a
        href={page.url.pathname === "/graphs" ? "/graphs?tab=device" : "/graphs"}
        data-testid="client-auth-passcode"
        class={["gk-button", inDrawer && "w-full"]}
    >
        Enter passcode
    </a>
{:else if accountState === "unavailable" && connectionMode === "managed"}
    <!-- The Sync Server not answering is no reason to be stuck signed in: the way out stays
         offered beside the way to Sync settings. -->
    {#if inDrawer}
        <AccountDrawerSection label="Sync unavailable">
            {@render unavailableMenu()}
        </AccountDrawerSection>
    {:else}
        <details class="group relative min-w-0" {@attach dismissibleMenu}>
            <summary
                data-testid="client-auth-unavailable"
                class="gk-button list-none [&::-webkit-details-marker]:hidden"
            >
                Sync unavailable
                {@render chevron()}
            </summary>

            <div class="gk-menu absolute right-0 z-40 mt-2 w-64 overflow-hidden">
                {@render unavailableMenu()}
            </div>
        </details>
    {/if}
{:else if accountState !== "unavailable" && managedSyncAvailable && (connectionMode === "managed" || connectionMode === null)}
    <button
        type="button"
        onclick={connectManagedSync}
        class={["gk-button", inDrawer && "w-full"]}
    >
        Sign in
    </button>
{:else}
    <a href={syncSettingsHref} class={["gk-button", inDrawer && "w-full"]}>
        {accountState === "unavailable" ? "Sync unavailable" : "Connect Sync"}
    </a>
{/if}
