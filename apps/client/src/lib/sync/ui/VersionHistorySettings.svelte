<script lang="ts">
    /**
     * Graph Settings' part of [[Version History]] (ADR 0184): how much the graph keeps, how long
     * for, a shorter period waiting to apply after a change of plan, and the Owner's control to
     * remove all of it for good.
     *
     * Removing it all cannot be undone and reaches every member's history, so the person types a
     * word to confirm, not only a click.
     */
    import { onMount } from "svelte";
    import { formatBytes, type VersionPolicy } from "@appsoftwareltd/etherpk-shared";
    import { VersionApiError } from "#lib/sync/version-history/version-api.js";
    import { policyNotice } from "#lib/sync/version-history/version-history-copy.js";
    import type { VersionHistory } from "#lib/sync/version-history/version-history.js";

    let {
        history,
        keptBytes,
        owner,
        onremoved,
    }: {
        history: VersionHistory;
        /** Bytes the graph keeps for Version History, when the server reported them. */
        keptBytes: number | null;
        /** Whether this account owns the graph: only the Owner removes all of it. */
        owner: boolean;
        /** After a removal, so the dialog can read the storage figures again. */
        onremoved?: () => void;
    } = $props();

    const CONFIRM_WORD = "remove";

    let policy = $state.raw<VersionPolicy | null>(null);
    let policyError = $state(false);
    let armed = $state(false);
    let typed = $state("");
    let removing = $state(false);
    let outcome = $state<{ tone: "done" | "error"; text: string } | null>(null);

    onMount(() => {
        let current = true;
        void history.policy().then(
            (answer) => current && (policy = answer),
            () => current && (policyError = true),
        );
        return () => {
            current = false;
        };
    });

    async function removeAll(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        if (removing || typed.trim().toLowerCase() !== CONFIRM_WORD) return;
        removing = true;
        outcome = null;
        try {
            const removed = await history.removeAll();
            armed = false;
            typed = "";
            outcome = {
                tone: "done",
                text: `Removed ${removed.versions} ${removed.versions === 1 ? "version" : "versions"} and ${removed.assets} deleted ${removed.assets === 1 ? "file" : "files"}.`,
            };
            onremoved?.();
        } catch (error) {
            const reason =
                error instanceof VersionApiError && error.code === "owner_only"
                    ? "only the graph's owner can do that."
                    : error instanceof VersionApiError
                      ? error.message
                      : "the Sync Server could not be reached. Check the connection and try again.";
            outcome = { tone: "error", text: `Could not remove the history: ${reason}` };
        } finally {
            removing = false;
        }
    }
</script>

<div class="space-y-2" data-testid="version-history-settings">
    <p class="text-sm text-neutral-600 dark:text-neutral-300" data-testid="version-history-kept">
        {keptBytes === null ? "Version history" : `${formatBytes(keptBytes)} kept for version history`}: earlier versions of
        documents, and deleted documents and files, which any member can restore from a document's Version history or from
        All Documents.
    </p>
    {#if policy}
        <p class="text-sm text-neutral-500 dark:text-neutral-400" data-testid="version-history-settings-policy">{policyNotice(policy)}</p>
    {:else if policyError}
        <p class="text-sm text-neutral-500 dark:text-neutral-400">How long it is kept could not be read just now.</p>
    {/if}
    {#if owner}
        {#if armed}
            <form class="space-y-2 rounded-lg border border-(--gk-border-strong) p-3" onsubmit={(event) => void removeAll(event)}>
                <label class="block text-sm text-neutral-700 dark:text-neutral-200" for="version-history-remove-all-word">
                    Every earlier version of every document, and every deleted document and file, is removed for every member.
                    This cannot be undone. Type <strong>{CONFIRM_WORD}</strong> to confirm.
                </label>
                <!-- svelte-ignore a11y_autofocus -->
                <input
                    id="version-history-remove-all-word"
                    autofocus
                    autocomplete="off"
                    class="w-full rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                    bind:value={typed}
                    onkeydown={(event) => event.key === "Escape" && (armed = false)}
                    data-testid="version-history-remove-all-word"
                />
                <div class="flex gap-2">
                    <button
                        type="submit"
                        class="gk-button gk-button--primary"
                        disabled={removing || typed.trim().toLowerCase() !== CONFIRM_WORD}
                        data-testid="version-history-remove-all-submit">{removing ? "Removing…" : "Remove all"}</button
                    >
                    <button
                        type="button"
                        class="gk-button"
                        onclick={() => (armed = false)}>Cancel</button
                    >
                </div>
            </form>
        {:else}
            <button
                type="button"
                class="gk-button"
                onclick={() => {
                    armed = true;
                    outcome = null;
                }}
                data-testid="version-history-remove-all">Remove all version history and deleted files…</button
            >
        {/if}
    {/if}
    {#if outcome}
        <p
            class={["text-sm", outcome.tone === "error" ? "text-red-700 dark:text-red-400" : "text-neutral-600 dark:text-neutral-300"]}
            role={outcome.tone === "error" ? "alert" : "status"}
            data-testid="version-history-settings-outcome"
        >
            {outcome.text}
        </p>
    {/if}
</div>
