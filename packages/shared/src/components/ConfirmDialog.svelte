<script lang="ts">
    /**
     * Confirmation dialog with two variants, built on the shared {@link Dialog} shell:
     * - "simple": title + message + Cancel/Confirm
     * - "type-to-confirm": the same plus a field that must match a target string exactly
     *   before Confirm is enabled (AGENTS.md rule 5: unrecoverable or externally visible
     *   actions only)
     *
     * One copy for all three apps; it was previously duplicated byte for byte in each.
     */
    import Dialog from "./Dialog.svelte";

    let {
        open = $bindable(false),
        title,
        message,
        confirmLabel = "Confirm",
        cancelLabel = "Cancel",
        variant = "simple",
        confirmValue = "",
        destructive = false,
        hideCancel = false,
        onconfirm,
        oncancel,
    }: {
        open: boolean;
        title: string;
        message: string;
        confirmLabel?: string;
        cancelLabel?: string;
        variant?: "simple" | "type-to-confirm";
        /** The string the user must type to enable confirm (type-to-confirm variant only). */
        confirmValue?: string;
        /** Styles the confirm button red, for destructive actions. */
        destructive?: boolean;
        /** Hides the cancel button, for info-only dialogs. */
        hideCancel?: boolean;
        onconfirm?: () => void;
        oncancel?: () => void;
    } = $props();

    let typedValue = $state("");
    const uid = $props.id();
    const inputId = `${uid}-input`;
    const hintId = `${uid}-hint`;

    // Reset the typed value whenever the dialog opens, so a previous attempt cannot pre-arm it.
    $effect(() => {
        if (open) typedValue = "";
    });

    const canConfirm = $derived(variant === "simple" || typedValue === confirmValue);

    function handleConfirm() {
        if (!canConfirm) return;
        onconfirm?.();
        open = false;
    }

    function handleCancel() {
        open = false;
        oncancel?.();
    }
</script>

<Dialog {open} {title} testId="confirm-dialog" onclose={handleCancel} onsubmit={handleConfirm}>
    {#snippet body()}
        <p class="text-sm text-gray-600 dark:text-gray-400">{message}</p>

        {#if variant === "type-to-confirm"}
            <div>
                <label for={inputId} class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400">
                    Type <span class="font-semibold text-gray-700 dark:text-gray-300">{confirmValue}</span> to confirm
                </label>
                <input
                    id={inputId}
                    type="text"
                    bind:value={typedValue}
                    autocomplete="off"
                    aria-describedby={canConfirm ? undefined : hintId}
                    class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:border-gray-950 dark:focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-950 dark:focus:ring-gray-400"
                />
                <!-- Rule 7: the confirm button is disabled and therefore not focusable, so its
                     condition has to be readable from the field it depends on. -->
                {#if !canConfirm}
                    <p id={hintId} class="mt-1.5 text-sm text-gray-500 dark:text-gray-400">
                        {confirmLabel} stays unavailable until this matches exactly.
                    </p>
                {/if}
            </div>
        {/if}
    {/snippet}

    {#snippet footer()}
        {#if !hideCancel}
            <button type="button" data-testid="confirm-cancel" onclick={handleCancel} class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors">
                {cancelLabel}
            </button>
        {/if}
        <button
            type="submit"
            data-testid="confirm-accept"
            disabled={!canConfirm}
            class="rounded-lg px-4 py-1.5 text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed {destructive
                ? 'bg-red-600 text-white hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700'
                : 'bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200'}"
        >
            {confirmLabel}
        </button>
    {/snippet}
</Dialog>
