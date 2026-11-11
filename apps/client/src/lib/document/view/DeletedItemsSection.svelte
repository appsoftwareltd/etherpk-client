<script lang="ts">
    /**
     * The Deleted section of All Documents (ADR 0184): the [[Deleted Document]]s and [[Deleted
     * Asset]]s a synced graph still keeps, each with when it will be removed, a restore, and a way
     * to remove it for good.
     *
     * Collapsed until asked for, then loaded: a deleted document's name is in its newest version,
     * which has to be fetched and opened, so the list is not read on every visit to All Documents.
     * A restore is safe and asks nothing. Removing for good cannot be undone, so it asks in place,
     * naming what goes.
     */
    import { getActiveLayoutController } from "#lib/layout/index.js";
    import { formatBytes } from "@appsoftwareltd/etherpk-shared";
    import { VersionApiError } from "#lib/sync/version-history/version-api.js";
    import { policyNotice, removalNotice, restoredMessage, restoreRefusal } from "#lib/sync/version-history/version-history-copy.js";
    import type { DeletedListing, VersionHistory } from "#lib/sync/version-history/version-history.js";

    let { history }: { history: VersionHistory } = $props();

    type Listing = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; listing: DeletedListing };

    let open = $state(false);
    let shown = $state.raw<Listing>({ kind: "idle" });
    let slow = $state(false);
    /** The row whose action is running, so one row cannot be acted on twice at once. */
    let busy = $state<string | null>(null);
    /** The row whose remove-for-good is asking. */
    let armed = $state<string | null>(null);
    /** A deleted document whose name another document has taken: the name to restore it under. */
    let renaming = $state<{ docId: string; taken: string; name: string; error: string | null } | null>(null);
    let outcome = $state<{ tone: "done" | "error"; text: string; open?: string } | null>(null);

    const dayFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

    function describe(error: unknown, doing: string): string {
        if (error instanceof VersionApiError) {
            if (error.code === "quota_denied") return `Could not ${doing}: the graph owner's plan does not allow changes at the moment.`;
            if (error.status === 404) return `Could not ${doing}: the Sync Server no longer holds it.`;
            return `Could not ${doing}: ${error.message}`;
        }
        if (error instanceof Error && error.name === "VersionApiUnavailableError") {
            return `Could not ${doing}: the Sync Server could not be reached. Check the connection and try again.`;
        }
        return `Could not ${doing}: ${(error as Error)?.message ?? "an unknown error"}.`;
    }

    function nameOf(identity: DeletedListing["documents"][number]["identity"]): string {
        if (!identity) return "A deleted document";
        return identity.kind === "journal" ? (identity.date ?? "A journal entry") : (identity.title ?? "A deleted page");
    }

    let loads = 0;
    async function load(): Promise<void> {
        const load = ++loads;
        if (shown.kind !== "ready") shown = { kind: "loading" };
        slow = false;
        const timer = setTimeout(() => (slow = true), 300);
        try {
            const listing = await history.deleted();
            if (load === loads) shown = { kind: "ready", listing };
        } catch (error) {
            if (load === loads) shown = { kind: "error", message: describe(error, "list what was deleted") };
        } finally {
            clearTimeout(timer);
        }
    }

    function toggle(): void {
        open = !open;
        if (open) void load();
    }

    async function restoreDocument(docId: string, versionId: string, name?: string): Promise<void> {
        if (busy) return;
        busy = docId;
        outcome = null;
        try {
            const result = await history.restore(docId, versionId, name === undefined ? undefined : { name });
            if (result.kind === "restored") {
                renaming = null;
                outcome = { tone: "done", text: restoredMessage(`Restored ${result.concept}.`, result.missingAssets.length), open: result.concept };
                await load();
            } else if (result.kind === "name-taken") {
                askForName(docId, result.name);
            } else {
                outcome = { tone: "error", text: restoreRefusal(result.kind) };
            }
        } catch (error) {
            outcome = { tone: "error", text: describe(error, "restore it") };
        } finally {
            busy = null;
        }
    }

    /** The name a deleted document needs is taken: ask for another, or say the one given is taken too. */
    function askForName(docId: string, taken: string): void {
        renaming =
            renaming?.docId === docId
                ? { ...renaming, error: `"${taken}" is taken too. Choose another name.` }
                : { docId, taken, name: `${taken} (restored)`, error: null };
    }

    function submitRename(event: SubmitEvent, versionId: string): void {
        event.preventDefault();
        if (!renaming) return;
        const name = renaming.name.trim();
        if (name === "") {
            renaming = { ...renaming, error: "Enter a name for the restored page." };
            return;
        }
        void restoreDocument(renaming.docId, versionId, name);
    }

    async function removeDocument(docId: string, name: string): Promise<void> {
        if (busy) return;
        busy = docId;
        outcome = null;
        try {
            await history.removeHistory(docId);
            armed = null;
            outcome = { tone: "done", text: `Removed ${name} for good.` };
            await load();
        } catch (error) {
            outcome = { tone: "error", text: describe(error, `remove ${name}`) };
        } finally {
            busy = null;
        }
    }

    async function restoreAsset(assetId: string, name: string): Promise<void> {
        if (busy) return;
        busy = assetId;
        outcome = null;
        try {
            const result = await history.restoreAsset(assetId);
            outcome =
                result === "gone"
                    ? { tone: "error", text: `Could not restore ${name}: it has been removed for good.` }
                    : { tone: "done", text: `Restored ${name}. Documents that show it show it again.` };
            await load();
        } catch (error) {
            outcome = { tone: "error", text: describe(error, `restore ${name}`) };
        } finally {
            busy = null;
        }
    }

    async function removeAsset(assetId: string, name: string): Promise<void> {
        if (busy) return;
        busy = assetId;
        outcome = null;
        try {
            await history.removeAssetForGood(assetId);
            armed = null;
            outcome = { tone: "done", text: `Removed ${name} for good.` };
            await load();
        } catch (error) {
            outcome = { tone: "error", text: describe(error, `remove ${name}`) };
        } finally {
            busy = null;
        }
    }

    /** The Client's monotone buttons (`controls.css`), which follow the theme and recede by colour when disabled. */
    const buttonClass = "gk-button pointer-coarse:min-h-11";
    /** The one action that confirms a removal. */
    const confirmClass = "gk-button gk-button--primary pointer-coarse:min-h-11";
