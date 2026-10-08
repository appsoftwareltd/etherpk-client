<script lang="ts" module>
    /** What the dialog is for: enter the passcode to unlock the keys, or set, change or turn it off. */
    export type DevicePasscodeDialogMode = "unlock" | "set" | "change" | "turn-off";
</script>

<script lang="ts">
    /**
     * The Device Passcode's dialog (ADR 0129). One passcode covers every server's keys on this
     * device, so the dialog names no server.
     *
     * Unlocking offers Forgot your passcode?, which removes the keys the passcode protects: the
     * device is then unlocked as a new one is, with the Recovery Code or by approval, and a custom
     * server needs a new access token. The caller hears of it through `onforgotten`.
     */
    import { tick } from "svelte";
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";
    import { focusFirstInvalid } from "@appsoftwareltd/etherpk-shared/ui";
    import { devicePasscode, WrongDevicePasscodeError } from "../device-passcode";
    import { listSyncConnections } from "../sync-connection";
    import { serverHost } from "../sync-connections";
    import { newPasscodeErrors, passcodeAdvice } from "./device-passcode-copy";

    let {
        mode,
        intro,
        dismissLabel = "Cancel",
        ondone,
        onclose,
        onforgotten,
    }: {
        mode: DevicePasscodeDialogMode;
        /** Replaces the opening paragraph, for a dialog offered after something else. */
        intro?: string;
        /** The label of the button that leaves without changing anything. */
        dismissLabel?: string;
        /** Unlocked, set, changed or turned off. */
        ondone: () => void;
        onclose: () => void;
        /** The user forgot the passcode and the keys it protected were removed. Unlock mode only. */
        onforgotten?: () => void;
    } = $props();

    const uid = $props.id();
    /** Unlock mode's second step: confirming the passcode is forgotten. */
    let forgetting = $state(false);
    let busy = $state(false);

    let current = $state("");
    let next = $state("");
    let again = $state("");
    let currentError = $state<string | null>(null);
    let nextError = $state<string | null>(null);
    let againError = $state<string | null>(null);
    /** A failure that belongs to no one field. */
    let formError = $state<string | null>(null);
    let currentInput = $state<HTMLInputElement>();
    let backButton = $state<HTMLButtonElement>();

    const asksCurrent = $derived(mode !== "set");
    const asksNew = $derived(mode === "set" || mode === "change");

    const title = $derived(
        forgetting
            ? "Forgot your passcode?"
            : mode === "unlock"
              ? "Enter this device's passcode"
              : mode === "set"
                ? "Set a passcode for this device"
                : mode === "change"
                  ? "Change this device's passcode"
                  : "Turn off the passcode",
    );
    const submitLabel = $derived(
        forgetting
            ? "Remove the Encryption Keys"
            : mode === "unlock"
              ? "Unlock Encryption Keys"
              : mode === "set"
                ? "Set passcode"
                : mode === "change"
                  ? "Change passcode"
                  : "Turn off",
    );
    const busyReason = $derived(
        forgetting
            ? "Removing…"
            : mode === "unlock"
              ? "Unlocking…"
              : mode === "turn-off"
                ? "Turning off…"
                : "Saving the passcode…",
    );

    // The servers whose access tokens a forgotten passcode takes with it, named so the user knows
    // which ones to add again.
    const customHosts = $derived(
        forgetting
            ? listSyncConnections()
                  .filter((connection) => connection.kind === "custom")
                  .map((connection) => serverHost(connection.origin))
            : [],
    );

    function checkFields(): boolean {
        currentError = asksCurrent && !current ? "Enter the passcode." : null;
        const fresh = asksNew ? newPasscodeErrors(next, again) : { passcode: null, again: null };
        nextError = fresh.passcode;
        againError = fresh.again;
        return !currentError && !nextError && !againError;
    }

    /**
     * Move between unlocking and confirming the passcode is forgotten. The control that was pressed
     * goes with the step, so focus moves to the safe choice on the new one.
     */
    async function showForgetStep(show: boolean) {
        formError = null;
        forgetting = show;
        await tick();
        (show ? backButton : currentInput)?.focus();
    }

    /** Once a field has said what is wrong, it says so again as the user fixes it. */
    function recheck() {
        if (currentError || nextError || againError) checkFields();
    }

    async function submit() {
        // Enter reaches this from any field, so re-entry is guarded here and not only by the button.
        if (busy) return;
        formError = null;
        if (forgetting) {
            devicePasscode.forgotten();
            onforgotten?.();
            return;
        }
        if (!checkFields()) {
            await focusFirstInvalid();
            return;
        }
        busy = true;
        try {
            if (mode === "unlock") await devicePasscode.unlock(current);
            else if (mode === "set") await devicePasscode.set(next);
            else if (mode === "change") await devicePasscode.change(current, next);
            else await devicePasscode.turnOff(current);
        } catch (error) {
            busy = false;
            // What was typed stays in the field, so one wrong character is one fix away.
            if (error instanceof WrongDevicePasscodeError) {
                currentError = "That is not this device's passcode. Check it and try again.";
                await focusFirstInvalid();
            } else {
                const action =
                    mode === "unlock" ? "unlock the Encryption Keys" : mode === "turn-off" ? "turn off the passcode" : "save the passcode";
                formError = `Could not ${action}: ${(error as Error).message.replace(/\.$/, "")}. Try again.`;
            }
            return;
        }
        busy = false;
        ondone();
    }
