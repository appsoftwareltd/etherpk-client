<script lang="ts">
    /**
     * The approver half of device approval (ADR 0026 flows), hosted once in the app shell.
     * For every Sync Server whose keys this device holds unlocked (ADR 0111), it polls for pending
     * requests from that account's OTHER devices; when one appears it shows the SAS derived from
     * the key the server delivered, and names the server the request came through. The user compares it with the code on the new device's
     * screen - a mismatch means the key was substituted in transit - and on approve the
     * vault key travels sealed to that key. Rejecting kills the request for good.
     */
    import {
        approvalSas,
        approveDevice,
        createSyncApiFor,
        getVaultWrapKey,
        listSyncConnections,
        rejectDeviceApproval,
        serverHost,
        setVaultWrapKey,
        SyncApiError,
        SYNC_CONNECTIONS_CHANGED_EVENT,
        SYNC_CONNECTIONS_STORAGE_KEY,
        type PendingDeviceApproval,
    } from "$lib/sync";
    import { announceAccountSignal } from "$lib/sync/account-signal";
    import { describeSyncFailure } from "$lib/sync/sync-error-copy";
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";

    let current = $state<{ approval: PendingDeviceApproval; sas: string; origin: string } | null>(null);
    let open = $state(false);
    let busy = $state(false);
    let error = $state<string | null>(null);
    // The request on screen replaced one that was withdrawn, so its code is new.
    let replaced = $state(false);
    // Requests the user closed without deciding - do not nag about them again this session.
    const dismissed = new Set<string>();
    /**
     * Servers that refused this device's credential (401). Polling them stops until the
     * connections change, rather than asking every ten seconds for an answer that cannot change;
     * the account menu is asked to re-check, and says the device is signed out.
     */
    const refused = new Set<string>();

    function connectionChanged(): void {
        refused.clear();
    }

    function storageChanged(event: StorageEvent): void {
        if (event.key === SYNC_CONNECTIONS_STORAGE_KEY || event.key === null) connectionChanged();
    }

    /** Pending requests on one server, newest first; null when it could not be asked. */
    async function pendingOn(origin: string): Promise<PendingDeviceApproval[] | null> {
        const api = createSyncApiFor(origin);
        // Locked keys can approve nothing, so a server whose vault is locked here is not asked.
        if (!api || !getVaultWrapKey(origin) || refused.has(origin)) return null;
        try {
            return (await api.listDeviceApprovals()).filter((p) => !dismissed.has(p.id));
        } catch (e) {
            if (e instanceof SyncApiError && e.status === 401) {
                refused.add(origin);
                announceAccountSignal({ type: "check" });
            }
            // Otherwise the server is unreachable: stay quiet; the next tick retries.
            return null;
        }
    }

    async function check() {
        if (busy) return; // an approve or reject is in flight: leave the prompt as it is
        if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
        const origins = listSyncConnections().map((connection) => connection.origin);
        const answers = await Promise.all(origins.map(async (origin) => ({ origin, pending: await pendingOn(origin) })));
        if (busy) return;
        // One prompt at a time, re-checked on every tick: a request withdrawn, answered elsewhere or
        // expired has a code that matches nothing, so it goes. A server that could not be asked
        // this tick keeps its prompt on screen rather than flickering it away.
        const shown = current;
        if (shown) {
            const answer = answers.find((a) => a.origin === shown.origin);
            if (!answer || answer.pending === null || answer.pending.some((p) => p.id === shown.approval.id)) return;
        }
        const next = answers.flatMap((a) => (a.pending ?? []).map((approval) => ({ approval, origin: a.origin })))[0];
        if (!next) {
            open = false;
            current = null;
            replaced = false;
            return;
        }
        replaced = current !== null && current.origin === next.origin;
        current = { approval: next.approval, sas: await approvalSas(next.approval), origin: next.origin };
        error = null;
        open = true;
    }

    $effect(() => {
        void check();
        const timer = setInterval(() => void check(), 10_000);
        // Same-tab connection changes (the Graphs page saving a new token) end a refusal too.
        window.addEventListener(SYNC_CONNECTIONS_CHANGED_EVENT, connectionChanged);
        return () => {
            clearInterval(timer);
            window.removeEventListener(SYNC_CONNECTIONS_CHANGED_EVENT, connectionChanged);
        };
    });

    async function approve() {
        if (!current) return;
        const { origin } = current;
        const a = createSyncApiFor(origin);
        const heldKey = getVaultWrapKey(origin);
        if (!a || !heldKey) return;
        busy = true;
        error = null;
        try {
            // Returns the true vault key (minting it if the vault was legacy) - re-cache it.
            setVaultWrapKey(origin, await approveDevice(a, current.approval, heldKey));
            open = false;
            current = null;
            replaced = false;
        } catch (e) {
            error = describeSyncFailure(e, "approve the device");
        } finally {
            busy = false;
        }
    }

    async function reject() {
        const a = current ? createSyncApiFor(current.origin) : null;
        if (!a || !current) return;
        busy = true;
        try {
            await rejectDeviceApproval(a, current.approval.id);
        } finally {
            busy = false;
            open = false;
            current = null;
            replaced = false;
        }
    }

    function dismiss() {
        if (current) dismissed.add(current.approval.id);
        open = false;
        current = null;
        replaced = false;
    }
</script>

<svelte:window onstorage={storageChanged} />

{#if current}
    <Modal {open} title="Approve a new device?" busy={busy} onclose={dismiss}>
        {#snippet body()}
            <div data-testid="device-approval-prompt" class="space-y-3">
                <p class="text-sm text-gray-600 dark:text-gray-400">
                    A device signed in to your account on
                    <span class="font-medium text-gray-950 dark:text-gray-100" data-testid="device-approval-server">{serverHost(current?.origin ?? "")}</span>
                    is asking for your encryption keys there.
                    Approve <strong>only if you are setting that device up right now</strong> and
                    its screen shows this exact code:
                </p>
                <p class="text-center text-2xl font-mono font-semibold tracking-widest text-gray-950 dark:text-gray-100" data-testid="device-approval-sas">{current?.sas}</p>
                <p role="status" class="text-sm text-gray-600 dark:text-gray-400" data-testid="device-approval-replaced">
                    {replaced ? "The device withdrew its earlier request and asked again with this new code." : ""}
                </p>
                <p class="text-sm text-gray-500 dark:text-gray-400">
                    A different code - or a request you are not expecting - means someone else is
                    trying to get in: reject it.
                </p>
                {#if error}<p class="text-sm text-red-600" data-testid="device-approval-error">{error}</p>{/if}
            </div>
        {/snippet}

        {#snippet footer()}
            <button
                type="button"
                onclick={reject}
                disabled={busy}
                data-testid="device-approval-reject"
                class="rounded-lg border border-red-300 dark:border-red-500/40 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-40"
            >Reject</button>
            <button
                type="button"
                onclick={approve}
                disabled={busy}
                data-testid="device-approval-approve"
                class="rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-40"
            >{busy ? "Approving" : "Approve"}</button>
        {/snippet}
    </Modal>
{/if}
