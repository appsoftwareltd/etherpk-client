<script lang="ts">
    /**
     * One command for an agent's computer, to copy: its label, the command, a copy button, a note,
     * and a failed copy's message beside the button that failed. Used by a graph's Agents tab and
     * the Graphs page's Agents tab alike (ADR 0147).
     */
    const { key, label, text, note }: { key: string; label: string; text: string; note: string } = $props();

    let copied = $state(false);
    let failed = $state(false);

    async function copy() {
        failed = false;
        try {
            await navigator.clipboard.writeText(text);
            copied = true;
            setTimeout(() => (copied = false), 2000);
        } catch {
            // No clipboard (an insecure context, a denied permission): the text is on screen
            // and selectable, so say that rather than failing silently.
            failed = true;
        }
    }
</script>

<span class="text-sm font-medium">{label}</span>
<div class="flex items-start gap-2">
    <pre class="min-w-0 flex-1 overflow-x-auto rounded-md border border-gray-900/10 dark:border-gray-100/15 bg-gray-50 dark:bg-white/5 p-3 font-mono text-sm" data-testid="agents-extra-{key}">{text}</pre>
    <button
        type="button"
        onclick={copy}
        class="shrink-0 rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-950 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800"
        data-testid="agents-copy-{key}">{copied ? "Copied" : "Copy"}</button
    >
</div>
<p class="text-sm text-gray-500 dark:text-gray-400">{note}</p>
{#if failed}
    <p role="status" class="text-sm text-red-700 dark:text-red-400">Couldn't copy - select the command and copy it by hand.</p>
{/if}
