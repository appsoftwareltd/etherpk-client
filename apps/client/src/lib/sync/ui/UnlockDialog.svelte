<script lang="ts">
    /**
     * Prompt to unlock the vault on this device. Two routes:
     * - Approve from another device (ADR 0125): once an unlocked device answers, both screens show
     *   the same code. The user approves there AND confirms the match here; only then is the vault
     *   key that arrived used. The confirmation here is what catches a server that plays the
     *   approving device itself. The Recovery Code stays in the drawer.
     * - Enter the Recovery Code: the recovery route, and the only one on a first device.
     * Used before any action that needs decrypted keys (opening a synced graph, invites…).
     *
     * Keys belong to one Sync Server's account (ADR 0111): the dialog unlocks the keys of the server
     * it is given, and says which, because a Recovery Code from another server cannot open them.
     */
    import { onDestroy, tick } from "svelte";
    import {
        beginDeviceApproval,
        createSyncApiFor,
        serverHost,
        pollDeviceApproval,
        rejectDeviceApproval,
        setVaultWrapKey,
        unlockWithRecoveryCode,
        type DeviceApprovalRequest,
    } from "$lib/sync";
    import { describeSyncFailure } from "$lib/sync/sync-error-copy";
    import { PUBLIC_DOCS_URL } from "@appsoftwareltd/etherpk-shared";
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";

    /** The user guide's section on getting back in without a Recovery Code. */
    const RECOVERING_ACCESS_URL = `${PUBLIC_DOCS_URL}/recovery-code-and-device-approval#recovering-access`;

    let {
        serverOrigin,
        onunlocked,
        onclose,
    }: {
        /** The Sync Server whose account's keys to unlock. */
        serverOrigin: string;
        onunlocked: () => void;
        onclose: () => void;
    } = $props();

    let open = $state(true);
    let code = $state("");
    let error = $state<string | null>(null);
    let busy = $state(false);
    let codeInput = $state<HTMLInputElement>();
    const errorId = $props.id();

    // The server is fixed for the dialog's life: a caller wanting another server's keys opens a
    // new dialog. Approve-from-another-device is only offered while the connection is held.
    // svelte-ignore state_referenced_locally
    const origin = serverOrigin;
    const host = serverHost(origin);
    const api = createSyncApiFor(origin);
    let approval = $state<DeviceApprovalRequest | null>(null);
    let approvalError = $state<string | null>(null);
    let startingApproval = $state(false);
    /** The code to compare, once another device has answered and this device has revealed its key. */
    let approvalCode = $state<string | null>(null);
    /** The user said the codes match. */
    let codesMatch = $state(false);
    /** The other device approved and its key opens this account's vault, but the user has not confirmed yet. */
    let approvedKey = $state<Uint8Array | null>(null);
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    /** A poll in flight. Overlapping polls could claim the one-shot reply twice. */
    let polling = false;

    function stopApproval(cancelServerSide: boolean) {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = undefined;
        if (cancelServerSide && approval && api) void rejectDeviceApproval(api, approval.id).catch(() => {});
        approval = null;
        approvalCode = null;
        codesMatch = false;
        approvedKey = null;
    }

    /** Both halves are done: the other device approved, and the user confirmed the codes match. */
    function finishApproval(deviceKey: Uint8Array) {
        setVaultWrapKey(origin, deviceKey);
        stopApproval(false);
        open = false;
        onunlocked();
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
        if (!api || !approval || polling) return;
        polling = true;
        try {
            const result = await pollDeviceApproval(api, approval);
            if (!approval) return; // cancelled while the poll was in flight
            if (result.state === "waiting") return;
            if (result.state === "code") {
                approvalCode = result.sas;
                return;
            }
            if (result.state === "approved") {
                // The reply has been claimed, so there is nothing more to poll for.
                if (pollTimer) clearInterval(pollTimer);
                pollTimer = undefined;
                approvalCode = result.sas;
                if (codesMatch) finishApproval(result.deviceKey);
                else approvedKey = result.deviceKey;
                return;
            }
            // rejected / expired: back to the code form with an explanation.
            stopApproval(false);
            approvalError = result.state === "rejected" ? "The request was rejected on the other device." : "The request expired - start again.";
        } catch (e) {
            stopApproval(true);
            approvalError = `${describeSyncFailure(e, "complete the approval")} You can enter your Recovery Code instead.`;
        } finally {
            polling = false;
        }
    }

    /** The user compared the two screens and they match. Finishes now if the other device already approved. */
    function confirmCodesMatch() {
        codesMatch = true;
        if (approvedKey) finishApproval(approvedKey);
    }

    /** The codes differ: something between the devices changed a key, so the request is cancelled. */
    function codesDiffer() {
        stopApproval(true);
        approvalError =
            "The codes did not match, so the request was cancelled. Something between your devices may have interfered. Start again, or enter your Recovery Code.";
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
        // The code is checked against this account's vault before anything is cached, so the
        // device must be able to reach its Sync Server to fetch it.
        if (!api) {
            error = `This device is not connected to ${host}, so the code cannot be checked. Connect to it in Sync settings, then try again.`;
            return;
        }
        busy = true;
        try {
            await unlockWithRecoveryCode(api, code.trim(), origin);
            open = false;
            onunlocked();
        } catch (e) {
            // A wrong code says it is wrong; a server that could not be reached says that instead.
            // What was typed stays in the field, so one wrong character is one fix away.
            error = describeSyncFailure(e, "unlock your keys");
            busy = false;
            await tick();
            codeInput?.focus();
        } finally {
            busy = false;
        }
    }
