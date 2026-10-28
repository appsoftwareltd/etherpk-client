<script lang="ts">
    /**
     * Said once as a Server-backed graph opens, when a name in it belongs to more than one
     * document (ADR 0157): the text in all but one of them is hidden, and Review goes to the
     * Maintenance section that merges them. Not now leaves it until the graph is opened again.
     */
    import Dialog from "@appsoftwareltd/etherpk-shared/dialog";
    import { duplicateNoticeMessage } from "./duplicate-names-copy";

    let {
        names,
        onreview,
        onclose,
    }: {
        /** How many names belong to more than one document. */
        names: number;
        onreview: () => void;
        /** Not now, Escape or the close button. */
        onclose: () => void;
    } = $props();
</script>

<Dialog open={true} title="Duplicate names" testId="duplicate-names-dialog" {onclose} onsubmit={onreview}>
    {#snippet body()}
        <p class="text-sm text-gray-600 dark:text-gray-300">{duplicateNoticeMessage(names)}</p>
        <p class="text-sm text-gray-600 dark:text-gray-300">
            Review shows them in Settings, where you can merge each set into one document.
        </p>
    {/snippet}
    {#snippet footer()}
        <button
            type="button"
            onclick={onclose}
            class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-gray-100 transition-colors"
            data-testid="duplicate-names-not-now">Not now</button
        >
        <button
            type="submit"
            data-autofocus
            class="rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
            data-testid="duplicate-names-review">Review</button
        >
    {/snippet}
</Dialog>