</script>

<Modal open {title} {busy} {busyReason} {onclose} onsubmit={submit} testId="device-passcode-dialog">
    {#snippet body()}
        {#if forgetting}
            <p class="text-sm text-gray-600 dark:text-gray-400">
                A passcode cannot be recovered. Remove the Encryption Keys it protects from this device, then unlock
                again with your Recovery Code or from another device that is unlocked. Nothing on your
                Sync Servers changes.
            </p>
            {#if customHosts.length > 0}
                <p class="text-sm text-gray-600 dark:text-gray-400" data-testid="device-passcode-forget-tokens">
                    The access {customHosts.length === 1 ? "token" : "tokens"} for
                    <span class="font-medium text-gray-950 dark:text-gray-100">{customHosts.join(", ")}</span>
                    {customHosts.length === 1 ? "is" : "are"} removed too. Connect to
                    {customHosts.length === 1 ? "that server" : "those servers"} again with a new token.
                </p>
            {/if}
        {:else}
            <p class="text-sm text-gray-600 dark:text-gray-400">
                {#if intro}
                    {intro}
                {:else if mode === "unlock"}
                    The Encryption Keys this device holds for your synced graphs are protected by its passcode. Enter
                    it to use them in this browser session.
                {:else if mode === "set"}
                    With a passcode, the Encryption Keys this device holds for your synced graphs, and the access
                    tokens for your own Sync Servers, are stored encrypted. You enter it once each time you
                    open EtherPK in this browser.
                {:else if mode === "change"}
                    The Encryption Keys and access tokens this device holds are encrypted again under the new
                    passcode.
                {:else}
                    The Encryption Keys this device holds are stored without encryption again, as they are on a device
                    with no passcode.
                {/if}
            </p>

            {#if asksCurrent}
                <div>
                    <label for="{uid}-current" class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400"
                        >{mode === "change" ? "Current passcode" : "Passcode"}</label
                    >
                    <input
                        id="{uid}-current"
                        type="password"
                        bind:this={currentInput}
                        bind:value={current}
                        oninput={recheck}
                        autocomplete="off"
                        data-testid="device-passcode-current"
                        aria-invalid={currentError ? "true" : undefined}
                        aria-describedby={currentError ? `${uid}-current-error` : undefined}
                        class="block w-full rounded-lg border bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:outline-none focus:ring-1 {currentError
                            ? 'border-red-400 dark:border-red-500/60 focus:border-red-500 focus:ring-red-500'
                            : 'border-gray-300 dark:border-gray-700 focus:border-gray-950 dark:focus:border-gray-400 focus:ring-gray-950 dark:focus:ring-gray-400'}"
                    />
                    {#if currentError}
                        <p id="{uid}-current-error" role="alert" class="mt-1.5 text-sm text-red-600" data-testid="device-passcode-current-error">
                            {currentError}
                        </p>
                    {/if}
                </div>
            {/if}

            {#if asksNew}
                <div>
                    <label for="{uid}-next" class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400"
                        >{mode === "change" ? "New passcode" : "Passcode"}</label
                    >
                    <input
                        id="{uid}-next"
                        type="password"
                        bind:value={next}
                        oninput={recheck}
                        autocomplete="new-password"
                        data-testid="device-passcode-new"
                        aria-invalid={nextError ? "true" : undefined}
                        aria-describedby="{uid}-advice{nextError ? ` ${uid}-next-error` : ''}"
                        class="block w-full rounded-lg border bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:outline-none focus:ring-1 {nextError
                            ? 'border-red-400 dark:border-red-500/60 focus:border-red-500 focus:ring-red-500'
                            : 'border-gray-300 dark:border-gray-700 focus:border-gray-950 dark:focus:border-gray-400 focus:ring-gray-950 dark:focus:ring-gray-400'}"
                    />
                    {#if nextError}
                        <p id="{uid}-next-error" role="alert" class="mt-1.5 text-sm text-red-600" data-testid="device-passcode-new-error">
                            {nextError}
                        </p>
                    {/if}
                    <!-- Advice, not an error: any length from 4 is taken, and this says what a short one stops. -->
                    <p id="{uid}-advice" class="mt-1.5 text-sm text-gray-600 dark:text-gray-400" data-testid="device-passcode-advice">
                        {passcodeAdvice(next)}
                    </p>
                </div>
                <div>
                    <label for="{uid}-again" class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400"
                        >{mode === "change" ? "New passcode again" : "Passcode again"}</label
                    >
                    <input
                        id="{uid}-again"
                        type="password"
                        bind:value={again}
                        oninput={recheck}
                        autocomplete="new-password"
                        data-testid="device-passcode-again"
                        aria-invalid={againError ? "true" : undefined}
                        aria-describedby={againError ? `${uid}-again-error` : undefined}
                        class="block w-full rounded-lg border bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:outline-none focus:ring-1 {againError
                            ? 'border-red-400 dark:border-red-500/60 focus:border-red-500 focus:ring-red-500'
                            : 'border-gray-300 dark:border-gray-700 focus:border-gray-950 dark:focus:border-gray-400 focus:ring-gray-950 dark:focus:ring-gray-400'}"
                    />
                    {#if againError}
                        <p id="{uid}-again-error" role="alert" class="mt-1.5 text-sm text-red-600" data-testid="device-passcode-again-error">
                            {againError}
                        </p>
                    {/if}
                </div>
                {#if mode === "set"}
                    <p class="text-sm text-gray-600 dark:text-gray-400">
                        It protects Encryption Keys and access tokens, not the documents already stored on this
                        device. If you forget it,
                        unlock again with your Recovery Code or from another device.
                    </p>
                {/if}
            {/if}

            {#if mode === "unlock"}
                <button
                    type="button"
                    data-testid="device-passcode-forgot"
                    onclick={() => void showForgetStep(true)}
                    class="text-sm font-medium text-gray-950 underline underline-offset-2 hover:no-underline dark:text-gray-100"
                    >Forgot your passcode?</button
                >
            {/if}
        {/if}

        {#if formError}
            <p role="alert" class="text-sm text-red-600" data-testid="device-passcode-error">{formError}</p>
        {/if}
    {/snippet}

    {#snippet footer()}
        {#if forgetting}
            <button
                type="button"
                bind:this={backButton}
                onclick={() => void showForgetStep(false)}
                data-testid="device-passcode-forget-back"
                class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                >Back</button
            >
            <button
                type="submit"
                data-testid="device-passcode-forget-confirm"
                class="min-w-28 rounded-lg bg-red-700 px-4 py-1.5 text-center text-sm font-medium text-white hover:bg-red-800"
                >{submitLabel}</button
            >
        {:else}
            <button
                type="button"
                onclick={onclose}
                data-testid="device-passcode-dismiss"
                class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                >{dismissLabel}</button
            >
            <button
                type="submit"
                disabled={busy}
                data-testid="device-passcode-submit"
                class="min-w-28 rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-center text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-40"
                >{busy ? busyReason : submitLabel}</button
            >
        {/if}
    {/snippet}
</Modal>
