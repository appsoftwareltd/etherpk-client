<script lang="ts">
    /**
     * The dialog behind a trash click on an [[Asset Reference]] (ADR 0054).
     *
     * It shows one of two things, decided entirely by the plan it is handed — it makes no
     * judgement of its own:
     *
     * - **The last reference.** Removing it destroys the bytes for good, so the primary action
     *   says so and is styled destructively.
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

    let {
        prompt,
        onchoose,
        onopendocument,
    }: {
        prompt: AssetDeletePrompt;
        onchoose: (choice: AssetDeleteChoice) => void;
        /** Open a document holding one of the other references. */
        onopendocument: (concept: string) => void;
    } = $props();

    const plan = $derived(prompt.plan);
    /** Documents other than the one the user is looking at cannot be told apart here, so all are listed. */
    const others = $derived(plan.documents);

    /** Why the bytes are staying, in the user's terms. Only ever read when deleteBytes is false. */
    const reason = $derived.by(() => {
        switch (plan.blockedBy) {
            case "used-elsewhere":
                return `This file is used in ${plan.references} places, so it cannot be deleted yet. You can remove it from here, and it stays where it is used.`;
            case "index-building":
                return "This graph is still being indexed, so we cannot yet tell whether anything else uses this file. You can remove it from here now, and delete it once indexing finishes.";
            case "offline":
                return "You are offline, so another device may have added a reference we have not seen. You can remove it from here now, and delete it once you are back online.";
            case "behind":
                return "This graph is still catching up with the server, so another member may have added a reference we have not seen. You can remove it from here now, and delete it once it has caught up.";
            case "protected-unread": {
                // A protected document is ciphertext to everything but the unlocked session, so a
                // reference inside one cannot be ruled out until it is read.
                const n = plan.unreadProtected ?? 1;
                return `${n === 1 ? "A protected document" : `${n} protected documents`} could not be read, so we cannot tell whether ${n === 1 ? "it uses" : "one of them uses"} this file. You can remove it from here now. If protected documents are locked, unlock them and try again; a document another member protected cannot be read on this device.`;
            }
            default:
                return "This file cannot be deleted right now. You can remove it from here instead.";
        }
    });
</script>

<Dialog open={true} title="Delete this file?" testId="delete-asset-dialog" onclose={() => onchoose("cancel")}>
    {#snippet body()}
        <p class="text-sm text-gray-600 dark:text-gray-400" data-testid="delete-asset-name">
            <span class="font-medium text-gray-900 dark:text-gray-100">{prompt.name}</span>
        </p>

        {#if plan.deleteBytes}
            <p class="text-sm text-gray-600 dark:text-gray-400" data-testid="delete-asset-message">
                This is the only place it is used. Deleting removes it from this document and deletes the
                file itself. This cannot be undone.
            </p>
        {:else}
            <p class="text-sm text-gray-600 dark:text-gray-400" data-testid="delete-asset-message">
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
                            >{#if document.references > 1}<span class="text-gray-500 dark:text-gray-400">
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
            class="rounded-lg px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10"
            onclick={() => onchoose("cancel")}>Cancel</button
        >
        <button
            type="button"
            data-testid="delete-asset-unlink"
            class="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
            onclick={() => onchoose("unlink")}>Remove from this document</button
        >
        {#if plan.deleteBytes}
            <button
                type="button"
                data-testid="delete-asset-confirm"
                class="rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-500"
                onclick={() => onchoose("delete")}>Delete permanently</button
            >
        {/if}
    {/snippet}
</Dialog>
