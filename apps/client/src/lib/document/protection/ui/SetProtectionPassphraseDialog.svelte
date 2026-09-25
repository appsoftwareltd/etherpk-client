<script lang="ts">
    /**
     * Set the graph's [[Protection Passphrase]] - the one moment a user meets the fact that there
     * is no recovery (ADR 0057).
     *
     * The warning is a checkbox rather than prose, because prose above a passphrase field does not
     * get read. It is the only gate here: strength is advised, not enforced, since a rule that
     * rejects a memorable sentence in favour of a short scrambled word makes the passphrase worse
     * and pushes it into a password manager, which is the very thing this feature exists to avoid.
     */
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";

    let {
        concept,
        onset,
        onclose,
    }: {
        /** The document that triggered this, so the dialog can say what is about to happen. */
        concept?: string;
        onset: (passphrase: string) => Promise<void>;
        onclose: () => void;
    } = $props();

    let open = $state(true);
    let passphrase = $state("");
    let confirmation = $state("");
    let acknowledged = $state(false);
    let error = $state<string | null>(null);
    let busy = $state(false);
    const errorId = $props.id();

    /**
     * Advisory only. Length is what actually matters against an offline attack on an exported
     * folder, so that is what is measured - not a character-class rule.
     */
    const strength = $derived(
        passphrase.length === 0
            ? null
            : passphrase.length < 12
              ? { label: "Too short to resist an offline attack", tone: "weak" as const }
              : passphrase.length < 20
                ? { label: "OK - a longer sentence would be better", tone: "fair" as const }
                : { label: "Good length", tone: "good" as const },
    );

    function close() {
        open = false;
        onclose();
    }

    async function submit() {
        if (busy) return;
        error = null;
        if (passphrase.length === 0) {
            error = "Enter a passphrase.";
            return;
        }
        if (passphrase !== confirmation) {
            error = "The two passphrases do not match.";
            return;
        }
        if (!acknowledged) {
            error = "Confirm you understand that a forgotten passphrase cannot be recovered.";
            return;
        }
        busy = true;
        try {
            await onset(passphrase);
            open = false;
        } catch (e) {
            error = `Could not set the passphrase: ${(e as Error).message}`;
        } finally {
            busy = false;
        }
    }
</script>

<Modal
    {open}
    title="Set a protection passphrase"
    {busy}
    busyReason="Setting up…"
    testId="set-protection-passphrase"
    onclose={close}
    onsubmit={submit}
>
    {#snippet body()}
        <p class="text-sm text-gray-600 dark:text-gray-400">
            {#if concept}
                Before <strong>{concept}</strong> can be protected, this graph needs a passphrase.
            {:else}
                This graph needs a passphrase before anything in it can be protected.
            {/if}
            One passphrase covers the whole graph, and it never leaves this device.
        </p>

        <div>
            <label for="protection-passphrase" class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400">Passphrase</label>
            <input
                id="protection-passphrase"
                type="password"
                bind:value={passphrase}
                data-testid="protection-passphrase-input"
                autocomplete="new-password"
                aria-invalid={error ? "true" : undefined}
                aria-describedby={error ? errorId : undefined}
                class="block w-full rounded-lg border bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:outline-none focus:ring-1 {error
                    ? 'border-red-400 dark:border-red-500/60 focus:border-red-500 focus:ring-red-500'
                    : 'border-gray-300 dark:border-gray-700 focus:border-gray-950 dark:focus:border-gray-400 focus:ring-gray-950 dark:focus:ring-gray-400'}"
            />
            {#if strength}
                <p
                    class="mt-1.5 text-sm {strength.tone === 'weak'
                        ? 'text-red-600'
                        : strength.tone === 'fair'
                          ? 'text-amber-600 dark:text-amber-500'
                          : 'text-green-700 dark:text-green-500'}"
                    data-testid="protection-passphrase-strength"
                >
                    {strength.label}
                </p>
            {/if}
        </div>

        <div>
            <label for="protection-passphrase-confirm" class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400">Confirm passphrase</label>
            <input
                id="protection-passphrase-confirm"
                type="password"
                bind:value={confirmation}
                data-testid="protection-passphrase-confirm"
                autocomplete="new-password"
                class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:outline-none focus:ring-1 focus:border-gray-950 dark:focus:border-gray-400 focus:ring-gray-950 dark:focus:ring-gray-400"
            />
        </div>

        <!-- The single most important thing on the screen, so it is a gate rather than a note. -->
        <div class="rounded-lg border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 p-3">
            <label class="flex items-start gap-2.5 text-sm text-amber-900 dark:text-amber-200">
                <input
                    type="checkbox"
                    bind:checked={acknowledged}
                    data-testid="protection-passphrase-acknowledge"
                    class="mt-0.5 h-4 w-4 shrink-0 rounded border-amber-400 text-amber-600 focus:ring-amber-500"
                />
                <span>
                    I understand that <strong>if I forget this passphrase, the contents of every protected
                    note in this graph are lost permanently</strong>. My Recovery Code will not restore
                    them, and neither can EtherPK.
                </span>
            </label>
        </div>

        <p class="text-sm text-gray-600 dark:text-gray-400">
            Once this is set, add a second device. A device with a passkey bound to it can still
            unlock if you forget the passphrase, and let you choose a new one. It is the closest
            thing to a backup there is.
        </p>

        {#if error}
            <p id={errorId} role="alert" class="text-sm text-red-600" data-testid="protection-passphrase-error">{error}</p>
        {/if}
    {/snippet}

    {#snippet footer()}
        <button type="button" onclick={close} class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300">Cancel</button>
        <button
            type="submit"
            disabled={busy}
            data-testid="protection-passphrase-submit"
            class="min-w-28 rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-center text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-40"
        >{busy ? "Setting up…" : "Set passphrase"}</button>
    {/snippet}
</Modal>
