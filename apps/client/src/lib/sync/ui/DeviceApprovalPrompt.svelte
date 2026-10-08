<script lang="ts">
    /**
     * The approver half of device approval (ADR 0125), hosted once in the app shell.
     *
     * For every Sync Server whose keys this device holds unlocked (ADR 0111), it polls for new
     * requests from that account's OTHER devices. The first time it sees one it answers at once
     * with a one-time key of its own, which makes this the device that handles the request, and
     * shows the prompt. The code appears once the new device reveals its key, which this device
     * checks against the commitment the request carried. The user compares it with the code on the
     * new device's screen - a mismatch means a key was substituted in transit - and on approve the
     * vault key travels encrypted so that only the new device can open it. Rejecting, or closing the
     * prompt, ends the request for good: this device holds it, so no other device could approve it.
     */
    import {
        answerDeviceApproval,
        approveDevice,
        createSyncApiFor,
        getVaultWrapKey,
        listSyncConnections,
        readApproverExchange,
        rejectDeviceApproval,
        serverHost,
        setVaultWrapKey,
        SyncApiError,
        SYNC_CONNECTIONS_CHANGED_EVENT,
        SYNC_CONNECTIONS_STORAGE_KEY,
        type ApproverSession,
        type PendingDeviceApproval,
    } from "$lib/sync";
    import { untrack } from "svelte";
    import { announceAccountSignal } from "$lib/sync/account-signal";
    import { describeSyncFailure } from "$lib/sync/sync-error-copy";
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";

    /** How often to look for new requests, and how often to look for the reveal of one being handled. */
    const IDLE_POLL_MS = 10_000;
    const ACTIVE_POLL_MS = 1_000;

    interface Prompt {
        origin: string;
        approvalId: string;
        /** This device's side of the exchange, or null when another device answered first. */
        session: ApproverSession | null;
        /** The code to compare, once the new device has revealed a key matching its commitment. */
        sas: string | null;
    }

    let current = $state<Prompt | null>(null);
    let open = $state(false);
    let busy = $state(false);
    let error = $state<string | null>(null);
    /** The new device's reveal did not match its commitment: only Reject is offered. */
    let tampered = $state(false);
    // The request on screen replaced one that was withdrawn, so its code is new.
    let replaced = $state(false);
    // Requests the user closed without deciding - never asked about again this session.
    const dismissed = new Set<string>();
    /**
     * Servers that refused this device's credential (401). Polling them stops until the
     * connections change, rather than asking every ten seconds for an answer that cannot change;
     * the account menu is asked to re-check, and says the device is signed out.
     */
    const refused = new Set<string>();
    let lastIdlePoll = 0;
    let checking = false;

    function connectionChanged(): void {
        refused.clear();
    }

    function storageChanged(event: StorageEvent): void {
        if (event.key === SYNC_CONNECTIONS_STORAGE_KEY || event.key === null) connectionChanged();
    }

    /** Live requests on one server, newest first; null when it could not be asked. */
    async function listedOn(origin: string): Promise<PendingDeviceApproval[] | null> {
        const api = createSyncApiFor(origin);
        // Locked keys can approve nothing, so a server whose vault is locked here is not asked.
        if (!api || !getVaultWrapKey(origin) || refused.has(origin)) return null;
        try {
            return await api.listDeviceApprovals();
        } catch (e) {
            if (e instanceof SyncApiError && e.status === 401) {
                refused.add(origin);
                announceAccountSignal({ type: "check" });
            }
            // Otherwise the server is unreachable: stay quiet; the next tick retries.
            return null;
        }
    }

    function close() {
        open = false;
        current = null;
        replaced = false;
        tampered = false;
        error = null;
    }

    /**
     * Answer a request at once, which makes this the device that handles it, and show the prompt.
     * `replacing` says the new device withdrew an earlier request and asked again.
     */
    async function take(origin: string, next: PendingDeviceApproval, replacing: boolean): Promise<void> {
        const api = createSyncApiFor(origin);
        if (!api) return;
        let session: ApproverSession | "taken";
        try {
            session = await answerDeviceApproval(api, next);
        } catch {
            return; // unreachable or refused: the next tick asks again
        }
        if (current) return;
        replaced = replacing;
        current = { origin, approvalId: next.id, session: session === "taken" ? null : session, sas: null };
        error = null;
        tampered = false;
        open = true;
    }

    /** Follow the request on screen: its reveal, or its end. */
    async function follow(prompt: Prompt): Promise<void> {
        const listing = await listedOn(prompt.origin);
        if (listing === null || busy || current !== prompt) return; // unreachable this tick: keep the prompt
        const mine = listing.find((p) => p.id === prompt.approvalId);
        // Withdrawn, expired, or ended: its code matches nothing now. A device that withdrew its
        // request and asked again has a new one waiting, which this device takes straight away.
        if (!mine) {
            const next = prompt.session ? listing.find((p) => p.status === "pending" && !dismissed.has(p.id)) : undefined;
            close();
            if (next) await take(prompt.origin, next, true);
            return;
        }
        if (!prompt.session || prompt.sas || tampered) return;
        try {
            const exchange = await readApproverExchange(prompt.session, mine);
            if (exchange && current === prompt) current = { ...prompt, sas: exchange.sas };
        } catch (e) {
            tampered = true;
            error = describeSyncFailure(e, "check the new device");
        }
    }

    /** Look for a new request on every server, and answer the first one at once. */
    async function lookForRequests(): Promise<void> {
        const origins = listSyncConnections().map((connection) => connection.origin);
        for (const origin of origins) {
            const listing = await listedOn(origin);
            if (!listing || busy || current) continue;
            // Only a request no device has answered yet is this device's to take.
            const next = listing.find((p) => p.status === "pending" && !dismissed.has(p.id));
            if (!next) continue;
            await take(origin, next, false);
            if (current) return;
        }
    }

    async function tick() {
        if (busy || checking) return; // an approve or reject is in flight: leave the prompt as it is
        if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
        const prompt = current;
        // A request being handled is followed every second, until its code shows.
        const following = prompt !== null && prompt.session !== null && prompt.sas === null && !tampered;
        if (!following && Date.now() - lastIdlePoll < IDLE_POLL_MS) return;
        checking = true;
        try {
            if (prompt) await follow(prompt);
            else await lookForRequests();
            if (!following) lastIdlePoll = Date.now();
        } finally {
            checking = false;
        }
    }

    $effect(() => {
        // Untracked: the tick reads the prompt's state, which must not restart this timer.
        untrack(() => void tick());
        const timer = setInterval(() => void tick(), ACTIVE_POLL_MS);
        // Same-tab connection changes (the Graphs page saving a new token) end a refusal too.
        window.addEventListener(SYNC_CONNECTIONS_CHANGED_EVENT, connectionChanged);
        return () => {
            clearInterval(timer);
            window.removeEventListener(SYNC_CONNECTIONS_CHANGED_EVENT, connectionChanged);
        };
    });

    async function approve() {
        const prompt = current;
        if (!prompt?.session || !prompt.sas || tampered) return;
        const a = createSyncApiFor(prompt.origin);
        const heldKey = getVaultWrapKey(prompt.origin);
        if (!a || !heldKey) return;
        busy = true;
        error = null;
        try {
            // Returns the true vault key (minting it if the vault was legacy) - re-cache it.
            setVaultWrapKey(prompt.origin, await approveDevice(a, prompt.session, heldKey));
            close();
        } catch (e) {
            error = describeSyncFailure(e, "approve the device");
        } finally {
            busy = false;
        }
    }

    /** Reject the request. Closing the prompt does the same, since this device holds it. */
    async function reject() {
        const prompt = current;
        if (!prompt) return;
        dismissed.add(prompt.approvalId);
        const a = createSyncApiFor(prompt.origin);
        busy = true;
        try {
            if (a && prompt.session) await rejectDeviceApproval(a, prompt.approvalId);
        } catch {
            // The request ends by itself within ten minutes; nothing else can approve it meanwhile.
        } finally {
            busy = false;
            close();
        }
    }
