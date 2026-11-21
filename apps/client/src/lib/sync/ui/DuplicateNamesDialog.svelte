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
        <p class="text-sm text-neutral-600 dark:text-neutral-300">{duplicateNoticeMessage(names)}</p>
        <p class="text-sm text-neutral-600 dark:text-neutral-300">
            Review shows them in Settings, where you can merge each set into one document.
        </p>
    {/snippet}
    {#snippet footer()}
        <button
            type="button"
            onclick={onclose}
            class="gk-button"
            data-testid="duplicate-names-not-now">Not now</button
        >
        <button
            type="submit"
            data-autofocus
            class="gk-button gk-button--primary"
            data-testid="duplicate-names-review">Review</button
        >
    {/snippet}
</Dialog>
