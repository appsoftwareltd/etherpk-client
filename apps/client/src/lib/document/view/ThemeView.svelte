<script lang="ts" module>
    /**
     * The label the tab's title opens with, ahead of the theme's name. Registered as the kind's
     * `titlePrefix` too, so the tab's width cap grows by it and the name keeps a document tab's
     * room.
     */
    export const THEME_TITLE_PREFIX = "Theme: ";
</script>

<script lang="ts">
    /**
     * The **Theme editor** [[View]] (ADR 0082): one [[Theme]] kept in the graph, its files listed
     * on the left and a plain CodeMirror on the right, in the HTML, CSS, JavaScript or JSON mode
     * the file's extension names. A theme is graph content that is not a note, so it gets its
     * own pane rather than a page in the outliner, and a code editor rather than the document
     * editor.
     *
     * Saves are explicit (Save, or Mod+S in the editor) and write one file whole through the
     * shared theme store, which the workspace has wired to whichever backend it opened. A file
     * arriving from a peer while it is open here is shown as "changed elsewhere" rather than
     * silently replacing the buffer; the user picks. Mounted through the dockview adapter, so it
     * reads its services through module accessors rather than Svelte context.
     *
     * **Preview.** The theme, unsaved edits included, rendered over a publication of the graph
     * that uses it (or a bundled sample when none does) into a sandboxed frame with an opaque
     * origin, so a theme's script previews with no reach into the app. The rendered site is
     * handed to the service worker and framed from its preview route (`static/sw.js`), which is
     * what lets the site's scripts run: a page inside the app's own document would inherit the
     * app's Content Security Policy and could run no inline script. Without a worker the page is
     * inlined into a `srcdoc` frame instead (`host/preview.ts`), which shows it without its
     * scripts. Explicit: **Update preview** renders, and a Save re-renders while the pane is
     * open, because a real publication is seconds of work and nobody wants that on every
     * keystroke.
     */
    import { onDestroy, onMount } from "svelte";
    import { EditorState } from "@codemirror/state";
    import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
    import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
    import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, type LanguageSupport } from "@codemirror/language";
    import { languages } from "@codemirror/language-data";
    import { strToU8, zipSync } from "fflate";

    import type { ViewRef } from "$lib/layout";
    import { workspaceService } from "$lib/workspace/workspace-services";

    import { bundledTheme } from "@appsoftwareltd/etherpk-themes";

    import { type GraphTheme, isThemeFilePath } from "../publish/theme/graph-theme";
    import { parseThemeManifest } from "../publish/theme/manifest";
    import {
        removeGraphTheme,
        removeGraphThemeFile,
        saveGraphTheme,
        saveGraphThemeFile,
        subscribeGraphThemes,
    } from "../publish/theme/theme-store";
    import { downloadZip } from "../publish/host/zip";
    import { PREVIEW_NAVIGATE, PREVIEW_PAGE, type PreviewSession, openPreviewSession, previewDocument, previewPages } from "../publish/host/preview";
    import { publishPublication, type PublishReport } from "../publish/publish";
    import { discoverPublications } from "../publish/publication";
    import { SAMPLE_PUBLICATION, SAMPLE_SOURCE } from "../publish/sample-graph";
    import { themeFilesOf } from "../publish/theme/graph-theme";
    import type { Publication, PublishSource, SiteBundle } from "../publish/types";

    let { view, panelId }: { view: ViewRef; panelId?: string } = $props();

    let theme = $state.raw<GraphTheme | null>(null);
    let missing = $state(false);
    let selected = $state<string | null>(null);
    /** The editor's text for the selected file, kept here so a file switch never loses an edit. */
    let drafts = $state.raw<Map<string, string>>(new Map());
    let saving = $state(false);
    let error = $state<string | null>(null);
    let announcement = $state("");
    /** A file whose stored text moved under an unsaved draft here. */
    let changedElsewhere = $state.raw<Set<string>>(new Set());
    let newPath = $state("");
    let addingFile = $state(false);
    let deleteArmed = $state(false);
    let themeName = $state("");
    let host = $state<HTMLDivElement | undefined>();

    // -- Preview ------------------------------------------------------------------------------
    let previewOpen = $state(false);
    let previewBusy = $state(false);
    let previewError = $state<string | null>(null);
    /** Publications of the graph that use this theme, once the graph has been read; null before. */
    let previewChoices = $state.raw<Publication[] | null>(null);
    /** The chosen publication's id, or "sample". */
    let previewChoice = $state("sample");
    let previewBundle = $state.raw<SiteBundle | null>(null);
    let previewReport = $state.raw<PublishReport | null>(null);
    let previewPage = $state("index.html");
    /** The graph as read for the preview; read once per open of the pane and on Refresh content. */
    let previewSource: PublishSource | null = null;
    let previewStale = $state(false);
    /** The service worker session serving the bundle, or null when the srcdoc fallback is in use. */
    let previewSession = $state.raw<PreviewSession | null>(null);
    /** Set while the frame navigates on its own (a click inside it), so the picker's change does not re-frame. */
    let previewFollowing = false;

    const previewSrcdoc = $derived.by(() => (previewBundle && !previewSession ? (previewDocument(previewBundle, previewPage) ?? "") : ""));
    const previewUrl = $derived(previewSession ? previewSession.urlFor(previewPage) : null);
    const previewPageList = $derived(previewBundle ? previewPages(previewBundle) : []);

    const manifest = $derived.by(() => {
        const json = theme?.files["theme.json"];
        return json === undefined ? null : parseThemeManifest(json);
    });
    const files = $derived(theme ? Object.keys(theme.files).sort(compareFiles) : []);
    const dirty = $derived.by(() => {
        if (!theme) return new Set<string>();
        const out = new Set<string>();
        for (const [path, text] of drafts) if (theme.files[path] !== text) out.add(path);
        return out;
    });
    const selectedDirty = $derived(selected !== null && dirty.has(selected));

    function compareFiles(a: string, b: string): number {
        const rank = (p: string) => (p === "theme.json" ? 0 : p.startsWith("layouts/") ? 1 : p.startsWith("partials/") ? 2 : 3);
        return rank(a) - rank(b) || a.localeCompare(b);
    }

    let editor: EditorView | undefined;

    /** The editor's extensions for one file: a fresh state per file, so undo history is per file too. */
    function extensionsFor(path: string | null, support: LanguageSupport | null) {
        return [
            lineNumbers(),
            highlightActiveLine(),
            drawSelection(),
            history(),
            bracketMatching(),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            support ?? [],
            EditorState.readOnly.of(path === null),
            keymap.of([{ key: "Mod-s", run: () => (void save(), true) }, indentWithTab, ...defaultKeymap, ...historyKeymap]),
            EditorView.updateListener.of((update) => {
                if (!update.docChanged || path === null || selected !== path) return;
                const next = new Map(drafts);
                next.set(path, update.state.doc.toString());
                drafts = next;
                if (previewBundle) previewStale = true;
            }),
            EditorView.theme({
                "&": { height: "100%", fontSize: "13px" },
                ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
            }),
        ];
    }

    async function languageFor(path: string): Promise<LanguageSupport | null> {
        const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
        const name = ext === "html" ? "HTML" : ext === "css" ? "CSS" : ext === "js" ? "JavaScript" : ext === "json" ? "JSON" : ext === "svg" ? "XML" : null;
        if (!name) return null;
        const description = languages.find((d) => d.name === name);
        return description ? description.load().catch(() => null) : null;
    }

    /**
     * The editor's host element exists only once the theme has loaded (it sits inside the
     * `{#if theme}` branch), so the editor is created when the element appears, not at mount,
     * and a file chosen before that moment is opened as soon as it can be.
     */
    $effect(() => {
        if (!host || editor) return;
        editor = new EditorView({ parent: host, state: EditorState.create({ doc: "", extensions: extensionsFor(null, null) }) });
        if (selected !== null) void select(selected);
    });

    async function select(path: string): Promise<void> {
        if (!theme) return;
        selected = path;
        if (!editor) return; // opened by the effect above once the host exists
        const text = drafts.get(path) ?? theme.files[path] ?? "";
        const support = await languageFor(path);
        if (selected !== path || !editor) return;
        editor.setState(EditorState.create({ doc: text, extensions: extensionsFor(path, support) }));
        editor.focus();
    }

    async function save(): Promise<void> {
        if (!theme || selected === null || saving) return;
        const text = drafts.get(selected);
        if (text === undefined || text === theme.files[selected]) return;
        saving = true;
        error = null;
        const path = selected;
        try {
            if (path === "theme.json") {
                const { errors } = parseThemeManifest(text);
                if (errors.length > 0) throw new Error(errors.join(" "));
            }
            await saveGraphThemeFile(theme.id, path, text);
            const next = new Set(changedElsewhere);
            next.delete(path);
            changedElsewhere = next;
            announcement = `Saved ${path}.`;
            if (previewOpen) void updatePreview();
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        } finally {
            saving = false;
        }
    }

    function revert(): void {
        if (!theme || selected === null) return;
        const next = new Map(drafts);
        next.delete(selected);
        drafts = next;
        const nextChanged = new Set(changedElsewhere);
        nextChanged.delete(selected);
        changedElsewhere = nextChanged;
        void select(selected);
    }

    async function resetToOriginal(): Promise<void> {
        if (!theme || selected === null || !theme.origin) return;
        const original = bundledTheme(theme.origin)?.files.get(selected);
        if (original === undefined) {
            error = `The original theme "${theme.origin}" has no ${selected}.`;
            return;
        }
        const next = new Map(drafts);
        next.set(selected, original);
        drafts = next;
        await select(selected);
    }

    async function addFile(): Promise<void> {
        if (!theme) return;
        const path = newPath.trim();
        if (!isThemeFilePath(path)) {
            error = "A theme file lives under layouts/, partials/ or assets/, with no `..` in its path.";
            return;
        }
        if (theme.files[path] !== undefined) {
            error = `The theme already has ${path}.`;
            return;
        }
        error = null;
        try {
            await saveGraphThemeFile(theme.id, path, "");
            addingFile = false;
            newPath = "";
            await select(path);
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        }
    }

    async function deleteFile(): Promise<void> {
        if (!theme || selected === null) return;
        const path = selected;
        if (path === "theme.json" || path === "layouts/page.html") {
            error = `${path} is required; a theme cannot render without it.`;
            return;
        }
        try {
            await removeGraphThemeFile(theme.id, path);
            const next = new Map(drafts);
            next.delete(path);
            drafts = next;
            selected = null;
            announcement = `Deleted ${path}.`;
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        }
    }

    async function rename(): Promise<void> {
        if (!theme || themeName.trim() === "" || themeName.trim() === theme.name) return;
        try {
            await saveGraphTheme({ ...theme, name: themeName.trim() });
            announcement = "Renamed.";
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        }
    }

    async function deleteTheme(): Promise<void> {
        if (!theme) return;
        try {
            await removeGraphTheme(theme.id);
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        }
    }

    function exportZip(): void {
        if (!theme) return;
        const files: Record<string, Uint8Array> = {};
        for (const [path, text] of Object.entries(theme.files)) files[path] = strToU8(drafts.get(path) ?? text);
        downloadZip(zipSync(files, { level: 6 }), `${theme.id}-theme.zip`);
    }

    /** The theme as it stands in the editor: stored files with unsaved drafts on top. */
    function draftTheme(): GraphTheme | null {
        if (!theme) return null;
        const files: Record<string, string> = { ...theme.files };
        for (const [path, text] of drafts) files[path] = text;
        return { ...theme, files };
    }

    async function readPreviewSource(force = false): Promise<void> {
        const publishing = workspaceService("publishing");
        if (!publishing) {
            previewChoices = [];
            previewSource = SAMPLE_SOURCE;
            return;
        }
        if (previewSource && !force) return;
        const { source } = await publishing.readSource();
        previewSource = source;
        const mine = discoverPublications(source.documents).publications.filter((p) => p.theme === view.target);
        previewChoices = mine;
        if (previewChoice !== "sample" && !mine.some((p) => p.id === previewChoice)) previewChoice = mine[0]?.id ?? "sample";
        if (previewChoice === "sample" && mine.length > 0) previewChoice = mine[0].id;
    }

    async function updatePreview(force = false): Promise<void> {
        const draft = draftTheme();
        if (!draft || previewBusy) return;
        previewBusy = true;
        previewError = null;
        try {
            await readPreviewSource(force);
            const publishing = workspaceService("publishing");
            const environment = publishing?.environment();
            const chosen = previewChoices?.find((p) => p.id === previewChoice);
            const publication: Publication = chosen ? { ...chosen, theme: view.target } : { ...SAMPLE_PUBLICATION, theme: view.target };
            const source = chosen && previewSource ? previewSource : SAMPLE_SOURCE;
            const loadTheme = async () => ({ theme: themeFilesOf(draft), source: "graph" as const });
            const { bundle, report } = await publishPublication(source, publication, {
                loadTheme,
                renderMermaid: environment?.renderMermaid,
                // The preview frame cannot load fonts by relative url, so the stylesheet alone is
                // enough: formulas render, in the fallback font.
                katexAssets: environment?.katexAssets ? async () => new Map([...(await environment.katexAssets!())].filter(([path]) => path.endsWith('.css'))) : undefined,
            });
            if (!report.ok) {
                previewError = report.errors.map((e) => e.message).join(" ");
                previewBundle = null;
            } else {
                previewSession = await openPreviewSession(bundle, previewSession);
                previewBundle = bundle;
                if (!bundle.has(previewPage)) previewPage = "index.html";
            }
            previewReport = report;
            previewStale = false;
        } catch (e) {
            previewError = e instanceof Error ? e.message : String(e);
        } finally {
            previewBusy = false;
        }
    }

    function togglePreview(): void {
        previewOpen = !previewOpen;
        if (previewOpen && !previewBundle) void updatePreview();
    }

    function onPreviewMessage(event: MessageEvent): void {
        const data = event.data as { type?: unknown; page?: unknown } | null;
        if (!data || typeof data.page !== "string" || !previewBundle?.has(data.page)) return;
        if (data.type === PREVIEW_NAVIGATE) {
            previewPage = data.page; // the srcdoc fallback: re-frame the page asked for
        } else if (data.type === PREVIEW_PAGE) {
            // The served frame navigated itself; the picker follows without re-framing.
            previewFollowing = true;
            previewPage = data.page;
            previewFollowing = false;
        }
    }

    let frame = $state<HTMLIFrameElement | undefined>();
    /** Re-frame when the picker changes, not when the frame reported its own navigation. */
    $effect(() => {
        const url = previewUrl;
        if (!frame || url === null || previewFollowing) return;
        if (frame.getAttribute("src") !== url) frame.setAttribute("src", url);
    });

    let unsubscribe: (() => void) | undefined;
    onMount(() => {
        unsubscribe = subscribeGraphThemes((list) => {
            const next = list.find((t) => t.id === view.target) ?? null;
            const previous = theme;
            theme = next;
            missing = next === null;
            if (next) {
                if (themeName === "" || (previous && previous.name === themeName)) themeName = next.name;
                workspaceService("retitleView")?.(panelId ?? `theme:${view.target}`, `${THEME_TITLE_PREFIX}${next.name}`);
                // A file that moved elsewhere while a draft here differs from BOTH the old and the new
                // stored text is a real conflict; a draft equal to the new text is simply saved.
                const flagged = new Set(changedElsewhere);
                for (const [path, draft] of drafts) {
                    const before = previous?.files[path];
                    const after = next.files[path];
                    if (before !== undefined && after !== before && draft !== after) flagged.add(path);
                    if (draft === after) flagged.delete(path);
                }
                changedElsewhere = flagged;
                if (selected === null) {
                    const first = Object.keys(next.files).sort(compareFiles).find((p) => p.startsWith("layouts/")) ?? Object.keys(next.files).sort(compareFiles)[0];
                    if (first) void select(first);
                }
            }
        });
    });
    onDestroy(() => {
        unsubscribe?.();
        editor?.destroy();
        editor = undefined;
        previewSession?.close();
    });

    const buttonClass = "rounded-md border border-gray-300 dark:border-gray-700 px-2.5 py-1 text-sm font-medium text-gray-950 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50";
    const primaryClass = "rounded-md bg-gray-900 dark:bg-gray-100 px-2.5 py-1 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-50";
