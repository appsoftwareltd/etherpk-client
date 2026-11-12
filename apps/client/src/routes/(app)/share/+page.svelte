<script lang="ts">
    /**
     * The [[Share Target]]'s one page (CONTEXT.md; ADR 0087, amended 2026-09-21 and 2026-10-13):
     * what arrived from the share sheet, in a box the user can edit, an "Add as task" checkbox,
     * the graph to put it in, and Add. Nothing lands until Add is pressed; leaving the page keeps
     * nothing, as cancelling a share sheet does.
     *
     * The page holds still while it loads. The heading never changes. The server renders it and
     * the text box; the controls appear once, below the box, when the graph registry has been
     * read, so nothing already on screen moves. As soon as a graph is selected its route is worked
     * out (`routeShare`): for a synced graph that reads the held keyring, a network call, so Add
     * saves at once, and a graph that will hand over is known before the press.
     *
     * After Add, a synced graph whose keys this device holds takes the note from here over a short
     * engine session (share-landing.ts), and the panel that replaces the controls says how far it
     * got: saved on this device, then synced once the relay acknowledges it. Nothing else opens,
     * so on a phone the user is back in the app they shared from in a moment. Otherwise - a folder
     * graph, a locked vault, no sync configured, any failure before the note is saved - the text
     * is stashed and the page navigates to `/g/<id>`, replacing this entry so Back leaves the app
     * rather than re-running the share; the workspace adds the note once the graph is open, with
     * its unlock prompt, folder permission button and every open notice reused.
     *
     * With no graphs the text stays on screen with Copy and a link to the Graphs page: a share is
     * never dropped on the floor. Reached with no query and a share still waiting (a graph that
     * would not open sent the user back here), the form is shown over that share again.
     */
    import { onMount } from "svelte";

    import { afterNavigate, goto } from "$app/navigation";
    import { isDemoGraph } from "#lib/demo/demo-graph.js";
    import { NoteFileError, storeNoteFiles } from "#lib/document/quick-note-file-store.js";
    import { noteTextWithFiles } from "#lib/document/quick-note-files.js";
    import { MAX_QUICK_NOTE_LENGTH } from "#lib/document/quick-notes.js";
    import { landShareDirectly, routeShare, shareFileStore, shareNamesFor, type ShareRoute } from "#lib/document/share-landing.js";
    import {
        composeSharedNote,
        orderShareTargets,
        peekPendingShare,
        shareNoteText,
        stashPendingShare,
    } from "#lib/document/share-target.js";
    import QuickNoteBox from "#lib/document/view/QuickNoteBox.svelte";
    import QuickNoteFileUnder from "#lib/document/view/QuickNoteFileUnder.svelte";
    import { PendingNoteFiles } from "#lib/document/view/quick-note-pending-files.svelte.js";
    import { SHARE_FILES_DROPPED } from "#lib/share/share-post.js";
    import { forgetSharedFiles, keepSharedFiles, readSharedFiles } from "#lib/share/shared-files.js";
    import { createIdbGraphRegistry, getLastGraphId, type GraphRecord } from "#lib/storage/index.js";
    import type { QueuedUploads } from "#lib/storage/synced/server-asset-store.js";
    import { NO_SHARE_NAMES, type ShareNames } from "#lib/sync/share-names.js";
    import { graphGroups } from "#lib/workspace/graph-order-state.js";

    import type { PageData } from "./$types";

    let { data }: { data: PageData } = $props();

    interface Share {
        text: string;
        truncated: boolean;
        /** The instant it was shared: taken on arrival, kept however long it waits. */
        createdAt: number;
        /** Where the files it arrived with are kept on this device, when it arrived with any. */
        filesId?: string;
        /** It arrived with files that could not be kept: the page says so. */
        filesDropped?: boolean;
    }

    /**
     * A save that has not finished by now says "Adding to <graph>…". A direct write from the
     * Local Cache usually finishes well inside it, so the panel goes straight to "Added".
     */
    const ADDING_NOTICE_DELAY_MS = 300;

    /**
     * What is on the URL, composed from the first render, so the server-rendered page already
     * shows the share rather than a flash of "nothing" before hydration.
     */
    function arrivedShare(): Share | null {
        const arrived = composeSharedNote(data);
        const files = arrivedFiles(data.files);
        // A share of files alone has no text, and is still a share.
        if (!arrived && !files) return null;
        return { text: arrived?.text ?? "", truncated: arrived?.truncated ?? false, createdAt: Date.now(), ...files };
    }

    /** What the address says about the share's files: where they are kept, or that they were dropped. */
    function arrivedFiles(files: string | null): Pick<Share, "filesId" | "filesDropped"> | null {
        if (!files) return null;
        return files === SHARE_FILES_DROPPED ? { filesDropped: true } : { filesId: files };
    }

    const initialShare = arrivedShare();
    let share = $state<Share | null>(initialShare);
    /** The text as it stands in the box: the share as composed, until the user edits it. */
    let text = $state(initialShare?.text ?? "");
    let asTask = $state(false);
    /** Set by Add with nothing to add; cleared as soon as the box has text again. */
    let textError = $state("");
    let box = $state<QuickNoteBox | undefined>();
    /** The share's files, and any attached here: stored when Add is pressed, never before. */
    const pending = new PendingNoteFiles();
    /** The share's files are being read from where the service worker kept them. */
    let filesLoading = $state(initialShare?.filesId !== undefined);
    /** The share named files this device no longer holds (it was added already, or a day has passed). */
    let filesMissing = $state(false);
    /** The concept the note is filed under, one of the selected graph's Favourites, or none. */
    let under = $state<string | null>(null);
    /**
     * What each graph lets the page show before anything is pressed: its page names and the
     * concepts to file under (`shareNamesFor`). Read from this device with the registry, so they
     * are on screen with the rest of the controls and nothing moves afterwards.
     */
    const namesByGraph = new Map<string, ShareNames>();
    /**
     * The browser has looked for a waiting share (sessionStorage, which the server cannot see).
     * "Nothing was shared" is said only after that, or a share sent back here by a graph that
     * would not open would flash as nothing before hydration found it.
     */
    let settled = $state(false);
    /** Null until the registry has been read, so "no graphs" is never said too early. */
    let graphs = $state.raw<GraphRecord[] | null>(null);
    let registryError = $state("");
    let selectedId = $state<string | null>(null);
    const selected = $derived(graphs?.find((g) => g.id === selectedId) ?? null);
    const names = $derived((selectedId && namesByGraph.get(selectedId)) || NO_SHARE_NAMES);

    /**
     * What Add started, for the panel that replaces the controls. `adding` until the engine has
     * the note in its durable outbox, `saved` from then until the relay acknowledges it, `synced`
     * after, or `unsynced` when the relay could not be reached or went quiet: the note is on this
     * device either way and ships the next time the graph opens here. `opening` is the hand-off,
     * on its way to the workspace.
     */
    type LandingState = "adding" | "saved" | "synced" | "unsynced" | "opening";
    let landing = $state<{ graph: GraphRecord; state: LandingState; refusal?: string } | null>(null);
    /** The save has run past the notice delay, so the panel says it is still adding. */
    let slow = $state(false);
    /** An Add that failed in a way the hand-off could not catch; the form is back, text kept. */
    let addError = $state("");
    /** Once Add is pressed the box shows what was added and can no longer change it. */
    const readOnly = $derived(landing !== null);
    const describedBy = $derived(
        [textError ? "share-text-error" : "", share?.truncated ? "share-truncated" : ""].filter(Boolean).join(" ") ||
            undefined,
    );
    /**
     * Counts Adds and new shares. A write still running for a share the window has since
     * replaced must not write over the panel of the one now shown.
     */
    let attempt = 0;
    /** Ends the direct write's wait for the relay early, when the user opens the graph instead. */
    let cancelSyncWait: AbortController | null = null;
    /**
     * The direct write in flight. Open graph awaits it so its engine is disposed before the
     * workspace's is built, and a second Add awaits it so one graph never has two engines here.
     */
    let landingDone: Promise<void> = Promise.resolve();
    /** Each graph's route, worked out when it is first selected. */
    const routes = new Map<string, Promise<ShareRoute>>();

    /** A copied clipboard is invisible, so Copy confirms itself in words beside the button. */
    let copied = $state(false);
    let copyError = $state("");

    const backendTag = (graph: GraphRecord) =>
        isDemoGraph(graph.id) ? "Demo" : graph.backend === "server" ? "Synced" : "Local";

    const panelHeading = $derived.by(() => {
        if (!landing) return "";
        const name = landing.graph.name;
        switch (landing.state) {
            case "adding":
                return slow ? `Adding to ${name}…` : "";
            case "opening":
                return `Opening ${name}…`;
            default:
                return `Added to ${name}`;
        }
    });

    const statusLine = $derived.by(() => {
        switch (landing?.state) {
            case "saved":
                return "Saved on this device. Syncing…";
            case "synced":
                return "Synced. Your other devices get it when they next connect.";
            case "unsynced":
                // A refusal is the Sync Server's own words about a file (too large, no storage left).
                return landing.refusal
                    ? `Saved on this device. The file was not uploaded: ${landing.refusal}`
                    : "Saved on this device. It syncs the next time this graph opens here.";
            default:
                return "";
        }
    });

    /**
     * A share arriving on the URL replaces whatever this page was showing; with nothing on the
     * URL, a share still waiting from an earlier choice is shown again. `afterNavigate` rather
     * than mount because a second share can arrive while the form is up: the same route with
     * new params, and the component stays mounted.
     */
    afterNavigate((navigation) => {
        // A shallow entry is not a page change (it runs the navigation hooks since SvelteKit 3).
        if (navigation.shallow && navigation.type === "goto") return;
        const arrived = arrivedShare();
        if (arrived && navigation.type === "enter") {
            // Hydration: the server already rendered this share, and the box may hold an edit
            // made before the page was interactive, which starting over would throw away.
            if (selected) warm(selected);
            void loadFiles(share);
        } else if (arrived) {
            adopt(arrived);
        } else {
            const waiting = peekPendingShare();
            adopt(
                waiting
                    ? {
                          text: waiting.text,
                          truncated: waiting.truncated,
                          createdAt: waiting.createdAt,
                          ...(waiting.filesId ? { filesId: waiting.filesId } : {}),
                      }
                    : null,
            );
        }
        settled = true;
    });

    onMount(() => {
        let cancelled = false;
        (async () => {
            try {
                const listed = await createIdbGraphRegistry().listGraphs();
                if (cancelled) return;
                const ordered = orderShareTargets(graphGroups(listed).flatMap((group) => group.graphs), { lastGraphId: getLastGraphId(), isDemo: isDemoGraph });
                const read = await Promise.all(ordered.map((graph) => shareNamesFor(graph)));
                if (cancelled) return;
                ordered.forEach((graph, index) => namesByGraph.set(graph.id, read[index]));
                graphs = ordered;
                selectedId = graphs[0]?.id ?? null;
                if (selected) warm(selected);
            } catch (err) {
                if (cancelled) return;
                // Read failed is not "none": the copy must not send someone to make a new graph
                // when theirs are all still there.
                console.error("Could not read the graph list:", err);
                registryError = "Your graphs could not be read from this browser's storage. Nothing has been deleted.";
            }
        })();
        return () => {
            cancelled = true;
        };
    });

    /** Show `next` as a fresh form, ending the wait of any write still running for the last share. */
    function adopt(next: Share | null) {
        attempt += 1;
        cancelSyncWait?.abort();
        share = next;
        text = next?.text ?? "";
        asTask = false;
        under = null;
        pending.clear();
        filesMissing = false;
        void loadFiles(next);
        textError = "";
        addError = "";
        landing = null;
        slow = false;
        if (selected) warm(selected);
    }

    /**
     * Start working out how a share to `graph` would land, once per graph. Only with a share on
     * screen: reading a synced graph's keys is a network call that "Nothing was shared" does not need.
     */
    function warm(graph: GraphRecord): Promise<ShareRoute> | undefined {
        if (!share) return undefined;
        let route = routes.get(graph.id);
        if (!route) {
            route = routeShare(graph);
            routes.set(graph.id, route);
        }
        return route;
    }

    /** The route for Add. One that failed is worked out again: the network may be back. */
    async function routeFor(graph: GraphRecord): Promise<ShareRoute> {
        const route = await (routes.get(graph.id) ?? routeShare(graph));
        if (route.kind === "handoff" && route.reason === "failed") {
            routes.delete(graph.id);
            const again = routeShare(graph);
            routes.set(graph.id, again);
            return again;
        }
        return route;
    }

    /**
     * Read the share's files from where the service worker kept them. They show in the box when
     * they are read; a share whose files are gone says so and keeps its text.
     */
    async function loadFiles(of: Share | null) {
        filesLoading = of?.filesId !== undefined;
        if (!of?.filesId) return;
        const files = await readSharedFiles(of.filesId).catch(() => []);
        if (share !== of) return;
        filesLoading = false;
        filesMissing = files.length === 0;
        pending.add(files);
    }

    function onTextInput() {
        // Once Add has said the box is empty, the message goes the moment it is not.
        if (textError && text.trim() !== "") textError = "";
    }

    /** Ctrl/Cmd+Enter adds. Plain Enter is a line break: the box holds a share, often several lines. */
    function onTextKey(event: KeyboardEvent): boolean {
        if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return false;
        add();
        return true;
    }

    /**
     * Add what is in the box to the selected graph. Guarded here as well as by the controls
     * leaving the page: a second press, or Ctrl+Enter after the panel appeared, does nothing.
     */
    function add() {
        if (!share || landing || !selected || filesLoading) return;
        const files = pending.files;
        // A note of files alone is a note. With neither text nor a file there is nothing to add.
        if (shareNoteText(text, asTask) === null && files.length === 0) {
            textError = "Write something to add.";
            box?.focus();
            return;
        }
        const graph = selected;
        const arrived = share;
        const typed = text;
        const filed = under;
        const task = asTask;
        const mine = ++attempt;
        addError = "";
        // The box shows what was added, checkbox included, from here on.
        text = shareNoteText(typed, task) ?? typed;
        landing = { graph, state: "adding" };
        slow = false;
        const notice = setTimeout(() => {
            if (mine === attempt) slow = true;
        }, ADDING_NOTICE_DELAY_MS);
        landingDone = landingDone
            .then(() => land(graph, arrived, { typed, task, filed, files }, mine))
            .catch((err: unknown) => {
                // Every expected failure hands over inside `land`; this is the unexpected one, or
                // a file that could not be stored. The form comes back with the text and the files
                // as the user left them, and the chain stays usable for the next Add.
                console.error("[share] add failed", err);
                if (mine !== attempt) return;
                landing = null;
                text = typed;
                addError = err instanceof NoteFileError ? `${err.message} Nothing was added.` : "Could not add the note. Try again.";
            })
            .finally(() => clearTimeout(notice));
    }

    /** What the user had on the form when they pressed Add. */
    interface Submitted {
        typed: string;
        task: boolean;
        filed: string | null;
        files: File[];
    }

    /**
     * Write directly when the route allows it; hand over to the workspace when it does not.
     *
     * Files (ADR 0186) are stored before the note is written, so the note never names a file the
     * device does not hold. On a direct route each is sealed and kept on this device with no
     * network call, and uploaded while the panel reports. On a hand-off they are kept where the
     * workspace reads them, and it stores them once the graph is open.
     */
    async function land(graph: GraphRecord, arrived: Share, submitted: Submitted, mine: number) {
        const route = await routeFor(graph);
        let stored: { noteText: string } | undefined;
        if (route.kind === "direct") {
            const outcome = await landDirect(route, graph, arrived, submitted, mine);
            if (outcome === "added") return;
            stored = outcome;
        } else if (route.reason === "failed") {
            console.warn("[share] direct write unavailable; opening the graph instead", route.error);
        }
        if (mine === attempt) await handOver(graph, arrived, submitted, stored?.noteText);
    }

    const NOTHING_TO_SEND: QueuedUploads = { sent: 0, waiting: 0 };

    /**
     * The direct write. The note's id is minted here, so a retry after a failure cannot add it
     * twice through the same session. Resolves "added", or with the note's text when the write
     * was declined after its files were stored: the hand-off then carries that text, whose
     * references name files this device already holds.
     */
    async function landDirect(
        route: Extract<ShareRoute, { kind: "direct" }>,
        graph: GraphRecord,
        arrived: Share,
        { typed, task, filed, files }: Submitted,
        mine: number,
    ): Promise<"added" | { noteText: string }> {
        const current = () => mine === attempt;
        const store = files.length > 0 ? shareFileStore(route) : null;
        const saved = store ? await storeNoteFiles(files, store) : [];
        const noteText = shareNoteText(noteTextWithFiles(typed, saved, names.imageSize), task) ?? "";
        const uploads = sendStored(store, files.length);
        cancelSyncWait = new AbortController();
        const note = { id: crypto.randomUUID(), text: noteText, createdAt: arrived.createdAt, ...(filed ? { under: filed } : {}) };
        const outcome = await landShareDirectly(route, note, undefined, {
            signal: cancelSyncWait.signal,
            onSaved: () => {
                if (current()) landing = { graph, state: "saved" };
            },
        });
        cancelSyncWait = null;
        if (outcome.kind !== "added") {
            store?.dispose();
            console.warn("[share] direct write declined; opening the graph instead", outcome.error);
            return { noteText };
        }
        const sent = await uploads;
        store?.dispose();
        forgetArrivedFiles(arrived);
        if (current()) landing = { graph, ...reached(outcome.synced, sent) };
        return "added";
    }

    /**
     * Send the files just kept on this device. A refusal is heard when the note is in, never
     * thrown: the note is saved either way.
     */
    function sendStored(store: ReturnType<typeof shareFileStore> | null, count: number): Promise<QueuedUploads> {
        if (!store) return Promise.resolve(NOTHING_TO_SEND);
        return store.uploadQueued().catch((error: unknown): QueuedUploads => ({ sent: 0, waiting: count, refusal: error as Error }));
    }

    /** How far the share got: "synced" is said only when its files are on the server too. */
    function reached(noteSynced: boolean, sent: QueuedUploads): { state: LandingState; refusal?: string } {
        const state = noteSynced && sent.waiting === 0 ? "synced" : "unsynced";
        return { state, ...(sent.refusal ? { refusal: sent.refusal.message } : {}) };
    }

    /**
     * Stash the share for the workspace and open the graph. Files not stored yet go where the
     * workspace reads them, with the text as typed: the checkbox is put in front once their
     * references are known. With `storedText` the files are stored already and are references
     * in it, which the workspace takes as plain text.
     */
    async function handOver(graph: GraphRecord, arrived: Share, { typed, task, filed, files }: Submitted, storedText?: string) {
        landing = { graph, state: "opening" };
        const filesId = storedText === undefined && files.length > 0 ? await keepSharedFiles(files) : undefined;
        stashPendingShare({
            graphId: graph.id,
            text: filesId ? typed.trim() : (storedText ?? shareNoteText(typed, task) ?? ""),
            createdAt: arrived.createdAt,
            truncated: arrived.truncated,
            ...(filed ? { under: filed } : {}),
            ...(filesId ? { filesId, ...(task ? { task } : {}) } : {}),
        });
        forgetArrivedFiles(arrived);
        void goto(`/g/${graph.id}`, { replace: true });
    }

    /** The share's files are stored, or kept again for the workspace: the copy they arrived as can go. */
    function forgetArrivedFiles(arrived: Share) {
        if (arrived.filesId) void forgetSharedFiles(arrived.filesId).catch(() => {});
    }

    async function copy() {
        copyError = "";
        copied = false;
        try {
            await navigator.clipboard.writeText(text);
            copied = true;
        } catch {
            copyError = "Could not copy: the browser refused clipboard access. Select the text above and copy it by hand.";
        }
    }

    /**
     * Open the graph the note went to. The direct write's session is ended first - the wait for
     * the relay is cancelled and its engine disposed - so the workspace never builds a second
     * engine over the same cache while the first is still up. A note already saved is in the
     * outbox either way, and the workspace's engine ships it.
     */
    async function openGraph(graph: GraphRecord) {
        cancelSyncWait?.abort();
        await landingDone;
        await goto(`/g/${graph.id}`);
    }

