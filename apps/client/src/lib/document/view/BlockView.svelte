<script lang="ts">
    /**
     * A [[Block View]] (the `block` View kind, ADR 0209): one bullet [[Block]] and everything nested
     * under it, in a tab of its own. Its editor is its document's own, on the document's shared
     * text (`DocumentView` embedded, with `block-view-range.ts` as its shown range), so an edit here
     * is an edit to the document and another member's edit shows here as it lands.
     *
     * The target is the block link the View was opened with (`block-view.ts`); the Block is found
     * from where it was last seen, or that link, when the View mounts (`block-link.ts`), and
     * followed from then on by the editor. Each change to the Block's words or place retitles the
     * tab, and once the edit has settled is noted for the address bar and the next reload.
     *
     * Every state a person can meet has a sentence and a way on:
     *
     * - **Waiting** for the document and the index: said after a moment.
     * - **Gone** when the Block was deleted or cannot be told from another: with a way to open the
     *   document, where it may still be.
     * - **Protected** while its document is a locked Protected Document: with a way to open it, where
     *   it is unlocked.
     */
    import { onDestroy, untrack } from "svelte";

    import { showNotice } from "#lib/activity/notices.js";
    import { prefersMobileLayout } from "#lib/layout/breakpoint.js";
    import { type ViewProps, viewKey } from "#lib/layout/index.js";
    import { tryGetActiveEventBus } from "#lib/surface/index.js";
    import { currentWorkspaceServices } from "#lib/workspace/workspace-services.js";

    import { blockFingerprintOf, resolveBlockLink, type BlockLink } from "../block-link";
    import { blockReadText, blockTitleText } from "../block-title";
    import { BLOCK_VIEW_TITLE_PREFIX, blockSeen, noteBlockSeen, parseBlockViewTarget, registerLiveBlockView } from "../block-view";
    import { canonicalConceptName, openConceptAtLine } from "../open-concept";
    import { documentProtection } from "../protection/cipher-fence";
    import { frontmatterSpan } from "#lib/storage/fs/frontmatter-span.js";
    import { requestFind } from "../find/find-events";
    import DocumentView from "./DocumentView.svelte";
    import { blockViewRange, type BlockViewRoot } from "./block-view-range";

    const { view, panelId, visibility }: ViewProps = $props();

    /** Fixed for the View's life, as its ref is. */
    const target = untrack(() => view.target);
    /**
     * The panel to retitle and readdress: the one a presenter names, or the View's own key, which is
     * its panel's id on the phone, whose presenter names none.
     */
    const panel = untrack(() => panelId ?? viewKey(view));
    const opened = parseBlockViewTarget(target);

    type Status = "waiting" | "ready" | "gone" | "ambiguous" | "protected";
    let status = $state<Status>("waiting");
    /** Where the Block was found when the View opened: the document and the line the editor anchors. */
    let found = $state.raw<{ document: string; line: number } | null>(null);
    /** Where the Block is now and what it says, as the editor last reported. */
    let root = $state.raw<BlockViewRoot | null>(null);
    /** The document the Block is in, for the states shown before the editor is. */
    const documentName = $derived(found?.document ?? blockSeen(target)?.document ?? opened?.document ?? "");

    /** The run the editor shows, reporting the Block as it changes. Made once: the editor reads it once. */
    const range = blockViewRange((next) => heard(next));

    function heard(next: BlockViewRoot | null): void {
        root = next;
        if (next === null) {
            // Ready and then nothing: the Block was taken out while the View was open.
            if (status === "ready") status = "gone";
            return;
        }
        retitle(next);
        noteSoon(next);
    }

    function retitle(next: BlockViewRoot): void {
        if (!found) return;
        const words = blockTitleText(next.text);
        currentWorkspaceServices()?.retitleView?.(panel, `${BLOCK_VIEW_TITLE_PREFIX}${words || found.document}`);
    }

    /**
     * Once the Block's words or place have been still for a moment, note where it is (`block-view.ts`)
     * and write the address bar again in place, so a link copied from it and a reload both find it.
     * Not per keystroke: the fingerprint is a hash, and the address bar is the browser's.
     */
    let noteTimer: ReturnType<typeof setTimeout> | undefined;
    function noteSoon(next: BlockViewRoot): void {
        clearTimeout(noteTimer);
        noteTimer = setTimeout(() => void note(next), 600);
    }
    async function note(next: BlockViewRoot): Promise<void> {
        if (!found) return;
        const parent = next.ancestors.at(-1)?.text ?? null;
        const fingerprint = await blockFingerprintOf(next.text, parent);
        if (root !== next || !found) return;
        noteBlockSeen(target, { document: found.document, line: next.line, fingerprint, title: blockTitleText(next.text) });
        currentWorkspaceServices()?.readdressView?.(panel);
    }

    /** The document's body, or null when it cannot be read or is a locked Protected Document. */
    async function readBody(document: string): Promise<string | null> {
        const store = currentWorkspaceServices()?.store;
        if (!store) return null;
        try {
            await store.whenReady?.(document);
            const text = store.open(document).getText();
            if (documentProtection(text).kind === "document") return null;
            const span = frontmatterSpan(text);
            return span ? text.slice(span.end) : text;
        } catch (error) {
            // Renamed or deleted since: the graph is searched instead.
            console.warn("[block-view] could not read", document, error);
            return null;
        }
    }

    /** Whether `document` is a locked Protected Document now. */
    async function lockedProtected(document: string): Promise<boolean> {
        const store = currentWorkspaceServices()?.store;
        if (!store) return false;
        try {
            await store.whenReady?.(document);
            return documentProtection(store.open(document).getText()).kind === "document";
        } catch {
            return false;
        }
    }

    /** Find the Block, from where it was last seen or the link the View was opened with. */
    async function resolve(): Promise<void> {
        const link: BlockLink | null = blockSeen(target) ?? opened;
        if (!link) {
            status = "gone";
            return;
        }
        const index = currentWorkspaceServices()?.index;
        const result = await resolveBlockLink(link, {
            resolveDocument: (name) => canonicalConceptName(name),
            readBody,
            async allBullets() {
                if (!index) return [];
                // The rest of the graph is the index's to answer, once it has been built.
                if (index.isBuilding()) {
                    await new Promise<void>((resolve) => {
                        const off = index.onUpdated(() => {
                            if (index.isBuilding()) return;
                            off();
                            resolve();
                        });
                    });
                }
                return index.bulletLabels();
            },
        });
        if (stopped) return;
        if (result.ok) {
            found = { document: result.document, line: result.line };
            status = "ready";
            takeKeyboardOnce();
            if (result.foundBy === "other_document") {
                showNotice({ id: "block-view-moved", tone: "info", text: `The block has moved to ${result.document}. This tab shows it there.` });
            }
            return;
        }
        if (await lockedProtected(canonicalConceptName(link.document))) status = "protected";
        else status = result.code === "block_ambiguous" ? "ambiguous" : "gone";
    }

    let stopped = false;
    void resolve();
    // A locked Protected Document is read again when protection changes: unlocked, its Block shows.
    const detachProtection = tryGetActiveEventBus()?.on("protection:changed", () => {
        if (status === "protected") void resolve();
    });
    /** The editor, for the tab menu's Find. */
    let documentView = $state<ReturnType<typeof DocumentView> | undefined>();
    const unregister = registerLiveBlockView(target, {
        where: () => (found && root ? { document: found.document, line: root.line } : null),
        printable: () => (found && root ? { document: found.document, title: blockReadText(root.text), markdown: root.markdown } : null),
        find() {
            const editor = documentView?.editorView();
            if (editor) requestFind(editor.dom, "open", editor);
        },
    });
    onDestroy(() => {
        stopped = true;
        clearTimeout(noteTimer);
        detachProtection?.();
        unregister();
    });

    /**
     * The person opened this Block View to work in it, so once its editor is up the caret goes to the
     * end of the Block's own line, as a document opened from a link takes the keyboard. Only when this
     * tab is the one in front (a Block View restored behind another waits), never over a dialog, and
     * not on a phone, where the keyboard would rise over what is being read.
     */
    function takeKeyboardOnce(): void {
        if (prefersMobileLayout()) return;
        let frames = 0;
        const attempt = () => {
            if (stopped || frames++ > 30) return;
            if (!documentView?.editorView()) return void requestAnimationFrame(attempt);
            if (inFrontAndFree()) documentView.editShownLine();
        };
        requestAnimationFrame(attempt);
    }

    /** This tab is the one in front, and no dialog holds the keyboard. */
    function inFrontAndFree(): boolean {
        const front = currentWorkspaceServices()?.layout?.activeView()?.panelId === panel;
        return front && !document.activeElement?.closest('[aria-modal="true"], dialog[open]');
    }

    /** Open the document at `line` (0-based body line), in this tab's Pane. */
    function openAt(line: number): void {
        if (found) openConceptAtLine(found.document, line, panelId);
    }

    /** Open the whole document at the Block, or at its top when the Block is gone. */
    function openDocument(): void {
        const document = found?.document ?? (documentName || null);
        if (!document) return;
        openConceptAtLine(document, root?.line ?? found?.line ?? 0, panelId);
    }
