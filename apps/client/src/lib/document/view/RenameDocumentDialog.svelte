<script lang="ts">
    /**
     * The rename dialog (ADR 0037). It does not choose for the user: renaming a page leaves
     * every `[[Old Name]]` pointing at a concept with no page behind it, and neither fix is
     * right often enough to impose.
     *
     * The reference count is what makes the choice informed rather than a coin toss - "412
     * documents link to this" reads very differently from "3".
     *
     * A [[Pageless Concept]] gets no choice (ADR 0064): there is no document to hold an alias,
     * so renaming one IS the rewrite, and the dialog states that effect instead of offering
     * an arm it could not honour.
     */
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";
    import { type RenameLinkStrategy, type RenamePlan, mergeCount } from "$lib/storage/rename";

    let {
        concept,
        plan,
        pageless = false,
        busy = false,
        error = null,
        initialName,
        source,
        onpreview,
        onconfirm,
        oncancel,
    }: {
        concept: string;
        /** What this rename would do, or null while it is being computed. */
        plan: RenamePlan | null;
        /**
         * The concept has no document - a [[Draft]] nothing has been typed into. Known by the
         * caller from the outset, so the strategy choice never flickers in and then out while
         * the plan is computed.
         */
        pageless?: boolean;
        /**
         * A name already chosen - typed into the document's frontmatter (ADR 0061). The dialog
         * opens on it and says where it came from; Cancel puts the old name back in the block.
         */
        initialName?: string;
        /**
         * Where `initialName` came from. A link edited in place (ADR 0065) frames the dialog as
         * a question about that edit, and its decline - "Just this link" - leaves the link as
         * typed rather than putting anything back: the text of a link is canonical.
         */
        source?: "frontmatter" | "wikilink";
        busy?: boolean;
        error?: string | null;
        /** Recompute the impact for a candidate name (debounced by the dialog). */
        onpreview: (candidate: string) => void;
        onconfirm: (next: string, strategy: RenameLinkStrategy) => void;
        oncancel: () => void;
    } = $props();

    /** Long enough not to re-plan on every keystroke over a large graph. */
    const PREVIEW_DEBOUNCE_MS = 200;

    let open = $state(true);
    // Mounted fresh per rename, so the initial value is the whole story.
    // svelte-ignore state_referenced_locally
    let name = $state(initialName ?? concept);
    let strategy = $state<RenameLinkStrategy>("alias");
    let previewTimer: ReturnType<typeof setTimeout> | undefined;
    const uid = $props.id();
    const errorId = `${uid}-error`;
    const hintId = `${uid}-hint`;

    const unchanged = $derived(name.trim() === "" || name.trim() === concept);
    /**
     * A name the store will not take - a Protected Document's, which nothing may merge into
     * (ADR 0062), or a day, which is its journal entry's name and never a page's (ADR 0056).
     * Shown where a failed rename's error goes, and Rename is disabled on it, so the refusal is
     * read before the button rather than after.
     */
    const refusal = $derived(plan?.refusal ?? null);
    const blocked = $derived(unchanged || busy || refusal !== null);
    const linkCount = $derived(plan?.referencingDocuments ?? 0);
    const cascade = $derived(plan?.cascade ?? []);
    const merges = $derived(plan ? mergeCount(plan) : 0);
    /** A documentless concept landing on a name that has a page: its links go there instead. */
    const redirectsTo = $derived(plan?.direct.redirects ? plan.direct.into : null);
    /** The direct step lands on another document's alias: the merge is into that document. */
    const mergesIntoAlias = $derived(
        plan?.direct.merges && plan.direct.into !== plan.direct.to ? plan.direct.into : null,
    );
    const documentsWord = (n: number) => (n === 1 ? "document" : "documents");

    function schedulePreview() {
        if (previewTimer) clearTimeout(previewTimer);
        previewTimer = setTimeout(() => {
            previewTimer = undefined;
            const candidate = name.trim();
            if (candidate !== "") onpreview(candidate);
        }, PREVIEW_DEBOUNCE_MS);
    }

    function confirm() {
        if (blocked) return;
        // A pageless concept has nothing to alias: renaming it is the rewrite (ADR 0064).
        onconfirm(name.trim(), pageless ? "rewrite" : strategy);
    }

    function close() {
        open = false;
        oncancel();
    }
</script>

