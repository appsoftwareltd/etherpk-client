<script lang="ts" module>
    import type { GraphRecord } from "$lib/storage";
    import type { PendingInvite } from "$lib/sync/sync-api";
    import type { SyncedGraphView, SyncedMember } from "./graph-picker-helpers";

    /** What a server's group asks the Graphs page to do; the page owns every action. */
    export interface SyncServerGroupActions {
        open(record: GraphRecord): void;
        add(view: SyncedGraphView): void;
        rename(record: GraphRecord): void;
        settings(record: GraphRecord): void;
        forget(record: GraphRecord): void;
        invite(view: SyncedGraphView, record: GraphRecord | null): void;
        transfer(view: SyncedGraphView): void;
        delete(view: SyncedGraphView): void;
        leave(view: SyncedGraphView): void;
        cancelInvite(view: SyncedGraphView, member: SyncedMember): void;
        /** Compare a member's Security Fingerprint and pin it (ADR 0126). */
        verifyMember(view: SyncedGraphView, member: SyncedMember): void;
        /** Remove a Player the owner has confirmed removing, then give the graph a new key (ADR 0127). */
        removeMember(view: SyncedGraphView, member: SyncedMember): void;
        /** Give an owned graph a new key now (ADR 0127). */
        rotateKey(view: SyncedGraphView): void;
        /** Compare the owner's new fingerprint, so the key copy they signed with it can be used. */
        verifyOwner(view: SyncedGraphView): void;
        acceptInvite(invite: PendingInvite): void;
        declineInvite(invite: PendingInvite): void;
        /** Ask to decline (an id), or step back from it (null). */
        beginDecline(inviteId: string | null): void;
        signIn(): void;
        reconnect(): void;
        retry(): void;
        /** Ask for this device's passcode, which protects the server's access token (ADR 0129). */
        enterPasscode(): void;
        /** Open this server's sub-tab on the Sync tab: its account, plan and keys. */
        showSettings(): void;
        /** Unlock this server's Encryption Keys on this device, as the Sync tab does. */
        unlock(): void;
    }
</script>