</script>

<section class="border-t border-(--gk-border-soft) pt-2" data-testid="deleted-items">
    <button
        type="button"
        class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-(--gk-text-default) hover:bg-(--gk-surface-2) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--gk-accent)"
        aria-expanded={open}
        aria-controls="deleted-items-body"
        onclick={toggle}
        data-testid="deleted-items-toggle"
    >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        Deleted documents and files
    </button>

    {#if open}
        <div id="deleted-items-body" class="space-y-2 px-2 pt-2">
            {#if shown.kind === "loading" || shown.kind === "idle"}
                <p class="text-sm text-(--gk-text-muted)" aria-live="polite">{slow ? "Loading what was deleted…" : ""}</p>
            {:else if shown.kind === "error"}
                <p class="text-sm text-red-700 dark:text-red-400" role="alert" data-testid="deleted-items-error">{shown.message}</p>
                <button type="button" class={buttonClass} onclick={() => void load()} data-testid="deleted-items-retry">Try again</button>
            {:else}
                <p class="text-sm text-(--gk-text-muted)" data-testid="deleted-items-policy">{policyNotice(shown.listing.policy)}</p>
                {#if shown.listing.documents.length === 0 && shown.listing.assets.length === 0}
                    <p class="text-sm text-(--gk-text-muted)" data-testid="deleted-items-empty">Nothing deleted is being kept.</p>
                {/if}
                <ul class="space-y-1">
                    {#each shown.listing.documents as doc (doc.docId)}
                        {@const name = nameOf(doc.identity)}
                        <li class="rounded-md px-2 py-1.5 hover:bg-(--gk-surface-1)" data-testid="deleted-document">
                            <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                                <span class="min-w-0 flex-1 truncate text-sm text-(--gk-text-strong)" data-testid="deleted-document-name">{name}</span>
                                <span class="text-sm text-(--gk-text-muted)">
                                    {doc.deletedAt ? `Deleted ${dayFormat.format(new Date(doc.deletedAt))} · ` : ""}{removalNotice(doc.removeAt)}
                                </span>
                            </div>
                            {#if renaming?.docId === doc.docId}
                                <form class="mt-2 flex flex-wrap items-start gap-2" onsubmit={(event) => submitRename(event, doc.newestVersionId)}>
                                    <label class="w-full text-sm text-(--gk-text-default)" for="deleted-rename-{doc.docId}">
                                        Another document is now called "{renaming.taken}". Restore it as:
                                    </label>
                                    <!-- svelte-ignore a11y_autofocus -->
                                    <input
                                        id="deleted-rename-{doc.docId}"
                                        autofocus
                                        class="min-w-40 flex-1 rounded-lg border border-(--gk-border-soft) bg-(--gk-surface-0) px-2 py-1 text-sm text-(--gk-text-default)"
                                        bind:value={renaming.name}
                                        aria-invalid={renaming.error !== null}
                                        aria-describedby={renaming.error ? `deleted-rename-error-${doc.docId}` : undefined}
                                        onkeydown={(event) => event.key === "Escape" && (renaming = null)}
                                        data-testid="deleted-rename-input"
                                    />
                                    <button type="submit" class={buttonClass} disabled={busy !== null} data-testid="deleted-rename-submit">Restore</button>
                                    <button type="button" class={buttonClass} onclick={() => (renaming = null)}>Cancel</button>
                                    {#if renaming.error}
                                        <p id="deleted-rename-error-{doc.docId}" class="w-full text-sm text-red-700 dark:text-red-400" role="alert">{renaming.error}</p>
                                    {/if}
                                </form>
                            {:else if armed === doc.docId}
                                <div class="mt-2 flex flex-wrap items-center gap-2" role="group" aria-label="Remove {name} for good">
                                    <p class="w-full text-sm text-(--gk-text-default)">Remove {name} and every earlier version of it for good? This cannot be undone.</p>
                                    <button
                                        type="button"
                                        class={confirmClass}
                                        disabled={busy !== null}
                                        onclick={() => void removeDocument(doc.docId, name)}
                                        data-testid="deleted-document-remove-submit">Remove for good</button
                                    >
                                    <button type="button" class={buttonClass} onclick={() => (armed = null)}>Cancel</button>
                                </div>
                            {:else}
                                <div class="mt-1 flex flex-wrap items-center gap-3">
                                    <button
                                        type="button"
                                        class={buttonClass}
                                        disabled={busy !== null}
                                        onclick={() => void restoreDocument(doc.docId, doc.newestVersionId)}
                                        data-testid="deleted-document-restore">{busy === doc.docId ? "Restoring…" : "Restore"}</button
                                    >
                                    <button type="button" class={buttonClass} disabled={busy !== null} onclick={() => (armed = doc.docId)} data-testid="deleted-document-remove"
                                        >Remove for good…</button
                                    >
                                </div>
                            {/if}
                        </li>
                    {/each}
                    {#each shown.listing.assets as asset (asset.assetId)}
                        {@const name = asset.name ?? "A deleted file"}
                        <li class="rounded-md px-2 py-1.5 hover:bg-(--gk-surface-1)" data-testid="deleted-asset">
                            <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                                <span class="min-w-0 flex-1 truncate text-sm text-(--gk-text-strong)" data-testid="deleted-asset-name">{name}</span>
                                <span class="text-sm text-(--gk-text-muted)">
                                    {formatBytes(asset.size)} · Deleted {dayFormat.format(new Date(asset.deletedAt))} · {removalNotice(asset.removeAt)}
                                </span>
                            </div>
                            {#if armed === asset.assetId}
                                <div class="mt-2 flex flex-wrap items-center gap-2" role="group" aria-label="Remove {name} for good">
                                    <p class="w-full text-sm text-(--gk-text-default)">Remove {name} for good? Any version that shows it will show it as missing. This cannot be undone.</p>
                                    <button
                                        type="button"
                                        class={confirmClass}
                                        disabled={busy !== null}
                                        onclick={() => void removeAsset(asset.assetId, name)}
                                        data-testid="deleted-asset-remove-submit">Remove for good</button
                                    >
                                    <button type="button" class={buttonClass} onclick={() => (armed = null)}>Cancel</button>
                                </div>
                            {:else}
                                <div class="mt-1 flex flex-wrap items-center gap-3">
                                    <button
                                        type="button"
                                        class={buttonClass}
                                        disabled={busy !== null}
                                        onclick={() => void restoreAsset(asset.assetId, name)}
                                        data-testid="deleted-asset-restore">{busy === asset.assetId ? "Restoring…" : "Restore"}</button
                                    >
                                    <button type="button" class={buttonClass} disabled={busy !== null} onclick={() => (armed = asset.assetId)} data-testid="deleted-asset-remove"
                                        >Remove for good…</button
                                    >
                                </div>
                            {/if}
                        </li>
                    {/each}
                </ul>
            {/if}
            {#if outcome}
                <p
                    class={["text-sm", outcome.tone === "error" ? "text-red-700 dark:text-red-400" : "text-(--gk-text-default)"]}
                    role={outcome.tone === "error" ? "alert" : "status"}
                    data-testid="deleted-items-outcome"
                >
                    {outcome.text}
                    {#if outcome.open}
                        {@const target = outcome.open}
                        <button
                            type="button"
                            class="ml-1 text-(--gk-accent) underline underline-offset-2"
                            onclick={() => getActiveLayoutController().openView({ kind: "document", target })}
                            data-testid="deleted-items-open">Open it</button
                        >
                    {/if}
                </p>
            {/if}
        </div>
    {/if}
</section>
