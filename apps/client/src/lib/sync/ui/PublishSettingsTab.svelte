<script lang="ts">
    /**
     * The **Publish** tab of the Settings modal (ADR 0082): the graph's [[Publication]]s, each
     * with its theme, includes, output folder and last report; the public documents no
     * publication takes; the graph's [[Theme]]s. Everything here is graph content edited through
     * the publication page (the workspace rewrites its frontmatter) except the output folder,
     * which is per device.
     *
     * A card's fields edit a draft and **Save changes** writes it in one go: writing the page on
     * every field change re-read the graph mid-edit and made a half-typed url a saved one
     * (2026-09-19). The draft survives another card's save and a re-read; Discard returns it to
     * the page.
     *
     * Renders into someone else's dialog rather than hosting one, so every button here declares
     * `type="button"` - an untyped button inside the shell's form is a submit button
     * (`dialog-button-type.test.ts`). The list is read when the tab opens and after every change
     * that could alter it, because the publications live in documents, not in a settings object.
     */
    import { onMount, tick } from "svelte";

    import LoadingSweep from "$lib/components/LoadingSweep.svelte";

    import { conceptKey } from "$lib/document/backlinks/backlink-index";
    import type { GraphTheme } from "$lib/document/publish/theme/graph-theme";
    import type { Publication, PublicationKind, PublicationSelection } from "$lib/document/publish/types";
    import { suggestPublicationId } from "$lib/workspace/publish-service";
    import type { NewPublicationInput, PublicationChanges, PublishDocumentSummary } from "$lib/workspace/publish-service";

    import type { GraphPublishingState, PublicationFolderState, PublishTabProps } from "./publish-tab";

    let {
        folderSupported,
        load,
        folderOf,
        onchoosefolder,
        onforgetfolder,
        onpublish,
        outcomes,
        showReport = undefined,
        onopenpage,
        oncreatepublication,
        onupdatepublication,
        subscribeThemes,
        bundledThemes,
        oncustomisetheme,
        onopentheme,
        onaddtheme,
        ondeletetheme,
        includeSlotsOf,
    }: PublishTabProps = $props();

    let graph = $state<GraphPublishingState | null>(null);
    let loading = $state(true);
    let loadError = $state<string | null>(null);
    let themes = $state<GraphTheme[]>([]);
    let folders = $state<Record<string, PublicationFolderState | null>>({});
    let busy = $state<Record<string, string>>({});
    let errors = $state<Record<string, string | null>>({});
    let slots = $state<Record<string, { name: string; description: string; kind?: "html" | "css" }[] | null>>({});
    // svelte-ignore state_referenced_locally
    let expandedReport = $state<string | null>(showReport ?? null);

    /** A card's editable copy of its publication's mapping. The theme picker's "url" choice keeps the url apart. */
    interface Draft {
        kind: PublicationKind;
        selection: PublicationSelection;
        home: string;
        url: string;
        theme: string;
        themeUrl: string;
        /** Posts on the front page, as typed; validated on save. */
        recent: string;
        includes: Record<string, string>;
    }
    let drafts = $state<Record<string, Draft>>({});
    /** The card whose save just landed, for the "Saved" beside its buttons until the next edit. */
    let justSaved = $state<string | null>(null);

    function draftOf(p: Publication): Draft {
        const url = isUrlTheme(p.theme);
        return {
            kind: p.kind,
            selection: p.selection,
            home: p.home ?? "",
            url: p.url ?? "",
            theme: url ? "url" : p.theme,
            themeUrl: url ? p.theme : "",
            recent: String(p.recent),
            includes: { ...p.includes },
        };
    }

    /** The draft's post count as a number, or null when it is not a whole number above zero. */
    function recentOf(d: Draft): number | null {
        const n = Number(d.recent.trim());
        return d.recent.trim() !== "" && Number.isInteger(n) && n > 0 ? n : null;
    }

    function themeRefOf(d: Draft): string {
        return d.theme === "url" ? d.themeUrl.trim() : d.theme;
    }

    /** What saving `d` would change on `p`, or null when nothing differs. */
    function changesOf(p: Publication, d: Draft): PublicationChanges | null {
        const changes: PublicationChanges = {};
        if (d.kind !== p.kind) changes.kind = d.kind;
        if (d.selection !== p.selection) changes.selection = d.selection;
        if (d.home.trim() !== (p.home ?? "")) changes.home = d.home.trim() || null;
        if (d.url.trim() !== (p.url ?? "")) changes.url = d.url.trim() || null;
        if (themeRefOf(d) !== p.theme) changes.theme = themeRefOf(d);
        if (d.recent.trim() !== String(p.recent)) changes.recent = recentOf(d);
        const includes: Record<string, string | null> = {};
        for (const slot of new Set([...Object.keys(d.includes), ...Object.keys(p.includes)])) {
            const next = (d.includes[slot] ?? "").trim();
            if (next !== (p.includes[slot] ?? "")) includes[slot] = next || null;
        }
        if (Object.keys(includes).length > 0) changes.includes = includes;
        return Object.keys(changes).length > 0 ? changes : null;
    }

    /**
     * Cards whose draft was just written: the next re-read seeds them afresh from the page. Kept
     * as a mark rather than by dropping the draft, so the form stays on screen, disabled, for
     * the whole save and re-read; dropping it collapsed the card to its header until the graph
     * had been read again, which looked like the save had vanished.
     */
    const reseedAfterSave = new Set<string>();

    /** Seed or refresh the drafts: a card mid-edit keeps its edits, every other card follows the page. */
    function adoptDrafts(previous: Publication[], next: Publication[]): void {
        const kept: Record<string, Draft> = {};
        for (const p of next) {
            const before = previous.find((q) => q.id === p.id);
            const draft = drafts[p.id];
            const saved = reseedAfterSave.delete(p.id);
            kept[p.id] = !saved && before && draft && changesOf(before, draft) !== null ? draft : draftOf(p);
        }
        drafts = kept;
    }

    // New publication form.
    let creating = $state(false);
    let newTitle = $state("");
    let newId = $state("");
    let idTouched = $state(false);
    let newKind = $state<"docs" | "blog">("docs");
    let newSelection = $state<"named" | "all-public">("named");
    let newHome = $state("");
    let newUrl = $state("");
    let createError = $state<string | null>(null);
    let createBusy = $state(false);

    // Add theme form.
    let addingTheme = $state(false);
    let themeRef = $state("etherpk-docs");
    let themeUrl = $state("");
    let themeName = $state("");
    let themeId = $state("");
    let themeIdTouched = $state(false);
    let addThemeError = $state<string | null>(null);
    let addThemeBusy = $state(false);
    let deleteThemeArmed = $state<string | null>(null);

    const suggestedId = $derived(suggestPublicationId(newTitle));
    const effectiveId = $derived(idTouched ? newId : suggestedId);
    const suggestedThemeId = $derived(suggestPublicationId(themeName));
    const effectiveThemeId = $derived(themeIdTouched ? themeId : suggestedThemeId);

    async function refresh(): Promise<void> {
        loading = true;
        loadError = null;
        try {
            const next = await load();
            adoptDrafts(graph?.publications ?? [], next.publications);
            graph = next;
            const nextFolders: Record<string, PublicationFolderState | null> = {};
            for (const p of next.publications) nextFolders[p.id] = await folderOf(p.id);
            folders = nextFolders;
            for (const p of next.publications) void loadSlots(p.theme);
        } catch (error) {
            loadError = error instanceof Error ? error.message : String(error);
        } finally {
            loading = false;
        }
    }

    async function loadSlots(themeRef: string): Promise<void> {
        if (themeRef in slots) return;
        slots = { ...slots, [themeRef]: null };
        const found = await includeSlotsOf(themeRef);
        slots = { ...slots, [themeRef]: found };
    }

    onMount(() => {
        void refresh().then(async () => {
            // Opened from a finished publish's toast: land on that report rather than the top.
            if (!showReport) return;
            await tick();
            document.querySelector(`[data-testid="publication-${CSS.escape(showReport)}-report"]`)?.scrollIntoView({ block: "nearest" });
        });
        return subscribeThemes((list) => {
            themes = list;
        });
    });

    function setBusy(id: string, what: string | null): void {
        const next = { ...busy };
        if (what === null) delete next[id];
        else next[id] = what;
        busy = next;
    }

    async function guarded(id: string, what: string, work: () => Promise<void>): Promise<void> {
        if (busy[id]) return;
        setBusy(id, what);
        errors = { ...errors, [id]: null };
        try {
            await work();
        } catch (error) {
            errors = { ...errors, [id]: error instanceof Error ? error.message : String(error) };
        } finally {
            setBusy(id, null);
        }
    }

    async function chooseFolder(p: Publication): Promise<void> {
        await guarded(p.id, "Choosing a folder", async () => {
            const chosen = await onchoosefolder(p.id);
            if (chosen) folders = { ...folders, [p.id]: chosen };
        });
    }

    async function forgetFolder(p: Publication): Promise<void> {
        await guarded(p.id, "Forgetting the folder", async () => {
            await onforgetfolder(p.id);
            folders = { ...folders, [p.id]: null };
        });
    }

    async function publish(p: Publication, target: "folder" | "zip"): Promise<void> {
        await guarded(p.id, target === "zip" ? "Building the zip" : "Publishing", async () => {
            const outcome = await onpublish(p, target);
            if (target === "folder" && outcome.report.ok) {
                folders = { ...folders, [p.id]: { ...(folders[p.id] ?? { folder: "" }), publishedAt: outcome.report.generatedAt } };
            }
        });
    }

    async function create(): Promise<void> {
        if (createBusy) return;
        createError = null;
        const input: NewPublicationInput = {
            title: newTitle.trim(),
            id: effectiveId,
            kind: newKind,
            selection: newSelection,
            ...(newHome.trim() ? { home: newHome.trim() } : {}),
            ...(newUrl.trim() ? { url: newUrl.trim() } : {}),
        };
        if (input.title === "") {
            createError = "Give the publication a name; it becomes the page's title.";
            return;
        }
        createBusy = true;
        try {
            await oncreatepublication(input);
            creating = false;
            newTitle = "";
            newId = "";
            idTouched = false;
            newHome = "";
            newUrl = "";
        } catch (error) {
            createError = error instanceof Error ? error.message : String(error);
        } finally {
            createBusy = false;
        }
    }

    async function save(p: Publication): Promise<void> {
        const draft = drafts[p.id];
        const changes = draft ? changesOf(p, draft) : null;
        if (!draft || !changes) return;
        if (draft.theme === "url" && !isUrlTheme(draft.themeUrl.trim())) {
            errors = { ...errors, [p.id]: "Enter the full url of the theme's theme.json, starting with https://." };
            return;
        }
        if (recentOf(draft) === null) {
            errors = { ...errors, [p.id]: "Posts on the front page must be a whole number above zero." };
            return;
        }
        await guarded(p.id, "Saving", async () => {
            await onupdatepublication(p, changes);
            // Written, so the re-read seeds this card afresh from the page rather than keeping
            // the draft as an edit in progress; the draft itself stays until then, so the form
            // is on screen (disabled, "Saving…") throughout rather than collapsing.
            reseedAfterSave.add(p.id);
            justSaved = p.id;
            await refresh();
        });
    }

    function discard(p: Publication): void {
        drafts = { ...drafts, [p.id]: draftOf(p) };
        errors = { ...errors, [p.id]: null };
    }

    function edited(id: string): void {
        if (justSaved === id) justSaved = null;
    }

    async function customise(p: Publication): Promise<void> {
        await guarded(p.id, "Copying the theme", async () => {
            await oncustomisetheme(p);
        });
    }

    async function addTheme(): Promise<void> {
        if (addThemeBusy) return;
        addThemeError = null;
        const ref = themeRef === "url" ? themeUrl.trim() : themeRef;
        if (themeRef === "url" && ref === "") {
            addThemeError = "Enter the url of the theme's theme.json.";
            return;
        }
        if (themeName.trim() === "") {
            addThemeError = "Give the theme a name.";
            return;
        }
        addThemeBusy = true;
        try {
            await onaddtheme({ ref, id: effectiveThemeId, name: themeName.trim() });
            addingTheme = false;
            themeName = "";
            themeId = "";
            themeIdTouched = false;
            themeUrl = "";
        } catch (error) {
            addThemeError = error instanceof Error ? error.message : String(error);
        } finally {
            addThemeBusy = false;
        }
    }

    /** A theme reference as a person reads it: the title of a bundled theme, the name of a graph one, and where it lives. */
    function themeLabel(ref: string): string {
        const graph = themes.find((t) => t.id === ref);
        if (graph) return `${graph.name} (in this graph)`;
        const bundled = bundledThemes.find((t) => t.name === ref);
        if (bundled) return `${bundled.title} (bundled)`;
        if (/^https?:\/\//i.test(ref)) return `${ref} (url)`;
        return `${ref} (not found)`;
    }

    /** The title alone, for prose: "with the theme EtherPK Blog". */
    function themeTitle(ref: string): string {
        return themes.find((t) => t.id === ref)?.name ?? bundledThemes.find((t) => t.name === ref)?.title ?? ref;
    }

    function isUrlTheme(ref: string): boolean {
        return /^https?:\/\//i.test(ref);
    }

    /** The publications whose saved mapping names the theme. */
    function usedBy(themeId: string): Publication[] {
        return graph?.publications.filter((p) => p.theme === themeId) ?? [];
    }

    /** The publications whose unsaved edits select the theme: a delete now would leave that save pointing at nothing. */
    function draftedBy(themeId: string): Publication[] {
        return graph?.publications.filter((p) => p.theme !== themeId && drafts[p.id] !== undefined && themeRefOf(drafts[p.id]) === themeId) ?? [];
    }

    /** Every document by its name and aliases, keyed the way the publisher matches a name. */
    const documentsByKey = $derived.by(() => {
        const map = new Map<string, PublishDocumentSummary>();
        for (const doc of graph?.documents ?? []) {
            map.set(conceptKey(doc.concept), doc);
            for (const alias of doc.aliases) map.set(conceptKey(alias), doc);
        }
        return map;
    });

    /**
     * Why a page a field names would not reach the site, or null when it would. The home page
     * and an include page are held to the same rule as any published content (public, and
     * naming the publication when the selection is `named`; an include's body reaches the site
     * too), checked against the card's draft selection, which is what a save would make true.
     */
    type PageProblem = "missing" | "protected" | "publication-page" | "not-public" | "not-named";

    function pageProblem(p: Publication, d: Draft, name: string): PageProblem | null {
        const doc = documentsByKey.get(conceptKey(name.trim()));
        if (!doc) return "missing";
        if (doc.isProtected) return "protected";
        if (doc.isPublicationPage) return "publication-page";
        if (!doc.isPublic) return "not-public";
        if (d.selection === "named" && !doc.publications.includes(p.id)) return "not-named";
        return null;
    }

    function homeProblem(p: Publication, d: Draft): PageProblem | null {
        return d.home.trim() === "" ? null : pageProblem(p, d, d.home);
    }

    function problemText(problem: PageProblem, p: Publication): string {
        switch (problem) {
            case "missing":
                return "This page does not yet exist.";
            case "protected":
                return "This page is protected, so it can never be published.";
            case "publication-page":
                return "This is a publication page, which is never published.";
            case "not-public":
                return "This page is not public, so it will not be on the site.";
            case "not-named":
                return `This page does not name this publication (publications: [${p.id}]), so it will not be on the site.`;
        }
    }

    /** Every problem a card's fields have right now, for the panel above Save changes. */
    function pageProblems(p: Publication, d: Draft, themeSlots: { name: string }[] | null): { field: string; problem: PageProblem }[] {
        const out: { field: string; problem: PageProblem }[] = [];
        const home = homeProblem(p, d);
        if (home) out.push({ field: "Home page", problem: home });
        for (const slot of themeSlots ?? []) {
            const named = (d.includes[slot.name] ?? "").trim();
            if (named === "") continue;
            const problem = pageProblem(p, d, named);
            if (problem) out.push({ field: `Include ${slot.name}`, problem });
        }
        return out;
    }

    function listNames(publications: Publication[]): string {
        return publications.map((p) => p.name).join(", ");
    }

    const inputClass = "block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100";
    const labelClass = "mb-1 block text-sm font-medium text-gray-500 dark:text-gray-400";
    // Disabled by colour rather than opacity: a faded light button on the dark surface left its
    // label unreadable ("Publish to folder" with no folder chosen read as a blank grey block).
    const primaryButton = "rounded-lg bg-gray-900 dark:bg-gray-100 px-3 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:bg-gray-300 disabled:text-gray-600 dark:disabled:bg-gray-700 dark:disabled:text-gray-300";
    const secondaryButton = "rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-950 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50";
    const dangerButton = "rounded-lg border border-red-300 dark:border-red-800 px-3 py-1.5 text-sm font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50";
    const linkButton = "text-sm font-medium text-agent-600 dark:text-agent-300 hover:underline";
    /** The same link while it cannot be followed: the text colour, underlined, no hover change. */
    const linkButtonUnavailable = "text-sm font-medium text-gray-700 dark:text-gray-300 underline underline-offset-2 cursor-default";
    const helpClass = "mt-1 text-sm text-gray-500 dark:text-gray-400";
    const warnClass = "text-amber-800 dark:text-amber-200";
</script>

<div class="space-y-5" data-testid="publish-tab">
    <p class="text-sm text-gray-600 dark:text-gray-400">
        A publication is a named selection of public documents rendered as one website, into a
        folder you deploy yourself. A document is published when its frontmatter says
        <code>public: true</code> and names the publication in <code>publications</code>
        (right-click a document for <strong>Publish…</strong>). The publication page's outline is
        the site's navigation.
    </p>

    {#if loading && !graph}
        <!-- The app's one loading indicator (the sweep, not a ring): every document is read
             to find the publications, which on a large graph is seconds, not a blink. -->
        <div role="status" class="space-y-2 py-2" data-testid="publish-loading">
            <LoadingSweep label="Reading the graph" />
            <p class="text-sm text-gray-500 dark:text-gray-400">Reading the graph…</p>
        </div>
    {:else if loadError}
        <div role="alert" class="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 p-3 text-sm text-red-800 dark:text-red-200">
            <p>The graph could not be read: {loadError}</p>
            <button type="button" class={secondaryButton + " mt-2"} onclick={() => void refresh()}>Try again</button>
        </div>
    {/if}

    {#if graph}
        {#if graph.unsettled.length > 0}
            <p role="status" class="text-sm text-amber-800 dark:text-amber-200" data-testid="publish-unsettled">
                {graph.unsettled.length} document{graph.unsettled.length === 1 ? " has" : "s have"} not finished syncing to this device
                and would be left out of a publish now: {graph.unsettled.slice(0, 5).join(", ")}{graph.unsettled.length > 5 ? "…" : ""}.
            </p>
        {/if}

        {#each graph.issues.filter((i) => i.level === "error") as issue (issue.code + (issue.concept ?? ""))}
            <p role="alert" class="text-sm text-red-700 dark:text-red-300" data-testid="publish-issue">
                {#if issue.concept}<button type="button" class={linkButton} onclick={() => onopenpage(issue.concept as string)}>{issue.concept}</button>: {/if}{issue.message}
            </p>
        {/each}

        <section class="space-y-4" aria-labelledby="publications-heading">
            <div class="flex items-center justify-between gap-3">
                <h3 id="publications-heading" class="text-sm font-semibold text-gray-950 dark:text-gray-100">Publications</h3>
                {#if !creating}
                    <button type="button" class={secondaryButton} data-testid="publish-new" onclick={() => (creating = true)}>New publication</button>
                {/if}
            </div>

            {#if creating}
                <form
                    class="space-y-3 rounded-lg border border-gray-200 dark:border-gray-800 p-3"
                    data-testid="publish-new-form"
                    onsubmit={(e) => {
                        e.preventDefault();
                        void create();
                    }}
                >
                    <div>
                        <label for="publish-new-title" class={labelClass}>Name</label>
                        <input id="publish-new-title" class={inputClass} bind:value={newTitle} placeholder="Docs Site" data-testid="publish-new-title" />
                        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">Becomes the title of the publication page and of the site.</p>
                    </div>
                    <div>
                        <label for="publish-new-id" class={labelClass}>Id</label>
                        <input
                            id="publish-new-id"
                            class={inputClass}
                            value={effectiveId}
                            oninput={(e) => {
                                idTouched = true;
                                newId = (e.currentTarget as HTMLInputElement).value;
                            }}
                            placeholder="docs"
                            data-testid="publish-new-id"
                        />
                        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">What documents name in <code>publications: [{effectiveId || "docs"}]</code>. Lower-case letters, digits and hyphens; fixed once documents use it.</p>
                    </div>
                    <div class="grid gap-3 sm:grid-cols-2">
                        <div>
                            <label for="publish-new-kind" class={labelClass}>Kind</label>
                            <select id="publish-new-kind" class={inputClass} bind:value={newKind} data-testid="publish-new-kind">
                                <option value="docs">Documentation</option>
                                <option value="blog">Blog</option>
                            </select>
                        </div>
                        <div>
                            <label for="publish-new-selection" class={labelClass}>Documents</label>
                            <select id="publish-new-selection" class={inputClass} bind:value={newSelection} data-testid="publish-new-selection">
                                <option value="named">Those that name this publication</option>
                                <option value="all-public">Every public document</option>
                            </select>
                        </div>
                    </div>
                    <div class="grid gap-3 sm:grid-cols-2">
                        <div>
                            <label for="publish-new-home" class={labelClass}>Home page (optional)</label>
                            <input id="publish-new-home" class={inputClass} bind:value={newHome} placeholder="Welcome" data-testid="publish-new-home" />
                            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">The document whose content is the front page. Without one the front page lists the pages.</p>
                        </div>
                        <div>
                            <label for="publish-new-url" class={labelClass}>Site address (optional)</label>
                            <input id="publish-new-url" class={inputClass} bind:value={newUrl} placeholder="https://docs.example.com" data-testid="publish-new-url" />
                            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">Needed for the sitemap and the feed.</p>
                        </div>
                    </div>
                    {#if createError}<p role="alert" class="text-sm text-red-700 dark:text-red-300" data-testid="publish-new-error">{createError}</p>{/if}
                    <div class="flex gap-2">
                        <button type="submit" class={primaryButton} disabled={createBusy} data-testid="publish-new-create">{createBusy ? "Creating…" : "Create and open"}</button>
                        <button type="button" class={secondaryButton} onclick={() => (creating = false)}>Cancel</button>
                    </div>
                </form>
            {/if}

            {#if graph.publications.length === 0 && !creating}
                <p class="text-sm text-gray-500 dark:text-gray-400" data-testid="publish-empty">
                    No publication yet. Create one, mark documents public, and publish to a folder or a zip.
                </p>
            {/if}

            {#each graph.publications as p (p.id)}
                {@const folder = folders[p.id] ?? null}
                {@const outcome = outcomes[p.id]}
                {@const working = busy[p.id]}
                {@const draft = drafts[p.id]}
                {@const changes = draft ? changesOf(p, draft) : null}
                {@const themeSlots = slots[p.theme] ?? null}
                {@const themeDirty = draft ? themeRefOf(draft) !== p.theme : false}
                {@const problems = draft ? pageProblems(p, draft, themeSlots) : []}
                {@const home = draft ? homeProblem(p, draft) : null}
                <article class="space-y-3 rounded-lg border border-gray-200 dark:border-gray-800 p-3" data-testid="publication-{p.id}" aria-busy={working ? "true" : "false"}>
                    <div class="flex flex-wrap items-baseline justify-between gap-2">
                        <div>
                            <h4 class="text-sm font-semibold text-gray-950 dark:text-gray-100">{p.name}</h4>
                            <p class="text-sm text-gray-500 dark:text-gray-400">
                                <code>{p.id}</code>
                                {#if p.url}· <a href={p.url} rel="noopener" target="_blank" class="underline">{p.url}</a>{/if}
                            </p>
                        </div>
                        <button type="button" class={linkButton} onclick={() => onopenpage(p.concept)} data-testid="publication-{p.id}-open">Edit page</button>
                    </div>

                    {#if draft}
                        <!-- The card is a draft of the page's mapping; nothing below writes until Save changes. -->
                        <div class="grid gap-3 sm:grid-cols-2">
                            <div>
                                <label for="publication-{p.id}-theme" class={labelClass}>Theme</label>
                                <select
                                    id="publication-{p.id}-theme"
                                    class={inputClass}
                                    bind:value={draft.theme}
                                    onchange={() => edited(p.id)}
                                    disabled={!!working}
                                    data-testid="publication-{p.id}-theme"
                                >
                                    {#each bundledThemes as t (t.name)}
                                        <option value={t.name}>{t.title} (bundled)</option>
                                    {/each}
                                    {#each themes as t (t.id)}
                                        <option value={t.id}>{t.name} (in this graph)</option>
                                    {/each}
                                    {#if !bundledThemes.some((t) => t.name === p.theme) && !themes.some((t) => t.id === p.theme) && !isUrlTheme(p.theme)}
                                        <option value={p.theme}>{themeLabel(p.theme)}</option>
                                    {/if}
                                    <option value="url">A theme at a url…</option>
                                </select>
                                {#if draft.theme === "url"}
                                    <label class="sr-only" for="publication-{p.id}-theme-url">Theme url</label>
                                    <input
                                        id="publication-{p.id}-theme-url"
                                        class={inputClass + " mt-2"}
                                        bind:value={draft.themeUrl}
                                        oninput={() => edited(p.id)}
                                        placeholder="https://…/theme.json"
                                        disabled={!!working}
                                        data-testid="publication-{p.id}-theme-url"
                                    />
                                {/if}
                                <div class="mt-1 flex flex-wrap gap-3">
                                    <!-- While the theme change is unsaved the link is not one: plain text colour with the
                                         underline, so it neither invites a click nor pretends to be gone. -->
                                    {#if themes.some((t) => t.id === p.theme)}
                                        <button type="button" class={themeDirty ? linkButtonUnavailable : linkButton} onclick={() => onopentheme(p.theme)} disabled={themeDirty} data-testid="publication-{p.id}-edit-theme">Open in Theme editor</button>
                                    {:else}
                                        <button type="button" class={!!working || themeDirty ? linkButtonUnavailable : linkButton} onclick={() => void customise(p)} disabled={!!working || themeDirty} data-testid="publication-{p.id}-customise">Customise theme…</button>
                                    {/if}
                                    {#if themeDirty}
                                        <span class="text-sm text-gray-500 dark:text-gray-400">Save the theme change first.</span>
                                    {/if}
                                </div>
                            </div>
                            <div>
                                <label for="publication-{p.id}-home" class={labelClass}>Home page</label>
                                <input
                                    id="publication-{p.id}-home"
                                    class={inputClass}
                                    bind:value={draft.home}
                                    oninput={() => edited(p.id)}
                                    placeholder="Lists the pages when empty"
                                    aria-describedby="publication-{p.id}-home-help"
                                    disabled={!!working}
                                    data-testid="publication-{p.id}-home"
                                />
                                <p id="publication-{p.id}-home-help" class={helpClass} data-testid="publication-{p.id}-home-help">
                                    The document whose content is the front page; without one the front page lists the pages.
                                    {#if home}<span class={warnClass} data-testid="publication-{p.id}-home-problem" data-problem={home}>{problemText(home, p)}</span>{/if}
                                </p>
                            </div>
                            <div>
                                <label for="publication-{p.id}-kind" class={labelClass}>Kind</label>
                                <select id="publication-{p.id}-kind" class={inputClass} bind:value={draft.kind} onchange={() => edited(p.id)} disabled={!!working} data-testid="publication-{p.id}-kind">
                                    <option value="docs">Documentation</option>
                                    <option value="blog">Blog</option>
                                </select>
                            </div>
                            <div>
                                <label for="publication-{p.id}-selection" class={labelClass}>Documents</label>
                                <select id="publication-{p.id}-selection" class={inputClass} bind:value={draft.selection} onchange={() => edited(p.id)} disabled={!!working} data-testid="publication-{p.id}-selection">
                                    <option value="named">Those that name this publication</option>
                                    <option value="all-public">Every public document</option>
                                </select>
                            </div>
                            <div class="sm:col-span-2">
                                <label for="publication-{p.id}-url" class={labelClass}>Site address</label>
                                <input
                                    id="publication-{p.id}-url"
                                    class={inputClass}
                                    bind:value={draft.url}
                                    oninput={() => edited(p.id)}
                                    placeholder="https://docs.example.com"
                                    disabled={!!working}
                                    data-testid="publication-{p.id}-url"
                                />
                                <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">Needed for the sitemap and the feed.</p>
                            </div>
                            {#if draft.kind === "blog"}
                                <div>
                                    <label for="publication-{p.id}-recent" class={labelClass}>Posts on the front page</label>
                                    <input
                                        id="publication-{p.id}-recent"
                                        class={inputClass}
                                        type="text"
                                        inputmode="numeric"
                                        pattern="[0-9]*"
                                        bind:value={draft.recent}
                                        oninput={() => edited(p.id)}
                                        disabled={!!working}
                                        data-testid="publication-{p.id}-recent"
                                    />
                                    <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                                        The latest posts, newest first. Every post is on <code>posts.html</code>, by year; add <code>[All posts](posts.html)</code> to the outline to put it in the menu.
                                    </p>
                                </div>
                            {/if}
                        </div>

                        {#if themeSlots && themeSlots.length > 0}
                            <details class="text-sm">
                                <summary class="cursor-pointer font-medium text-gray-700 dark:text-gray-300">Includes ({Object.keys(p.includes).length} of {themeSlots.length} set)</summary>
                                <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">Names of pages whose markdown or HTML body fills each slot. A page's wikilinks resolve like any other; the <code>styles</code> slot takes the page's first <code>css</code> fenced code block. A page named here has to be public and in this publication like any other content, and is then a snippet: it fills its slot and is not published as a page of its own.</p>
                                <div class="mt-2 grid gap-2 sm:grid-cols-2">
                                    {#each themeSlots as slot (slot.name)}
                                        {@const named = (draft.includes[slot.name] ?? "").trim()}
                                        {@const problem = named === "" ? null : pageProblem(p, draft, named)}
                                        <div>
                                            <label for="publication-{p.id}-include-{slot.name}" class={labelClass}>{slot.name}</label>
                                            <input
                                                id="publication-{p.id}-include-{slot.name}"
                                                class={inputClass}
                                                value={draft.includes[slot.name] ?? ""}
                                                oninput={(e) => {
                                                    draft.includes[slot.name] = (e.currentTarget as HTMLInputElement).value;
                                                    edited(p.id);
                                                }}
                                                placeholder="Page name"
                                                aria-describedby="publication-{p.id}-include-{slot.name}-help"
                                                disabled={!!working}
                                                data-testid="publication-{p.id}-include-{slot.name}"
                                            />
                                            <!-- One line for both, so the warning appearing moves nothing below it. -->
                                            <p id="publication-{p.id}-include-{slot.name}-help" class={helpClass}>
                                                {slot.description}
                                                {#if problem}<span class={warnClass} data-testid="publication-{p.id}-include-{slot.name}-problem" data-problem={problem}>{problemText(problem, p)}</span>{/if}
                                            </p>
                                        </div>
                                    {/each}
                                </div>
                            </details>
                        {/if}

                        {#if problems.length > 0}
                            {@const named = draft.selection === "named"}
                            <!-- Saving is still allowed: the settings are valid, the pages are not ready. What
                                 to do is spelled out here rather than in a toast, beside the fields it is about. -->
                            <div class="space-y-2 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-3 text-sm text-amber-900 dark:text-amber-100" data-testid="publication-{p.id}-page-warnings">
                                <p class="font-medium">{problems.length === 1 ? "A page this publication names would not be on the site:" : "Pages this publication names would not be on the site:"}</p>
                                <ul class="list-disc pl-5">
                                    {#each problems as item (item.field)}
                                        <li><strong>{item.field}</strong>: {problemText(item.problem, p)}</li>
                                    {/each}
                                </ul>
                                {#if problems.some((i) => i.problem === "not-public" || i.problem === "not-named")}
                                    <p>
                                        To put a page on this site, right-click its tab, choose <strong>Publish…</strong> and tick <strong>Public</strong>{#if named}&nbsp;and <strong>{p.id}</strong>{/if}.
                                        In its frontmatter that is <code>public: true</code>{#if named}&nbsp;and <code>publications: [{p.id}]</code>{/if}.
                                        {#if !named}This publication takes every public document, so Public is all it needs.{/if}
                                    </p>
                                {/if}
                                {#if problems.some((i) => i.problem === "missing")}
                                    <p>A page that does not exist yet: check the spelling here, or type the name into <strong>Quick find</strong> in the sidebar and choose its <strong>New page</strong> row.</p>
                                {/if}
                                {#if problems.some((i) => i.problem === "protected")}
                                    <p>A protected page can never be published; name a different page.</p>
                                {/if}
                                {#if problems.some((i) => i.problem === "publication-page")}
                                    <p>A publication page holds settings and the navigation and is never published; name a content page.</p>
                                {/if}
                            </div>
                        {/if}

                        <!-- Always present, so saving never shifts the folder controls under the pointer. -->
                        <div class="flex flex-wrap items-center gap-2">
                            <button type="button" class={primaryButton} onclick={() => void save(p)} disabled={!!working || !changes} data-testid="publication-{p.id}-save">{working === "Saving" ? "Saving…" : "Save changes"}</button>
                            <button type="button" class={secondaryButton} onclick={() => discard(p)} disabled={!!working || !changes} data-testid="publication-{p.id}-discard">Discard</button>
                            <span role="status" class="text-sm {changes && working !== 'Saving' ? 'text-amber-800 dark:text-amber-200' : 'text-gray-500 dark:text-gray-400'}" data-testid="publication-{p.id}-save-state">
                                {#if working === "Saving"}Saving…{:else if changes}Unsaved changes{:else if justSaved === p.id}Saved{/if}
                            </span>
                            {#if working === "Saving"}
                                <!-- The write plus the re-read of the graph behind it: seconds on a large graph. -->
                                <LoadingSweep label="Saving the publication" />
                            {/if}
                        </div>
                    {/if}

                    <div class="space-y-2 rounded-md bg-gray-50 dark:bg-white/5 p-2">
                        {#if folderSupported}
                            <p class="text-sm text-gray-950 dark:text-gray-100" data-testid="publication-{p.id}-folder">
                                {#if folder}
                                    Folder: <strong>{folder.folder}</strong>{#if folder.publishedAt} · last published {new Date(folder.publishedAt).toLocaleString()}{/if}
                                    <button type="button" class={linkButton + " ml-2"} onclick={() => void forgetFolder(p)} disabled={!!working}>Forget</button>
                                {:else}
                                    No folder chosen on this device.
                                {/if}
                            </p>
                        {:else}
                            <p class="text-sm text-gray-600 dark:text-gray-400">This browser cannot write a folder; download the site as a zip instead, or use Chrome or Edge on a desktop to publish straight into a folder.</p>
                        {/if}
                        <div class="flex flex-wrap gap-2">
                            {#if folderSupported}
                                <button type="button" class={secondaryButton} onclick={() => void chooseFolder(p)} disabled={!!working} data-testid="publication-{p.id}-choose-folder">{folder ? "Change folder…" : "Choose folder…"}</button>
                                <button type="button" class={primaryButton} onclick={() => void publish(p, "folder")} disabled={!!working || !folder} data-testid="publication-{p.id}-publish">{working === "Publishing" ? "Publishing…" : "Publish to folder"}</button>
                            {/if}
                            <button type="button" class={folderSupported ? secondaryButton : primaryButton} onclick={() => void publish(p, "zip")} disabled={!!working} data-testid="publication-{p.id}-zip">{working === "Building the zip" ? "Building…" : "Download zip"}</button>
                        </div>
                        {#if folderSupported && !folder}
                            <p class="text-sm text-gray-500 dark:text-gray-400">Choose a folder to publish into; the same folder is reused on this device each time.</p>
                        {/if}
                        {#if changes}
                            <p class="text-sm text-gray-500 dark:text-gray-400">A publish uses the saved settings, not the unsaved edits above.</p>
                        {/if}
                    </div>

                    {#if errors[p.id]}
                        <p role="alert" class="text-sm text-red-700 dark:text-red-300" data-testid="publication-{p.id}-error">{errors[p.id]}</p>
                    {/if}

                    {#if outcome}
                        {@const r = outcome.report}
                        <div class="space-y-1 text-sm" data-testid="publication-{p.id}-report" role="status">
                            {#if r.ok}
                                <p class="text-gray-950 dark:text-gray-100">
                                    Published {r.included.length} document{r.included.length === 1 ? "" : "s"}
                                    {#if outcome.target === "zip"}as a zip{:else if outcome.written}to the folder ({outcome.written.written} written, {outcome.written.unchanged} unchanged{#if outcome.written.deleted.length > 0}, {outcome.written.deleted.length} removed{/if}){/if}
                                    with the theme {r.theme?.source === "graph" ? themeTitle(p.theme) : themeTitle(r.theme?.name ?? p.theme)}{#if r.warnings.length > 0}, {r.warnings.length} warning{r.warnings.length === 1 ? "" : "s"}{/if}.
                                </p>
                            {:else}
                                <p class="text-red-700 dark:text-red-300">Not published: {r.errors.map((e) => e.message).join(" ")}</p>
                            {/if}
                            <button type="button" class={linkButton} onclick={() => (expandedReport = expandedReport === p.id ? null : p.id)} aria-expanded={expandedReport === p.id}>
                                {expandedReport === p.id ? "Hide report" : "Show report"}
                            </button>
                            {#if expandedReport === p.id}
                                <div class="space-y-2 rounded-md border border-gray-200 dark:border-gray-800 p-2" data-testid="publication-{p.id}-report-detail">
                                    {#each r.warnings as w (w.code + w.message)}
                                        <p class="text-amber-800 dark:text-amber-200">{w.message}</p>
                                    {/each}
                                    {#if r.excluded.length > 0}
                                        <p class="text-gray-700 dark:text-gray-300">Left out:</p>
                                        <ul class="list-disc pl-5 text-gray-600 dark:text-gray-400">
                                            {#each r.excluded as e (e.concept)}
                                                <li>
                                                    <button type="button" class={linkButton} onclick={() => onopenpage(e.concept)}>{e.concept}</button>
                                                    {#if e.reason === "protected"}(protected, never published){:else if e.reason === "not-public"}(not public){:else if e.reason === "publication-page"}(a publication page){:else if e.reason === "include-page"}(fills the {(e.includes ?? []).map((u) => `${u.slot} include of ${u.publication}`).join(", ")}; not a page of its own){:else}(public, but not in this publication{#if e.publishedIn}; published in {e.publishedIn.join(", ")}{/if}){/if}
                                                </li>
                                            {/each}
                                        </ul>
                                    {/if}
                                    {#if r.missingLinks.length > 0}
                                        <p class="text-gray-700 dark:text-gray-300">Links to pages that are not on the site:</p>
                                        <ul class="list-disc pl-5 text-gray-600 dark:text-gray-400">
                                            {#each r.missingLinks as l (l.from + "→" + l.concept)}
                                                <li>{l.from} → {l.concept} {#if l.status === "elsewhere"}(published in {l.publishedIn?.join(", ")}, not here){:else if l.status === "private"}(not public){:else}(no such document){/if}</li>
                                            {/each}
                                        </ul>
                                    {/if}
                                    {#if r.assets.missing.length > 0}
                                        <p class="text-gray-700 dark:text-gray-300">Assets the graph does not hold: {r.assets.missing.map((a) => `${a.name} (${a.from})`).join(", ")}</p>
                                    {/if}
                                    {#if r.external.length > 0}
                                        <p class="text-gray-700 dark:text-gray-300">Loaded from elsewhere by the theme or an include: {r.external.join(", ")}</p>
                                    {/if}
                                    <p class="text-gray-600 dark:text-gray-400">Includes: {r.includes.map((i) => `${i.name} (${i.source === "page" ? i.concept : "theme"})`).join(", ") || "none"}.</p>
                                </div>
                            {/if}
                        </div>
                    {/if}
                </article>
            {/each}

            {#if graph.publicInNoPublication.length > 0}
                {@const orphans = graph.publicInNoPublication.length}
                {@const orphanList = [...graph.publicInNoPublication].sort((a, b) => a.localeCompare(b))}
                <!-- One page per row inside a bounded, scrolling list: a converted blog can have
                     dozens here, and a run-on sentence of titles was unreadable past a handful. -->
                <div class="space-y-2 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-3" data-testid="publish-orphans">
                    <p class="text-sm text-amber-800 dark:text-amber-200">
                        {orphans === 1 ? "One document is" : `${orphans} documents are`} public but in no publication. Name a publication in
                        {orphans === 1 ? "its" : "their"} frontmatter (right-click the document → <strong>Publish…</strong>), or make a publication that takes every public document.
                    </p>
                    <ul class="max-h-48 overflow-y-auto rounded-md border border-amber-200 dark:border-amber-900 bg-white dark:bg-gray-900 divide-y divide-gray-100 dark:divide-gray-800" aria-label="Public documents in no publication">
                        {#each orphanList as concept (concept)}
                            <li>
                                <button type="button" class="block w-full truncate px-3 py-1.5 text-left text-sm font-medium text-agent-600 dark:text-agent-300 hover:bg-gray-50 dark:hover:bg-white/5 hover:underline" title={concept} onclick={() => onopenpage(concept)}>{concept}</button>
                            </li>
                        {/each}
                    </ul>
                </div>
            {/if}
        </section>

        <section class="space-y-3" aria-labelledby="themes-heading">
            <div class="flex items-center justify-between gap-3">
                <h3 id="themes-heading" class="text-sm font-semibold text-gray-950 dark:text-gray-100">Themes in this graph</h3>
                {#if !addingTheme}
                    <button type="button" class={secondaryButton} data-testid="theme-add" onclick={() => (addingTheme = true)}>Add theme</button>
                {/if}
            </div>
            <p class="text-sm text-gray-600 dark:text-gray-400">
                A theme is templates, a stylesheet and a search script, never code that runs in EtherPK. The bundled themes ship with the app; a copy in the graph can be edited in the Theme editor and travels with the graph.
            </p>

            {#if addingTheme}
                <form
                    class="space-y-3 rounded-lg border border-gray-200 dark:border-gray-800 p-3"
                    data-testid="theme-add-form"
                    onsubmit={(e) => {
                        e.preventDefault();
                        void addTheme();
                    }}
                >
                    <div>
                        <label for="theme-add-ref" class={labelClass}>Copy from</label>
                        <select id="theme-add-ref" class={inputClass} bind:value={themeRef} data-testid="theme-add-ref">
                            {#each bundledThemes as t (t.name)}
                                <option value={t.name}>{t.title} (bundled)</option>
                            {/each}
                            <option value="url">A url to a theme.json</option>
                        </select>
                    </div>
                    {#if themeRef === "url"}
                        <div>
                            <label for="theme-add-url" class={labelClass}>Url</label>
                            <input id="theme-add-url" class={inputClass} bind:value={themeUrl} placeholder="https://raw.githubusercontent.com/you/theme/main/theme.json" data-testid="theme-add-url" />
                        </div>
                    {/if}
                    <div class="grid gap-3 sm:grid-cols-2">
                        <div>
                            <label for="theme-add-name" class={labelClass}>Name</label>
                            <input id="theme-add-name" class={inputClass} bind:value={themeName} placeholder="My docs theme" data-testid="theme-add-name" />
                        </div>
                        <div>
                            <label for="theme-add-id" class={labelClass}>Id</label>
                            <input
                                id="theme-add-id"
                                class={inputClass}
                                value={effectiveThemeId}
                                oninput={(e) => {
                                    themeIdTouched = true;
                                    themeId = (e.currentTarget as HTMLInputElement).value;
                                }}
                                data-testid="theme-add-id"
                            />
                        </div>
                    </div>
                    {#if addThemeError}<p role="alert" class="text-sm text-red-700 dark:text-red-300" data-testid="theme-add-error">{addThemeError}</p>{/if}
                    <div class="flex gap-2">
                        <button type="submit" class={primaryButton} disabled={addThemeBusy} data-testid="theme-add-submit">{addThemeBusy ? "Adding…" : "Add to graph"}</button>
                        <button type="button" class={secondaryButton} onclick={() => (addingTheme = false)}>Cancel</button>
                    </div>
                </form>
            {/if}

            {#if themes.length === 0 && !addingTheme}
                <p class="text-sm text-gray-500 dark:text-gray-400" data-testid="themes-empty">No theme has been copied into this graph; the publications use the bundled ones.</p>
            {/if}
            <ul class="space-y-2">
                {#each themes as t (t.id)}
                    {@const users = usedBy(t.id)}
                    {@const drafted = draftedBy(t.id)}
                    <li class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 dark:border-gray-800 p-2 text-sm" data-testid="theme-{t.id}">
                        <div>
                            <span class="font-medium text-gray-950 dark:text-gray-100">{t.name}</span>
                            <span class="text-gray-500 dark:text-gray-400"> · <code>{t.id}</code>{#if t.origin} · from {t.origin}{/if}{#if users.length > 0} · used by {listNames(users)}{/if}</span>
                        </div>
                        <div class="flex flex-wrap gap-2">
                            <button type="button" class={secondaryButton} onclick={() => onopentheme(t.id)} data-testid="theme-{t.id}-open">Open editor</button>
                            {#if deleteThemeArmed === t.id}
                                <button
                                    type="button"
                                    class={dangerButton}
                                    onclick={() => {
                                        deleteThemeArmed = null;
                                        void ondeletetheme(t.id);
                                    }}
                                    data-testid="theme-{t.id}-delete-confirm">Delete for everyone</button
                                >
                                <button type="button" class={secondaryButton} onclick={() => (deleteThemeArmed = null)}>Keep</button>
                            {:else}
                                <!-- Blocked while a saved mapping names it, and while an unsaved card selects it: that
                                     save would otherwise point at a theme that is gone. The reason sits below. -->
                                <button type="button" class={secondaryButton} onclick={() => (deleteThemeArmed = t.id)} disabled={users.length > 0 || drafted.length > 0} data-testid="theme-{t.id}-delete">Delete…</button>
                            {/if}
                        </div>
                        {#if deleteThemeArmed !== t.id}
                            {#if users.length > 0}
                                <p class="w-full text-sm text-gray-500 dark:text-gray-400" data-testid="theme-{t.id}-in-use">In use by {listNames(users)}, so it cannot be deleted; point {users.length === 1 ? "that publication" : "those publications"} at another theme and save first.</p>
                            {:else if drafted.length > 0}
                                <p class="w-full text-sm text-gray-500 dark:text-gray-400" data-testid="theme-{t.id}-in-draft">Selected in the unsaved changes of {listNames(drafted)}; save or discard them first.</p>
                            {/if}
                        {/if}
                    </li>
                {/each}
            </ul>
        </section>
    {/if}
</div>
