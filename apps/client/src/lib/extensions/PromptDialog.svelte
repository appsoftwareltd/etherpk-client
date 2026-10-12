<script lang="ts">
    /**
     * The dialog behind `context.dialogs.prompt`: one question with one line of text for an answer,
     * drawn like the Client's own dialogs (the shared Modal), so an extension's question looks and
     * behaves like the rest of the app, with a line naming the extension that asks, so the person
     * never takes it for the Client's own question. Enter answers and Esc cancels, the keyboard stays inside while
     * it is open and returns to where it was when it closes (the Modal's `dialogFocus`).
     *
     * The answer is checked when it is given, by the extension's `validate`. A wrong one keeps the
     * dialog open with the text kept and the reason under the field, and from then on the reason
     * follows each change, so it clears as soon as the text is right.
     */
    import type { PromptOptions } from "@appsoftwareltd/etherpk-extension-api";
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";

    const { options, from, onanswer }: { options: PromptOptions; from: string; onanswer: (value: string | undefined) => void } = $props();

    // Mounted fresh for each question, so the first value is the whole story.
    // svelte-ignore state_referenced_locally
    let value = $state(options.value ?? "");
    let open = $state(true);
    /** Whether an answer was refused once: the check then runs on every change. */
    let checked = $state(false);
    const uid = $props.id();

    function check(text: string): string | undefined {
        try {
            return options.validate?.(text.trim());
        } catch (error) {
            console.error("[extensions] a prompt's validate threw", error);
            return "This answer could not be checked.";
        }
    }

    const error = $derived(checked ? check(value) : undefined);

    function answer() {
        const message = check(value);
        if (message !== undefined) {
            checked = true;
            return;
        }
        open = false;
        onanswer(value.trim());
    }

    function cancel() {
        open = false;
        onanswer(undefined);
    }
</script>

<Modal {open} title={options.title} onclose={cancel} onsubmit={answer} testId="extension-prompt">
    {#snippet body()}
        <div>
            <p class="mb-3 text-sm text-gray-500 dark:text-gray-400" data-testid="extension-prompt-from">Asked by {from}, an extension.</p>
            <label for="{uid}-field" class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400">{options.label}</label>
            <input
                id="{uid}-field"
                data-testid="extension-prompt-input"
                bind:value
                placeholder={options.placeholder}
                autocomplete="off"
                spellcheck="false"
                aria-invalid={error !== undefined}
                aria-describedby={error !== undefined ? `${uid}-error` : undefined}
                class="block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-950 focus:border-gray-950 focus:ring-1 focus:ring-gray-950 focus:outline-none dark:border-gray-700 dark:bg-white/10 dark:text-gray-100 dark:focus:border-gray-400 dark:focus:ring-gray-400"
            />
            {#if error !== undefined}
                <p id="{uid}-error" class="mt-1.5 text-sm text-red-600 dark:text-red-400" data-testid="extension-prompt-error">{error}</p>
            {/if}
        </div>
    {/snippet}

    {#snippet footer()}
        <button
            type="button"
            onclick={cancel}
            class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300">Cancel</button
        >
        <button
            type="submit"
            data-testid="extension-prompt-submit"
            class="rounded-lg bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200"
            >{options.submitLabel ?? "OK"}</button
        >
    {/snippet}
</Modal>
