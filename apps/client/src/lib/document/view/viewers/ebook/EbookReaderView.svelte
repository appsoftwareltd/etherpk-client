<script lang="ts">
    import { untrack } from "svelte";
    /**
     * One EBook, in its tab: the toolbar, the pages and the panels. Behaviour is in `EbookReader`, and the
     * EBook itself is in a frame with an opaque origin and no network (ADR 0181): the app's document holds
     * none of its markup, so nothing in an EBook can reach the Graph Keys beside it.
     */
    import { PUBLIC_DOCS_URL } from "@appsoftwareltd/etherpk-shared";
    import { todayISO } from "#lib/document/calendar/month-grid-core.js";
    import { assetUsageNeedles } from "#lib/document/asset-delete.js";
    import { ebookDeviceMemory } from "#lib/document/ebook/ebook-device-memory.js";
    import { EBOOK_FRAME_PATH } from "#lib/document/ebook/ebook-frame-policy.js";
    import { ebookQuoteMarkdown, requestedEbookPlace, subscribeEbookPlaceRequests } from "#lib/document/ebook/ebook-links.js";
    import { formatMinutes } from "#lib/document/ebook/ebook-pace.js";
    import { browserDictionaryShelf, createEbookDictionaries, type Definition } from "#lib/document/ebook/ebook-dictionaries.js";
    import { exportHighlights } from "#lib/document/ebook/export-highlights.js";
    import { parseInertHtml } from "#lib/security/trusted-types.js";
    import { refusingEbookState, type EbookHighlight } from "#lib/document/ebook/ebook-state.js";
    import { writeClipboardText } from "#lib/document/commands/clipboard-text.js";
    import { editorContext } from "#lib/document/index.js";
    import { registerFileSelection } from "#lib/document/file-in-front.js";
    import { openConcept } from "#lib/document/open-concept.js";
    import { READING_RATES } from "#lib/document/ebook/read-aloud-voices.js";
    import { ANNOTATION_COLOURS } from "#lib/document/pdf/annotation-palette.js";
    import { appendToJournal } from "#lib/document/pdf/journal-write.js";
    import { addPdfFavourite, isPdfFavourite, pdfFavouriteTarget, removePdfFavourite, subscribePdfFavourites } from "#lib/document/pdf/pdf-favourites.js";
    import { viewKey } from "#lib/layout/index.js";
    import { putTopBarOverView, topBarOverView } from "#lib/layout/top-bar-over-view.svelte.js";
    import { COMMAND_BAR_KIND, type CommandBarItem, listCommandBarItems, tryGetActiveCommandRegistry, tryGetActiveContributionRegistry } from "#lib/surface/index.js";
    import { offerCommandBarTools } from "#lib/surface/command-bar-tools.svelte.js";
    import { iconSvg } from "#lib/surface/icons.js";
    import { hideAppHeaderOnPhone } from "#lib/workspace/app-header.svelte.js";
    import { currentWorkspaceServices, workspaceService } from "#lib/workspace/workspace-services.js";
    import { deleteFileQuestion, keptDaysOf } from "#lib/sync/version-history/kept-copy.js";
    import { formatBytes } from "@appsoftwareltd/etherpk-shared";
    import { createSubscriber, MediaQuery } from "svelte/reactivity";

    import { getActiveDocumentStore } from "../../../active-store";
    import { assetRefOf } from "../pdf/pdf-asset-ref";
    import EbookDictionaries from "./EbookDictionaries.svelte";
    import EbookFindBar from "./EbookFindBar.svelte";
    import EbookSettingsPanel from "./EbookSettingsPanel.svelte";
    import ToolOptions from "../ToolOptions.svelte";
    import EbookSidePanel from "./EbookSidePanel.svelte";
    import { EbookReader, EDGE_TAP_SHARE, TOUCH_PHONE } from "./ebook-reader.svelte";

    let { url, name, target, onretry }: { url: string; name: string; target: string; onretry: () => void } = $props();

    const files = workspaceService("pdf");
    const ebookService = workspaceService("ebook");

    const reader = new EbookReader({
        graphId: currentWorkspaceServices()?.graphId ?? "unknown",
        target: () => target,
        name: () => displayName,
        openState: (hash) => ebookService?.state.open(hash) ?? Promise.resolve(refusingEbookState("Changes to this EBook cannot be saved here.")),
    });

    let root = $state<HTMLDivElement>();
    let panelOpen = $state(false);
    let moreOpen = $state(false);
    let settingsOpen = $state(false);
    let moreButton = $state<HTMLButtonElement>();
    let moreMenu = $state<HTMLDivElement>();
    let renameOpen = $state(false);
    let renameValue = $state("");
    let renameError = $state("");
    let deleteOpen = $state(false);
    /** How long the graph keeps a deleted file (ADR 0184), read as the confirmation opens. */
    let deleteKeptDays = $state<number | "unknown" | undefined>(undefined);
    let deleteBusy = $state(false);
    let deleteMessage = $state("");
    let toast = $state("");
    let toastAction = $state<{ label: string; run: () => void } | null>(null);
    let toastTimer: ReturnType<typeof setTimeout> | undefined;
    let linkedFrom = $state.raw<{ concept: string; references: number }[] | null>(null);
    let keptOnDevice = $state(false);
    let keepBusy = $state(false);
    let keepError = $state("");
    let favourite = $state(false);
    let dictionariesOpen = $state(false);
    let dictionaryCount = $state(0);
    let definitions = $state.raw<{ word: string; found: Definition[] } | null>(null);
    let percentInput = $state("");
    let selectionCopied = $state(false);
    let selectionCopiedTimer: ReturnType<typeof setTimeout> | undefined;
    /** The name it has now: a rename takes over from the one it opened with. */
    let displayName = $derived(name);

    const usesTouch = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
    const ebookRef = $derived(assetRefOf(target, displayName, ".epub"));
    const needles = $derived(assetUsageNeedles(pdfFavouriteTarget(target)));
    const inBar = $derived(editorContext.commandBarShowing);

    // Opening the file is an external effect, tied to this component's life: the wrapper re-creates it
    // when the tab is pointed at another file.
    $effect(() => {
        void reader.open(url);
        return () => void reader.destroy();
    });

    // An EBook joins Recents as it comes up, once its real name is known.
    $effect(() => {
        if (reader.status === "ready") workspaceService("recents")?.touchPdf(target, displayName);
    });

    // A rename on another device: a kept copy still carries the old name, so the server is asked.
    $effect(() => {
        if (reader.status !== "ready" || !files) return;
        void files.currentName?.(target).then((current) => {
            if (current && current !== displayName) showName(current);
        });
    });

    $effect(() => {
        const refresh = () => (favourite = isPdfFavourite(target));
        refresh();
        return subscribePdfFavourites(refresh);
    });

    $effect(() => {
        const answer = () => {
            const cfi = requestedEbookPlace(target);
            if (cfi !== null) reader.openPlaceFromLink(cfi);
        };
        answer();
        return subscribeEbookPlaceRequests(answer);
    });

    $effect(() => {
        if (files?.backend !== "synced") return;
        void files.keptOnDevice(target).then((kept) => (keptOnDevice = kept));
    });

    // The frame cannot read the app's colours, so an EBook that follows the app is told when they change.
    $effect(() => {
        const observer = new MutationObserver(() => reader.themeChanged());
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
        return () => observer.disconnect();
    });

    // On a phone the pages take the height of the app's header.
    $effect(() => hideAppHeaderOnPhone());

    $effect(() => {
        if (!inBar) return;
        return offerCommandBarTools({ file: "epub", strip: barStrip, pinned: barPinned });
    });

    // Reading on a touch phone, the top bar and the page buttons go a few seconds after they show.
    const touchPhone = new MediaQuery(TOUCH_PHONE);
    const hidesControls = $derived(reader.status === "ready" && inBar && touchPhone.current && reader.preferences.hidesControls);
    const topRowShowing = $derived(renameOpen || deleteOpen || reader.findOpen || !!reader.noteEditor || !!reader.linkAsked || !!reader.placeElsewhere || reader.readAloud.state !== "off" || !!reader.readAloud.problem || dictionariesOpen || !!definitions);
    const clearsTopBar = $derived(hidesControls && (topRowShowing || panelOpen || reader.highlightToolOn));

    $effect(() =>
        reader.controls.update({
            on: hidesControls,
            opened: topRowShowing || panelOpen || reader.highlightToolOn || moreOpen || settingsOpen || topBarOverView.opened,
            busy: !!reader.selection || !!reader.pressedHighlight,
        }),
    );

    $effect(() => {
        if (!hidesControls) return;
        return putTopBarOverView({
            get hidden() {
                return reader.controlsHidden;
            },
            pressed: () => reader.controls.pressed(),
        });
    });

    // Once on a device, because a top bar going by itself could look like a fault.
    $effect(() => {
        if (!reader.controlsHidden || reader.preferences.controlsHintSeen) return;
        untrack(() => {
            reader.updatePreferences({ controlsHintSeen: true });
            showToast("Tap the middle of the page to bring back the top bar and page buttons");
        });
    });

    // A pinned Command Bar button that names this type of file, drawn over the tab where no Command Bar
    // shows. An extension's come and go as it starts or is switched off, so the list is read again as they do.
    const contributions = tryGetActiveContributionRegistry();
    const watchActions = createSubscriber((update) => contributions?.subscribe(COMMAND_BAR_KIND, update) ?? (() => {}));
    const fileActions = $derived.by<CommandBarItem[]>(() => {
        watchActions();
        if (!contributions || inBar) return [];
        return listCommandBarItems(contributions).filter((item) => item.align === "end" && item.files?.includes("epub"));
    });

    function runFileAction(action: CommandBarItem) {
        const commands = tryGetActiveCommandRegistry();
        if (commands?.has(action.command)) void commands.execute(action.command, action.args);
    }

    // What an extension can ask about this EBook while it is the file in front.
    $effect(() => registerFileSelection(target, () => reader.fileSelection()));

    /** The frame goes in with the tab, so it is there to say it is ready whatever else is showing. */
    const mountFrame = (element: HTMLIFrameElement) => {
        untrack(() => {
            reader.attachFrame(element);
            reader.onFrameKey = (event) => element.dispatchEvent(event);
            reader.onPagePress = closeMenus;
        });
    };

    /** A press on the page closes what is open over it, which the app's own document never hears of. */
    function closeMenus(): boolean {
        const anything = moreOpen || settingsOpen || reader.toolOptionsOpen;
        moreOpen = false;
        settingsOpen = false;
        reader.toolOptionsOpen = false;
        return anything;
    }

    function refreshLinks() {
        const index = workspaceService("index");
        if (!index || index.isBuilding()) {
            linkedFrom = null;
            return;
        }
        void index
            .assetUsage(needles)
            .then((usage) => (linkedFrom = usage.documents.map(({ concept, references }) => ({ concept, references }))))
            .catch(() => (linkedFrom = null));
    }

    function togglePanel() {
        panelOpen = !panelOpen;
        if (panelOpen) refreshLinks();
    }

    /** The tab is the one in front: it fills its space and the keyboard is in it, on its Command Bar, or nowhere. */
    function holdsKeyboard(): boolean {
        if (!root || root.offsetParent === null) return false;
        const active = document.activeElement;
        return !active || active === document.body || root.contains(active) || (inBar && !!active.closest(".command-bar"));
    }

    function isTextEntry(element: Element | null): boolean {
        return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || (element instanceof HTMLElement && element.isContentEditable);
    }

    const MOD_KEYS: Record<string, (event: KeyboardEvent) => void> = {
        z: (event) => (event.shiftKey ? reader.redo() : reader.undo()),
        "=": () => reader.textLarger(),
        "+": () => reader.textLarger(),
        "-": () => reader.textSmaller(),
    };

    const TURN_KEYS: Record<string, (event: KeyboardEvent) => void> = {
        arrowleft: () => reader.turnLeft(),
        arrowright: () => reader.turnRight(),
        pageup: () => reader.previous(),
        pagedown: () => reader.next(),
        " ": (event) => (event.shiftKey ? reader.previous() : reader.next()),
    };

    function closeOneThing(): boolean {
        if (moreOpen) moreOpen = false;
        else if (settingsOpen) settingsOpen = false;
        else if (reader.toolOptionsOpen) reader.toolOptionsOpen = false;
        else if (reader.pressedHighlight) reader.pressedHighlight = null;
        else if (reader.selection) reader.clearSelection();
        else if (reader.highlightToolOn) reader.highlightToolOn = false;
        else return false;
        return true;
    }

    /** What a key does here. A space on a button is the button's. */
    function keyAction(event: KeyboardEvent, key: string, mod: boolean) {
        if (mod) return MOD_KEYS[key];
        if (event.altKey) return undefined;
        const onButton = key === " " && event.target instanceof Element && !!event.target.closest("button");
        return onButton ? undefined : TURN_KEYS[key];
    }

    function openFindFromKey(event: KeyboardEvent) {
        event.preventDefault();
        event.stopPropagation();
        reader.openFind();
    }

    function onWindowKeydown(event: KeyboardEvent) {
        if (reader.status !== "ready" || !holdsKeyboard()) return;
        const mod = event.ctrlKey || event.metaKey;
        const key = event.key.toLowerCase();
        if (mod && key === "f") return openFindFromKey(event);
        if (isTextEntry(document.activeElement)) return;
        reader.controls.show();
        const action = keyAction(event, key, mod);
        if (action) {
            event.preventDefault();
            action(event);
        } else if (key === "escape" && closeOneThing()) {
            event.preventDefault();
        }
    }

    function onWindowPointerdown(event: PointerEvent) {
        if (!moreOpen || !(event.target instanceof Node)) return;
        if (moreMenu?.contains(event.target) || moreButton?.contains(event.target)) return;
        moreOpen = false;
    }

    function commitPercent() {
        const value = Number.parseFloat(percentInput);
        if (Number.isFinite(value)) reader.goToFraction(value / 100);
        percentInput = "";
    }

    function showToast(message: string, action: { label: string; run: () => void } | null = null) {
        toast = message;
        toastAction = action;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toast = "";
            toastAction = null;
        }, 7000);
    }

    async function copySelection() {
        try {
            await writeClipboardText(reader.fileSelection().selectedText);
            selectionCopied = true;
            clearTimeout(selectionCopiedTimer);
            selectionCopiedTimer = setTimeout(() => (selectionCopied = false), 1500);
        } catch (error) {
            showToast(`That could not be copied (${error instanceof Error ? error.message : String(error)}). It is still selected, so try your browser's own copy.`);
        }
    }

    const ebookLabel = () => reader.title || displayName.replace(/\.epub$/i, "");

    async function copyToJournal(highlight: EbookHighlight) {
        const store = getActiveDocumentStore();
        const day = todayISO();
        const label = highlight.chapter ? `${ebookLabel()}, ${highlight.chapter}` : ebookLabel();
        try {
            await appendToJournal(store, day, ebookQuoteMarkdown(highlight.text, highlight.note, label, ebookRef, highlight.cfi));
            showToast(`Copied to today's journal.`, { label: "Open", run: () => openConcept(day) });
        } catch (error) {
            showToast(`That could not be copied to the journal (${error instanceof Error ? error.message : String(error)}).`);
        }
    }

    async function exportToPage() {
        try {
            const { concept, added } = await exportHighlights(getActiveDocumentStore(), { title: ebookLabel(), author: reader.author, ref: ebookRef, highlights: reader.highlights });
            showToast(added === 0 ? `${concept} already holds these.` : `Added ${added} to ${concept}.`, { label: "Open", run: () => openConcept(concept) });
        } catch (error) {
            showToast(`The highlights could not be exported (${error instanceof Error ? error.message : String(error)}).`);
        }
    }

    function downloadOriginal() {
        moreOpen = false;
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = displayName;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
    }

    async function toggleFavourite() {
        moreOpen = false;
        try {
            if (favourite) await removePdfFavourite(target);
            else await addPdfFavourite(target, displayName);
        } catch (error) {
            showToast(`That could not be saved (${error instanceof Error ? error.message : String(error)}).`);
        }
    }

    async function toggleBookmark() {
        try {
            await reader.toggleBookmark();
        } catch (error) {
            showToast(`That could not be saved (${error instanceof Error ? error.message : String(error)}).`);
        }
    }

    function showName(next: string) {
        displayName = next;
        workspaceService("retitleView")?.(viewKey({ kind: "asset", target }), next);
    }

    function openRename() {
        moreOpen = false;
        renameValue = displayName.replace(/\.epub$/i, "");
        renameError = "";
        renameOpen = true;
    }

    async function submitRename(event: SubmitEvent) {
        event.preventDefault();
        if (!files) return;
        const next = renameValue.trim();
        if (next === "") {
            renameError = "Give the EBook a name.";
            return;
        }
        try {
            const renamed = await files.renameAsset(target, `${next.replace(/\.epub$/i, "")}.epub`, displayName);
            showName(renamed.name);
            renameOpen = false;
        } catch (error) {
            renameError = `It could not be renamed (${error instanceof Error ? error.message : String(error)}).`;
        }
    }

    function openDelete() {
        moreOpen = false;
        deleteMessage = "";
        deleteOpen = true;
        deleteKeptDays = workspaceService("versions") ? "unknown" : undefined;
        void keptDaysOf(workspaceService("versions")).then((days) => (deleteKeptDays = days));
    }

    /** After the bytes: a failure here leaves a little private state behind, never a missing EBook whose highlights were deleted first. */
    async function forgetDeletedEbook(hash: string) {
        await ebookService?.state.forget(hash).catch((error: unknown) => console.warn("[EBook] could not delete the state of a deleted EBook", error));
        ebookDeviceMemory().forgetEbook(currentWorkspaceServices()?.graphId ?? "unknown", hash);
    }

    async function confirmDelete() {
        const { hash } = reader;
        if (!files || !hash || deleteBusy) return;
        deleteBusy = true;
        try {
            const answer = await files.deleteAsset(target, hash);
            if (answer.deleted) {
                deleteOpen = false;
                await forgetDeletedEbook(hash);
                return;
            }
            deleteMessage = answer.reason === "linked" ? `It cannot be deleted while it is linked. Remove the links in ${answer.documents.join(", ")} first.` : answer.message;
        } catch (error) {
            deleteMessage = `It could not be deleted (${error instanceof Error ? error.message : String(error)}).`;
        } finally {
            deleteBusy = false;
        }
    }

    const fileSize = $derived(formatBytes(reader.fileSize));

    /** Room for the file, by the browser's own estimate. A browser with no estimate is let try. */
    async function hasRoomFor(bytes: number): Promise<boolean> {
        const estimate = await navigator.storage?.estimate?.().catch(() => null);
        if (!estimate?.quota) return true;
        return estimate.quota - (estimate.usage ?? 0) > bytes * 1.1;
    }

    async function setKept(keep: boolean) {
        if (!files || keepBusy) return;
        keepBusy = true;
        keepError = "";
        try {
            if (keep && !keptOnDevice && !(await hasRoomFor(reader.fileSize))) throw new Error(`This device does not have room to keep ${fileSize}.`);
            await files.setKeptOnDevice(target, keep);
            keptOnDevice = keep;
        } catch (error) {
            keepError = error instanceof Error ? error.message : String(error);
        } finally {
            keepBusy = false;
        }
    }

    const percent = $derived(Math.round((reader.place?.fraction ?? 0) * 100));
    const progressWords = $derived.by(() => {
        const place = reader.place;
        if (!place) return "";
        const page = place.printPage ? `p. ${place.printPage}, ` : "";
        const left = reader.paced(place.minutesLeftInChapter);
        return `${page}${percent}%${left === null ? "" : `, about ${formatMinutes(left)} left in this chapter`}`;
    });
    const bookmarked = $derived(reader.bookmarksHere.length > 0);
    const bookmarkLabel = $derived(bookmarked ? "Remove the bookmark here" : "Add a bookmark here");
    const pressedOrSelected = $derived(!!reader.selection || !!reader.pressedHighlight);
    const backTo = $derived(reader.place?.backTo ?? null);
    const offersBack = $derived(backTo !== null && !pressedOrSelected);
    // On a desktop the place stays at the foot of the page, as a PDF's page count does. Where the toolbar is
    // on the Command Bar it shows when the place changes, and goes for a selection; Back keeps it.
    const progressGone = $derived(inBar && !offersBack && (!reader.progressShowing || pressedOrSelected));

    // The Highlight text tool: a selection made with it on is highlighted as the pointer lets go.
    $effect(() => {
        if (reader.highlightToolOn && reader.selection) {
            const { cfi } = reader.selection;
            const timer = setTimeout(() => {
                if (reader.selection?.cfi === cfi) reader.highlightSelection();
            }, 400);
            return () => clearTimeout(timer);
        }
    });

    const focusNote = (element: HTMLTextAreaElement) => element.focus();

    // The dictionaries on this device, and what the last word looked up found.
    const shelf = browserDictionaryShelf();
    const dictionaries = shelf ? createEbookDictionaries(shelf, (markup) => parseInertHtml(markup).body.textContent ?? "") : null;
    /** A word or a short phrase. A dictionary has nothing to say about a sentence. */
    const canDefine = $derived(dictionaryCount > 0 && !!reader.selection && reader.selection.text.trim().split(/\s+/).length <= 3);

    const countDictionaries = async () => {
        dictionaryCount = (await dictionaries?.list().catch(() => []))?.length ?? 0;
    };
    $effect(() => void countDictionaries());

    async function defineSelection() {
        const word = reader.selection?.text.trim();
        if (!word || !dictionaries) return;
        definitions = { word, found: await dictionaries.lookUp(word) };
    }

    function toggleReadAloud() {
        if (reader.readAloud.state === "off") reader.readAloud.start();
        else reader.readAloud.stop();
    }

    function onPickVoice(event: Event) {
        reader.updatePreferences({ readingVoice: (event.currentTarget as HTMLSelectElement).value });
    }

    function onPickRate(event: Event) {
        reader.updatePreferences({ readingRate: Number((event.currentTarget as HTMLSelectElement).value) });
    }

    function onNoteKeydown(event: KeyboardEvent) {
        const area = event.currentTarget as HTMLTextAreaElement;
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            reader.cancelNote();
        } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            reader.commitNote(area.value);
        }
    }

    /** The press leaves a selection in the frame where it is. */
    const keepPress = (event: Event) => event.preventDefault();
