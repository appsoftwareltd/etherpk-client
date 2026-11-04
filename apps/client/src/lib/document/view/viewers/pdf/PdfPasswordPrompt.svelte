<script lang="ts">
    /**
     * The password that opens a PDF, asked for each time it opens and never stored. The tick asks for
     * a copy without it: the original stays locked, because an Asset never changes.
     */
    let {
        name,
        wrong,
        folderGraph,
        onsubmit,
    }: { name: string; wrong: boolean; folderGraph: boolean; onsubmit: (password: string, removeIt: boolean) => void } = $props();

    let password = $state("");
    let removeIt = $state(false);

    function submit(event: SubmitEvent) {
        event.preventDefault();
        if (password !== "") onsubmit(password, removeIt);
    }

    const focusField = (input: HTMLInputElement) => input.focus();
</script>

<div class="flex flex-1 items-center justify-center p-6">
    <form class="flex w-full max-w-sm flex-col gap-3" onsubmit={submit} data-testid="pdf-password-prompt">
        <p class="text-sm text-(--gk-text-default)">
            <span class="font-medium text-(--gk-text-strong)">{name}</span> is protected with a password.
        </p>
        <div class="flex flex-col gap-1">
            <label class="text-sm font-medium text-(--gk-text-default)" for="pdf-password">Password</label>
            <input
                id="pdf-password"
                {@attach focusField}
                type="password"
                autocomplete="off"
                class="rounded-lg border border-gray-300 bg-(--gk-surface-0) px-2 py-1.5 text-sm text-(--gk-text-default) dark:border-gray-700"
                bind:value={password}
                aria-invalid={wrong}
                aria-describedby={wrong ? "pdf-password-error" : undefined}
                data-testid="pdf-password-input"
            />
            {#if wrong}
                <p id="pdf-password-error" class="text-sm text-red-700 dark:text-red-400" role="alert" data-testid="pdf-password-error">That password is not right. Try again.</p>
            {/if}
        </div>
        <label class="flex items-start gap-2 text-sm text-(--gk-text-default)">
            <input type="checkbox" class="mt-0.5" bind:checked={removeIt} data-testid="pdf-password-remove" />
            <span>
                Save a copy without the password. This PDF stays locked.
                {#if folderGraph}The copy sits unlocked in your folder if you add it to the graph.{/if}
            </span>
        </label>
        <div>
            <button
                type="submit"
                class="rounded-lg bg-(--gk-accent) px-3 py-1.5 text-sm font-medium text-(--gk-surface-0) hover:bg-(--gk-accent-hover) disabled:opacity-60"
                disabled={password === ""}
                data-testid="pdf-password-submit">Open</button
            >
        </div>
    </form>
</div>
