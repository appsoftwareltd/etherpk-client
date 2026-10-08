<script lang="ts">
    /**
     * Account Reset (ADR 0029): the "burn it down" flow. Shows exactly what will be lost — owned
     * graphs, split into shared (offer transfer to a player to preserve them) and solo (deleted).
     * A type-to-confirm gate guards the irreversible final step.
     *
     * On a custom server the final step happens on the server's own Reset Encryption Keys page
     * (ADR 0133): the reset route accepts no access token, which is all this device holds for it,
     * and needs a recent sign-in there. The dialog opens that page and watches for the vault to
     * go, then finishes the reset on this device as it would have after running it itself.
     */
    import { onDestroy } from "svelte";
    import { delayedFlag } from "@appsoftwareltd/etherpk-shared/delayed";
    import { createSyncApiFor, serverHost, syncConnectionFor, type SyncApi } from "$lib/sync";
    import { describeSyncFailure } from "$lib/sync/sync-error-copy";
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";
    import TransferOwnershipDialog from "./TransferOwnershipDialog.svelte";

    let {
        serverOrigin,
        onclose,
        oncomplete,
    }: {
        /** The Sync Server whose account is reset: only its keys and graphs are touched (ADR 0111). */
        serverOrigin: string;
        onclose: () => void;
        oncomplete: () => void;
    } = $props();

    interface Member {
        userId: string;
        email: string;
        role: string;
    }
    interface OwnedGraph {
        graphId: string;
        otherMembers: Member[];
        solo: boolean;
    }

    let open = $state(true);
    let step = $state<"review" | "confirm" | "portal" | "done">("review");
    /**
     * On the portal step: whether the account had a vault when the step began. Only then can the
     * dialog tell the reset happened (the vault is gone); without one it waits to be closed.
     */
    let portalWatchesVault = $state(false);
    let portalCheckError = $state<string | null>(null);
    /** Asking whether the account has a vault before handing over: a moment, not the reset itself. */
    let checkingVault = $state(false);
    let loading = $state(true);
    let error = $state<string | null>(null);
    let owned = $state<OwnedGraph[]>([]);
    let confirmText = $state("");
    let busy = $state(false);
    /** The preview could not be read, so nothing here can be trusted to describe the damage. */
    let previewFailed = $state(false);
    /** Shown only if the preview is genuinely slow; a 20ms flash reads as a glitch (rule 2). */
    const showLoading = delayedFlag(() => loading);
    let summary = $state<{
        ownedGraphsDeleted: number;
        membershipsDropped: number;
        /** Absent from a server older than agent tokens. */
        agentTokensRevoked?: number;
    } | null>(null);
    let transferFor = $state<OwnedGraph | null>(null);

    // Fixed for the dialog's life: resetting is about one server's account from start to finish.
    // svelte-ignore state_referenced_locally
    const host = serverHost(serverOrigin);
    // svelte-ignore state_referenced_locally
    const api: SyncApi | null = createSyncApiFor(serverOrigin);
    // svelte-ignore state_referenced_locally
    const resetsOnPortal = syncConnectionFor(serverOrigin)?.kind === "custom";
    // svelte-ignore state_referenced_locally
    const portalResetUrl = `${serverOrigin.replace(/\/$/, "")}/account/reset-keys`;

    const shared = $derived(owned.filter((g) => !g.solo));
    const solo = $derived(owned.filter((g) => g.solo));
    /** Every graph still owned when the reset runs is deleted - transfers on the review step shrink this. */
    const deleting = $derived(owned.length);
    /**
     * The phrase names the damage rather than the action, so the user types the number of
     * graphs about to be destroyed and cannot confirm on autopilot. With nothing left to delete
     * (no owned graphs, or all of them transferred) the only loss is the keys, and the phrase
     * says that instead.
     */
    const confirmPhrase = $derived(
        deleting === 0
            ? "RESET MY ENCRYPTION KEYS"
            : `DELETE ${deleting} GRAPH${deleting === 1 ? "" : "S"}`,
    );
    const confirmed = $derived(confirmText.trim() === confirmPhrase);

    async function load() {
        if (!api) {
            error = `This device is not connected to ${host}.`;
            previewFailed = true;
            loading = false;
            return;
        }
        error = null;
        previewFailed = false;
        loading = true;
        try {
            owned = await api.resetPreview();
        } catch (e) {
            // A failed preview leaves `owned` empty, and an empty list renders as the
            // reassuring "0 graphs will be permanently deleted". Reset is irreversible, so
            // the flow stops here rather than proceeding on a list it could not read.
            error = describeSyncFailure(e, "check what this would delete");
            previewFailed = true;
        } finally {
            loading = false;
        }
    }
    void load();

    async function execute() {
        // Enter reaches this from any step, and `confirmText` survives a Back to the review
        // step, so the step itself has to be part of the guard: pressing Enter while reading
        // the review must never run an irreversible reset.
        if (!api || busy || step !== "confirm" || !confirmed) return;
        busy = true;
        error = null;
        try {
            summary = await api.resetAccount();
            step = "done";
        } catch (e) {
            error = describeSyncFailure(e, "reset your Encryption Keys");
        } finally {
            busy = false;
        }
    }

    /** Review done on a custom server: hand the reset to its portal and start watching for it. */
    async function continueOnPortal() {
        if (!api || checkingVault) return;
        checkingVault = true;
        error = null;
        try {
            portalWatchesVault = (await api.getVault()) !== null;
            step = "portal";
            if (portalWatchesVault) watchForPortalReset(api);
        } catch (e) {
            error = describeSyncFailure(e, "check your Encryption Keys on the server");
        } finally {
            checkingVault = false;
        }
    }

    /**
     * While the portal step shows, look every few seconds, and at once when this window gets the
     * focus back, for the vault to be gone: the reset ran on the portal. A failed look says so and
     * keeps looking; the reset itself is not this device's to retry.
     */
    let stopWatching: (() => void) | null = null;
    function watchForPortalReset(watched: SyncApi) {
        stopWatchingForPortalReset();
        let stopped = false;
        const check = async () => {
            try {
                const vault = await watched.getVault();
                if (stopped || vault !== null) {
                    if (!stopped) portalCheckError = null;
                    return;
                }
                // A 404 for the vault could be a proxy's, not the server's. A reset also leaves
                // the account owning nothing, so ask that too before forgetting this server's
                // graphs on the device.
                const owned = await watched.resetPreview();
                if (stopped) return;
                portalCheckError = null;
                if (owned.length === 0) {
                    stopWatchingForPortalReset();
                    step = "done";
                }
            } catch (e) {
                if (!stopped) portalCheckError = describeSyncFailure(e, "check whether the reset is done");
            }
        };
        const timer = setInterval(check, 3000);
        const onFocus = () => void check();
        window.addEventListener("focus", onFocus);
        stopWatching = () => {
            stopped = true;
            clearInterval(timer);
            window.removeEventListener("focus", onFocus);
        };
    }
    function stopWatchingForPortalReset() {
        stopWatching?.();
        stopWatching = null;
    }
    onDestroy(stopWatchingForPortalReset);

    function close(done = false) {
        stopWatchingForPortalReset();
        open = false;
        if (done) oncomplete();
        else onclose();
    }
