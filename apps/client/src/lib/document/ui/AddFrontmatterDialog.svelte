<script lang="ts">
    /**
     * The dialog behind **Add frontmatter…**: which of the keys EtherPK reads to lay out at the
     * top of a document. Each is written with a value that changes nothing until it is edited
     * (ADR 0108), so ticking a key costs nothing and the person can fill it in now or later.
     *
     * States: keys to choose from (a key the block already names is shown ticked and locked,
     * with the reason beside it), nothing ticked (Add has nothing to do, and the dialog says so
     * in place), a failed write (the message, with the choice kept), and a document that
     * already has every key.
     */
    import Dialog from "@appsoftwareltd/etherpk-shared/dialog";

    import type { AddableKey, AddFrontmatterChoice } from "../frontmatter/add-frontmatter";

    let {
        concept,
        choices,
        initial,
        onadd,
        onclose,
    }: {
        concept: string;
        choices: AddFrontmatterChoice[];
        /** The keys to tick when the dialog opens: the last choice on this device. */
        initial: readonly AddableKey[];
        onadd: (keys: AddableKey[]) => Promise<void>;
        onclose: () => void;
    } = $props();

    // svelte-ignore state_referenced_locally
    let ticked = $state<AddableKey[]>(initial.filter((key) => choices.some((c) => c.key === key && !c.present)));
    let adding = $state(false);
    let addError = $state<string | null>(null);

    const missing = $derived(choices.filter((c) => !c.present));
    const toAdd = $derived(missing.filter((c) => ticked.includes(c.key)).map((c) => c.key));
    const firstEnabled = $derived(missing[0]?.key);

    function toggle(key: AddableKey, on: boolean): void {
        ticked = on ? [...new Set([...ticked, key])] : ticked.filter((k) => k !== key);
    }

    async function add(): Promise<void> {
        // Guarded here as well as on the button: Enter in the form reaches this too.
        if (adding || toAdd.length === 0) return;
        adding = true;
        addError = null;
        try {
            await onadd(toAdd);
            onclose();
        } catch (error) {
            addError = error instanceof Error ? error.message : String(error);
        } finally {
            adding = false;
        }
    }

    /**
     * Enter on a checkbox adds, as it does in a text field: every control here is a checkbox,
     * and a browser does not submit a form from one.
     */
    function onKeydown(event: KeyboardEvent): void {
        if (event.key !== "Enter" || event.isComposing) return;
        event.preventDefault();
        void add();
    }

    /**
     * A summary with its `code` spans marked, as the key list writes them. Each part is keyed by
     * its place in the sentence, which never changes for a given summary.
     */
    function segments(summary: string): { id: string; text: string; code: boolean }[] {
        return summary.split("`").map((text, i) => ({ id: `${i}`, text, code: i % 2 === 1 }));
    }
</script>

<Dialog open={true} title="Add frontmatter" testId="add-frontmatter-dialog" busy={adding} busyReason="Adding…" {onclose} onsubmit={() => void add()}>
    {#snippet body()}
        <p class="text-sm text-gray-600 dark:text-gray-400">
            Adds the keys EtherPK reads to the top of
            <span class="font-medium text-gray-900 dark:text-gray-100">{concept}</span>. Each starts with a value that changes nothing, so you can fill it in now, later, or not at all.
        </p>
        {#if missing.length === 0}
            <p class="text-sm text-gray-600 dark:text-gray-400" data-testid="add-frontmatter-complete">This document already has every key EtherPK reads.</p>
        {:else}
            <fieldset class="space-y-3" data-testid="add-frontmatter-keys">
                <legend class="sr-only">Keys to add</legend>
                {#each choices as choice (choice.key)}
                    <label class="flex items-start gap-2 text-sm text-gray-950 dark:text-gray-100">
                        <input
                            type="checkbox"
                            class="mt-1 shrink-0"
                            checked={choice.present || ticked.includes(choice.key)}
                            disabled={choice.present}
                            data-autofocus={choice.key === firstEnabled ? "" : undefined}
                            aria-describedby="add-frontmatter-summary-{choice.key}"
                            onchange={(e) => toggle(choice.key, (e.currentTarget as HTMLInputElement).checked)}
                            onkeydown={onKeydown}
                            data-testid="add-frontmatter-key-{choice.key}"
                        />
                        <span>
                            <code class="font-medium">{choice.key}</code>
                            {#if choice.present}
                                <span class="text-gray-500 dark:text-gray-400" data-testid="add-frontmatter-present-{choice.key}">Already in this document</span>
                            {/if}
                            <br />
                            <span id="add-frontmatter-summary-{choice.key}" class="text-gray-600 dark:text-gray-400">
                                {#each segments(choice.summary) as part (part.id)}{#if part.code}<code>{part.text}</code>{:else}{part.text}{/if}{/each}
                            </span>
                        </span>
                    </label>
                {/each}
            </fieldset>
            {#if toAdd.length === 0}
                <p class="text-sm text-gray-600 dark:text-gray-400" data-testid="add-frontmatter-nothing-ticked">Tick a key to add it.</p>
            {/if}
        {/if}
        {#if addError}<p role="alert" class="text-sm text-red-700 dark:text-red-300" data-testid="add-frontmatter-error">{addError}</p>{/if}
    {/snippet}

    {#snippet footer()}
        <button type="button" class="rounded-lg px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10" onclick={onclose}>{missing.length === 0 ? "Close" : "Cancel"}</button>
        {#if missing.length > 0}
            <button type="submit" class="rounded-lg bg-gray-900 dark:bg-gray-100 px-3 py-2 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-50" disabled={toAdd.length === 0 || adding} data-testid="add-frontmatter-add">{adding ? "Adding…" : "Add"}</button>
        {/if}
    {/snippet}
</Dialog>
