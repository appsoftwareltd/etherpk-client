<script lang="ts">
    /**
     * The **Publish** tab of the Settings modal (ADR 0082): the graph's [[Publication]]s, each
     * with its theme, includes, destination and last report; the public documents no
     * publication takes; the graph's [[Theme]]s. Everything here is graph content edited through
     * the publication page (the workspace rewrites its frontmatter) except where a publication
     * publishes, which is per device: a [[Publish Folder]] or a [[Publish Repository]] (ADR 0152),
     * one or the other. The person's GitHub token, one for every repository, has a section of its
     * own at the top; the tab knows whether one is set, never what it is.
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
    import { GitHubError } from "$lib/document/publish/host/github-api";
    import { isBranchName, parseRepository } from "$lib/document/publish/host/github-repository";
    import type { GraphTheme } from "$lib/document/publish/theme/graph-theme";
    import type { Publication, PublicationKind, PublicationSelection } from "$lib/document/publish/types";
    import { suggestPublicationId } from "$lib/workspace/publish-service";
    import type { NewPublicationInput, PublicationChanges, PublishDocumentSummary } from "$lib/workspace/publish-service";

    import type { GitHubTokenState, GraphPublishingState, PublicationDestinationState, PublishTabProps, PublishTarget, RepositoryCheckState } from "./publish-tab";

    let {
        folderSupported,
        load,
        destinationOf,
        onchoosefolder,
        onforgetdestination,
        onsaverepository,
        oncreatebranch,
        githubToken,
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
    /** Where each publication publishes on this device, as remembered. */
    let destinations = $state<Record<string, PublicationDestinationState | null>>({});
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

    // ── Destinations ──────────────────────────────────────────────────────────────────────
    // A card shows one destination: the kind it remembers, or the one the person has picked and
    // not yet set up. Picking does not forget the other; setting one up replaces it.
    let choices = $state<Record<string, "folder" | "github">>({});
    /** A card's repository fields as typed. */
    interface RepositoryDraft {
        repository: string;
        branch: string;
    }
    let repositoryDrafts = $state<Record<string, RepositoryDraft>>({});
    /** What the last check of a card's repository found this session; null before one ran. */
    let repositoryChecks = $state<Record<string, RepositoryCheckState | null>>({});
    /** What is wrong with a card's repository fields as typed, before anything is sent. */
    let repositoryFieldErrors = $state<Record<string, string | null>>({});
    /** Files a first publish to a repository would replace, waiting for the person's go-ahead. */
    let confirmations = $state<Record<string, string[] | null>>({});

    function choiceOf(p: Publication): "folder" | "github" {
        const chosen = choices[p.id];
        if (chosen) return chosen;
        const remembered = destinations[p.id];
        if (remembered?.kind === "repository") return "github";
        return folderSupported ? "folder" : "github";
    }

    function savedRepositoryOf(p: Publication): Extract<PublicationDestinationState, { kind: "repository" }> | null {
        const remembered = destinations[p.id];
        return remembered?.kind === "repository" ? remembered : null;
    }

    function repositoryDraftOf(p: Publication): RepositoryDraft {
        const saved = savedRepositoryOf(p);
        return repositoryDrafts[p.id] ?? { repository: saved ? `${saved.owner}/${saved.name}` : "", branch: saved?.branch ?? "main" };
    }

    /** True when the fields differ from the remembered repository. */
    function repositoryEdited(p: Publication): boolean {
        const saved = savedRepositoryOf(p);
        const draft = repositoryDraftOf(p);
        if (!saved) return draft.repository.trim() !== "";
        const parsed = parseRepository(draft.repository);
        return !parsed || parsed.owner !== saved.owner || parsed.name !== saved.name || (draft.branch.trim() || "main") !== saved.branch;
    }

    function editRepository(p: Publication, change: Partial<RepositoryDraft>): void {
        repositoryDrafts = { ...repositoryDrafts, [p.id]: { ...repositoryDraftOf(p), ...change } };
        // Validated on save, then again as the person corrects the field.
        if (repositoryFieldErrors[p.id]) repositoryFieldErrors = { ...repositoryFieldErrors, [p.id]: repositoryFieldProblem(repositoryDraftOf(p)) };
    }

    function repositoryFieldProblem(draft: RepositoryDraft): string | null {
        if (!parseRepository(draft.repository)) return "Enter the repository as owner/name, such as you/garden-site, or paste its address on GitHub.";
        if (!isBranchName(draft.branch.trim() || "main")) return `"${draft.branch.trim()}" is not a branch name git takes. Leave it empty for main.`;
        return null;
    }

    // ── The GitHub token ──────────────────────────────────────────────────────────────────
    // Read at once so the section never flashes "no token" before the subscription in onMount.
    // svelte-ignore state_referenced_locally
    let token = $state<GitHubTokenState>(githubToken.read());
    let tokenDraft = $state("");
    let tokenError = $state<string | null>(null);
    let replacingToken = $state(false);
    let forgetTokenArmed = $state(false);
    /** GitHub refused the token this session: it has expired or been revoked. */
    let tokenRefused = $state(false);
    let tokenInput = $state<HTMLInputElement>();

    const showGitHub = $derived(token.set || (graph?.publications ?? []).some((p) => choiceOf(p) === "github"));

    function saveToken(): void {
        const value = tokenDraft.trim();
        if (value === "") {
            tokenError = "Paste the token GitHub gave you.";
            tokenInput?.focus();
            return;
        }
        if (/\s/.test(value)) {
            tokenError = "A GitHub token has no spaces in it. Copy it again from GitHub.";
            tokenInput?.focus();
            return;
        }
        githubToken.save(value);
        tokenDraft = "";
        tokenError = null;
        replacingToken = false;
        tokenRefused = false;
    }

    function cancelReplaceToken(): void {
        replacingToken = false;
        tokenDraft = "";
        tokenError = null;
    }

    function forgetToken(): void {
        githubToken.forget();
        forgetTokenArmed = false;
        tokenRefused = false;
    }

    async function focusTokenField(): Promise<void> {
        if (token.set) replacingToken = true;
        await tick();
        tokenInput?.focus();
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
            const nextDestinations: Record<string, PublicationDestinationState | null> = {};
            for (const p of next.publications) nextDestinations[p.id] = await destinationOf(p.id);
            destinations = nextDestinations;
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
        const stopToken = githubToken.subscribe(() => (token = githubToken.read()));
        const stopThemes = subscribeThemes((list) => {
            themes = list;
        });
        return () => {
            stopToken();
            stopThemes();
        };
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
            // A branch that is not there yet is a state of the repository, shown beside its
            // fields with Create branch, rather than an error under the card.
            if (error instanceof GitHubError && (error.code === "branch-missing" || error.code === "empty-repository")) {
                repositoryChecks = { ...repositoryChecks, [id]: error.code === "empty-repository" ? "empty" : "branch-missing" };
                return;
            }
            if (error instanceof GitHubError && error.code === "bad-token") tokenRefused = true;
            errors = { ...errors, [id]: error instanceof Error ? error.message : String(error) };
        } finally {
            setBusy(id, null);
        }
    }

    async function chooseFolder(p: Publication): Promise<void> {
        await guarded(p.id, "Choosing a folder", async () => {
            const chosen = await onchoosefolder(p.id);
            if (chosen) {
                destinations = { ...destinations, [p.id]: { kind: "folder", ...chosen } };
                repositoryChecks = { ...repositoryChecks, [p.id]: null };
                confirmations = { ...confirmations, [p.id]: null };
            }
        });
    }

    async function forgetDestination(p: Publication): Promise<void> {
        await guarded(p.id, "Forgetting", async () => {
            await onforgetdestination(p.id);
            destinations = { ...destinations, [p.id]: null };
            repositoryDrafts = { ...repositoryDrafts, [p.id]: { repository: "", branch: "main" } };
            repositoryChecks = { ...repositoryChecks, [p.id]: null };
            confirmations = { ...confirmations, [p.id]: null };
        });
    }

    async function saveRepository(p: Publication): Promise<void> {
        const draft = repositoryDraftOf(p);
        const problem = repositoryFieldProblem(draft);
        repositoryFieldErrors = { ...repositoryFieldErrors, [p.id]: problem };
        if (problem) {
            document.getElementById(problem.startsWith("Enter") ? `publication-${p.id}-repository` : `publication-${p.id}-branch`)?.focus();
            return;
        }
        const parsed = parseRepository(draft.repository) as { owner: string; name: string };
        const branch = draft.branch.trim() || "main";
        await guarded(p.id, "Checking", async () => {
            repositoryChecks = { ...repositoryChecks, [p.id]: null };
            confirmations = { ...confirmations, [p.id]: null };
            try {
                const state = await onsaverepository(p.id, { ...parsed, branch });
                repositoryChecks = { ...repositoryChecks, [p.id]: state };
                if (state !== "unchecked") tokenRefused = false;
            } finally {
                // Remembered whatever the check found, and shown as the workspace wrote it.
                destinations = { ...destinations, [p.id]: await destinationOf(p.id) };
                repositoryDrafts = { ...repositoryDrafts, [p.id]: { repository: `${parsed.owner}/${parsed.name}`, branch } };
            }
        });
    }

    async function createBranch(p: Publication): Promise<void> {
        await guarded(p.id, "Creating the branch", async () => {
            const state = await oncreatebranch(p);
            repositoryChecks = { ...repositoryChecks, [p.id]: state };
            destinations = { ...destinations, [p.id]: await destinationOf(p.id) };
        });
    }

    async function publish(p: Publication, target: PublishTarget, confirmed = false): Promise<void> {
        await guarded(p.id, target === "zip" ? "Building the zip" : "Publishing", async () => {
            confirmations = { ...confirmations, [p.id]: null };
            const attempt = await onpublish(p, target, { confirmed });
            if (attempt.state === "needs-confirmation") {
                confirmations = { ...confirmations, [p.id]: attempt.replaced };
                return;
            }
            if (target === "repository") {
                repositoryChecks = { ...repositoryChecks, [p.id]: "ready" };
                tokenRefused = false;
            }
            if (target !== "zip" && attempt.outcome.report.ok) destinations = { ...destinations, [p.id]: await destinationOf(p.id) };
        });
    }

    /** The files a confirmation names, the first few in full. */
    function fileList(paths: string[]): string {
        const shown = paths.slice(0, 5).join(", ");
        return paths.length > 5 ? `${shown} and ${paths.length - 5} more` : shown;
    }

    /** Focus a node as it appears: the confirmation's Cancel, so a keyboard user lands on the question with the safe answer. */
    function focusOnMount(node: HTMLElement): void {
        node.focus();
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
            createError = "Give the publication a name - it becomes the page's title.";
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
    // EtherPK's control classes (controls.css, ADR 0151), which are disabled by colour rather than
    // opacity: a faded light button on the dark surface left its label unreadable ("Publish to
    // folder" with no folder chosen read as a blank grey block).
    const primaryButton = "gk-button gk-button--primary";
    const secondaryButton = "gk-button";
    const dangerButton = "gk-button gk-button--danger";
    const linkButton = "gk-link text-sm";
    /** The same link while it cannot be followed: the text colour, underlined, no hover change. */
    const linkButtonUnavailable = "text-sm font-medium text-gray-700 dark:text-gray-300 underline underline-offset-2 cursor-default";
    const helpClass = "mt-1 text-sm text-gray-500 dark:text-gray-400";
    const warnClass = "text-amber-800 dark:text-amber-200";
</script>

<div class="space-y-5" data-testid="publish-tab">
    <p class="text-sm text-gray-600 dark:text-gray-400">
        A publication is a named selection of public documents rendered as one website, into a
        folder or a GitHub repository that your host deploys from. A document is published when its frontmatter says
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

        {#if showGitHub}
            <!-- One token for every repository the person publishes to, kept with their settings
                 rather than the graph (ADR 0152). Its value is never read back into the page. -->
            <section class="space-y-2 rounded-lg border border-gray-200 dark:border-gray-800 p-3" aria-labelledby="publish-github-heading" data-testid="publish-github">
                <h3 id="publish-github-heading" class="text-sm font-semibold text-gray-950 dark:text-gray-100">GitHub</h3>
                {#if token.set && !replacingToken}
                    <p class="text-sm text-gray-950 dark:text-gray-100" data-testid="publish-github-token-state">
                        A GitHub token is set{token.follows ? ". It follows you to your other devices through your account." : " on this device."}
                    </p>
                    {#if tokenRefused}
                        <p role="alert" class="text-sm text-red-700 dark:text-red-300" data-testid="publish-github-token-refused">
                            GitHub refused this token the last time EtherPK used it. It has expired, been revoked or was mistyped. Replace it with a new one.
                        </p>
                    {/if}
                    <div class="flex flex-wrap items-center gap-2">
                        {#if forgetTokenArmed}
                            <span class="text-sm text-gray-950 dark:text-gray-100">Forget the token on this device{token.follows ? " and your other devices" : ""}? Publishing to GitHub then needs a new one.</span>
                            <button type="button" class={dangerButton} onclick={forgetToken} data-testid="publish-github-forget-confirm">Forget token</button>
                            <button type="button" class={secondaryButton} onclick={() => (forgetTokenArmed = false)}>Keep</button>
                        {:else}
                            <button type="button" class={secondaryButton} onclick={() => void focusTokenField()} data-testid="publish-github-replace">Replace token</button>
                            <button type="button" class={secondaryButton} onclick={() => (forgetTokenArmed = true)} data-testid="publish-github-forget">Forget token…</button>
                        {/if}
                    </div>
                {:else}
                    <form
                        class="space-y-2"
                        data-testid="publish-github-token-form"
                        onsubmit={(e) => {
                            e.preventDefault();
                            saveToken();
                        }}
                    >
                        <label for="publish-github-token" class={labelClass}>GitHub token</label>
                        <input
                            id="publish-github-token"
                            bind:this={tokenInput}
                            class={inputClass}
                            type="password"
                            autocomplete="off"
                            spellcheck="false"
                            bind:value={tokenDraft}
                            oninput={() => {
                                if (tokenError) tokenError = null;
                            }}
                            onkeydown={(e) => {
                                // Esc backs out of replacing; it must not close the whole modal.
                                if (e.key === "Escape" && replacingToken) {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    cancelReplaceToken();
                                }
                            }}
                            placeholder="github_pat_…"
                            aria-describedby="publish-github-token-help"
                            aria-invalid={tokenError ? "true" : undefined}
                            data-testid="publish-github-token"
                        />
                        <p id="publish-github-token-help" class={helpClass}>
                            {#if tokenError}<span class="text-red-700 dark:text-red-300" data-testid="publish-github-token-error">{tokenError}</span>{:else}Your own token, which EtherPK commits the site with. It is not shown again once saved.{/if}
                        </p>
                        <div class="flex flex-wrap gap-2">
                            <button type="submit" class={primaryButton} data-testid="publish-github-token-save">Save token</button>
                            {#if replacingToken}
                                <button type="button" class={secondaryButton} onclick={cancelReplaceToken}>Cancel</button>
                            {/if}
                        </div>
                    </form>
                {/if}
                <details class="text-sm" data-testid="publish-github-steps">
                    <summary class="cursor-pointer font-medium text-gray-700 dark:text-gray-300">How to make a token</summary>
                    <ol class="mt-2 list-decimal space-y-1 pl-5 text-gray-600 dark:text-gray-400">
                        <li>On GitHub, open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener" class="underline">Settings → Developer settings → Fine-grained tokens → Generate new token</a>.</li>
                        <li>Give it a name and an expiry date. When it expires, make a new one and replace it here.</li>
                        <li>For Resource owner, choose the account or organisation that owns the site's repository. An organisation's owners may have to approve the token before it works.</li>
                        <li>For Repository access, choose Only select repositories, and pick the site's repositories.</li>
                        <li>Under Permissions, on the Repositories tab, select Add permissions, search for Contents and tick it. Contents then shows in the list with an access menu: set it to Read and write. GitHub adds Metadata, read-only, by itself. Add nothing else.</li>
                        <li>Generate the token, copy it and paste it here.</li>
                    </ol>
                </details>
                <p class={helpClass}>
                    Limited scope for the token is important for your security (EtherPK community extensions are reviewed before they are listed, but they run
                    in EtherPK's browser tab and have the potential to read data from it).
                </p>
            </section>
        {/if}

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
                        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">What documents name in <code>publications: [{effectiveId || "docs"}]</code>. Lower-case letters, digits and hyphens - fixed once documents use it.</p>
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
                {@const destination = destinations[p.id] ?? null}
                {@const folder = destination?.kind === "folder" ? destination : null}
                {@const savedRepository = savedRepositoryOf(p)}
                {@const choice = choiceOf(p)}
                {@const repositoryDraft = repositoryDraftOf(p)}
                {@const repositoryCheck = repositoryChecks[p.id] ?? null}
                {@const repositoryUnsaved = repositoryEdited(p)}
                {@const confirmation = confirmations[p.id] ?? null}
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
                                    The document whose content is the front page - without one the front page lists the pages.
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
                                        The latest posts, newest first. Every post is on <code>posts.html</code>, by year - add <code>[All posts](posts.html)</code> to the outline to put it in the menu.
                                    </p>
                                </div>
                            {/if}
                        </div>

                        {#if themeSlots && themeSlots.length > 0}
                            <details class="text-sm">
                                <summary class="cursor-pointer font-medium text-gray-700 dark:text-gray-300">Includes ({Object.keys(p.includes).length} of {themeSlots.length} set)</summary>
                                <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">Names of pages whose markdown or HTML body fills each slot. A page's wikilinks resolve like any other - the <code>styles</code> slot takes the page's first <code>css</code> fenced code block. A page named here has to be public and in this publication like any other content, and is then a snippet: it fills its slot and is not published as a page of its own.</p>
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
                                    <p>A page that does not exist yet: check the spelling here, or search for the name with <strong>Search</strong> in the sidebar and choose its <strong>New page</strong> row.</p>
                                {/if}
                                {#if problems.some((i) => i.problem === "protected")}
                                    <p>A protected page can never be published - name a different page.</p>
                                {/if}
                                {#if problems.some((i) => i.problem === "publication-page")}
                                    <p>A publication page holds settings and the navigation and is never published - name a content page.</p>
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

                    <div class="space-y-3 rounded-md bg-gray-50 dark:bg-white/5 p-2" data-testid="publication-{p.id}-destination">
                        {#if folderSupported}
                            <!-- One destination per device: picking only shows the other's controls; setting
                                 one up (choosing a folder, saving a repository) replaces the remembered one. -->
                            <fieldset>
                                <legend class={labelClass}>Publish to</legend>
                                <div class="flex flex-wrap gap-x-5 gap-y-2">
                                    <label class="inline-flex items-center gap-2 text-sm text-gray-950 dark:text-gray-100">
                                        <input type="radio" name="publication-{p.id}-destination" value="folder" checked={choice === "folder"} onchange={() => (choices = { ...choices, [p.id]: "folder" })} disabled={!!working} data-testid="publication-{p.id}-destination-folder" />
                                        A folder on this device
                                    </label>
                                    <label class="inline-flex items-center gap-2 text-sm text-gray-950 dark:text-gray-100">
                                        <input type="radio" name="publication-{p.id}-destination" value="github" checked={choice === "github"} onchange={() => (choices = { ...choices, [p.id]: "github" })} disabled={!!working} data-testid="publication-{p.id}-destination-github" />
                                        A GitHub repository
                                    </label>
                                </div>
                            </fieldset>
                        {:else}
                            <p class="text-sm text-gray-600 dark:text-gray-400">This browser cannot write a folder, so the site goes to a GitHub repository or into a zip. Chrome or Edge on a desktop, or Chrome on Android, can also publish straight into a folder.</p>
                        {/if}

                        {#if choice === "folder"}
                            <p class="text-sm text-gray-950 dark:text-gray-100" data-testid="publication-{p.id}-folder">
                                {#if folder}
                                    Folder: <strong>{folder.folder}</strong>{#if folder.publishedAt} · last published {new Date(folder.publishedAt).toLocaleString()}{/if}
                                    <button type="button" class={linkButton + " ml-2"} onclick={() => void forgetDestination(p)} disabled={!!working}>Forget</button>
                                {:else if savedRepository}
                                    No folder chosen on this device. Choosing one replaces the repository {savedRepository.owner}/{savedRepository.name}.
                                {:else}
                                    No folder chosen on this device.
                                {/if}
                            </p>
                            <div class="flex flex-wrap gap-2">
                                <button type="button" class={secondaryButton} onclick={() => void chooseFolder(p)} disabled={!!working} data-testid="publication-{p.id}-choose-folder">{folder ? "Change folder…" : "Choose folder…"}</button>
                                <button type="button" class={primaryButton} onclick={() => void publish(p, "folder")} disabled={!!working || !folder} data-testid="publication-{p.id}-publish">{working === "Publishing" ? "Publishing…" : "Publish to folder"}</button>
                                <button type="button" class={secondaryButton} onclick={() => void publish(p, "zip")} disabled={!!working} data-testid="publication-{p.id}-zip">{working === "Building the zip" ? "Building…" : "Download zip"}</button>
                            </div>
                            {#if !folder}
                                <p class="text-sm text-gray-500 dark:text-gray-400">Choose a folder of its own to publish into, outside any graph. The same folder is reused on this device each time.</p>
                            {/if}
                        {:else}
                            <form
                                class="space-y-2"
                                data-testid="publication-{p.id}-repository-form"
                                onsubmit={(e) => {
                                    e.preventDefault();
                                    void saveRepository(p);
                                }}
                            >
                                <div class="grid gap-3 sm:grid-cols-3">
                                    <div class="sm:col-span-2">
                                        <label for="publication-{p.id}-repository" class={labelClass}>Repository</label>
                                        <input
                                            id="publication-{p.id}-repository"
                                            class={inputClass}
                                            value={repositoryDraft.repository}
                                            oninput={(e) => editRepository(p, { repository: (e.currentTarget as HTMLInputElement).value })}
                                            placeholder="you/garden-site"
                                            autocomplete="off"
                                            spellcheck="false"
                                            aria-describedby="publication-{p.id}-repository-help"
                                            aria-invalid={repositoryFieldErrors[p.id] ? "true" : undefined}
                                            disabled={!!working}
                                            data-testid="publication-{p.id}-repository"
                                        />
                                    </div>
                                    <div>
                                        <label for="publication-{p.id}-branch" class={labelClass}>Branch</label>
                                        <input
                                            id="publication-{p.id}-branch"
                                            class={inputClass}
                                            value={repositoryDraft.branch}
                                            oninput={(e) => editRepository(p, { branch: (e.currentTarget as HTMLInputElement).value })}
                                            placeholder="main"
                                            autocomplete="off"
                                            spellcheck="false"
                                            aria-describedby="publication-{p.id}-repository-help"
                                            disabled={!!working}
                                            data-testid="publication-{p.id}-branch"
                                        />
                                    </div>
                                </div>
                                <p id="publication-{p.id}-repository-help" class={helpClass}>
                                    {#if repositoryFieldErrors[p.id]}
                                        <span class="text-red-700 dark:text-red-300" data-testid="publication-{p.id}-repository-invalid">{repositoryFieldErrors[p.id]}</span>
                                    {:else}
                                        The repository and branch the site is committed to, as owner/name or its address on GitHub. Each publish is one commit, and what it publishes stays in the repository's history.
                                    {/if}
                                </p>
                                <div class="flex flex-wrap items-center gap-2">
                                    <button type="submit" class={secondaryButton} disabled={!!working} data-testid="publication-{p.id}-save-repository">{working === "Checking" ? "Checking…" : "Save and check"}</button>
                                    {#if (repositoryCheck === "empty" || repositoryCheck === "branch-missing") && savedRepository && !repositoryUnsaved}
                                        <button type="button" class={secondaryButton} onclick={() => void createBranch(p)} disabled={!!working} data-testid="publication-{p.id}-create-branch">{working === "Creating the branch" ? "Creating…" : `Create branch ${savedRepository.branch}`}</button>
                                    {/if}
                                    <span role="status" class="text-sm {repositoryUnsaved ? 'text-amber-800 dark:text-amber-200' : 'text-gray-600 dark:text-gray-400'}" data-testid="publication-{p.id}-repository-state">
                                        {#if working === "Checking"}
                                            Checking {repositoryDraft.repository.trim()}…
                                        {:else if repositoryUnsaved}
                                            {savedRepository ? "Unsaved changes. A publish uses the saved repository." : "Not saved yet."}
                                        {:else if savedRepository && repositoryCheck === "ready"}
                                            Ready. The token can write to {savedRepository.owner}/{savedRepository.name} on {savedRepository.branch}.
                                        {:else if savedRepository && repositoryCheck === "empty"}
                                            {savedRepository.owner}/{savedRepository.name} is empty. Create the branch to make its first commit.
                                        {:else if savedRepository && repositoryCheck === "branch-missing"}
                                            {savedRepository.owner}/{savedRepository.name} has no branch "{savedRepository.branch}" yet. A publish never creates one, in case the name is mistyped.
                                        {:else if savedRepository && repositoryCheck === "unchecked"}
                                            Saved. Set a GitHub token above to check it.
                                        {:else if savedRepository}
                                            {savedRepository.checkedAt ? "Saved." : "Saved, not checked yet. The first publish checks it."}{#if savedRepository.publishedAt} Last published {new Date(savedRepository.publishedAt).toLocaleString()}.{/if}
                                        {/if}
                                    </span>
                                </div>
                                {#if repositoryCheck === "unchecked" && !token.set}
                                    <button type="button" class={linkButton} onclick={() => void focusTokenField()} data-testid="publication-{p.id}-set-token">Set a GitHub token</button>
                                {/if}
                            </form>

                            {#if confirmation && savedRepository}
                                <!-- Asked once, before the first publish replaces files on a branch that does not
                                     say it holds this site. Focus lands on Cancel, the safe answer. -->
                                <div
                                    class="space-y-2 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-3 text-sm text-amber-900 dark:text-amber-100"
                                    role="group"
                                    aria-labelledby="publication-{p.id}-confirm-title"
                                    data-testid="publication-{p.id}-confirm"
                                >
                                    <p id="publication-{p.id}-confirm-title" class="font-medium">{savedRepository.owner}/{savedRepository.name} does not hold this site on {savedRepository.branch} yet.</p>
                                    <p>
                                        Publishing replaces or deletes {confirmation.length} file{confirmation.length === 1 ? "" : "s"} there that this site did not write: {fileList(confirmation)}.
                                        The old versions stay in the branch's history.
                                    </p>
                                    <div class="flex flex-wrap gap-2">
                                        <button type="button" class={dangerButton} onclick={() => void publish(p, "repository", true)} disabled={!!working} data-testid="publication-{p.id}-confirm-publish">Publish and replace {confirmation.length} file{confirmation.length === 1 ? "" : "s"}</button>
                                        <button type="button" class={secondaryButton} {@attach focusOnMount} onclick={() => (confirmations = { ...confirmations, [p.id]: null })} data-testid="publication-{p.id}-confirm-cancel">Cancel</button>
                                    </div>
                                </div>
                            {/if}

                            <div class="flex flex-wrap gap-2">
                                <button type="button" class={primaryButton} onclick={() => void publish(p, "repository")} disabled={!!working || !savedRepository} data-testid="publication-{p.id}-publish-github">{working === "Publishing" ? "Publishing…" : "Publish to GitHub"}</button>
                                <button type="button" class={secondaryButton} onclick={() => void publish(p, "zip")} disabled={!!working} data-testid="publication-{p.id}-zip">{working === "Building the zip" ? "Building…" : "Download zip"}</button>
                                {#if savedRepository}
                                    <button type="button" class={linkButton} onclick={() => void forgetDestination(p)} disabled={!!working} data-testid="publication-{p.id}-forget-repository">Forget the repository</button>
                                {/if}
                            </div>
                            {#if !savedRepository}
                                <p class="text-sm text-gray-500 dark:text-gray-400">
                                    Save a repository to publish to it. It is remembered on this device{folder ? `, in place of the folder ${folder.folder}` : ""}.
                                </p>
                            {/if}
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
                            {#if r.ok && outcome.repository && outcome.commit === null}
                                <p class="text-gray-950 dark:text-gray-100" data-testid="publication-{p.id}-unchanged">
                                    Nothing had changed on {outcome.repository.owner}/{outcome.repository.name}@{outcome.repository.branch}, so no commit was made. The site has
                                    {r.included.length} document{r.included.length === 1 ? "" : "s"}{#if r.warnings.length > 0}, and the report {r.warnings.length} warning{r.warnings.length === 1 ? "" : "s"}{/if}.
                                </p>
                            {:else if r.ok}
                                <p class="text-gray-950 dark:text-gray-100">
                                    Published {r.included.length} document{r.included.length === 1 ? "" : "s"}
                                    {#if outcome.target === "zip"}as a zip{:else if outcome.repository && outcome.written}to {outcome.repository.owner}/{outcome.repository.name}@{outcome.repository.branch} ({outcome.written.written} written{#if outcome.written.deleted.length > 0}, {outcome.written.deleted.length} removed{/if}){:else if outcome.written}to the folder ({outcome.written.written} written, {outcome.written.unchanged} unchanged{#if outcome.written.deleted.length > 0}, {outcome.written.deleted.length} removed{/if}){/if}
                                    with the theme {r.theme?.source === "graph" ? themeTitle(p.theme) : themeTitle(r.theme?.name ?? p.theme)}{#if r.warnings.length > 0}, {r.warnings.length} warning{r.warnings.length === 1 ? "" : "s"}{/if}.
                                </p>
                                {#if outcome.commit}
                                    <a href={outcome.commit.url} target="_blank" rel="noopener" class={linkButton} data-testid="publication-{p.id}-commit">View the commit on GitHub</a>
                                {/if}
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
                                                    {#if e.reason === "protected"}(protected, never published){:else if e.reason === "not-public"}(not public){:else if e.reason === "publication-page"}(a publication page){:else if e.reason === "include-page"}(fills the {(e.includes ?? []).map((u) => `${u.slot} include of ${u.publication}`).join(", ")} - not a page of its own){:else}(public, but not in this publication{#if e.publishedIn} - published in {e.publishedIn.join(", ")}{/if}){/if}
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
                A theme is templates, a stylesheet and a search script, never code that runs in EtherPK. The bundled themes ship with the app - a copy in the graph can be edited in the Theme editor and travels with the graph.
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
                <p class="text-sm text-gray-500 dark:text-gray-400" data-testid="themes-empty">No theme has been copied into this graph - the publications use the bundled ones.</p>
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
                                <p class="w-full text-sm text-gray-500 dark:text-gray-400" data-testid="theme-{t.id}-in-use">In use by {listNames(users)}, so it cannot be deleted - point {users.length === 1 ? "that publication" : "those publications"} at another theme and save first.</p>
                            {:else if drafted.length > 0}
                                <p class="w-full text-sm text-gray-500 dark:text-gray-400" data-testid="theme-{t.id}-in-draft">Selected in the unsaved changes of {listNames(drafted)} - save or discard them first.</p>
                            {/if}
                        {/if}
                    </li>
                {/each}
            </ul>
        </section>
    {/if}
</div>