</script>

<Modal
    {open}
    title={`Reset Encryption Keys on ${host}`}
    {busy}
    busyReason="Resetting…"
    onclose={() => close()}
    onsubmit={execute}
>
    {#snippet body()}
        {#if loading}
            <!-- Nothing else while loading: an empty `owned` renders as the reassuring
                 "0 graphs will be permanently deleted", which is the C5 failure in miniature. -->
            {#if showLoading.current}
                <p
                    role="status"
                    class="text-sm text-gray-500 dark:text-gray-400"
                >
                    Loading your graphs…
                </p>
            {/if}
        {:else if previewFailed && step === "review"}
            <div
                role="alert"
                data-testid="reset-preview-failed"
                class="rounded-lg border border-red-200 dark:border-red-500/40 bg-red-50 dark:bg-red-950/20 p-3"
            >
                <p class="text-sm font-medium text-red-700 dark:text-red-300">
                    Could not check what this would delete.
                </p>
                <p class="mt-1 text-sm text-red-700/80 dark:text-red-300/80">
                    {error}
                </p>
                <p class="mt-1 text-sm text-red-700/80 dark:text-red-300/80">
                    Resetting without that list could destroy graphs you did not
                    expect, so it is blocked until the check succeeds.
                </p>
            </div>
        {:else if step === "review"}
            <p class="text-sm text-gray-600 dark:text-gray-400">
                Resetting deletes your Encryption Keys, and creating new ones
                afterwards gives you a new identity and Recovery Code. Everything below that you
                own will be affected. Graphs you only take part in as a player
                are not touched, you simply leave them. Every agent is signed out,
                and logs in again with a new setup code.
            </p>

            {#if shared.length > 0}
                <div
                    class="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-3"
                >
                    <p
                        class="text-sm font-medium text-gray-950 dark:text-white"
                    >
                        Shared graphs you own
                    </p>
                    <p class="text-sm text-gray-500 dark:text-gray-400">
                        Hand each to a player to keep it alive. They can share
                        it back to your new identity later.
                    </p>
                    {#each shared as g (g.graphId)}
                        <div class="flex items-center justify-between gap-2">
                            <span
                                class="text-sm font-mono text-gray-500 dark:text-gray-400 truncate"
                                >{g.graphId.slice(0, 8)}…</span
                            >
                            <button
                                type="button"
                                data-testid="reset-transfer-{g.graphId}"
                                class="rounded-md border border-gray-300 dark:border-gray-700 px-2 py-1 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                                onclick={() => (transferFor = g)}
                                >Transfer…</button
                            >
                        </div>
                    {/each}
                </div>
            {/if}

            <div
                class="rounded-lg border border-red-200 dark:border-red-500/40 bg-red-50 dark:bg-red-950/20 p-3"
            >
                <p class="text-sm font-medium text-red-700 dark:text-red-300">
                    {solo.length} graph{solo.length === 1 ? "" : "s"} will be permanently
                    deleted.
                </p>
                <p class="mt-1 text-sm text-red-700/80 dark:text-red-300/80">
                    These are yours alone. No one else holds their Graph Keys, so
                    they cannot be recovered.
                </p>
            </div>
        {:else if step === "confirm"}
            <p class="text-sm text-gray-600 dark:text-gray-400">
                {#if deleting === 0}
                    This resets your Encryption Keys. You own no graphs, so nothing is
                    deleted. It cannot be undone.
                {:else}
                    This permanently deletes {deleting} graph{deleting === 1
                        ? ""
                        : "s"} you still own and resets your Encryption Keys. It cannot be undone.
                {/if}
            </p>
            <div>
                <label
                    for="reset-confirm"
                    class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400"
                >
                    Type <span
                        data-testid="reset-confirm-phrase"
                        class="font-semibold text-gray-700 dark:text-gray-300"
                        >{confirmPhrase}</span
                    > to confirm
                </label>
                <input
                    id="reset-confirm"
                    data-testid="reset-confirm-input"
                    bind:value={confirmText}
                    autocomplete="off"
                    autocapitalize="characters"
                    spellcheck="false"
                    class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100"
                />
            </div>
        {:else if step === "portal"}
            <p class="text-sm text-gray-600 dark:text-gray-400">
                {host} needs you to sign in to it again before a reset, so the last
                step is on its own page. Open it, sign in if it asks, and type the
                phrase it shows.
            </p>
            <a
                href={portalResetUrl}
                target="_blank"
                rel="noopener"
                data-testid="reset-open-portal"
                class="inline-flex min-h-11 items-center rounded-lg bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700"
                >Open the reset page on {host}</a
            >
            {#if portalWatchesVault}
                <p role="status" class="text-sm text-gray-600 dark:text-gray-400" data-testid="reset-portal-waiting">
                    This dialog finishes by itself once the reset is done.
                </p>
            {:else}
                <p class="text-sm text-gray-600 dark:text-gray-400">
                    This account has no Encryption Keys on {host} yet, so this dialog
                    cannot tell when the reset is done. Close it when you have finished.
                </p>
            {/if}
            {#if portalCheckError}
                <p role="alert" class="text-sm text-red-600">{portalCheckError}</p>
            {/if}
        {:else if step === "done"}
            <p class="text-sm text-gray-600 dark:text-gray-400" data-testid="reset-summary">
                {#if summary}
                    Your Encryption Keys have been reset. {summary.ownedGraphsDeleted} owned
                    graph{summary.ownedGraphsDeleted === 1 ? "" : "s"}
                    deleted.
                    {#if summary.agentTokensRevoked}
                        {summary.agentTokensRevoked} agent{summary.agentTokensRevoked === 1 ? " was" : "s were"}
                        signed out.
                    {/if}
                {:else}
                    Your Encryption Keys on {host} have been reset.
                {/if}
                Create a new synced graph to start fresh with a new Recovery Code.
            </p>
        {/if}
        <!-- The review step renders its own failure panel above; this is the in-flight case. -->
        {#if error && !previewFailed}<p
                role="alert"
                class="text-sm text-red-600"
                data-testid="reset-error"
            >
                {error}
            </p>{/if}
    {/snippet}

    {#snippet footer()}
        {#if step === "review"}
            <button
                type="button"
                onclick={() => close()}
                class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                >Cancel</button
            >
            {#if previewFailed}
                <button
                    type="button"
                    onclick={() => void load()}
                    data-testid="reset-preview-retry"
                    class="min-w-32 rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-center text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200"
                    >Try again</button
                >
            {:else}
                <button
                    type="button"
                    onclick={() => (resetsOnPortal ? void continueOnPortal() : (step = "confirm"))}
                    disabled={loading || checkingVault}
                    data-testid="reset-continue"
                    class="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40"
                    >Continue to reset</button
                >
            {/if}
        {:else if step === "confirm"}
            <button
                type="button"
                onclick={() => (step = "review")}
                class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                >Back</button
            >
            <button
                type="submit"
                disabled={busy || !confirmed}
                data-testid="reset-execute"
                class="min-w-44 rounded-lg bg-red-600 px-4 py-1.5 text-center text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >{busy ? "Resetting…" : "Permanently reset"}</button
            >
        {:else if step === "portal"}
            <button
                type="button"
                onclick={() => {
                    stopWatchingForPortalReset();
                    step = "review";
                }}
                class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                >Back</button
            >
            <button
                type="button"
                onclick={() => close()}
                class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                >Close</button
            >
        {:else}
            <button
                type="button"
                onclick={() => close(true)}
                data-testid="reset-done"
                class="rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200"
                >Done</button
            >
        {/if}
    {/snippet}
</Modal>

{#if transferFor && api}
    <TransferOwnershipDialog
        {api}
        graphId={transferFor.graphId}
        candidates={transferFor.otherMembers}
        onclose={(result) => {
            if (result)
                owned = owned.filter((g) => g.graphId !== transferFor!.graphId); // handed off; no longer owned
            transferFor = null;
        }}
    />
{/if}