</script>

<svelte:head><title>{share || !settled ? "Add to Quick notes" : "Nothing was shared"} - EtherPK</title></svelte:head>

<div class="mx-auto max-w-xl space-y-5 sm:py-2" data-testid="share-target">
    {#if !share}
        {#if settled}
            <header>
                <h1 class="text-2xl font-semibold text-(--gk-text-strong)">Nothing was shared</h1>
                <p class="mt-2 text-sm text-(--gk-text-muted)" data-testid="share-nothing">
                    Share text or a link to EtherPK from another app and it lands here, ready to go
                    into a graph's quick notes. There is nothing waiting at the moment.
                </p>
            </header>
            <a
                href="/graphs"
                class="inline-block rounded-lg border border-(--gk-border-strong) px-3 py-1.5 text-sm font-medium text-(--gk-text-default) hover:bg-(--gk-surface-2) pointer-coarse:py-2.5"
                >Go to graphs</a
            >
        {/if}
    {:else}
        <h1 class="text-2xl font-semibold text-(--gk-text-strong)">Add to Quick notes</h1>

        <div class="space-y-2">
            {#if share.truncated}
                <p
                    id="share-truncated"
                    class="text-sm text-(--gk-text-warning)"
                    data-testid="share-truncated"
                    role="status"
                >
                    Cut to the first {MAX_QUICK_NOTE_LENGTH.toLocaleString()} characters.
                </p>
            {/if}
            <!-- Grows with its text up to a screenful, then scrolls, so a shared article does not
                 push the controls off the bottom. Not focused on load: on a phone the keyboard
                 would cover Add. -->
            <QuickNoteBox
                bind:this={box}
                bind:value={text}
                testid="share-text"
                label="Text to add"
                roomy
                readonly={readOnly}
                invalid={textError !== ""}
                {describedBy}
                maxlength={MAX_QUICK_NOTE_LENGTH}
                placeholder={pending.count > 0 || filesLoading ? "Add a caption (optional)" : ""}
                concepts={names.concepts.length > 0 ? () => names.concepts : undefined}
                namesHint="Page names show once this graph is open."
                files={pending.shown}
                {filesLoading}
                onaddfiles={(files) => pending.add(files)}
                onremovefile={(id) => pending.remove(id)}
                oninput={onTextInput}
                onkey={onTextKey}
            />
            {#if share.filesDropped}
                <p class="text-sm text-(--gk-text-warning)" role="status" data-testid="share-files-dropped">
                    The file did not arrive. Share it to EtherPK again.
                </p>
            {:else if filesMissing}
                <p class="text-sm text-(--gk-text-warning)" role="status" data-testid="share-files-missing">
                    The file is no longer waiting on this device. Share it to EtherPK again.
                </p>
            {/if}
            {#if textError}
                <p id="share-text-error" class="text-sm text-(--gk-text-danger)" data-testid="share-text-error">
                    {textError}
                </p>
            {/if}
        </div>

        {#if registryError}
            <p role="alert" class="text-sm text-(--gk-text-danger)" data-testid="share-registry-error">{registryError}</p>
        {:else if graphs === null}
            <!-- The registry is IndexedDB, read in a moment; nothing until it is, so the controls
                 appear once, below the box, and nothing on screen moves. -->
        {:else if graphs.length === 0}
            <div class="space-y-3" data-testid="share-no-graphs">
                <p class="text-sm text-(--gk-text-muted)">
                    Quick notes are saved to a graph, and this device has none yet. Copy the text for now,
                    or open a graph from the Graphs page and share again.
                </p>
                <div class="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        data-testid="share-copy"
                        onclick={copy}
                        class="rounded-lg bg-(--gk-accent) px-3 py-1.5 text-sm font-medium text-(--gk-surface-0) hover:bg-(--gk-accent-hover) pointer-coarse:py-2.5"
                        >Copy text</button
                    >
                    <a
                        href="/graphs"
                        data-testid="share-graphs-link"
                        class="rounded-lg border border-(--gk-border-strong) px-3 py-1.5 text-sm font-medium text-(--gk-text-default) hover:bg-(--gk-surface-2) pointer-coarse:py-2.5"
                        >Go to graphs</a
                    >
                    {#if copied}
                        <span role="status" data-testid="share-copied" class="text-sm text-(--gk-text-muted)">Copied</span>
                    {/if}
                    {#if copyError}
                        <p role="alert" class="w-full text-sm text-(--gk-text-danger)">{copyError}</p>
                    {/if}
                </div>
            </div>
        {:else if landing}
            <!-- Replaces the controls in place. The heading and the line under it keep their
                 height while empty, so the panel does not grow as the write reports progress. -->
            <section
                class="space-y-3 rounded-xl border border-(--gk-border-strong) px-4 py-3"
                data-testid="share-landing"
                data-state={landing.state}
            >
                <div role="status" class="space-y-1">
                    <h2 class="min-h-6 text-base font-semibold text-(--gk-text-strong)" data-testid="share-landing-heading">
                        {panelHeading}
                    </h2>
                    {#if landing.state !== "opening"}
                        <p class="min-h-5 text-sm text-(--gk-text-muted)" data-testid="share-landing-status">{statusLine}</p>
                    {/if}
                </div>
                {#if landing.state !== "opening"}
                    <!-- A button rather than a link: it ends the write's session before the
                         workspace opens over the same cache. -->
                    <button
                        type="button"
                        data-testid="share-open-graph"
                        onclick={() => void openGraph(landing!.graph)}
                        class="rounded-lg border border-(--gk-border-strong) px-3 py-1.5 text-sm font-medium text-(--gk-text-default) hover:bg-(--gk-surface-2) pointer-coarse:py-2.5"
                        >Open graph</button
                    >
                {/if}
            </section>
        {:else}
            <form
                class="space-y-4"
                novalidate
                onsubmit={(event) => {
                    event.preventDefault();
                    add();
                }}
            >
                {#if graphs.length > 1}
                    <!-- Each row is its own rounded box, so its border and focus outline follow
                         its corners; one clipped list drew a square ring over them. -->
                    <fieldset class="space-y-2">
                        <legend class="mb-2 text-sm font-medium text-(--gk-text-muted)">Graph</legend>
                        {#each graphs as graph (graph.id)}
                            <label
                                data-testid="share-graph"
                                data-graph-id={graph.id}
                                class="flex cursor-pointer items-center gap-3 rounded-xl border border-(--gk-border-strong) px-4 py-3 [-webkit-tap-highlight-color:transparent] hover:bg-(--gk-surface-1) has-checked:border-(--gk-accent) has-checked:bg-(--gk-selection) has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-(--gk-accent)"
                            >
                                <input
                                    type="radio"
                                    name="share-graph"
                                    value={graph.id}
                                    bind:group={selectedId}
                                    onchange={() => {
                                        // Another graph's favourites are other concepts.
                                        under = null;
                                        warm(graph);
                                    }}
                                    class="size-4 shrink-0 accent-(--gk-accent) focus:outline-none"
                                />
                                <span class="min-w-0 flex-1 truncate text-sm font-medium text-(--gk-text-strong)"
                                    >{graph.name}</span
                                >
                                <span
                                    class="shrink-0 rounded-full bg-(--gk-surface-2) px-2 py-0.5 text-sm text-(--gk-text-muted)"
                                    data-testid="share-graph-tag">{backendTag(graph)}</span
                                >
                            </label>
                        {/each}
                    </fieldset>
                {:else}
                    <p class="text-sm text-(--gk-text-muted)" data-testid="share-destination">
                        Goes to <span class="font-medium text-(--gk-text-strong)">{graphs[0].name}</span>
                    </p>
                {/if}

                <QuickNoteFileUnder choices={names.fileUnder} bind:selected={under} testid="share-under" roomy />

                <label
                    class="flex w-fit cursor-pointer items-center gap-3 py-1 [-webkit-tap-highlight-color:transparent] pointer-coarse:min-h-11"
                >
                    <input
                        type="checkbox"
                        bind:checked={asTask}
                        data-testid="share-task"
                        class="size-4 shrink-0 accent-(--gk-accent)"
                    />
                    <span class="text-sm text-(--gk-text-strong)">Add as task</span>
                </label>

                <button
                    type="submit"
                    data-testid="share-add"
                    class="w-full rounded-lg bg-(--gk-accent) px-5 py-2.5 text-sm font-medium text-(--gk-surface-0) hover:bg-(--gk-accent-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--gk-accent) sm:w-auto pointer-coarse:min-h-11"
                    >Add</button
                >
                {#if addError}
                    <p role="alert" class="text-sm text-(--gk-text-danger)" data-testid="share-add-error">{addError}</p>
                {/if}
            </form>
        {/if}
    {/if}
</div>