</script>

{#if opened === null}
    <div class="flex h-full items-start p-6" data-testid="block-view-invalid">
        <p class="m-0 text-sm text-(--gk-text-muted)">This tab does not name a block to show.</p>
    </div>
{:else}
    <div class="block-view relative flex h-full flex-col" data-testid="block-view" data-status={status}>
        {#if status === "ready" && found}
            <nav class="block-view__trail" aria-label="Where the block is" data-testid="block-view-trail">
                <button type="button" class="gk-link block-view__crumb" data-testid="block-view-document" onclick={openDocument}>{found.document}</button>
                {#each root?.ancestors ?? [] as ancestor (ancestor.line)}
                    <span class="block-view__sep" aria-hidden="true">›</span>
                    <button type="button" class="gk-link block-view__crumb block-view__ancestor" onclick={() => openAt(ancestor.line)}>{blockReadText(ancestor.text) || "…"}</button>
                {/each}
            </nav>
            <div class="min-h-0 flex-1">
                <DocumentView
                    bind:this={documentView}
                    view={{ kind: "document", target: found.document }}
                    {panelId}
                    {visibility}
                    embedded
                    findable
                    revealAt={found.line}
                    shownRange={range}
                    onopenintab={openDocument}
                />
            </div>
        {:else if status === "waiting"}
            <div class="loading absolute inset-0 flex items-start p-6" aria-busy="true">
                <p class="m-0 text-sm text-(--gk-text-muted)">Finding the block…</p>
            </div>
        {:else}
            <div class="flex flex-col items-start gap-3 p-6" role="status" data-testid={`block-view-${status}`}>
                <p class="m-0 max-w-md text-sm text-(--gk-text-muted)">
                    {#if status === "protected"}
                        {documentName} is a protected document. Unlock protected documents to see this block.
                    {:else if status === "ambiguous"}
                        This block is in more than one place in the graph, so this tab cannot tell which one to show. Open {documentName} to find it.
                    {:else}
                        This block is no longer in {documentName}. It may have been deleted, or its words and place both changed.
                    {/if}
                </p>
                {#if documentName}
                    <button type="button" class="gk-button" data-testid="block-view-open-document" onclick={openDocument}>Open {documentName}</button>
                {/if}
            </div>
        {/if}
    </div>
{/if}

<style>
    /* The trail of where the Block is, above its editor: one line, muted, each step a link. */
    .block-view__trail {
        display: flex;
        align-items: baseline;
        gap: 0.375rem;
        min-width: 0;
        padding: 0.5rem 1rem 0;
        font-size: 0.875rem;
        line-height: 1.25rem;
        color: var(--gk-text-muted);
        overflow: hidden;
        white-space: nowrap;
    }
    .block-view__crumb {
        min-width: 0;
        max-width: 16rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex-shrink: 1;
    }
    .block-view__sep {
        flex-shrink: 0;
    }
    /* A phone has room for the document's name alone. */
    @media (max-width: 639px) {
        .block-view__ancestor,
        .block-view__sep {
            display: none;
        }
    }
    /* Wait before saying anything, so a quick open never flashes a message. */
    .loading {
        animation: block-view-appear 160ms ease-out 400ms both;
    }
    @keyframes block-view-appear {
        from {
            opacity: 0;
        }
        to {
            opacity: 1;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .loading {
            animation: none;
        }
    }
</style>
