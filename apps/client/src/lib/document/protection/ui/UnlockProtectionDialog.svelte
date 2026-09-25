<script lang="ts">
    /**
     * Unlock this graph's protected content (ADR 0057, ADR 0058).
     *
     * Two routes, in the order they should be reached for: a passkey bound to this device
     * (biometric or PIN, no typing), and the [[Protection Passphrase]], which is the portable root
     * and the only route on a device that has never been enrolled.
     *
     * The passkey is attempted automatically on open where one is bound, because a user who has
     * bound one has said they want that to be the everyday route - making them press a button
     * first would waste the gesture. It falls back to the passphrase silently on any failure,
     * including a cancelled biometric prompt.
     */
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";

    let {
        hasPasskey,
        onpassphrase,
        onpasskey,
        onclose,
    }: {
        /** Whether a passkey is bound to this graph on this device. */
        hasPasskey: boolean;
        onpassphrase: (passphrase: string) => Promise<void>;
        /** Unlock from the bound passkey. Rejects if the ceremony fails or is cancelled. */
        onpasskey: () => Promise<void>;
        onclose: () => void;
    } = $props();

    let open = $state(true);
    let passphrase = $state("");
    let error = $state<string | null>(null);
    let busy = $state(false);
    let passkeyBusy = $state(false);
    /** Set once the automatic attempt has run, so it never fires twice for one dialog. */
    let passkeyTried = $state(false);
    const errorId = $props.id();

    function close() {
        open = false;
        onclose();
    }

    async function tryPasskey(explicit: boolean) {
        if (passkeyBusy || busy) return;
        passkeyBusy = true;
        error = null;
        try {
            await onpasskey();
            open = false;
        } catch (e) {
            // Only say something when the user asked for it. An automatic attempt that fails -
            // most often because they dismissed the biometric prompt - should leave the passphrase
            // field waiting, not an error accusing them of something.
            if (explicit)
                error = `Could not unlock with your passkey: ${(e as Error).message}`;
        } finally {
            passkeyBusy = false;
        }
    }

    async function submit() {
        if (busy || passkeyBusy) return;
        error = null;
        if (!passphrase) {
            error = "Enter your protection passphrase.";
            return;
        }
        busy = true;
        try {
            await onpassphrase(passphrase);
            open = false;
        } catch (e) {
            error = (e as Error).message;
        } finally {
            busy = false;
        }
    }

    // The one automatic attempt. An effect is the right tool here: it is a side effect on mount
    // that must not run during SSR, and there is no user interaction to hang it off.
    $effect(() => {
        if (hasPasskey && !passkeyTried) {
            passkeyTried = true;
            void tryPasskey(false);
        }
    });
</script>

<Modal
    {open}
    title="Enter passphrase"
    busy={busy || passkeyBusy}
    busyReason={passkeyBusy
        ? "Waiting for your passkey…"
        : "Checking passphrase…"}
    testId="unlock-protection"
    onclose={close}
    onsubmit={submit}
>
    {#snippet body()}
        <p class="text-sm text-gray-600 dark:text-gray-400">
            Enter your protection passphrase to read this graph's protected
            documents. It never leaves this device, and the sync service never
            sees it.
        </p>

        <div>
            <label
                for="protection-unlock"
                class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400"
                >Protection passphrase</label
            >
            <input
                id="protection-unlock"
                type="password"
                bind:value={passphrase}
                data-testid="protection-unlock-input"
                autocomplete="current-password"
                aria-invalid={error ? "true" : undefined}
                aria-describedby={error ? errorId : undefined}
                class="block w-full rounded-lg border bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:outline-none focus:ring-1 {error
                    ? 'border-red-400 dark:border-red-500/60 focus:border-red-500 focus:ring-red-500'
                    : 'border-gray-300 dark:border-gray-700 focus:border-gray-950 dark:focus:border-gray-400 focus:ring-gray-950 dark:focus:ring-gray-400'}"
            />
            {#if error}
                <p
                    id={errorId}
                    role="alert"
                    class="mt-1.5 text-sm text-red-600"
                    data-testid="protection-unlock-error"
                >
                    {error}
                </p>
            {/if}
        </div>

        {#if hasPasskey}
            <p class="text-sm text-gray-600 dark:text-gray-400">
                Or use the passkey bound to this device:
                <button
                    type="button"
                    data-testid="protection-unlock-passkey"
                    disabled={passkeyBusy}
                    onclick={() => void tryPasskey(true)}
                    class="font-medium text-gray-950 dark:text-gray-100 underline underline-offset-2 hover:no-underline disabled:opacity-50"
                >
                    {passkeyBusy ? "waiting…" : "unlock with a passkey"}
                </button>
            </p>
        {/if}
    {/snippet}

    {#snippet footer()}
        <button
            type="button"
            onclick={close}
            class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
            >Cancel</button
        >
        <button
            type="submit"
            disabled={busy || passkeyBusy}
            data-testid="protection-unlock-submit"
            class="min-w-24 rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-center text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-40"
            >{busy ? "Checking…" : "Enter passphrase"}</button
        >
    {/snippet}
</Modal>