</script>

<svelte:window onmessage={onPreviewMessage} />

<div class="flex h-full min-h-0 flex-col bg-white dark:bg-gray-950" data-testid="theme-view">
    <p class="sr-only" role="status" aria-live="polite">{announcement}</p>
    {#if missing}
        <div class="p-4 text-sm text-gray-600 dark:text-gray-400" data-testid="theme-view-missing">
            This graph has no theme called <code>{view.target}</code>. It may have been deleted, or by another member. Open Settings → Publish to see the graph's themes.
        </div>
    {:else if theme}
        <header class="flex flex-wrap items-center gap-2 border-b border-gray-200 dark:border-gray-800 px-3 py-2">
            <label class="flex items-center gap-2 text-sm text-gray-950 dark:text-gray-100">
                <span class="text-gray-500 dark:text-gray-400">Theme</span>
                <input class="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-2 py-1 text-sm" bind:value={themeName} onchange={() => void rename()} data-testid="theme-view-name" />
            </label>
            <span class="text-sm text-gray-500 dark:text-gray-400"><code>{theme.id}</code>{#if theme.origin} · from {theme.origin}{/if}{#if manifest && manifest.errors.length > 0} · <span class="text-red-700 dark:text-red-300">theme.json: {manifest.errors[0]}</span>{/if}</span>
            <span class="flex-1"></span>
            <button type="button" class={previewOpen ? primaryClass : buttonClass} onclick={togglePreview} aria-pressed={previewOpen} data-testid="theme-view-preview-toggle">Preview</button>
            <button type="button" class={buttonClass} onclick={exportZip} data-testid="theme-view-export">Export zip</button>
            {#if deleteArmed}
                <button type="button" class="rounded-md bg-red-600 px-2.5 py-1 text-sm font-medium text-white hover:bg-red-500" onclick={() => void deleteTheme()} data-testid="theme-view-delete-confirm">Delete theme for everyone</button>
                <button type="button" class={buttonClass} onclick={() => (deleteArmed = false)}>Keep</button>
            {:else}
                <button type="button" class={buttonClass} onclick={() => (deleteArmed = true)} data-testid="theme-view-delete">Delete…</button>
            {/if}
        </header>
        <div class="flex min-h-0 flex-1">
            <nav class="w-56 shrink-0 overflow-y-auto border-r border-gray-200 dark:border-gray-800 py-2 text-sm" aria-label="Theme files">
                <ul>
                    {#each files as path (path)}
                        <li>
                            <button
                                type="button"
                                class="flex w-full items-center gap-1 px-3 py-1 text-left hover:bg-gray-100 dark:hover:bg-gray-800 {selected === path ? 'bg-gray-100 dark:bg-gray-800 font-medium' : ''}"
                                aria-current={selected === path ? "true" : undefined}
                                onclick={() => void select(path)}
                                data-testid="theme-file-{path}"
                            >
                                <span class="truncate text-gray-950 dark:text-gray-100">{path}</span>
                                {#if dirty.has(path)}<span class="text-amber-600" title="Unsaved changes">●</span>{/if}
                                {#if changedElsewhere.has(path)}<span class="text-red-600" title="Changed elsewhere">!</span>{/if}
                            </button>
                        </li>
                    {/each}
                </ul>
                <div class="px-3 pt-2">
                    {#if addingFile}
                        <form
                            class="space-y-1"
                            onsubmit={(e) => {
                                e.preventDefault();
                                void addFile();
                            }}
                        >
                            <label class="sr-only" for="theme-new-file">New file path</label>
                            <input id="theme-new-file" class="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-2 py-1 text-sm" bind:value={newPath} placeholder="partials/banner.html" data-testid="theme-new-file" />
                            <div class="flex gap-1">
                                <button type="submit" class={primaryClass} data-testid="theme-new-file-add">Add</button>
                                <button type="button" class={buttonClass} onclick={() => (addingFile = false)}>Cancel</button>
                            </div>
                        </form>
                    {:else}
                        <button type="button" class={buttonClass} onclick={() => (addingFile = true)} data-testid="theme-add-file">Add file…</button>
                    {/if}
                </div>
            </nav>
            <section class="flex min-w-0 flex-1 flex-col" aria-label="File editor">
                <div class="flex flex-wrap items-center gap-2 border-b border-gray-200 dark:border-gray-800 px-3 py-1.5 text-sm">
                    <span class="font-medium text-gray-950 dark:text-gray-100" data-testid="theme-view-selected">{selected ?? "No file selected"}</span>
                    {#if selected !== null && changedElsewhere.has(selected)}
                        <span class="text-red-700 dark:text-red-300" data-testid="theme-view-conflict">Changed elsewhere since you started editing. Save keeps yours; Revert takes theirs.</span>
                    {:else if selectedDirty}
                        <span class="text-amber-700 dark:text-amber-300" data-testid="theme-view-unsaved">Unsaved changes</span>
                    {:else if selected !== null}
                        <span class="text-gray-500 dark:text-gray-400" data-testid="theme-view-saved">Saved</span>
                    {/if}
                    <span class="flex-1"></span>
                    <button type="button" class={primaryClass} onclick={() => void save()} disabled={!selectedDirty || saving} data-testid="theme-view-save">{saving ? "Saving…" : "Save"}</button>
                    <button type="button" class={buttonClass} onclick={revert} disabled={!selectedDirty} data-testid="theme-view-revert">Revert</button>
                    {#if theme.origin && selected !== null}
                        <button type="button" class={buttonClass} onclick={() => void resetToOriginal()} data-testid="theme-view-reset">Reset to original</button>
                    {/if}
                    <button type="button" class={buttonClass} onclick={() => void deleteFile()} disabled={selected === null || selected === "theme.json" || selected === "layouts/page.html"} data-testid="theme-view-delete-file">Delete file</button>
                </div>
                {#if error}<p role="alert" class="px-3 py-1 text-sm text-red-700 dark:text-red-300" data-testid="theme-view-error">{error}</p>{/if}
                <div class="min-h-0 flex-1 overflow-hidden" bind:this={host} data-testid="theme-view-editor"></div>
            </section>
            {#if previewOpen}
                <section class="flex w-1/2 min-w-0 shrink-0 flex-col border-l border-gray-200 dark:border-gray-800" aria-label="Preview" data-testid="theme-view-preview">
                    <div class="flex flex-wrap items-center gap-2 border-b border-gray-200 dark:border-gray-800 px-3 py-1.5 text-sm">
                        <label class="flex items-center gap-1 text-gray-600 dark:text-gray-400">
                            <span>Content</span>
                            <select class="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-2 py-1 text-sm text-gray-950 dark:text-gray-100" bind:value={previewChoice} onchange={() => void updatePreview()} disabled={previewBusy} data-testid="theme-view-preview-content">
                                {#each previewChoices ?? [] as p (p.id)}
                                    <option value={p.id}>{p.name}</option>
                                {/each}
                                <option value="sample">Sample content</option>
                            </select>
                        </label>
                        <label class="flex items-center gap-1 text-gray-600 dark:text-gray-400">
                            <span>Page</span>
                            <select class="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-2 py-1 text-sm text-gray-950 dark:text-gray-100" bind:value={previewPage} disabled={previewPageList.length === 0} data-testid="theme-view-preview-page">
                                {#each previewPageList as page (page)}
                                    <option value={page}>{page}</option>
                                {/each}
                            </select>
                        </label>
                        <span class="flex-1"></span>
                        {#if previewStale}
                            <span class="text-amber-700 dark:text-amber-300" data-testid="theme-view-preview-stale">Edited since</span>
                        {/if}
                        <button type="button" class={primaryClass} onclick={() => void updatePreview()} disabled={previewBusy} data-testid="theme-view-preview-update">{previewBusy ? "Rendering…" : "Update preview"}</button>
                        <button type="button" class={buttonClass} onclick={() => void updatePreview(true)} disabled={previewBusy} title="Read the graph again" data-testid="theme-view-preview-refresh">Refresh content</button>
                        {#if previewUrl !== null}
                            <!-- A plain link: the preview route serves a top-level tab exactly as it serves the frame
                                 (same sandboxing response), so the site can be tested at full size, on a phone
                                 emulation, or with devtools. The srcdoc fallback has no url to open. -->
                            <a class={`inline-block ${buttonClass}`} href={previewUrl} target="_blank" rel="noopener noreferrer" data-testid="theme-view-preview-open">Open in new tab</a>
                        {/if}
                    </div>
                    <p class="px-3 py-1 text-sm text-gray-500 dark:text-gray-400">
                        Shows your unsaved edits.
                        {#if previewChoices && previewChoices.length === 0}No publication uses this theme yet, so this is sample content.{/if}
                        {#if previewBundle && !previewSession}Scripts (search, a theme's own) do not run in this preview, and it cannot open in a tab: the browser has no service worker to serve it.{/if}
                        {#if previewReport && previewReport.warnings.length > 0}{previewReport.warnings.length} warning{previewReport.warnings.length === 1 ? "" : "s"} in the report.{/if}
                    </p>
                    {#if previewError}<p role="alert" class="px-3 py-1 text-sm text-red-700 dark:text-red-300" data-testid="theme-view-preview-error">{previewError}</p>{/if}
                    <div class="min-h-0 flex-1 bg-white">
                        {#if previewUrl !== null}
                            <!-- allow-same-origin so the navigation reaches the service worker, whose response then
                                 sandboxes the document to an opaque origin (see static/sw.js): a theme's script previews
                                 with no reach into the app. The src is set by the effect above so a click inside the
                                 frame is not undone. -->
                            <iframe title="Theme preview" class="h-full w-full border-0" sandbox="allow-scripts allow-same-origin allow-forms" bind:this={frame} data-testid="theme-view-preview-frame"></iframe>
                        {:else if previewSrcdoc}
                            <iframe title="Theme preview" class="h-full w-full border-0" sandbox="allow-scripts" srcdoc={previewSrcdoc} data-testid="theme-view-preview-frame" data-preview-fallback="true"></iframe>
                        {:else if previewBusy}
                            <p class="p-4 text-sm text-gray-500 dark:text-gray-400">Rendering…</p>
                        {/if}
                    </div>
                </section>
            {/if}
        </div>
    {:else}
        <p class="p-4 text-sm text-gray-500 dark:text-gray-400">Loading…</p>
    {/if}
</div>
