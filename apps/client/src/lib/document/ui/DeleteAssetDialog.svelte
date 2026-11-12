<script lang="ts">
    /**
     * The dialog behind a trash click on an [[Asset Reference]] (ADR 0054).
     *
     * It shows one of two things, decided entirely by the plan it is handed — it makes no
     * judgement of its own:
     *
     * - **The last reference.** Removing it deletes the file: for good on a Filesystem graph, and
     *   for the retention period on a synced one (ADR 0184), which the message says. The primary
     *   action is styled destructively. When protected documents went unchecked (locked, or
     *   their text could not be read), a warning says so above the button, and the delete is still
     *   offered.
     * - **Anything else.** The bytes are staying. The dialog says why, names the documents
     *   holding the other references (each one navigable, so the refusal is a route forward
     *   rather than a dead end), and offers only to remove the reference in front of the user.
     *
     * The two paths deliberately do NOT share a button: "Delete" and "Remove this reference"
     * are different actions with different consequences, and one button whose meaning changes
     * with the state behind it is how someone destroys a file they meant to unlink.
     */
    import Dialog from "@appsoftwareltd/etherpk-shared/dialog";

    import type { AssetDeleteChoice, AssetDeletePrompt } from "../commands/asset-commands";
    import { deleteOutcomeSentence } from "#lib/sync/version-history/kept-copy.js";

    let {
        prompt,
        onchoose,
        onopendocument,
        keptDays,
    }: {
        prompt: AssetDeletePrompt;
        onchoose: (choice: AssetDeleteChoice) => void;
        /** Open a document holding one of the other references. */
        onopendocument: (concept: string) => void;
        /** How long a synced graph keeps a deleted file (ADR 0184); absent on a Filesystem graph. */
        keptDays?: number | "unknown";
    } = $props();

    const plan = $derived(prompt.plan);
    /** Documents other than the one the user is looking at cannot be told apart here, so all are listed. */
    const others = $derived(plan.documents);

    /** Why the bytes are staying, in the user's terms. Only ever read when deleteBytes is false. */
    const reason = $derived.by(() => {
        switch (plan.blockedBy) {
            case "used-elsewhere":
                return (
                    `This file is used in ${plan.references} places, so it cannot be deleted yet. You can remove it from here, and it stays where it is used.` +
                    (plan.quickNotes ? ` ${plan.quickNotes === 1 ? "One of them is a quick note." : `${plan.quickNotes} of them are quick notes.`}` : "")
                );
            case "index-building":
                return "This graph is still being indexed, so we cannot yet tell whether anything else uses this file. You can remove it from here now, and delete it once indexing finishes.";
            case "offline":
                return "You are offline, so another device may have added a reference we have not seen. You can remove it from here now, and delete it once you are back online.";
            case "behind":
                return "This graph is still catching up with the server, so another member may have added a reference we have not seen. You can remove it from here now, and delete it once it has caught up.";
            default:
                return "This file cannot be deleted right now. You can remove it from here instead.";
        }
    });

    /**
     * The warning for protected documents that went unchecked: locked, or their stored text could
     * not be read. A reference inside one would be left pointing at nothing, which is the person's
     * call to make, not a refusal.
     */
    const uncheckedWarning = $derived.by(() => {
        const locked = plan.lockedProtected ?? 0;
        const unread = plan.unreadProtected ?? 0;
        if (locked + unread === 0) return null;
        const causes = [
            locked > 0 ? (locked === 1 ? "a protected document is locked" : `${locked} protected documents are locked`) : null,
            unread > 0 ? (unread === 1 ? "a protected document could not be read" : `${unread} protected documents could not be read`) : null,
        ].filter((cause): cause is string => cause !== null);
        const one = locked + unread === 1;
        const text = `${causes.join(" and ")}, so we could not check whether ${one ? "it uses" : "they use"} this file. If ${one ? "it does" : "one does"}, the file will be missing there.`;
        return text.charAt(0).toUpperCase() + text.slice(1);
    });
</script>

<Dialog open={true} title="Delete this file?" testId="delete-asset-dialog" onclose={() => onchoose("cancel")}>
    {#snippet body()}
        <p class="text-sm text-neutral-600 dark:text-neutral-400" data-testid="delete-asset-name">
            <span class="font-medium text-neutral-900 dark:text-neutral-100">{prompt.name}</span>
        </p>

        {#if plan.deleteBytes}
            <p class="text-sm text-neutral-600 dark:text-neutral-400" data-testid="delete-asset-message">
                {#if !uncheckedWarning}This is the only place it is used.{/if} Deleting removes it from this document
                and deletes the file itself. {deleteOutcomeSentence(keptDays)}
            </p>
            {#if uncheckedWarning}
                <p
                    class="rounded-lg border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-950/20 p-3 text-sm text-amber-900 dark:text-amber-200"
                    data-testid="delete-asset-unchecked-warning"
                >
                    {uncheckedWarning}
                </p>
            {/if}
        {:else}
            <p class="text-sm text-neutral-600 dark:text-neutral-400" data-testid="delete-asset-message">
                {reason}
            </p>

            {#if others.length > 0}
                <ul class="space-y-1 text-sm" data-testid="delete-asset-usage">
                    {#each others as document (document.concept)}
                        <li>
                            <button
                                type="button"
                                class="text-left text-[var(--gk-accent,#007ACC)] underline underline-offset-2 hover:opacity-80"
                                onclick={() => onopendocument(document.concept)}
                            >{document.concept}</button
                            >{#if document.references > 1}<span class="text-neutral-500 dark:text-neutral-400">
                                    &nbsp;({document.references} times)</span
                                >{/if}
                        </li>
                    {/each}
                </ul>
            {/if}
        {/if}
    {/snippet}

    {#snippet footer()}
        <button
            type="button"
            class="rounded-lg px-3 py-2 text-sm font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-white/10"
            onclick={() => onchoose("cancel")}>Cancel</button
        >
        <button
            type="button"
            data-testid="delete-asset-unlink"
            class="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-white/5"
            onclick={() => onchoose("unlink")}>Remove from this document</button
        >
        {#if plan.deleteBytes}
            <button
                type="button"
                data-testid="delete-asset-confirm"
                class="rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-500"
                onclick={() => onchoose("delete")}>{keptDays === undefined || keptDays === 0 ? "Delete permanently" : "Delete"}</button
            >
        {/if}
    {/snippet}
</Dialog>