</script>

<svelte:window onkeydowncapture={onWindowKeydown} onpointerdowncapture={onWindowPointerdown} />

{#snippet icon(iconName: string)}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
    {@html iconSvg(iconName, { size: 18 })}
{/snippet}

{#snippet turnPage(direction: "previous" | "next", className: string, testId: string)}
    {@const previous = direction === "previous"}
    {@const label = previous ? "Previous page" : "Next page"}
    <button type="button" class={className} aria-label={label} title={label} onclick={() => (previous ? reader.previous() : reader.next())} data-testid={testId}>
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
        {@html iconSvg(previous ? "pdf-page-previous" : "pdf-page-next")}
    </button>
{/snippet}

{#snippet toggleRow(label: string, checked: boolean, testId: string, onchange: (next: boolean) => void)}
    <label class="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-(--gk-text-default) hover:bg-(--gk-surface-2)">
        <input type="checkbox" {checked} onchange={(event) => onchange(event.currentTarget.checked)} data-testid={testId} />
        {label}
    </label>
{/snippet}

{#snippet percentBox()}
    <span class="flex shrink-0 items-center gap-1 text-sm text-(--gk-text-muted)">
        <label class="sr-only" for="ebook-percent-input">How far through the EBook, as a percentage</label>
        <input
            id="ebook-percent-input"
            class="w-12 rounded-md border border-neutral-300 bg-(--gk-surface-0) px-1 py-0.5 text-center text-sm text-(--gk-text-default) dark:border-neutral-700"
            inputmode="decimal"
            value={percentInput === "" ? percent : percentInput}
            oninput={(event) => (percentInput = event.currentTarget.value)}
            onblur={commitPercent}
            onkeydown={(event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    commitPercent();
                    event.currentTarget.blur();
                }
            }}
            data-testid="ebook-percent-input"
        />
        <span>%</span>
    </span>
{/snippet}

<!-- The buttons of the toolbar, in `button`'s style: the toolbar's own on a desktop, the Command Bar's where there is one. -->
{#snippet tools(button: string)}
    <button type="button" class={button} aria-label="Find in this EBook" title="Find in this EBook" onclick={() => reader.openFind()} data-testid="ebook-find-open">{@render icon("search")}</button>
    {@render turnPage("previous", `${button} max-sm:hidden`, "ebook-previous")}
    {#if !inBar}{@render percentBox()}{/if}
    {@render turnPage("next", `${button} max-sm:hidden`, "ebook-next")}
    {#if !inBar}<span class="etherpk-ebook-divider"></span>{/if}
    <button type="button" class={button} aria-label="Text settings" title="Text settings" aria-expanded={settingsOpen} onclick={() => (settingsOpen = !settingsOpen)} data-testid="ebook-settings-open">{@render icon("ebook-text-size")}</button>
    <button type="button" class={button} aria-label="Contents, highlights and bookmarks" title="Contents, highlights and bookmarks" aria-pressed={panelOpen} onclick={togglePanel} data-testid="ebook-panel-toggle">{@render icon("list")}</button>
    <button type="button" class={[button, bookmarked && "etherpk-ebook-bookmarked"]} aria-label={bookmarkLabel} title={bookmarkLabel} aria-pressed={bookmarked} onclick={toggleBookmark} data-testid="ebook-bookmark">{@render icon("bookmark")}</button>
    <button type="button" class={button} aria-label="Read aloud" title="Read aloud" aria-pressed={reader.readAloud.state !== "off"} onclick={toggleReadAloud} data-testid="ebook-read-aloud">{@render icon("ebook-read-aloud")}</button>
    <button type="button" class={button} aria-label="Highlight text" title="Highlight text as you select it" aria-pressed={reader.highlightToolOn} onclick={() => reader.toggleHighlightTool()} data-testid="ebook-tool-highlight">{@render icon("highlight")}</button>
    {#if !inBar}<span class="etherpk-ebook-divider"></span>{/if}
    <button type="button" class={button} aria-label="Undo" title="Undo" disabled={!reader.canUndo} onclick={() => reader.undo()} data-testid="ebook-undo">{@render icon("undo")}</button>
    <button type="button" class={button} aria-label="Redo" title="Redo" disabled={!reader.canRedo} onclick={() => reader.redo()} data-testid="ebook-redo">{@render icon("redo")}</button>
{/snippet}

{#snippet moreToggle(button: string)}
    <button type="button" class={button} bind:this={moreButton} aria-label="More" title="More" aria-expanded={moreOpen} onclick={() => (moreOpen = !moreOpen)} data-testid="ebook-more">{@render icon("more")}</button>
{/snippet}

{#snippet barStrip()}
    {#if reader.status === "ready"}
        <div class="contents" role="toolbar" aria-label="EBook tools" tabindex="-1" data-testid="ebook-toolbar">
            {@render tools("command-bar__btn")}
        </div>
    {/if}
{/snippet}

{#snippet barPinned()}
    {#if reader.status === "ready"}{@render moreToggle("command-bar__btn")}{/if}
{/snippet}

{#snippet moreMenuBlock()}
    {#if moreOpen}
        <div class="relative h-0 shrink-0">
            <div bind:this={moreMenu} class={["etherpk-ebook-more flex flex-col gap-0.5 rounded-lg border border-(--gk-surface-2) bg-(--gk-surface-0) p-1 shadow-lg", inBar && "etherpk-ebook-more--above"]} role="group" aria-label="More for this EBook" data-testid="ebook-more-menu">
                <div class="flex items-center justify-between">
                    <span class="px-2 text-sm font-medium text-(--gk-text-muted)">More</span>
                    <button type="button" class="ebook-tool" aria-label="Close this menu" title="Close this menu" onclick={() => (moreOpen = false)} data-testid="ebook-more-close">{@render icon("close")}</button>
                </div>
                {#if inBar}
                    <div class="flex items-center gap-2 px-2 py-1.5 text-sm text-(--gk-text-default)" data-testid="ebook-more-percent">
                        <span aria-hidden="true">Go to</span>
                        {@render percentBox()}
                    </div>
                {/if}
                {@render toggleRow("Page by page", reader.settings.flow === "paginated", "ebook-page-by-page", (next) => reader.updateSettings({ flow: next ? "paginated" : "scrolled" }))}
                {#if usesTouch}
                    {@render toggleRow("Keep the screen on", reader.preferences.keepScreenOn, "ebook-keep-screen", (next) => reader.setKeepScreenOn(next))}
                {/if}
                {#if touchPhone.current}
                    {@render toggleRow("Hide top bar and page buttons", reader.preferences.hidesControls, "ebook-hide-controls", (next) => reader.updatePreferences({ hidesControls: next }))}
                {/if}
                {#if files?.backend === "synced"}
                    {@render toggleRow(`Keep on this device (${fileSize})`, keptOnDevice, "ebook-keep-on-device", (next) => void setKept(next))}
                    {#if keepError}<p class="px-2 text-sm text-red-700 dark:text-red-400" role="alert" data-testid="ebook-keep-error">{keepError}</p>{/if}
                {/if}
                <hr class="my-0.5 border-(--gk-surface-2)" />
                <button type="button" class="rounded-lg px-2 py-1.5 text-left text-sm text-(--gk-text-default) hover:bg-(--gk-surface-2)" onclick={toggleFavourite} data-testid="ebook-favourite">{favourite ? "Remove from favourites" : "Add to favourites"}</button>
                {#if dictionaries}
                    <button type="button" class="rounded-lg px-2 py-1.5 text-left text-sm text-(--gk-text-default) hover:bg-(--gk-surface-2)" onclick={() => { moreOpen = false; dictionariesOpen = true; }} data-testid="ebook-dictionaries-open">Dictionaries</button>
                {/if}
                <button type="button" class="rounded-lg px-2 py-1.5 text-left text-sm text-(--gk-text-default) hover:bg-(--gk-surface-2)" onclick={downloadOriginal} data-testid="ebook-download">Download the original</button>
                {#if files}
                    <button type="button" class="rounded-lg px-2 py-1.5 text-left text-sm text-(--gk-text-default) hover:bg-(--gk-surface-2)" onclick={openRename} data-testid="ebook-rename">Rename…</button>
                    <button type="button" class="rounded-lg px-2 py-1.5 text-left text-sm text-(--gk-text-default) hover:bg-(--gk-surface-2)" onclick={openDelete} data-testid="ebook-delete">Delete…</button>
                {/if}
            </div>
        </div>
    {/if}
{/snippet}

<div bind:this={root} class="etherpk-ebook-reader flex h-full flex-col" data-testid="ebook-asset-viewer" data-hash={reader.hash ?? undefined} data-status={reader.status} data-chapter={reader.place?.chapter ?? undefined} data-percent={percent}>
    {#if reader.status === "error"}
        <div class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <p class="text-sm text-(--gk-text-muted)" role="alert" data-testid="ebook-error">{reader.errorMessage}</p>
            <div class="flex gap-2">
                <button type="button" class="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-(--gk-text-default) dark:border-neutral-700" onclick={onretry} data-testid="ebook-retry">Try again</button>
                <button type="button" class="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-(--gk-text-default) dark:border-neutral-700" onclick={downloadOriginal}>Download it instead</button>
            </div>
        </div>
    {:else if reader.status === "protected"}
        <div class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <p class="max-w-prose text-sm text-(--gk-text-muted)" role="alert" data-testid="ebook-protected">This EBook is protected by DRM, so EtherPK can't open it. Read it in the app it came from.</p>
            <button type="button" class="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-(--gk-text-default) dark:border-neutral-700" onclick={downloadOriginal} data-testid="ebook-protected-download">Download it</button>
        </div>
    {:else}
        {#if reader.status === "opening"}
            <p class="absolute inset-x-0 top-0 p-6 text-center text-sm text-(--gk-text-muted)" role="status" data-testid="ebook-opening">Opening {name}…</p>
        {/if}
        {#if reader.status === "ready" && !inBar}
            <div class="etherpk-ebook-toolbar flex shrink-0 flex-wrap items-center gap-0.5 border-b border-(--gk-surface-2) bg-(--gk-surface-1) px-1 py-1" role="toolbar" aria-label="EBook tools" data-testid="ebook-toolbar">
                {@render tools("ebook-tool")}
                <div class="relative shrink-0">{@render moreToggle("ebook-tool")}</div>
            </div>
        {/if}
        {#if !inBar}{@render moreMenuBlock()}{/if}
        {#if settingsOpen && !inBar}<EbookSettingsPanel {reader} above={false} onclose={() => (settingsOpen = false)} />{/if}
        {#if clearsTopBar}<div class="etherpk-ebook-top-bar-room" aria-hidden="true"></div>{/if}
        {#if renameOpen}
            <form class="flex shrink-0 flex-wrap items-center gap-2 border-b border-(--gk-surface-2) bg-(--gk-surface-1) p-2" onsubmit={submitRename} data-testid="ebook-rename-form">
                <label class="text-sm font-medium text-(--gk-text-default)" for="ebook-rename-input">Name</label>
                <!-- svelte-ignore a11y_autofocus -->
                <input id="ebook-rename-input" autofocus class="min-w-40 flex-1 rounded-lg border border-neutral-300 bg-(--gk-surface-0) px-2 py-1 text-sm text-(--gk-text-default) dark:border-neutral-700" bind:value={renameValue} data-testid="ebook-rename-input" />
                <button type="submit" class="rounded-lg bg-(--gk-accent) px-3 py-1 text-sm font-medium text-(--gk-surface-0)" data-testid="ebook-rename-submit">Rename</button>
                <button type="button" class="rounded-lg border border-neutral-300 px-3 py-1 text-sm text-(--gk-text-default) dark:border-neutral-700" onclick={() => (renameOpen = false)}>Cancel</button>
                {#if renameError}<p class="w-full text-sm text-red-700 dark:text-red-400" role="alert" data-testid="ebook-rename-error">{renameError}</p>{/if}
            </form>
        {/if}
        {#if deleteOpen}
            <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-(--gk-surface-2) bg-(--gk-surface-1) p-2" role="alert" data-testid="ebook-delete-confirm">
                <p class="min-w-40 flex-1 text-sm text-(--gk-text-default)">
                    {deleteFileQuestion(displayName, reader.highlights.length > 0 ? `${reader.highlights.length} highlight${reader.highlights.length === 1 ? "" : "s"}` : null, deleteKeptDays)}
                </p>
                <button type="button" class="rounded-lg bg-red-700 px-3 py-1 text-sm font-medium text-white disabled:opacity-60" disabled={deleteBusy} onclick={confirmDelete} data-testid="ebook-delete-submit">Delete</button>
                <button type="button" class="rounded-lg border border-neutral-300 px-3 py-1 text-sm text-(--gk-text-default) dark:border-neutral-700" onclick={() => (deleteOpen = false)}>Cancel</button>
                {#if deleteMessage}<p class="w-full text-sm text-red-700 dark:text-red-400" data-testid="ebook-delete-message">{deleteMessage}</p>{/if}
            </div>
        {/if}
        {#if reader.linkAsked}
            <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-(--gk-surface-2) bg-(--gk-surface-1) p-2" role="alert" data-testid="ebook-link-confirm">
                <p class="min-w-40 flex-1 text-sm break-all text-(--gk-text-default)">This link leaves EtherPK for {reader.linkAsked}. Open it?</p>
                <button type="button" class="rounded-lg bg-(--gk-accent) px-3 py-1 text-sm font-medium text-(--gk-surface-0)" onclick={() => reader.followLink()} data-testid="ebook-link-open">Open</button>
                <button type="button" class="rounded-lg border border-neutral-300 px-3 py-1 text-sm text-(--gk-text-default) dark:border-neutral-700" onclick={() => (reader.linkAsked = null)} data-testid="ebook-link-cancel">Cancel</button>
            </div>
        {/if}
        {#if reader.placeElsewhere}
            <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-(--gk-surface-2) bg-(--gk-surface-1) p-2" role="status" data-testid="ebook-place-elsewhere">
                <p class="min-w-40 flex-1 text-sm text-(--gk-text-default)">You read to {Math.round(reader.placeElsewhere.fraction * 100)}% on another device.</p>
                <button type="button" class="rounded-lg bg-(--gk-accent) px-3 py-1 text-sm font-medium text-(--gk-surface-0)" onclick={() => reader.acceptPlaceElsewhere()} data-testid="ebook-place-elsewhere-go">Go there</button>
                <button type="button" class="rounded-lg border border-neutral-300 px-3 py-1 text-sm text-(--gk-text-default) dark:border-neutral-700" onclick={() => (reader.placeElsewhere = null)} data-testid="ebook-place-elsewhere-stay">Stay here</button>
            </div>
        {/if}
        {#if reader.stateProblem}
            <p class="shrink-0 border-b border-(--gk-surface-2) bg-(--gk-surface-1) p-2 text-sm text-red-700 dark:text-red-400" role="alert" data-testid="ebook-state-problem">{reader.stateProblem}</p>
        {/if}
        {#if reader.findOpen}
            <EbookFindBar {reader} />
        {/if}
        {#if dictionariesOpen && dictionaries}
            <EbookDictionaries {dictionaries} onchange={countDictionaries} onclose={() => (dictionariesOpen = false)} />
        {/if}
        {#if definitions}
            <div class="flex max-h-60 shrink-0 flex-col gap-1 overflow-y-auto border-b border-(--gk-surface-2) bg-(--gk-surface-1) p-2 text-sm text-(--gk-text-default)" role="status" data-testid="ebook-definition">
                <div class="flex items-center gap-2">
                    <span class="min-w-0 flex-1 truncate font-medium">{definitions.word}</span>
                    <button type="button" class="ebook-tool" aria-label="Close this definition" title="Close this definition" onclick={() => (definitions = null)} data-testid="ebook-definition-close">{@render icon("close")}</button>
                </div>
                {#each definitions.found as found, index (index)}
                    <p class="whitespace-pre-wrap" data-testid="ebook-definition-text">{found.text}</p>
                    <p class="text-(--gk-text-muted)">{found.dictionary}</p>
                {:else}
                    <p data-testid="ebook-definition-none">Your dictionaries have no entry for this.</p>
                {/each}
            </div>
        {/if}
        {#if reader.readAloud.state !== "off"}
            <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-(--gk-surface-2) bg-(--gk-surface-1) p-2" role="group" aria-label="Read aloud" data-testid="ebook-read-aloud-bar">
                {#if reader.readAloud.state === "paused"}
                    <button type="button" class="rounded-lg bg-(--gk-accent) px-3 py-1 text-sm font-medium text-(--gk-surface-0)" onclick={() => reader.readAloud.resume()} data-testid="ebook-read-resume">Resume</button>
                {:else}
                    <button type="button" class="rounded-lg border border-neutral-300 px-3 py-1 text-sm text-(--gk-text-default) dark:border-neutral-700" onclick={() => reader.readAloud.pause()} data-testid="ebook-read-pause">Pause</button>
                {/if}
                <button type="button" class="rounded-lg border border-neutral-300 px-3 py-1 text-sm text-(--gk-text-default) dark:border-neutral-700" onclick={() => reader.readAloud.stop()} data-testid="ebook-read-stop">Stop</button>
                <label class="flex min-w-0 items-center gap-1 text-sm text-(--gk-text-default)">
                    Voice
                    <select class="max-w-48 rounded-lg border border-neutral-300 bg-(--gk-surface-0) px-1 py-1 text-sm dark:border-neutral-700" onchange={onPickVoice} data-testid="ebook-read-voice">
                        {#each reader.readAloud.voices as voice (voice.name)}
                            <option value={voice.name} selected={voice.name === reader.preferences.readingVoice}>{voice.name}</option>
                        {/each}
                    </select>
                </label>
                <label class="flex items-center gap-1 text-sm text-(--gk-text-default)">
                    Speed
                    <select class="rounded-lg border border-neutral-300 bg-(--gk-surface-0) px-1 py-1 text-sm dark:border-neutral-700" onchange={onPickRate} data-testid="ebook-read-rate">
                        {#each READING_RATES as rate (rate)}
                            <option value={rate} selected={rate === reader.preferences.readingRate}>{rate}×</option>
                        {/each}
                    </select>
                </label>
            </div>
        {/if}
        {#if reader.readAloud.problem}
            <p class="shrink-0 border-b border-(--gk-surface-2) bg-(--gk-surface-1) p-2 text-sm text-(--gk-text-default)" role="status" data-testid="ebook-read-problem">
                {reader.readAloud.problem}
                {#if reader.readAloud.noVoice}
                    <a class="text-(--gk-accent) underline" href="{PUBLIC_DOCS_URL}/ebooks-reading-and-highlighting#add-a-voice" target="_blank" rel="noopener noreferrer" data-testid="ebook-read-voice-help">How to add a voice</a>
                {/if}
            </p>
        {/if}
        {#if reader.noteEditor}
            {@const editor = reader.noteEditor}
            <form
                class="flex shrink-0 flex-col gap-2 border-b border-(--gk-surface-2) bg-(--gk-surface-1) p-2"
                onsubmit={(event) => {
                    event.preventDefault();
                    reader.commitNote(new FormData(event.currentTarget).get("note") as string);
                }}
                data-testid="ebook-note-editor"
            >
                <label class="text-sm font-medium text-(--gk-text-default)" for="ebook-note-input">Note on “<span class="line-clamp-1 inline font-normal text-(--gk-text-muted)">{editor.quote}</span>”</label>
                <textarea id="ebook-note-input" name="note" rows="3" {@attach focusNote} class="rounded-lg border border-neutral-300 bg-(--gk-surface-0) px-2 py-1 text-sm text-(--gk-text-default) dark:border-neutral-700" value={editor.text} onkeydown={onNoteKeydown} data-testid="ebook-note-input"></textarea>
                <div class="flex gap-2">
                    <button type="submit" class="rounded-lg bg-(--gk-accent) px-3 py-1 text-sm font-medium text-(--gk-surface-0)" data-testid="ebook-note-save">Save</button>
                    <button type="button" class="rounded-lg border border-neutral-300 px-3 py-1 text-sm text-(--gk-text-default) dark:border-neutral-700" onclick={() => reader.cancelNote()} data-testid="ebook-note-cancel">Cancel</button>
                </div>
            </form>
        {/if}
        <div class="relative flex min-h-0 flex-1">
            <div class="relative min-w-0 flex-1">
                <!-- No sandbox attribute: its flags would pass down to the reader's own frames and split their
                     origins (ADR 0181). The page here holds no script. The `data:` document inside it has the
                     opaque origin the EBook reads in, under a policy of one script and no network. -->
                <iframe {@attach mountFrame} title={`Pages of ${displayName}`} src={EBOOK_FRAME_PATH} class="absolute inset-0 size-full border-0" data-testid="ebook-frame"></iframe>
                {#if reader.status === "ready"}
                    {#key reader.turnFlash}
                        {#if reader.turnFlash}
                            <!-- The side that turned the page, so a person sees how far a side reaches. It takes no touches. -->
                            <div class="etherpk-ebook-turn-flash" data-side={reader.turnFlash.side} style:width="{EDGE_TAP_SHARE * 100}%" aria-hidden="true" data-testid="ebook-turn-flash" onanimationend={() => (reader.turnFlash = null)}></div>
                        {/if}
                    {/key}
                    <div class="etherpk-ebook-nav" data-in-bar={inBar || undefined} data-buttons-gone={reader.controlsHidden || undefined} role="group" aria-label="Turn the page" data-testid="ebook-nav">
                        {@render turnPage("previous", "ebook-tool etherpk-ebook-edge", "ebook-previous-edge")}
                        <!-- On a desktop it holds the page buttons too, as a PDF's does. On a touch screen or in a
                             narrow window they move out to the edges of the view, near a thumb. -->
                        <div class="etherpk-ebook-progress" data-gone={progressGone || undefined} data-testid="ebook-progress">
                            {#if !inBar}{@render turnPage("previous", "ebook-tool etherpk-ebook-inner", "ebook-previous-inner")}{/if}
                            {#if offersBack && backTo !== null}
                                <!-- After a jump, in place of the progress words, until the person goes back or reads on. -->
                                <button type="button" class="etherpk-ebook-back" onclick={() => reader.goBack()} data-testid="ebook-back">{@render icon("ebook-back")}Back to {Math.round(backTo * 100)}%</button>
                            {:else}
                                <span class="min-w-0 truncate px-1 text-sm text-(--gk-text-default)">{progressWords}</span>
                            {/if}
                            {#if !inBar}{@render turnPage("next", "ebook-tool etherpk-ebook-inner", "ebook-next-inner")}{/if}
                        </div>
                        {@render turnPage("next", "ebook-tool etherpk-ebook-edge", "ebook-next-edge")}
                    </div>
                    {#if fileActions.length > 0}
                        <!-- Level with the page controls. Where the layout has a Command Bar, these buttons are on it. -->
                        <div class="etherpk-ebook-file-actions">
                            {#each fileActions as action (action.id)}
                                <button type="button" class="etherpk-ebook-file-action" aria-label={action.label} title={action.label} onclick={() => runFileAction(action)} data-testid="ebook-file-action" data-command={action.command}>
                                    <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
                                    {@html iconSvg(action.icon, { size: 18 })}
                                </button>
                            {/each}
                        </div>
                    {/if}
                    {#if reader.highlightToolOn || reader.pressedHighlight}
                        {@const inHand = reader.pressedHighlight?.colour ?? reader.highlightColour}
                        <ToolOptions open={reader.toolOptionsOpen} colour={inHand} label="Colour" testid="ebook" ontoggle={() => (reader.toolOptionsOpen = !reader.toolOptionsOpen)}>
                            <div class="flex flex-wrap items-center justify-center gap-1" role="group" aria-label="Colour" data-testid="ebook-colours">
                                {#each ANNOTATION_COLOURS as { label, colour } (colour)}
                                    {@const on = inHand === colour}
                                    <button type="button" class={["size-6 rounded-full border pointer-coarse:size-8", on ? "border-(--gk-text-strong) ring-2 ring-(--gk-text-strong)" : "border-neutral-400"]} style:background-color={colour} aria-label={label} title={label} aria-pressed={on} onclick={() => reader.setHighlightColour(colour)}></button>
                                {/each}
                            </div>
                        </ToolOptions>
                    {/if}
                    {#if reader.selection && !reader.highlightToolOn}
                        <div class="etherpk-ebook-actions" role="group" aria-label="Selected text" data-testid="ebook-selection-actions">
                            <button type="button" class="etherpk-ebook-action" onpointerdown={keepPress} onmousedown={keepPress} onclick={() => reader.highlightSelection()} data-testid="ebook-selection-highlight">{@render icon("highlight")}Highlight</button>
                            <button type="button" class="etherpk-ebook-action" onpointerdown={keepPress} onmousedown={keepPress} onclick={() => reader.startNote(null)} data-testid="ebook-selection-note">{@render icon("pdf-note")}Note</button>
                            {#if canDefine}
                                <button type="button" class="etherpk-ebook-action" onpointerdown={keepPress} onmousedown={keepPress} onclick={defineSelection} data-testid="ebook-selection-define">{@render icon("search")}Define</button>
                            {/if}
                            <button type="button" class="etherpk-ebook-action" onpointerdown={keepPress} onmousedown={keepPress} onclick={copySelection} data-testid="ebook-selection-copy">{@render icon("copy")}{selectionCopied ? "Copied" : "Copy"}</button>
                        </div>
                    {/if}
                    {#if reader.pressedHighlight}
                        {@const pressed = reader.pressedHighlight}
                        <div class="etherpk-ebook-actions" role="group" aria-label="This highlight" data-testid="ebook-highlight-actions">
                            <button type="button" class="etherpk-ebook-action" onclick={() => reader.startNote(pressed)} data-testid="ebook-pressed-note">{@render icon("pdf-note")}{pressed.note ? "Note" : "Add note"}</button>
                            <button type="button" class="etherpk-ebook-action" onclick={() => copyToJournal(pressed)} data-testid="ebook-pressed-copy">{@render icon("todays-journal")}To journal</button>
                            <button type="button" class="etherpk-ebook-action" onclick={() => reader.removeHighlight(pressed.id)} data-testid="ebook-pressed-delete">{@render icon("trash")}Delete</button>
                        </div>
                    {/if}
                {/if}
            </div>
            {#if panelOpen}
                <EbookSidePanel {reader} {linkedFrom} onclose={togglePanel} onopendocument={(concept) => openConcept(concept)} oncopytojournal={copyToJournal} onexport={exportToPage} />
            {/if}
        </div>
        {#if inBar}{@render moreMenuBlock()}{/if}
        {#if settingsOpen && inBar}<EbookSettingsPanel {reader} above={true} onclose={() => (settingsOpen = false)} />{/if}
    {/if}
    {#if toast}
        <div class="etherpk-ebook-toast flex items-center gap-3 rounded-lg bg-neutral-900 px-3 py-2 text-sm text-white shadow-lg" role="status" data-testid="ebook-toast">
            <span>{toast}</span>
            {#if toastAction}
                <button type="button" class="font-medium underline" onclick={toastAction.run} data-testid="ebook-toast-action">{toastAction.label}</button>
            {/if}
        </div>
    {/if}
</div>

<style>
    .etherpk-ebook-reader {
        position: relative;
        min-height: 0;
    }
    .etherpk-ebook-reader :global(.ebook-tool) {
        display: inline-flex;
        flex-shrink: 0;
        align-items: center;
        justify-content: center;
        border-radius: 0.5rem;
        padding: 0.375rem;
        color: var(--gk-text-default);
    }
    @media (pointer: coarse) {
        .etherpk-ebook-reader :global(.ebook-tool) {
            padding: 0.625rem;
        }
    }
    @media (width < 40rem) {
        .etherpk-ebook-reader :global(.ebook-tool.max-sm\:hidden) {
            display: none;
        }
    }
    .etherpk-ebook-reader :global(.ebook-tool:hover:not(:disabled)) {
        background: var(--gk-surface-2);
    }
    .etherpk-ebook-reader :global(.ebook-tool[aria-pressed="true"]) {
        background: var(--gk-surface-2);
        color: var(--gk-accent);
    }
    .etherpk-ebook-reader :global(.ebook-tool:disabled) {
        color: var(--gk-text-subtle);
        cursor: default;
    }
    .etherpk-ebook-reader :global(.ebook-tool:focus-visible) {
        outline: 2px solid var(--gk-accent);
        outline-offset: -2px;
    }
    :global(.etherpk-ebook-bookmarked svg) {
        fill: currentColor;
    }
    .etherpk-ebook-divider {
        width: 1px;
        height: 1.25rem;
        margin: 0 0.25rem;
        background: var(--gk-surface-2);
    }
    .etherpk-ebook-top-bar-room {
        flex-shrink: 0;
        height: var(--top-bar-over, 0px);
    }
    .etherpk-ebook-more {
        position: absolute;
        top: 0.25rem;
        right: 0.5rem;
        z-index: 20;
        /* A set width: a row's words changing must not move the rows under the pointer. */
        width: min(20rem, calc(100% - 1rem));
        max-height: 70dvh;
        overflow-y: auto;
    }
    .etherpk-ebook-more--above {
        top: auto;
        bottom: 0.25rem;
    }
    /* Across the view, with the progress in its middle. Only the buttons take the pointer: the gaps are the page's. */
    .etherpk-ebook-nav {
        position: absolute;
        right: 0.75rem;
        bottom: calc(env(safe-area-inset-bottom) + 0.5rem);
        left: 0.75rem;
        z-index: 10;
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        pointer-events: none;
    }
    .etherpk-ebook-progress,
    .etherpk-ebook-reader :global(.ebook-tool.etherpk-ebook-edge) {
        pointer-events: auto;
        border: 1px solid var(--gk-border-strong, var(--gk-surface-2));
        background: var(--gk-surface-1);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
    }
    /* Only its buttons take the pointer, so a tap on the words reaches the page. */
    .etherpk-ebook-progress {
        grid-column: 2;
        display: flex;
        align-items: center;
        gap: 0.25rem;
        min-height: 2.5rem;
        max-width: calc(100vw - 8rem);
        padding: 0 0.25rem;
        border-radius: 0.75rem;
        pointer-events: none;
    }
    .etherpk-ebook-progress > :global(button) {
        pointer-events: auto;
    }
    .etherpk-ebook-back {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        min-height: 2rem;
        padding: 0 0.5rem;
        border-radius: 0.5rem;
        color: var(--gk-text-default);
        font-size: 0.875rem;
        font-weight: 500;
        white-space: nowrap;
    }
    .etherpk-ebook-back:hover {
        background: var(--gk-surface-2);
    }
    .etherpk-ebook-back:focus-visible {
        outline: 2px solid var(--gk-accent);
        outline-offset: 2px;
    }
    @media (pointer: coarse) {
        .etherpk-ebook-progress,
        .etherpk-ebook-back {
            min-height: 2.75rem;
        }
    }
    .etherpk-ebook-progress[data-gone] {
        visibility: hidden;
    }
    .etherpk-ebook-reader :global(.ebook-tool.etherpk-ebook-edge) {
        display: none;
        width: 2.75rem;
        height: 2.75rem;
        border-radius: 0.75rem;
    }
    .etherpk-ebook-reader :global(.ebook-tool.etherpk-ebook-edge:last-child) {
        grid-column: 3;
        justify-self: end;
    }
    @media (pointer: coarse), (width < 40rem) {
        .etherpk-ebook-reader :global(.ebook-tool.etherpk-ebook-edge) {
            display: inline-flex;
        }
        .etherpk-ebook-reader :global(.ebook-tool.etherpk-ebook-inner) {
            display: none;
        }
    }
    .etherpk-ebook-nav[data-buttons-gone] {
        visibility: hidden;
    }
    .etherpk-ebook-file-actions {
        position: absolute;
        right: 1.5rem;
        bottom: calc(env(safe-area-inset-bottom) + 0.5rem);
        z-index: 10;
        display: flex;
        gap: 0.25rem;
    }
    .etherpk-ebook-file-action {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 2.5rem;
        height: 2.5rem;
        border: 1px solid var(--gk-border-strong, var(--gk-surface-2));
        border-radius: 0.75rem;
        background: var(--gk-surface-1);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
        color: var(--gk-text-default);
    }
    .etherpk-ebook-file-action:hover {
        background: var(--gk-surface-2);
    }
    /* Equal columns, so that Copy turning into Copied moves no button. */
    .etherpk-ebook-actions {
        position: absolute;
        bottom: calc(env(safe-area-inset-bottom) + 3.5rem);
        left: 50%;
        transform: translateX(-50%);
        z-index: 11;
        display: grid;
        grid-auto-columns: 1fr;
        grid-auto-flow: column;
        gap: 0.125rem;
        padding: 0.25rem;
        border: 1px solid var(--gk-border-strong, var(--gk-surface-2));
        border-radius: 0.75rem;
        background: var(--gk-surface-1);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
    }
    .etherpk-ebook-action {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.375rem;
        min-height: 2.25rem;
        padding: 0 0.625rem;
        border-radius: 0.5rem;
        color: var(--gk-text-default);
        font-size: 0.875rem;
        font-weight: 500;
        white-space: nowrap;
    }
    .etherpk-ebook-action:hover {
        background: var(--gk-surface-2);
    }
    .etherpk-ebook-action:focus-visible {
        outline: 2px solid var(--gk-accent);
        outline-offset: -2px;
    }
    @media (pointer: coarse) {
        .etherpk-ebook-action {
            min-height: 2.75rem;
        }
    }
    .etherpk-ebook-turn-flash {
        position: absolute;
        top: 0;
        bottom: 0;
        z-index: 5;
        background: var(--gk-surface-2);
        opacity: 0;
        pointer-events: none;
        animation: etherpk-ebook-turn-flash 200ms ease-out both;
    }
    .etherpk-ebook-turn-flash[data-side="previous"] {
        left: 0;
    }
    .etherpk-ebook-turn-flash[data-side="next"] {
        right: 0;
    }
    @keyframes etherpk-ebook-turn-flash {
        0%,
        35% {
            opacity: 0.6;
        }
        100% {
            opacity: 0;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .etherpk-ebook-turn-flash {
            animation-duration: 1ms;
        }
    }
    .etherpk-ebook-toast {
        position: absolute;
        bottom: 1rem;
        left: 50%;
        transform: translateX(-50%);
        z-index: 30;
        max-width: calc(100% - 2rem);
    }
    :global(.etherpk-ebook-panel) {
        width: 20rem;
        flex-shrink: 0;
    }
    @media (max-width: 640px) {
        :global(.etherpk-ebook-panel) {
            position: absolute;
            inset: 0;
            z-index: 25;
            width: 100%;
        }
    }
</style>