<script lang="ts">
    /**
     * One Sync Server's synced graphs on the Graphs tab (ADR 0111): headed by the server, with its
     * account, what its plan says, its pending invites and a row per graph. Every server a device is
     * connected to gets a group of its own, so which server a graph is on never needs asking.
     */
    import {
        PLAN_NOTICE_TEXT,
        formatBytes,
    } from "@appsoftwareltd/etherpk-shared";
    import SyncPlusOffer from "@appsoftwareltd/etherpk-shared/sync-plus-offer";
    import SyncedGraphRow from "./SyncedGraphRow.svelte";
    import { keyCopyNotice } from "./graph-picker-helpers";
    import {
        CUSTOM_SERVER_ICON,
        MANAGED_SERVER_ICON,
    } from "./graphs-page-icons";
    import type { SyncServerView } from "./sync-server-view.svelte";

    let {
        server,
        planNoticeId,
        records,
        interruptedGraphIds,
        rowMessage,
        discardChecking,
        withdrawingInvite,
        removingMember,
        checkingInvite,
        decliningInvite,
        corporateBillingUrl,
        corporatePricingUrl,
        showPending,
        actions,
    }: {
        server: SyncServerView;
        /** The plan line's id, so the page's New synced graph button can point at it. */
        planNoticeId: string;
        /** This device's records of graphs on this server. */
        records: GraphRecord[];
        /** Graphs an import was cut off partway through. */
        interruptedGraphIds: ReadonlySet<string>;
        rowMessage: Record<string, { text: string; tone: "info" | "error" }>;
        discardChecking: string | null;
        withdrawingInvite: string | null;
        /** The member whose removal is in flight. */
        removingMember: string | null;
        checkingInvite: string | null;
        decliningInvite: string | null;
        corporateBillingUrl: string | null;
        /** Corporate's pricing page, where a Free account's offer leads. */
        corporatePricingUrl: string | null;
        /** A plan being confirmed has taken long enough to say so (delayed, so a fast answer never flashes it). */
        showPending: boolean;
        actions: SyncServerGroupActions;
    } = $props();

    const headingId = $props.id();
    const managed = $derived(server.connection.kind === "managed");

    /**
     * Signed in, with Encryption Keys on the server that are not unlocked on this device: every
     * graph's name is hidden and none opens, so the group says so first and offers the unlock.
     */
    const keysLocked = $derived(
        server.authState === "authenticated" &&
            server.vaultExists === true &&
            !server.vaultUnlocked,
    );

    /**
     * One row per graph. While the server's list is to hand the rows are its memberships, each
     * joined to this device's copy; while it is not (offline, or the list failed) they are the
     * copies this device holds for this server. None before the first account check answers, which
     * may yet say the account changed, and none while signed out, when the copies are hidden.
     */
    const rows = $derived.by(() => {
        if (
            server.authState === "signed-out" ||
            (!server.checked && !server.listed)
        )
            return [];
        if (server.listed) {
            return server.graphs.map((view) => ({
                id: view.id,
                view: view as SyncedGraphView | null,
                record: records.find((record) => record.id === view.id) ?? null,
            }));
        }
        return records.map((record) => ({
            id: record.id,
            view: null as SyncedGraphView | null,
            record,
        }));
    });

    /** Who is signed in here, or why nobody is, beside the kind of server. */
    const accountLine = $derived.by(() => {
        const kind = managed ? "Managed Sync" : "Custom server";
        switch (server.authState) {
            case "authenticated":
                return `${kind} · signed in as ${server.accountLabel}`;
            case "signed-out":
                return `${kind} · signed out`;
            case "unavailable":
                return `${kind} · could not be reached`;
            case "locked":
                return `${kind} · needs this device's passcode`;
            default:
                return `${kind} · checking…`;
        }
    });

    /**
     * Why a row carries the id placeholder rather than a name: the keys are locked here; the graph
     * is being read; it has no name at all; the relay did not answer; or this account holds no key
     * for it (ADR 0031, amended). The line must never read as a key failure: "Encrypted name" once
     * sent a user towards Reset (2026-09-01).
     */
    function nameNoteFor(view: SyncedGraphView): string | null {
        if (view.onDevice || view.nameSource !== "placeholder") return null;
        if (!server.vaultUnlocked)
            return "Unlock Encryption Keys on this device to see its name.";
        switch (server.nameReads[view.id]) {
            case "reading":
                return "Reading its name from the graph…";
            case "unnamed":
                return "This graph has no name yet. Add it to this device and open it to give it one.";
            case "unreachable":
                return "Its name could not be read: the sync server's relay did not answer. It appears once any member opens the graph, or once you add it here.";
            default:
                return "This account holds no key for this graph yet, so its name cannot be read here.";
        }
    }

    const dayFormat = new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
    });
    const SECONDARY_BUTTON =
        "inline-flex items-center justify-center rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 pointer-coarse:min-h-11 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-white/5";
    const PRIMARY_BUTTON =
        "inline-flex items-center justify-center rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 pointer-coarse:min-h-11 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200";
</script>

<section
    data-testid="synced-graphs"
    data-origin={server.origin}
    aria-labelledby={headingId}
    class="space-y-3"