</script>

<Modal {open} title={`Unlock your keys on ${host}`} busy={busy} busyReason="Unlocking…" onclose={close} onsubmit={submit}>
    {#snippet body()}
        {#if approval}
            {#if !approvalCode}
                <p class="text-sm text-gray-600 dark:text-gray-400">
                    On a device where your keys are already unlocked, an approval prompt will appear.
                    This device then shows a code to compare with it.
                </p>
                <!-- The wait, and its outcome, are the only things happening here; a screen reader
                     that is told neither has no way to know the dialog is still working. -->
                <p class="text-sm text-gray-500 dark:text-gray-400" role="status" data-testid="approval-waiting">Waiting for another device…</p>
            {:else}
                <p class="text-sm text-gray-600 dark:text-gray-400">
                    Check that your other device shows <strong>this exact code</strong>. Approve there, and
                    select <strong>The codes match</strong> here.
                </p>
                <p class="text-center text-2xl font-mono font-semibold tracking-widest text-gray-950 dark:text-gray-100" data-testid="approval-sas">{approvalCode}</p>
                <p class="text-sm text-gray-500 dark:text-gray-400" role="status" data-testid="approval-waiting">
                    {#if approvedKey}
                        Your other device approved. Select The codes match to finish.
                    {:else if codesMatch}
                        Waiting for your other device to approve…
                    {:else}
                        Waiting for approval on your other device…
                    {/if}
                </p>
            {/if}
            <!-- The server drops a request nobody approves within ten minutes (device-approval-store.ts). -->
            <p class="text-sm text-gray-500 dark:text-gray-400" data-testid="approval-expiry">
                If nobody approves it within 10 minutes, the request expires and you can start again.
            </p>
        {:else}
            <p class="text-sm text-gray-600 dark:text-gray-400">
                Enter the Recovery Code you saved for <span class="font-medium text-gray-950 dark:text-gray-100">{host}</span>
                to unlock your encryption keys on this device. A code for another Sync Server does not
                open them. It never leaves your browser and the sync server never sees it.
            </p>
            <div>
                <label for="unlock-code" class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400">Recovery Code</label>
                <input
                    id="unlock-code"
                    bind:this={codeInput}
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
            <!-- Someone without their code and with no unlocked device reaches this dialog too; it
                 names what they can still do rather than leaving them at a field they cannot fill. -->
            <details class="text-sm text-gray-600 dark:text-gray-400" data-testid="unlock-lost-code">
                <summary class="cursor-pointer font-medium text-gray-950 dark:text-gray-100">Lost your Recovery Code?</summary>
                <div class="mt-1.5 space-y-1.5">
                    <p>
                        If another of your devices still has its keys unlocked, approve this one from
                        it, then make a new code there with <strong>Regenerate Recovery Code</strong>.
                        Nothing is lost.
                    </p>
                    <p>
                        With no unlocked device, nothing can decrypt your notes.
                        <strong>Reset encryption keys</strong>, in Sync settings, starts over: it deletes
                        every graph you own, after offering to hand shared ones to a player.
                    </p>
                    <a
                        href={RECOVERING_ACCESS_URL}
                        target="_blank"
                        rel="noopener"
                        class="inline-block font-medium text-gray-950 underline underline-offset-2 hover:no-underline dark:text-gray-100"
                    >What to do without your code</a>
                </div>
            </details>
        {/if}
    {/snippet}

    {#snippet footer()}
        {#if approval}
            <button type="button" onclick={cancelApproval} data-testid="approval-cancel" class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300">Use my Recovery Code instead</button>
            {#if approvalCode}
                <button
                    type="button"
                    onclick={codesDiffer}
                    data-testid="approval-mismatch"
                    class="rounded-lg border border-red-300 dark:border-red-500/40 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                >They don't match</button>
                <button
                    type="button"
                    onclick={confirmCodesMatch}
                    disabled={codesMatch}
                    data-testid="approval-confirm"
                    class="min-w-28 rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-center text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-40"
                >{codesMatch ? "Confirmed" : "The codes match"}</button>
            {/if}
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