<Modal {open} title="Rename" busy={busy} busyReason="Renaming…" onclose={close} onsubmit={confirm}>
    {#snippet body()}
        <div>
            <label for="rename-name" class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400">New name</label>
            <input
                id="rename-name"
                data-testid="rename-input"
                bind:value={name}
                autocomplete="off"
                oninput={schedulePreview}
                aria-invalid={error || refusal ? "true" : undefined}
                aria-describedby={error || refusal ? errorId : unchanged ? hintId : undefined}
                class="block w-full rounded-lg border bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:outline-none focus:ring-1 {error || refusal
                    ? 'border-red-400 dark:border-red-500/60 focus:border-red-500 focus:ring-red-500'
                    : 'border-gray-300 dark:border-gray-700 focus:border-gray-950 dark:focus:border-gray-400 focus:ring-gray-950 dark:focus:ring-gray-400'}"
            />
            {#if initialName !== undefined && source === "wikilink"}
                <p class="mt-1.5 text-sm text-gray-500 dark:text-gray-400" data-testid="rename-from-wikilink">
                    You changed a link from "{concept}" to "{initialName}". Rename "{concept}" everywhere, or keep just this link?
                </p>
            {:else if initialName !== undefined}
                <p class="mt-1.5 text-sm text-gray-500 dark:text-gray-400" data-testid="rename-from-frontmatter">
                    You changed the title in the document's frontmatter. Cancel puts "{concept}" back.
                </p>
            {/if}
            {#if error || refusal}
                <p id={errorId} role="alert" class="mt-1.5 text-sm text-red-600" data-testid="rename-error">{error ?? refusal}</p>
            {:else if unchanged}
                <!-- Rule 7: Rename is disabled here, and a native disabled button is not
                     focusable, so the reason cannot live on its tooltip. -->
                <p id={hintId} class="mt-1.5 text-sm text-gray-500 dark:text-gray-400" data-testid="rename-unchanged-hint">
                    Enter a name different from the current one.
                </p>
            {/if}
        </div>

        <!--
            The impact preview (ADR 0038 §1). Renaming one page and silently retitling twelve
            others is exactly the surprise informed consent exists to prevent, so the cascade
            and any merges are stated before the button is pressed.
        -->
        {#if cascade.length > 0 || merges > 0}
            <div
                class="rounded-lg border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-950/20 p-3 text-sm text-amber-900 dark:text-amber-200"
                data-testid="rename-impact"
            >
                {#if cascade.length > 0}
                    <p class="font-medium">
                        {cascade.length} scoped {cascade.length === 1 ? "document" : "documents"} will also be renamed:
                    </p>
                    <ul class="mt-1 space-y-0.5">
                        {#each cascade.slice(0, 5) as step (step.from)}
                            <li class="truncate font-mono" data-testid="rename-cascade-row">
                                {step.from} → {step.to}{#if step.merges}<span class="font-sans font-medium"> (merges{#if step.into !== step.to} into "{step.into}"{/if})</span>{/if}
                            </li>
                        {/each}
                        {#if cascade.length > 5}
                            <li>…and {cascade.length - 5} more</li>
                        {/if}
                    </ul>
                {/if}
                {#if mergesIntoAlias !== null}
                    <p class="mt-2 font-medium" data-testid="rename-merge-warning">
                        "{plan?.direct.to}" is already a name of "{mergesIntoAlias}", so this document will be merged
                        into it: the contents are joined and nothing is discarded, and "{mergesIntoAlias}" keeps its
                        title.
                    </p>
                {:else if merges > 0}
                    <p class="mt-2 font-medium" data-testid="rename-merge-warning">
                        {merges} {merges === 1 ? "document lands" : "documents land"} on a name that already exists and
                        will be merged: the contents are joined and nothing is discarded.
                    </p>
                {/if}
            </div>
        {/if}

        <!--
            A documentless concept renamed onto a page's name: nothing is joined, so this is
            not the amber merge warning - the links simply go to the page that has the name
            (ADR 0064 §2).
        -->
        {#if redirectsTo !== null}
            <p
                class="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-white/5 p-3 text-sm text-gray-700 dark:text-gray-300"
                data-testid="rename-redirect"
            >
                {#if plan && redirectsTo !== plan.direct.to}
                    "{plan.direct.to}" is already a name of "{redirectsTo}".
                {:else}
                    "{redirectsTo}" already has a page.
                {/if}
                {#if linkCount > 0}
                    The {linkCount} {documentsWord(linkCount)} that {linkCount === 1 ? "links" : "link"} to "{concept}" will link to it instead.
                {:else}
                    Nothing links to "{concept}" yet, so there is nothing to update.
                {/if}
            </p>
        {:else if pageless}
            <!-- No strategy: there is no document to hold an alias (ADR 0064 §1). -->
            <p class="text-sm text-gray-700 dark:text-gray-200" data-testid="rename-pageless-effect">
                {#if plan === null}
                    Checking what links here…
                {:else if linkCount === 0}
                    Nothing links to "{concept}" yet, so there is nothing to update.
                {:else}
                    {linkCount} {documentsWord(linkCount)} link to "{concept}" and will be updated to say the new name.
                {/if}
            </p>
        {:else}
        <fieldset>
            <legend class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400">
                {#if plan === null}
                    Checking what links here…
                {:else if linkCount === 0}
                    Nothing links to this page yet
                {:else}
                    {linkCount} {linkCount === 1 ? "document links" : "documents link"} to "{concept}"
                {/if}
            </legend>
            <div class="space-y-2">
                <label class="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
                    <input type="radio" bind:group={strategy} value="alias" data-testid="rename-strategy-alias" class="mt-0.5" />
                    <span>
                        <span class="font-medium">Keep the old name working</span> - "{concept}" becomes an alias, so existing
                        links still resolve and their text is left as written.
                    </span>
                </label>
                <label class="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
                    <input type="radio" bind:group={strategy} value="rewrite" data-testid="rename-strategy-rewrite" class="mt-0.5" />
                    <span>
                        <span class="font-medium">Update the links</span> - rewrite
                        {#if linkCount > 0}{linkCount} {linkCount === 1 ? "document" : "documents"}{:else}any documents{/if}
                        to use the new name.
                    </span>
                </label>
            </div>
        </fieldset>
        {/if}

        <!-- The cascade rule (ADR 0038 §2): a scoped concept's name contains its scope's. -->
        <p class="text-sm text-gray-500 dark:text-gray-400">
            Links that use "{concept}" as a scope are updated with it - a scoped concept is named by its scope.
        </p>

    {/snippet}

    {#snippet footer()}
        <button type="button" onclick={close} disabled={busy} data-testid="rename-cancel" class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-40">{source === "wikilink" ? "Just this link" : "Cancel"}</button>
        <button
            type="submit"
            disabled={blocked}
            aria-describedby={unchanged && !error ? hintId : undefined}
            data-testid="rename-confirm"
            class="min-w-28 rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-center text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-40"
        >{busy ? "Renaming…" : "Rename"}</button>
    {/snippet}
</Modal>