>
    <div class="min-w-0">
        <h2
            id={headingId}
            class="flex items-center gap-2 text-lg font-semibold text-gray-950 dark:text-white"
        >
            <span class="min-w-0 truncate"
                >Synced graphs on {server.host}</span
            >
            <svg
                class="h-5 w-5 shrink-0 text-gray-500 dark:text-gray-400"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                aria-hidden="true"
            >
                <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d={managed ? MANAGED_SERVER_ICON : CUSTOM_SERVER_ICON}
                />
            </svg>
        </h2>
        <p
            class="mt-1 text-sm text-gray-500 dark:text-gray-400"
            data-testid="synced-graphs-account"
        >
            {accountLine}
        </p>
    </div>

    {#if keysLocked}
        <div
            data-testid="synced-graphs-keys-locked"
            class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-900/15 bg-white p-4 dark:border-gray-100/20 dark:bg-white/5"
        >
            <p class="text-sm text-gray-700 dark:text-gray-200">
                Unlock Encryption Keys for the synced graphs or go to the <button
                    type="button"
                    onclick={actions.showSettings}
                    class="font-medium text-gray-950 underline underline-offset-2 hover:no-underline dark:text-white"
                    >Sync tab</button
                > for more options.
            </p>
            <button type="button" onclick={actions.unlock} class={PRIMARY_BUTTON}
                >Unlock Encryption Keys</button
            >
        </div>
    {/if}

    <!-- What stands between this account and a new graph here, or a payment to fix. The Sync tab's
         account section carries the whole notice. -->
    {#if server.showsPlanLine && server.shownPlanNotice === "upsell"}
        <!-- Free: the offer every origin makes to a Free account. It also describes the disabled
             New synced graph button, which points here. -->
        <div id={planNoticeId} data-testid="graphs-plan-notice" data-kind="upsell">
            <SyncPlusOffer pricingUrl={corporatePricingUrl} />
        </div>
    {:else if server.showsPlanLine}
        <div
            id={planNoticeId}
            data-testid="graphs-plan-notice"
            data-kind={server.shownPlanNotice ?? "none"}
            class="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 text-sm {server.shownPlanNotice ===
            'pending'
                ? 'text-gray-600 dark:text-gray-300'
                : 'text-amber-800 dark:text-amber-200'}"
        >
            {#if server.shownPlanNotice === "pending"}
                <!-- Held open from the first paint so nothing moves when the words arrive. -->
                {#if showPending}
                    <span class="flex items-center gap-2" role="status">
                        <svg
                            class="h-4 w-4 text-gray-500 motion-safe:animate-spin dark:text-gray-400"
                            viewBox="0 0 24 24"
                            fill="none"
                            aria-hidden="true"
                        >
                            <circle
                                cx="12"
                                cy="12"
                                r="10"
                                stroke="currentColor"
                                stroke-width="3"
                                stroke-opacity="0.25"
                            />
                            <path
                                fill="currentColor"
                                d="M4 12a8 8 0 0 1 8-8v3a5 5 0 0 0-5 5H4z"
                            />
                        </svg>
                        {PLAN_NOTICE_TEXT.pending}
                    </span>
                {/if}
            {:else if server.shownPlanNotice === "payment_failed" || server.shownPlanNotice === "payment_overdue"}
                <span
                    >{server.shownPlanNotice === "payment_failed"
                        ? "Your last Sync+ payment failed."
                        : "A Sync+ payment is overdue, so the graphs you own are read-only."}</span
                >
                {#if corporateBillingUrl}
                    <a
                        href={corporateBillingUrl}
                        data-sveltekit-reload
                        class="font-medium underline underline-offset-2"
                        >Fix payment</a
                    >
                {/if}
            {:else}
                <span>{server.createBlockedReason}</span>
                {#if server.syncPlusRequired && corporateBillingUrl}
                    <a
                        href={corporateBillingUrl}
                        data-sveltekit-reload
                        class="font-medium underline underline-offset-2"
                        >Restart Sync+</a
                    >
                {:else}
                    <button
                        type="button"
                        onclick={actions.showSettings}
                        class="font-medium underline underline-offset-2"
                        >Details on the Sync tab</button
                    >
                {/if}
            {/if}
        </div>
    {/if}

    {#if server.invites.length > 0}
        <div
            data-testid="graphs-invites"
            class="rounded-xl border border-gray-900/15 bg-white p-4 dark:border-gray-100/20 dark:bg-white/5"
        >
            <!-- An invite is often what brings a new account here, so it shows on a first visit too. -->
            <h3 class="text-sm font-semibold text-gray-950 dark:text-white">
                Pending invites
            </h3>
            <ul class="mt-3 space-y-2">
                {#each server.invites as invite (invite.id)}
                    {@const graphName = server.inviteNames[invite.id]}
                    {@const sender = invite.inviterEmail ?? "Someone"}
                    <li
                        data-testid="invite-row"
                        class="flex flex-wrap items-center justify-between gap-3"
                    >
                        <p
                            class="min-w-0 text-sm text-gray-700 dark:text-gray-300"
                        >
                            <span
                                class="break-all font-medium text-gray-950 dark:text-white"
                                >{sender}</span
                            >
                            invited you to
                            {#if graphName}<span
                                    class="font-medium text-gray-950 dark:text-white"
                                    >{graphName}</span
                                >{:else}a shared graph{/if}{#if invite.createdAt}<span
                                    class="text-gray-500 dark:text-gray-400"
                                    >, {dayFormat.format(
                                        new Date(invite.createdAt),
                                    )}</span
                                >{/if}.
                        </p>
                        {#if decliningInvite === invite.id}
                            <!-- Declining cannot be undone from this side: the owner would have to invite
                                 again, so it asks once, here, rather than in a dialog. -->
                            <div
                                class="flex flex-wrap items-center gap-2"
                                data-testid="invite-decline-confirmation"
                            >
                                <span
                                    class="text-sm text-gray-600 dark:text-gray-400"
                                    >Decline? {sender === "Someone"
                                        ? "The owner"
                                        : sender} would have to invite you again.</span
                                >
                                <button
                                    data-testid="invite-decline-confirm"
                                    disabled={withdrawingInvite === invite.id}
                                    onclick={() =>
                                        actions.declineInvite(invite)}
                                    class="shrink-0 rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:cursor-progress dark:border-red-500/40 dark:hover:bg-red-950/30"
                                    >{withdrawingInvite === invite.id
                                        ? "Declining…"
                                        : "Decline"}</button
                                >
                                <button
                                    data-testid="invite-decline-keep"
                                    onclick={() => actions.beginDecline(null)}
                                    class={SECONDARY_BUTTON}>Keep</button
                                >
                            </div>
                        {:else}
                            <div class="flex shrink-0 gap-2">
                                <button
                                    data-testid="invite-decline"
                                    onclick={() =>
                                        actions.beginDecline(invite.id)}
                                    class={SECONDARY_BUTTON}>Decline</button
                                >
                                <button
                                    data-testid="invite-accept"
                                    onclick={() => actions.acceptInvite(invite)}
                                    aria-busy={checkingInvite === invite.id}
                                    class="rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200"
                                    >{checkingInvite === invite.id
                                        ? "Checking…"
                                        : "Accept"}</button
                                >
                            </div>
                        {/if}
                    </li>
                {/each}
            </ul>
        </div>
    {/if}

    {#if server.authState === "signed-out"}
        <div
            data-testid="synced-graphs-signed-out"
            class="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-white/10 dark:bg-white/5"
        >
            <p class="text-sm font-medium text-gray-900 dark:text-gray-100">
                {managed
                    ? `You are signed out of ${server.host}.`
                    : `${server.host} did not accept this device's access token.`}
            </p>
            <p
                class="mt-1 text-sm text-gray-700 dark:text-gray-300"
                data-testid="graphs-hidden"
            >
                {managed
                    ? "Your synced graphs there are hidden until you sign in. Local folder graphs are not affected."
                    : "It may have been revoked or have expired. Synced graphs from this server are hidden until you add a new token."}
            </p>
            {#if managed}
                <button
                    type="button"
                    data-testid="sync-sign-in"
                    onclick={actions.signIn}
                    class="mt-3 rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200"
                    >Sign in</button
                >
            {:else}
                <button
                    type="button"
                    data-testid="sync-reconnect"
                    onclick={actions.reconnect}
                    class="mt-3 {SECONDARY_BUTTON}"
                    >Add a new access token</button
                >
            {/if}
        </div>
    {:else if server.error}
        <div
            role="alert"
            class="flex flex-wrap items-center gap-3"
            data-testid="synced-graphs-error"
        >
            <p class="text-sm text-red-600 dark:text-red-400">{server.error}</p>
            <button
                type="button"
                onclick={actions.retry}
                disabled={server.loading}
                class="{SECONDARY_BUTTON} disabled:cursor-progress"
                >{server.loading ? "Trying again…" : "Try again"}</button
            >
        </div>
    {:else if server.authState === "locked"}
        <div
            class="flex flex-wrap items-center gap-3"
            data-testid="synced-graphs-locked"
        >
            <p class="min-w-0 flex-1 text-sm text-gray-600 dark:text-gray-400">
                The access token for {server.host} is protected by this device's
                passcode. The graphs this device holds for it are listed here.
                Enter the passcode to see the rest.
            </p>
            <button
                type="button"
                data-testid="sync-enter-passcode"
                onclick={actions.enterPasscode}
                class={SECONDARY_BUTTON}>Enter passcode</button
            >
        </div>
    {:else if server.authState === "unavailable"}
        <div
            class="flex flex-wrap items-center gap-3"
            data-testid="synced-graphs-unavailable"
        >
            <p
                class="min-w-0 flex-1 text-sm text-amber-800 dark:text-amber-200"
            >
                Could not reach {server.host}. The graphs this device holds for
                it are listed here - they open, and the rest of the list comes
                back, when the server responds.
            </p>
            <button
                type="button"
                onclick={actions.retry}
                class={SECONDARY_BUTTON}>Try again</button
            >
        </div>
    {/if}

    {#if rows.length > 0}
        <ul
            data-testid="synced-graphs-list"
            class="divide-y divide-gray-200 overflow-hidden rounded-xl border border-gray-200 bg-white dark:divide-white/10 dark:border-white/10 dark:bg-white/5"
        >
            {#each rows as row (row.id)}
                {@const view = row.view}
                {@const record = row.record}
                <SyncedGraphRow
                    graphId={row.id}
                    name={record?.name ?? view?.name ?? row.id}
                    role={view?.role ?? null}
                    onDevice={record !== null}
                    readOnly={view?.role === "owner" &&
                        !server.ownedGraphsWritable}
                    importInterrupted={interruptedGraphIds.has(row.id)}
                    storage={view?.storage ?? null}
                    nameNote={view ? nameNoteFor(view) : null}
                    members={view?.role === "owner" ? view.members : undefined}
                    message={rowMessage[row.id] ?? null}
                    canInvite={server.ownedGraphsWritable}
                    checking={discardChecking === row.id}
                    cancellingInvite={withdrawingInvite}
                    keyNotice={view?.role !== "owner" && server.keyCopies[row.id]
                        ? keyCopyNotice(server.keyCopies[row.id])
                        : null}
                    rotating={server.rotating.has(row.id)}
                    {removingMember}
                    onopen={() => record && actions.open(record)}
                    onadd={() => view && actions.add(view)}
                    onrename={() => record && actions.rename(record)}
                    onsettings={() => record && actions.settings(record)}
                    onforget={() => record && actions.forget(record)}
                    oninvite={() => view && actions.invite(view, record)}
                    ontransfer={() => view && actions.transfer(view)}
                    ondelete={() => view && actions.delete(view)}
                    onleave={() => view && actions.leave(view)}
                    oncancelinvite={(member) =>
                        view && actions.cancelInvite(view, member)}
                    onverify={(member) =>
                        view && actions.verifyMember(view, member)}
                    onremovemember={(member) =>
                        view && actions.removeMember(view, member)}
                    onrotate={() => view && actions.rotateKey(view)}
                    onverifyowner={() => view && actions.verifyOwner(view)}
                />
            {/each}
        </ul>
    {:else if (!server.checked || server.authState === "checking" || server.loading) && !server.error}
        <!-- First load only: later refreshes keep the rows in place while data renews. -->
        <p
            class="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400"
            data-testid="synced-graphs-loading"
        >
            <svg
                class="h-4 w-4 text-gray-500 motion-safe:animate-spin dark:text-gray-400"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
            >
                <circle
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    stroke-width="3"
                    stroke-opacity="0.25"
                />
                <path
                    fill="currentColor"
                    d="M4 12a8 8 0 0 1 8-8v3a5 5 0 0 0-5 5H4z"
                />
            </svg>
            Loading synced graphs…
        </p>
    {:else if server.listed}
        <p
            class="text-sm text-gray-500 dark:text-gray-400"
            data-testid="synced-graphs-empty"
        >
            No synced graphs on {server.host} yet.
        </p>
    {/if}

    {#if server.ownedStorage && server.ownedStorage.graphs > 0}
        <p
            class="text-sm text-gray-500 dark:text-gray-400"
            data-testid="synced-owned-storage"
        >
            Graphs you own use {formatBytes(
                server.ownedStorage.docBytes + server.ownedStorage.assetBytes,
            )} on {server.host}
            ({formatBytes(server.ownedStorage.docBytes)} notes · {formatBytes(
                server.ownedStorage.assetBytes,
            )} assets across
            {server.ownedStorage.graphs}
            {server.ownedStorage.graphs === 1 ? "graph" : "graphs"}).
        </p>
    {/if}
</section>
