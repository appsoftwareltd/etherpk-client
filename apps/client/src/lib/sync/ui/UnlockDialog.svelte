<script lang="ts">
    /**
     * Prompt to unlock the vault on this device. Two routes (ADR 0026 flows):
     * - Approve from another device: this device shows a SAS; any unlocked device confirms
     *   the same code and the vault key arrives sealed - the Recovery Code stays in the drawer.
     * - Enter the Recovery Code: the recovery route, and the only one on a first device.
     * Used before any action that needs decrypted keys (opening a synced graph, invites…).
     */
    import { onDestroy } from "svelte";
    import {
        beginDeviceApproval,
        createConfiguredSyncApi,
        pollDeviceApproval,
        rejectDeviceApproval,
        setVaultWrapKey,
        unlockWithRecoveryCode,
        type DeviceApprovalRequest,
    } from "$lib/sync";
    import { describeSyncFailure } from "$lib/sync/sync-error-copy";
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";

    let {
        onunlocked,
        onclose,
    }: {
        onunlocked: () => void;
        onclose: () => void;
    } = $props();

    let open = $state(true);
    let code = $state("");
    let error = $state<string | null>(null);
    let busy = $state(false);
    const errorId = $props.id();

    // Approve-from-another-device mode. Only offered when the device has a sync config.
    const api = createConfiguredSyncApi();
    let approval = $state<DeviceApprovalRequest | null>(null);
    let approvalError = $state<string | null>(null);
    let startingApproval = $state(false);
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    function stopApproval(cancelServerSide: boolean) {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = undefined;
        if (cancelServerSide && approval && api) void rejectDeviceApproval(api, approval.id).catch(() => {});
        approval = null;
    }

    async function startApproval() {
        // Guard the handler, not just the control: this is reached from a text link with no
        // disabled state, and a second call used to overwrite `pollTimer` while the first
        // interval kept running against an approval nothing would ever reject.
        if (!api || approval || startingApproval) return;
        startingApproval = true;
        error = null;
        approvalError = null;
        try {
            approval = await beginDeviceApproval(api);
        } catch (e) {
            approvalError = describeSyncFailure(e, "start the approval");
            return;
        } finally {
            startingApproval = false;
        }
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(() => void checkApproval(), 2000);
    }

    async function checkApproval() {
        if (!api || !approval) return;
        try {
            const result = await pollDeviceApproval(api, approval);
            if (result.state === "waiting") return;
            if (result.state === "unlocked") {
                setVaultWrapKey(result.deviceKey);
                stopApproval(false);
                open = false;
                onunlocked();
                return;
            }
            // rejected / expired: back to the code form with an explanation.
            stopApproval(false);
            approvalError = result.state === "rejected" ? "The request was rejected on the other device." : "The request expired - start again.";
        } catch (e) {
            stopApproval(true);
            approvalError = `${describeSyncFailure(e, "complete the approval")} You can enter your Recovery Code instead.`;
        }
    }

    function cancelApproval() {
        stopApproval(true);
    }

    onDestroy(() => stopApproval(true));

    function close() {
        stopApproval(true);
        open = false;
        onclose();
    }

    async function submit() {
        // Enter reaches this from the field as well as the button, so re-entry is guarded here
        // rather than relying on the button's disabled attribute alone.
        if (busy || approval) return;
        error = null;
        if (!code.trim()) {
            error = "Enter your Recovery Code.";
            return;
        }
        busy = true;
        try {
            await unlockWithRecoveryCode(code.trim());
            open = false;
            onunlocked();
        } catch (e) {
            error = `Could not unlock: ${(e as Error).message}. Check your Recovery Code and try again.`;
        } finally {
            busy = false;
        }
    }
</script>

<Modal {open} title="Unlock your keys" busy={busy} busyReason="Unlocking…" onclose={close} onsubmit={submit}>
    {#snippet body()}
        {#if approval}
            <p class="text-sm text-gray-600 dark:text-gray-400">
                On any device where your keys are already unlocked, an approval prompt will
                appear. Approve it there <strong>only if it shows this exact code</strong>:
            </p>
            <p class="text-center text-2xl font-mono font-semibold tracking-widest text-gray-950 dark:text-gray-100" data-testid="approval-sas">{approval.sas}</p>
            <!-- The wait, and its outcome, are the only things happening here; a screen reader
                 that is told neither has no way to know the dialog is still working. -->
            <p class="text-sm text-gray-500 dark:text-gray-400" role="status" data-testid="approval-waiting">Waiting for approval…</p>
        {:else}
            <p class="text-sm text-gray-600 dark:text-gray-400">
                Enter your Recovery Code to unlock your encryption keys on this device. It never leaves
                your browser and the sync server never sees it.
            </p>
            <div>
                <label for="unlock-code" class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400">Recovery Code</label>
                <input
                    id="unlock-code"
                    bind:value={code}
                    data-testid="unlock-input"
                    autocomplete="off"
                    aria-invalid={error ? "true" : undefined}
                    aria-describedby={error ? errorId : undefined}
                    placeholder="EPK1-XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX"
                    class="block w-full rounded-lg border bg-white dark:bg-white/10 px-3 py-2 text-sm font-mono text-gray-950 dark:text-gray-100 focus:outline-none focus:ring-1 {error
                        ? 'border-red-400 dark:border-red-500/60 focus:border-red-500 focus:ring-red-500'
                        : 'border-gray-300 dark:border-gray-700 focus:border-gray-950 dark:focus:border-gray-400 focus:ring-gray-950 dark:focus:ring-gray-400'}"
                />
                <!-- At the field, not at the foot of the dialog, and announced when it appears. -->
                {#if error}
                    <p id={errorId} role="alert" class="mt-1.5 text-sm text-red-600" data-testid="unlock-error">{error}</p>
                {/if}
            </div>
            {#if api}
                <p class="text-sm text-gray-600 dark:text-gray-400">
                    Or, if another device is already unlocked:
                    <button type="button" data-testid="unlock-approve-mode" disabled={startingApproval} onclick={startApproval} class="font-medium text-gray-950 dark:text-gray-100 underline underline-offset-2 hover:no-underline disabled:opacity-50">
                        {startingApproval ? "starting…" : "approve from another device"}
                    </button>
                </p>
            {/if}
            {#if approvalError}
                <p role="alert" class="text-sm text-red-600" data-testid="approval-error">{approvalError}</p>
            {/if}
        {/if}
    {/snippet}

    {#snippet footer()}
        {#if approval}
            <button type="button" onclick={cancelApproval} data-testid="approval-cancel" class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300">Back</button>
        {:else}
            <button type="button" onclick={close} class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300">Cancel</button>
            <button
                type="submit"
                disabled={busy}
                data-testid="unlock-submit"
                class="min-w-28 rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-center text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-40"
            >{busy ? "Unlocking…" : "Unlock"}</button>
        {/if}
    {/snippet}
</Modal>
