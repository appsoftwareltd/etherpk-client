<script lang="ts">
    /**
     * The approver half of device approval (ADR 0026 flows), hosted once in the app shell.
     * While this device is unlocked (and sync-configured), it polls for pending requests
     * from the account's OTHER devices; when one appears it shows the SAS derived from the
     * key the server delivered. The user compares it with the code on the new device's
     * screen - a mismatch means the key was substituted in transit - and on approve the
     * vault key travels sealed to that key. Rejecting kills the request for good.
     */
    import {
        approvalSas,
        approveDevice,
        createConfiguredSyncApi,
        getVaultWrapKey,
        rejectDeviceApproval,
        setVaultWrapKey,
        type PendingDeviceApproval,
    } from "$lib/sync";
    import { describeSyncFailure } from "$lib/sync/sync-error-copy";
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";

    let current = $state<{ approval: PendingDeviceApproval; sas: string } | null>(null);
    let open = $state(false);
    let busy = $state(false);
    let error = $state<string | null>(null);
    // Requests the user closed without deciding - do not nag about them again this session.
    const dismissed = new Set<string>();

    function api() {
        return createConfiguredSyncApi();
    }

    async function check() {
        if (current) return; // one prompt at a time
        if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
        const a = api();
        if (!a || !getVaultWrapKey()) return; // locked devices can approve nothing
        try {
            const pending = (await a.listDeviceApprovals()).find((p) => !dismissed.has(p.id));
            if (pending) {
                current = { approval: pending, sas: await approvalSas(pending) };
                error = null;
                open = true;
            }
        } catch {
            // Server unreachable - stay quiet; the next tick retries.
        }
    }

    $effect(() => {
        void check();
        const timer = setInterval(() => void check(), 10_000);
        return () => clearInterval(timer);
    });

    async function approve() {
        const a = api();
        const heldKey = getVaultWrapKey();
        if (!a || !heldKey || !current) return;
        busy = true;
        error = null;
        try {
            // Returns the true vault key (minting it if the vault was legacy) - re-cache it.
            setVaultWrapKey(await approveDevice(a, current.approval, heldKey));
            open = false;
            current = null;
        } catch (e) {
            error = describeSyncFailure(e, "approve the device");
        } finally {
            busy = false;
        }
    }

    async function reject() {
        const a = api();
        if (!a || !current) return;
        busy = true;
        try {
            await rejectDeviceApproval(a, current.approval.id);
        } finally {
            busy = false;
            open = false;
            current = null;
        }
    }

    function dismiss() {
        if (current) dismissed.add(current.approval.id);
        open = false;
        current = null;
    }
</script>

{#if current}
    <Modal {open} title="Approve a new device?" busy={busy} onclose={dismiss}>
        {#snippet body()}
            <div data-testid="device-approval-prompt" class="space-y-3">
                <p class="text-sm text-gray-600 dark:text-gray-400">
                    A device signed in to your account is asking for your encryption keys.
                    Approve <strong>only if you are setting that device up right now</strong> and
                    its screen shows this exact code:
                </p>
                <p class="text-center text-2xl font-mono font-semibold tracking-widest text-gray-950 dark:text-gray-100" data-testid="device-approval-sas">{current?.sas}</p>
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