</script>

<svelte:window onstorage={storageChanged} />

{#if current}
    <Modal {open} title="Approve a new device?" busy={busy} onclose={reject}>
        {#snippet body()}
            <div data-testid="device-approval-prompt" class="space-y-3">
                {#if !current?.session}
                    <p class="text-sm text-gray-600 dark:text-gray-400" data-testid="device-approval-taken">
                        A device signed in to your account on
                        <span class="font-medium text-gray-950 dark:text-gray-100">{serverHost(current?.origin ?? "")}</span>
                        asked for your Encryption Keys, and another of your devices is already handling the request.
                    </p>
                {:else}
                    <p class="text-sm text-gray-600 dark:text-gray-400">
                        A device signed in to your account on
                        <span class="font-medium text-gray-950 dark:text-gray-100" data-testid="device-approval-server">{serverHost(current?.origin ?? "")}</span>
                        is asking for your Encryption Keys there.
                        Approve <strong>only if you are setting that device up right now</strong> and
                        its screen shows this exact code:
                    </p>
                    {#if current?.sas}
                        <p class="text-center text-2xl font-mono font-semibold tracking-widest text-gray-950 dark:text-gray-100" data-testid="device-approval-sas">{current.sas}</p>
                    {:else if !tampered}
                        <p class="text-center text-sm text-gray-500 dark:text-gray-400" role="status" data-testid="device-approval-checking">Checking the new device…</p>
                    {/if}
                    <p role="status" class="text-sm text-gray-600 dark:text-gray-400" data-testid="device-approval-replaced">
                        {replaced ? "The device withdrew its earlier request and asked again with this new code." : ""}
                    </p>
                    <p class="text-sm text-gray-500 dark:text-gray-400">
                        A different code - or a request you are not expecting - means someone else is
                        trying to get in: reject it.
                    </p>
                {/if}
                {#if error}<p role="alert" class="text-sm text-red-600" data-testid="device-approval-error">{error}</p>{/if}
            </div>
        {/snippet}

        {#snippet footer()}
            {#if current?.session}
                <button
                    type="button"
                    onclick={reject}
                    disabled={busy}
                    data-testid="device-approval-reject"
                    class="rounded-lg border border-red-300 dark:border-red-500/40 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-40"
                >Reject</button>
                {#if !tampered}
                    <button
                        type="button"
                        onclick={approve}
                        disabled={busy || !current?.sas}
                        data-testid="device-approval-approve"
                        class="rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-40"
                    >{busy ? "Approving" : "Approve"}</button>
                {/if}
            {:else}
                <button
                    type="button"
                    onclick={close}
                    data-testid="device-approval-close"
                    class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                >Close</button>
            {/if}
        {/snippet}
    </Modal>
{/if}
