<script lang="ts">
    /**
     * The dialog behind `context.dialogs.choose`: one question answered by picking one of a list of
     * answers from a dropdown and confirming it, drawn like the Client's own dialogs (the shared
     * Modal) with a line naming the extension that asks, as `PromptDialog.svelte` is. A [[Kanban
     * Board]]'s Move all to lane asks where to move a lane's tasks with it (ADR 0167).
     *
     * The keyboard starts on the dropdown. Enter there confirms, as it does in a text field (a
     * browser does not submit a form from a select), Esc cancels, and the confirm button says what
     * it will do for the answer picked when the extension gives it the words.
     */
    import type { ChooseOptions } from "@appsoftwareltd/etherpk-extension-api";
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";

    const { options, from, onanswer }: { options: ChooseOptions; from: string; onanswer: (value: string | undefined) => void } = $props();

    // Mounted fresh for each question, so the first value is the whole story.
    // svelte-ignore state_referenced_locally
    let value = $state(options.choices.some((choice) => choice.value === options.value) ? options.value : options.choices[0]?.value);
    let open = $state(true);
    const uid = $props.id();

    /** The confirm button's words for the answer picked. A function that throws costs its words, never the dialog. */
    const submitLabel = $derived.by(() => {
        const label = options.submitLabel;
        if (typeof label !== "function") return label ?? "OK";
        try {
            return value === undefined ? "OK" : label(value);
        } catch (error) {
            console.error("[extensions] a choose dialog's submitLabel threw", error);
            return "OK";
        }
    });

    function answer() {
        if (value === undefined) return;
        open = false;
        onanswer(value);
    }

    function cancel() {
        open = false;
        onanswer(undefined);
    }
</script>

<Modal {open} title={options.title} onclose={cancel} onsubmit={answer} testId="extension-choose">
    {#snippet body()}
        <div>
            <p class="gk-hint mt-0 mb-3" data-testid="extension-choose-from">Asked by {from}, an extension.</p>
            {#if options.message}
                <p class="mt-0 mb-3 text-sm text-(--gk-text-default)" id="{uid}-message" data-testid="extension-choose-message">{options.message}</p>
            {/if}
            <label for="{uid}-field" class="gk-label mb-1.5 block">{options.label}</label>
            <select
                id="{uid}-field"
                class="gk-select w-full"
                bind:value
                data-autofocus=""
                aria-describedby={options.message ? `${uid}-message` : undefined}
                data-testid="extension-choose-select"
                onkeydown={(event) => {
                    if (event.key !== "Enter" || event.isComposing) return;
                    event.preventDefault();
                    answer();
                }}
            >
                {#each options.choices as choice (choice.value)}
                    <option value={choice.value}>{choice.label}</option>
                {/each}
            </select>
        </div>
    {/snippet}

    {#snippet footer()}
        <button type="button" class="gk-button" onclick={cancel} data-testid="extension-choose-cancel">Cancel</button>
        <button type="submit" class="gk-button gk-button--primary" disabled={value === undefined} data-testid="extension-choose-submit">{submitLabel}</button>
    {/snippet}
</Modal>
