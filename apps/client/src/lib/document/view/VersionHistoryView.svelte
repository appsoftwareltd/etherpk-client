<script lang="ts">
    /**
     * A document's [[Version History]] (ADR 0184): its earlier versions, newest first, a read-only
     * preview of the one selected, and the two things a person does with them: restore one, or
     * remove them all for good. The preview shows what changed since the version before, as a
     * unified diff, or the version's full text.
     *
     * The tab is addressed by the document's name, as a document tab is; the versions are the
     * document's by id, so a document renamed while the tab is open keeps its history. A restore
     * is an ordinary edit with a version made before it, so it asks no question: the version it
     * replaced is at the top of the list afterwards. Removing history cannot be undone, so it asks.
     *
     * Mounted through the dockview adapter, so its services come from the workspace accessors.
     */
    import { onMount } from "svelte";

    import type { VersionListEntry, VersionPolicy } from "@appsoftwareltd/etherpk-shared";
    import VersionDiff from "./VersionDiff.svelte";
    import { prefersMobileLayout } from "#lib/layout/breakpoint.js";
    import { getActiveLayoutController, type ViewRef } from "#lib/layout/index.js";
    import { VersionApiError } from "#lib/sync/version-history/version-api.js";
    import type { DocumentVersionPayload } from "#lib/sync/version-history/version-payload.js";
    import {
        groupByDay,
        policyNotice,
        reasonLabel,
        restoredMessage,
        restoreRefusal,
        versionMoment,
        versionTime,
        WHEN_VERSIONS_ARE_KEPT,
    } from "#lib/sync/version-history/version-history-copy.js";
    import { workspaceService } from "#lib/workspace/workspace-services.js";

    const { view }: { view: ViewRef } = $props();

    const history = workspaceService("versions");
    /** Read once: the phone shows the list and the preview as two steps. */
    const phone = prefersMobileLayout();

    type ListState =
        | { kind: "loading" }
        | { kind: "error"; message: string }
        | { kind: "ready"; versions: VersionListEntry[]; policy: VersionPolicy };
    /** The version a preview's changes are counted from: the one before it in the list. */
    type Compared =
        /** The earliest version kept: nothing to compare it with. */
        | { kind: "none" }
        | { kind: "ready"; text: string; moment: string }
        | { kind: "error" };
    type PreviewState =
        | { kind: "none" }
        | { kind: "loading"; versionId: string }
        | { kind: "error"; versionId: string; message: string }
        | { kind: "ready"; versionId: string; text: string; missing: string[]; compared: Compared };

    let list = $state.raw<ListState>({ kind: "loading" });
    /** A list load that has taken long enough to say so: a fast one never flashes "Loading". */
    let slow = $state(false);
    let preview = $state.raw<PreviewState>({ kind: "none" });
    let restoring = $state(false);
    let removeArmed = $state(false);
    let removing = $state(false);
    /** What the last action did, shown in place and announced. */
    let outcome = $state<{ tone: "done" | "error"; text: string } | null>(null);
    /** On a phone, whether the preview step is showing. */
    let showingPreview = $state(false);
    /** What the preview shows: the changes since the version before, or the whole text. */
    let shown = $state<"changes" | "text">("changes");

    const concept = $derived(view.target);
    const docId = $derived(history?.documentIdOf(concept));
    const days = $derived(list.kind === "ready" ? groupByDay(list.versions, new Date()) : []);
    /** The version the preview is about, while one is chosen. */
    const previewId = $derived(preview.kind === "none" ? null : preview.versionId);
    const selected = $derived(
        list.kind === "ready" && previewId !== null ? (list.versions.find((v) => v.versionId === previewId) ?? null) : null,
    );

    /** A failure in the person's terms: what happened, and what to do next. */
    function describe(error: unknown, doing: string): string {
        if (error instanceof VersionApiError) {
            if (error.code === "quota_denied") {
                return `Could not ${doing}: the graph owner's plan does not allow changes at the moment.`;
            }
            if (error.status === 404) return `Could not ${doing}: the Sync Server no longer holds it.`;
            return `Could not ${doing}: ${error.message}`;
        }
        if (error instanceof Error && error.name === "VersionApiUnavailableError") {
            return `Could not ${doing}: the Sync Server could not be reached. Check the connection and try again.`;
        }
        return `Could not ${doing}: ${(error as Error)?.message ?? "an unknown error"}.`;
    }

    /** Loads of the list are numbered, so an answer that arrives after a newer request is dropped. */
    let loads = 0;
    async function load(): Promise<void> {
        if (!history || !docId) return;
        const id = docId;
        const load = ++loads;
        if (list.kind !== "ready") list = { kind: "loading" };
        slow = false;
        const timer = setTimeout(() => (slow = true), 300);
        try {
            const answer = await history.list(id);
            if (load !== loads) return;
            list = { kind: "ready", versions: answer.versions, policy: answer.policy };
            // Keep the selection when it is still there, so a refresh after a restore stays put.
            if (previewId !== null && !answer.versions.some((v) => v.versionId === previewId)) {
                preview = { kind: "none" };
            }
        } catch (error) {
            if (load !== loads) return;
            list = { kind: "error", message: describe(error, "load this document's versions") };
        } finally {
            clearTimeout(timer);
            if (load === loads) slow = false;
        }
    }

    /**
     * Versions opened this session, by id. A version never changes, so stepping back and forth
     * through the list, or comparing with the one before, fetches each once.
     */
    const opened = new Map<string, Promise<DocumentVersionPayload>>();
    function openOnce(id: string, versionId: string): Promise<DocumentVersionPayload> {
        let reading = opened.get(versionId);
        if (!reading) {
            reading = history!.read(id, versionId);
            opened.set(versionId, reading);
            // A failed read is tried again next time, not remembered.
            reading.catch(() => opened.delete(versionId));
        }
        return reading;
    }

    /** The version before `version` in the list, read for the comparison; never throws. */
    async function compareWith(id: string, version: VersionListEntry): Promise<Compared> {
        const versions = list.kind === "ready" ? list.versions : [];
        const before = versions[versions.findIndex((v) => v.versionId === version.versionId) + 1];
        if (!before) return { kind: "none" };
        try {
            const payload = await openOnce(id, before.versionId);
            return { kind: "ready", text: payload.text, moment: versionMoment(before.createdAt, new Date()) };
        } catch {
            return { kind: "error" };
        }
    }

    let reads = 0;
    async function select(version: VersionListEntry): Promise<void> {
        if (!history || !docId) return;
        const id = docId;
        outcome = null;
        removeArmed = false;
        showingPreview = true;
        // Check the files again even when it is the version shown: one may have been removed since.
        const read = ++reads;
        preview = { kind: "loading", versionId: version.versionId };
        try {
            const [payload, compared] = await Promise.all([openOnce(id, version.versionId), compareWith(id, version)]);
            const missing = await history.missingAssets(payload.text);
            if (read !== reads) return;
            preview = { kind: "ready", versionId: version.versionId, text: payload.text, missing, compared };
        } catch (error) {
            if (read !== reads) return;
            preview = { kind: "error", versionId: version.versionId, message: describe(error, "open this version") };
        }
    }

    async function restore(): Promise<void> {
        if (!history || !docId || restoring || preview.kind !== "ready" || !selected) return;
        restoring = true;
        outcome = null;
        const when = versionMoment(selected.createdAt, new Date());
        try {
            const result = await history.restore(docId, preview.versionId);
            if (result.kind === "restored") {
                const lead = `Restored the version from ${when}. The text it replaced is the newest version below.`;
                outcome = { tone: "done", text: restoredMessage(lead, result.missingAssets.length) };
                await load();
            } else {
                outcome = { tone: "error", text: restoreRefusal(result.kind, result.kind === "name-taken" ? result.name : undefined) };
            }
        } catch (error) {
            outcome = { tone: "error", text: describe(error, "restore this version") };
        } finally {
            restoring = false;
        }
    }

    async function removeHistory(): Promise<void> {
        if (!history || !docId || removing) return;
        removing = true;
        outcome = null;
        try {
            await history.removeHistory(docId);
            opened.clear();
            removeArmed = false;
            preview = { kind: "none" };
            showingPreview = false;
            outcome = { tone: "done", text: `Removed the earlier versions of ${concept}.` };
            await load();
        } catch (error) {
            outcome = { tone: "error", text: describe(error, "remove the history") };
        } finally {
            removing = false;
        }
    }

    /** Up and down move through the versions, as in a list box; the one focused is shown. */
    function onRowKey(event: KeyboardEvent & { currentTarget: HTMLButtonElement }): void {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const list = event.currentTarget.closest("[data-testid='version-history-list']");
        const rows = [...(list?.querySelectorAll<HTMLButtonElement>("[data-version-row]") ?? [])];
        const at = rows.indexOf(document.activeElement as HTMLButtonElement);
        const next = rows[Math.min(rows.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))];
        if (!next) return;
        event.preventDefault();
        next.focus();
        next.click();
    }

    function openDocument(): void {
        getActiveLayoutController().openView({ kind: "document", target: concept });
    }

    onMount(() => {
        void load();
    });
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="version-history">
    {#if !history}
        <p class="p-4 text-sm text-(--gk-text-muted)" data-testid="version-history-unavailable">
            Version history is kept for synced graphs. This graph is a folder on this device: its history is whatever
            version control you keep for that folder.
        </p>
    {:else if !docId}
        <p class="p-4 text-sm text-(--gk-text-muted)" data-testid="version-history-gone">
            "{concept}" is not in this graph any more. A deleted document can be restored from All Documents.
        </p>
    {:else}
        <header class="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-(--gk-border-soft) px-4 py-3">
            <h2 class="text-base font-semibold text-(--gk-text-strong)">
                <button type="button" class="hover:underline" onclick={openDocument} data-testid="version-history-document">{concept}</button>
            </h2>
            {#if list.kind === "ready"}
                <p class="text-sm text-(--gk-text-muted)" data-testid="version-history-policy">{policyNotice(list.policy)}</p>
            {/if}
        </header>

        <div class="flex min-h-0 flex-1">
            {#if !phone || !showingPreview}
                <section
                    class={["flex min-h-0 flex-col overflow-y-auto", phone ? "flex-1" : "w-72 shrink-0 border-r border-(--gk-border-soft)"]}
                    aria-label="Versions"
                >
                    {#if list.kind === "loading"}
                        <p class="p-4 text-sm text-(--gk-text-muted)" aria-live="polite" data-testid="version-history-loading">
                            {slow ? "Loading versions…" : ""}
                        </p>
                    {:else if list.kind === "error"}
                        <div class="space-y-2 p-4" data-testid="version-history-error">
                            <p class="text-sm text-red-700 dark:text-red-400" role="alert">{list.message}</p>
                            <button type="button" class="gk-button" onclick={() => void load()} data-testid="version-history-retry">Try again</button>
                        </div>
                    {:else if list.versions.length === 0}
                        <p class="p-4 text-sm text-(--gk-text-muted)" data-testid="version-history-empty">No earlier versions yet.</p>
                    {:else}
                        <ul class="py-2" data-testid="version-history-list">
                            {#each days as day (day.label)}
                                <li>
                                    <h3 class="px-4 pt-3 pb-1 text-sm font-semibold text-(--gk-text-muted)">{day.label}</h3>
                                    <ul>
                                        {#each day.versions as version (version.versionId)}
                                            {@const current = previewId === version.versionId}
                                            <li>
                                                <button
                                                    type="button"
                                                    data-version-row
                                                    data-testid="version-history-row"
                                                    aria-current={current ? "true" : undefined}
                                                    onclick={() => void select(version)}
                                                    onkeydown={onRowKey}
                                                    class={[
                                                        "flex w-full items-baseline gap-3 px-4 py-2 text-left text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--gk-accent) pointer-coarse:min-h-11",
                                                        current ? "bg-(--gk-surface-2) text-(--gk-text-strong)" : "text-(--gk-text-default) hover:bg-(--gk-surface-1)",
                                                    ]}
                                                >
                                                    <span class="w-20 shrink-0 whitespace-nowrap tabular-nums">{versionTime(version.createdAt)}</span>
                                                    <span class="min-w-0 flex-1 truncate text-(--gk-text-muted)">{reasonLabel(version.reason)}</span>
                                                </button>
                                            </li>
                                        {/each}
                                    </ul>
                                </li>
                            {/each}
                        </ul>
                    {/if}
                    <div class="mt-auto space-y-3 border-t border-(--gk-border-soft) p-4">
                        <p class="text-sm text-(--gk-text-muted)" data-testid="version-history-when">{WHEN_VERSIONS_ARE_KEPT}</p>
                        {#if removeArmed}
                            <div class="space-y-2" role="group" aria-label="Remove history" data-testid="version-history-remove-confirm">
                                <p class="text-sm text-(--gk-text-default)">
                                    Remove every earlier version of {concept} for good? The document itself stays as it is. This
                                    cannot be undone.
                                </p>
                                <div class="flex gap-2">
                                    <button
                                        type="button"
                                        class="gk-button gk-button--primary pointer-coarse:min-h-11"
                                        disabled={removing}
                                        onclick={() => void removeHistory()}
                                        data-testid="version-history-remove-submit">{removing ? "Removing…" : "Remove"}</button
                                    >
                                    <button
                                        type="button"
                                        class="gk-button pointer-coarse:min-h-11"
                                        onclick={() => (removeArmed = false)}
                                        onkeydown={(event) => event.key === "Escape" && (removeArmed = false)}>Cancel</button
                                    >
                                </div>
                            </div>
                        {:else}
                            <!-- Disabled with nothing to remove: the list above says there are no versions. -->
                            <button
                                type="button"
                                class="gk-button pointer-coarse:min-h-11"
                                disabled={list.kind !== "ready" || list.versions.length === 0}
                                onclick={() => (removeArmed = true)}
                                data-testid="version-history-remove">Remove history…</button
                            >
                        {/if}
                    </div>
                </section>
            {/if}

            {#if !phone || showingPreview}
                <section class="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Preview" data-testid="version-history-preview">
                    {#if phone}
                        <button
                            type="button"
                            class="border-b border-(--gk-border-soft) px-4 py-2 text-left text-sm text-(--gk-accent) pointer-coarse:min-h-11"
                            onclick={() => (showingPreview = false)}
                            data-testid="version-history-back">← Versions</button
                        >
                    {/if}
                    {#if preview.kind === "none"}
                        <p class="p-4 text-sm text-(--gk-text-muted)">Choose a version to see what the document held then.</p>
                    {:else if preview.kind === "loading"}
                        <p class="p-4 text-sm text-(--gk-text-muted)" aria-live="polite">Opening the version…</p>
                    {:else if preview.kind === "error"}
                        <p class="p-4 text-sm text-red-700 dark:text-red-400" role="alert">{preview.message}</p>
                    {:else}
                        <div class="flex flex-wrap items-center gap-3 border-b border-(--gk-border-soft) px-4 py-2">
                            {#if selected}
                                <!-- Wide enough to read on one line; the controls wrap below it in a narrow pane. -->
                                <p class="min-w-48 flex-1 text-sm text-(--gk-text-muted)">
                                    {reasonLabel(selected.reason)}, {versionMoment(selected.createdAt, new Date())}
                                </p>
                            {/if}
                            <!-- Two views of one version, as a segmented control: the one showing is filled. -->
                            <div class="inline-flex rounded-lg border border-(--gk-control-border) p-0.5" role="group" aria-label="Show">
                                {#each [["changes", "Changes"], ["text", "Full text"]] as const as [value, label] (value)}
                                    <button
                                        type="button"
                                        class={[
                                            "rounded-md px-2.5 py-0.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--gk-accent) pointer-coarse:min-h-10",
                                            shown === value
                                                ? "bg-(--gk-surface-2) text-(--gk-text-strong)"
                                                : "text-(--gk-text-muted) hover:text-(--gk-text-strong)",
                                        ]}
                                        aria-pressed={shown === value}
                                        onclick={() => (shown = value)}
                                        data-testid="version-history-show-{value}">{label}</button
                                    >
                                {/each}
                            </div>
                            <button
                                type="button"
                                class="gk-button gk-button--primary pointer-coarse:min-h-11"
                                disabled={restoring}
                                onclick={() => void restore()}
                                data-testid="version-history-restore">{restoring ? "Restoring…" : "Restore this version"}</button
                            >
                        </div>
                        {#if preview.missing.length > 0}
                            <p class="border-b border-(--gk-border-soft) px-4 py-2 text-sm text-amber-800 dark:text-amber-300" data-testid="version-history-missing">
                                {preview.missing.length === 1 ? "A file this version shows has" : `${preview.missing.length} files this version shows have`}
                                been removed for good. Restoring it shows {preview.missing.length === 1 ? "that file" : "those files"} as missing.
                            </p>
                        {/if}
                        {#if shown === "changes" && preview.compared.kind === "ready"}
                            <VersionDiff before={preview.compared.text} after={preview.text} beforeMoment={preview.compared.moment} />
                        {:else}
                            {#if shown === "changes"}
                                <p class="border-b border-(--gk-border-soft) px-4 py-2 text-sm text-(--gk-text-muted)" data-testid="version-diff-summary">
                                    {preview.compared.kind === "none"
                                        ? "This is the earliest version kept, so there is nothing to compare it with. Its full text is below."
                                        : "The version before it could not be opened, so this version's full text is shown instead."}
                                </p>
                            {/if}
                            <!-- The preview scrolls, and a keyboard has to reach it to scroll it. -->
                            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                            <pre
                                class="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-sm text-(--gk-text-default) select-text"
                                data-testid="version-history-text"
                                tabindex="0"
                                aria-label="The version's text">{preview.text}</pre>
                        {/if}
                    {/if}
                    {#if outcome}
                        <p
                            class={["border-t border-(--gk-border-soft) px-4 py-2 text-sm", outcome.tone === "error" ? "text-red-700 dark:text-red-400" : "text-(--gk-text-default)"]}
                            role={outcome.tone === "error" ? "alert" : "status"}
                            data-testid="version-history-outcome"
                        >
                            {outcome.text}
                        </p>
                    {/if}
                </section>
            {/if}
        </div>
    {/if}
</div>
