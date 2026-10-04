<script lang="ts">
    /**
     * What one rename will do, and the choice it leaves (ADR 0037, 0038, 0064): the scoped
     * documents it cascades to and any merges, then either where a pageless concept's links go
     * or the choice between keeping the old name as an alias and updating the links. A name that
     * is one of a page's aliases is renamed as that alias (ADR 0065, amended 2026-10-04): the page
     * keeps its title, and the choice is between keeping the old alias beside the new one and
     * swapping it. Shared by the rename dialog and the dialog for the renames a link edit
     * proposes, so a plan reads the same wherever it is shown.
     */
    import { type RenameLinkStrategy, type RenamePlan, mergeCount, scopedAliasRewrites } from "$lib/storage/rename";
    import { conceptKey } from "$lib/storage/fs/identity";

    let {
        concept,
        plan,
        pageless,
        // Updating the links is the default: a graph is easier to read with fewer aliases, and keeping
        // the old name is a choice made on purpose.
        strategy = $bindable("rewrite"),
        disabled = false,
    }: {
        /** The concept being renamed: the old name. */
        concept: string;
        /** What the rename would do, or null while it is being computed. */
        plan: RenamePlan | null;
        /** The concept has no document, so there is no alias arm to offer (ADR 0064). */
        pageless: boolean;
        strategy?: RenameLinkStrategy;
        disabled?: boolean;
    } = $props();

    const uid = $props.id();
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
    /** Aliases that name the concept as a scope, which the rename carries along (ADR 0038, amended 2026-10-03). */
    const aliasRewrites = $derived(plan ? scopedAliasRewrites(plan) : []);
    /** The page whose alias the concept is, when the rename renames an alias rather than a title. */
    const aliasOf = $derived(plan?.aliasOf ?? null);
    /** That page is in the cascade itself: its title names the alias as a scope. */
    const aliasOfRetitled = $derived(
        aliasOf !== null && cascade.some((step) => conceptKey(step.from) === conceptKey(aliasOf)),
    );
    /** A pageless concept is always the rewrite (ADR 0064); otherwise the chosen arm decides. */
    const keepsOldAliases = $derived(!pageless && strategy === "alias");
</script>

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
    Aliases that name the concept as a scope follow it, on whatever document holds them, as a
    scoped title does (ADR 0038, amended 2026-10-03). Neutral rather than amber: nothing merges.
-->
{#if aliasRewrites.length > 0}
    <div
        class="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-white/5 p-3 text-sm text-gray-700 dark:text-gray-300"
        data-testid="rename-alias-rewrites"
    >
        <p class="font-medium">
            {aliasRewrites.length} {aliasRewrites.length === 1 ? "alias names" : "aliases name"} "{concept}" as a scope and
            {keepsOldAliases ? "will also answer to the new name, keeping the old one:" : "will be renamed:"}
        </p>
        <ul class="mt-1 space-y-0.5">
            {#each aliasRewrites.slice(0, 5) as rewrite (JSON.stringify([rewrite.holder, rewrite.from]))}
                <li class="truncate" data-testid="rename-alias-row">
                    {rewrite.holder}: <span class="font-mono">{rewrite.from} → {rewrite.to}</span>
                </li>
            {/each}
            {#if aliasRewrites.length > 5}
                <li>…and {aliasRewrites.length - 5} more</li>
            {/if}
        </ul>
    </div>
{/if}

<!--
    A documentless concept renamed onto a page's name: nothing is joined, so this is
    not the amber merge warning - the links simply go to the page that has the name
    (ADR 0064 §2).
-->
<!-- Said before the choice, since it changes what both arms mean: the page's title stays. -->
{#if aliasOf !== null}
    <p class="text-sm text-gray-700 dark:text-gray-200" data-testid="rename-alias-of">
        "{concept}" is an alias of "{aliasOf}".{#if !aliasOfRetitled}
            Renaming it leaves that page's title as it is.{/if}
    </p>
{/if}

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
    <fieldset {disabled}>
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
            <!-- The default first: updating the links leaves no alias behind. -->
            <label class="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
                <input type="radio" name="{uid}-strategy" bind:group={strategy} value="rewrite" data-testid="rename-strategy-rewrite" class="mt-0.5" />
                <span>
                    <span class="font-medium">Update the links</span> -
                    {#if aliasOf !== null}replace the alias "{concept}" with the new name, and{/if}
                    rewrite
                    {#if linkCount > 0}{linkCount} {linkCount === 1 ? "document" : "documents"}{:else}any documents{/if}
                    to use the new name.
                </span>
            </label>
            <label class="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
                <input type="radio" name="{uid}-strategy" bind:group={strategy} value="alias" data-testid="rename-strategy-alias" class="mt-0.5" />
                <span>
                    {#if aliasOf !== null}
                        <span class="font-medium">Keep the old name working</span> - "{aliasOf}" answers to the new name as
                        well, and links that say "{concept}" are left as written.
                    {:else}
                        <span class="font-medium">Keep the old name working</span> - "{concept}" becomes an alias, so existing
                        links still resolve and their text is left as written.
                    {/if}
                </span>
            </label>
        </div>
    </fieldset>
{/if}
