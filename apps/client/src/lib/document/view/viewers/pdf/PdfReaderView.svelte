<script lang="ts">
    import { untrack } from "svelte";
    /**
     * One PDF, in its tab: the toolbar, the pages and the panels. Behaviour is in `PdfReader`; this is
     * what the person sees of it. Drawn by the app rather than framed, for the reasons in ADR 0055.
     */
    import { todayISO } from "#lib/document/calendar/month-grid-core.js";
    import { viewKey } from "#lib/layout/index.js";
    import { openConcept } from "#lib/document/open-concept.js";
    import { assetUsageNeedles } from "#lib/document/asset-delete.js";
    import { writeClipboardText } from "#lib/document/commands/clipboard-text.js";
    import { ANNOTATION_COLOURS, STROKE_WIDTHS, STROKE_WIDTH_NAMES, colourName } from "#lib/document/pdf/annotation-palette.js";
    import { appendToJournal, insertAfterReference, pdfLinkMarkdown, quoteMarkdown } from "#lib/document/pdf/journal-write.js";
    import { addPdfFavourite, isPdfFavourite, pdfFavouriteTarget, removePdfFavourite, subscribePdfFavourites } from "#lib/document/pdf/pdf-favourites.js";
    import { requestedPdfPage, subscribePdfPageRequests, takePdfOpenedFrom } from "#lib/document/pdf/page-requests.js";
    import type { PdfAnnotation } from "#lib/document/pdf/pdf-state.js";
    import { refusingPdfState } from "#lib/document/pdf/synced-pdf-state.js";
    import { formatBytes } from "@appsoftwareltd/etherpk-shared";
    import { COMMAND_BAR_KIND, type CommandBarItem, listCommandBarItems, tryGetActiveCommandRegistry, tryGetActiveContributionRegistry } from "#lib/surface/index.js";
    import { iconSvg } from "#lib/surface/icons.js";
    import { editorContext } from "#lib/document/index.js";
    import { registerFileSelection } from "#lib/document/file-in-front.js";
    import { createSubscriber } from "svelte/reactivity";
    import { offerCommandBarTools } from "#lib/surface/command-bar-tools.svelte.js";
    import { hideAppHeaderOnPhone } from "#lib/workspace/app-header.svelte.js";
    import { currentWorkspaceServices, workspaceService } from "#lib/workspace/workspace-services.js";

    import { tryGetActiveAssetStore } from "../../../active-asset-store";
    import { getActiveDocumentStore } from "../../../active-store";
    import { assetRefOf } from "./pdf-asset-ref";
    import PdfFindBar from "./PdfFindBar.svelte";
    import PdfPasswordPrompt from "./PdfPasswordPrompt.svelte";
    import { EDGE_TAP_SHARE, isTouchFirst, PdfReader } from "./pdf-reader.svelte";
    import { saveCopy } from "./pdf-save";
    import PdfSaveDialog, { type LinkPlace, type SaveRequest } from "./PdfSaveDialog.svelte";
    import PdfSidePanel from "./PdfSidePanel.svelte";
    import SignatureDialog from "./SignatureDialog.svelte";
    import type { PdfTool } from "./pdf-overlay";

    let { url, name, target }: { url: string; name: string; target: string } = $props();

    const service = workspaceService("pdf");
    const folderGraph = service?.backend === "folder";

    const reader = new PdfReader({
        graphId: currentWorkspaceServices()?.graphId ?? "unknown",
        target: () => target,
        name: () => displayName,
        openState: (hash) => service?.state.open(hash) ?? Promise.resolve(refusingPdfState("Changes to this PDF cannot be saved here.")),
    });

    let root = $state<HTMLDivElement>();
    let panelOpen = $state(false);
    let moreOpen = $state(false);
    let moreButton = $state<HTMLButtonElement>();
    let moreMenu = $state<HTMLDivElement>();
    let saveOpen = $state(false);
    let signatureOpen = $state(false);
    let includeAnnotations = $state(true);
    let printOptionsOpen = $state(false);
    let renameOpen = $state(false);
    let renameValue = $state("");
    let renameError = $state("");
    let deleteOpen = $state(false);
    let deleteBusy = $state(false);
    let deleteMessage = $state("");
    let closeGuardOpen = $state(false);
    let toast = $state("");
    let toastAction = $state<{ label: string; run: () => void } | null>(null);
    let linkedFrom = $state.raw<{ concept: string; references: number }[] | null>(null);
    let keptOnDevice = $state(false);
    let keepBusy = $state(false);
    let keepError = $state("");
    let digitalSignature = $state(false);
    let favourite = $state(false);
    /** The name it has now: a rename takes over from the one it opened with. */
    let displayName = $derived(name);
    let pageInput = $state("");

    const usesTouch = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
    const pdfRef = $derived(assetRefOf(target, displayName));
    const needles = $derived(assetUsageNeedles(pdfFavouriteTarget(target)));

    // Opening the file is an external effect, tied to this component's life: the wrapper re-creates
    // it when the tab is pointed at another file.
    $effect(() => {
        void reader.open(url);
        return () => {
            const layout = workspaceService("layout");
            const view = { kind: "asset", target } as const;
            reader.releaseSavedSignatures(() => layout?.isOpen(view) ?? false);
            void reader.destroy();
        };
    });

    $effect(() => {
        if (reader.status !== "ready" || !reader.pdf) return;
        void detectDigitalSignature(reader.pdf);
    });

    async function detectDigitalSignature(pdf: NonNullable<typeof reader.pdf>) {
        const fields = await pdf.getFieldObjects().catch(() => null);
        digitalSignature = Object.values(fields ?? {}).some((widgets) => (widgets as { type?: string }[]).some((widget) => widget.type === "signature"));
    }

    // A PDF joins Recents as it comes up, once its real name is known.
    $effect(() => {
        if (reader.status === "ready") workspaceService("recents")?.touchPdf(target, displayName);
    });

    // A rename on another device: a kept copy still carries the old name, so the server is asked.
    $effect(() => {
        if (reader.status !== "ready" || !service) return;
        void service.currentName?.(target).then((current) => {
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
            const page = requestedPdfPage(target);
            if (page !== null) reader.openPageFromLink(page);
            const from = takePdfOpenedFrom(target);
            if (from) reader.noteOpenedFrom(from);
        };
        answer();
        return subscribePdfPageRequests(answer);
    });

    $effect(() => {
        if (service?.backend !== "synced") return;
        void service.keptOnDevice(target).then((kept) => (keptOnDevice = kept));
    });

    // On a phone the pages take the height of the app's header. The phone's top bar stays, and leads
    // to the rest of the graph, where the header comes back.
    $effect(() => hideAppHeaderOnPhone());

    /** Where a Command Bar shows, the toolbar's buttons are on it, which saves the rows they took up here. */
    const inBar = $derived(editorContext.commandBarShowing);
    $effect(() => {
        if (!inBar) return;
        return offerCommandBarTools({ file: "pdf", strip: barStrip, pinned: barPinned });
    });

    /** A press on the Command Bar leaves a selection and the keyboard where they are, except that a note being typed closes. */
    function keepPress(event: Event) {
        if (!reader.noteEditor) event.preventDefault();
    }

    /** A tool turned on shows whole on the Command Bar, whose strip scrolls. */
    const scrollIntoBar = (tool: PdfTool) => (button: HTMLButtonElement) => {
        if (inBar && reader.tool === tool) button.scrollIntoView({ block: "nearest", inline: "nearest" });
    };

    // Full-screen on a phone goes in the browser's top layer: it alone sits over the phone's top bar,
    // whichever stacking context the tab is in. A manual popover closes only when told to.
    $effect(() => {
        const element = root;
        if (!element || typeof element.showPopover !== "function") return;
        if (reader.immersive) element.showPopover();
        else if (element.matches(":popover-open")) element.hidePopover();
    });

    // A signature nobody saved is in no file, so closing the tab asks first.
    $effect(() => {
        const layout = workspaceService("layout");
        if (!reader.hasUnsavedSignature || !layout) return;
        return layout.guardClose({ kind: "asset", target }, () => {
            closeGuardOpen = true;
            return false;
        });
    });

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

    const mountViewer = (container: HTMLDivElement) => {
        // Once for the tab's life. Mounting reads the reader's preferences, and an attachment would run
        // again when they change, drawing a second set of pages over the first.
        untrack(() => reader.mount(container, container.firstElementChild as HTMLDivElement));
        return undefined;
    };

    /** The tab is the one in front: it fills its space and the keyboard is in it, on the Command Bar that has its tools, or nowhere. */
    function holdsKeyboard(): boolean {
        if (!root || root.offsetParent === null) return false;
        const active = document.activeElement;
        return !active || active === document.body || root.contains(active) || (inBar && !!active.closest(".command-bar"));
    }

    function isTextEntry(element: Element | null): boolean {
        return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || (element instanceof HTMLElement && element.isContentEditable);
    }

    /** Find and print, which take over from the browser's own even in a text field. */
    function handleBrowserKeys(event: KeyboardEvent, key: string): boolean {
        if (key === "f") {
            event.preventDefault();
            event.stopPropagation();
            reader.openFind();
            return true;
        }
        if (key === "p") {
            event.preventDefault();
            printOptionsOpen = true;
            return true;
        }
        return false;
    }

    function closeMoreMenu() {
        moreOpen = false;
        moreButton?.focus();
    }

    /** The press on the pages that closed the menu: it did that and nothing else. */
    let swallowClick = false;

    /** A press anywhere else closes the menu. On the pages it goes no further: no page turns, no stroke starts. */
    function onWindowPointerdown(event: PointerEvent) {
        swallowClick = false;
        if (!moreOpen || !(event.target instanceof Node)) return;
        if (moreMenu?.contains(event.target) || moreButton?.contains(event.target)) return;
        moreOpen = false;
        if (root?.querySelector(".etherpk-pdf-scroller")?.contains(event.target)) {
            event.stopPropagation();
            swallowClick = true;
        }
    }

    /** The click that press ends in, which would open a note. A key's click (`detail` 0) is not one. */
    function onWindowClick(event: MouseEvent) {
        if (swallowClick && event.detail > 0) event.stopPropagation();
        swallowClick = false;
    }

    function onWindowKeydown(event: KeyboardEvent) {
        if (reader.status !== "ready" || !holdsKeyboard()) return;
        const mod = event.ctrlKey || event.metaKey;
        const key = event.key.toLowerCase();
        if (mod && handleBrowserKeys(event, key)) return;
        // Ahead of the text entry check, because the menu's rows are checkboxes.
        if (key === "escape" && moreOpen) return closeMoreMenu();
        if (isTextEntry(document.activeElement)) return;
        handleReaderKeys(event, mod, key);
    }

    /** The keys a reader answers with the Ctrl or Cmd key held. */
    const MOD_KEYS: Record<string, (event: KeyboardEvent) => void> = {
        z: (event) => (event.shiftKey ? reader.redo() : reader.undo()),
        "=": () => reader.zoomIn(),
        "+": () => reader.zoomIn(),
        "-": () => reader.zoomOut(),
    };
    /** The keys that turn a page when reading page by page. */
    const PAGE_KEYS: Record<string, () => void> = {
        pagedown: () => reader.nextPage(),
        pageup: () => reader.previousPage(),
    };

    function handleReaderKeys(event: KeyboardEvent, mod: boolean, key: string) {
        const action = mod ? MOD_KEYS[key] : reader.preferences.pageByPage ? PAGE_KEYS[key] : undefined;
        if (action) {
            event.preventDefault();
            action(event);
        } else if (key === "escape" && reader.tool !== "none") {
            reader.setTool("none");
        }
    }

    function commitPageInput() {
        const value = Number.parseInt(pageInput, 10);
        if (Number.isFinite(value)) reader.goToPage(value);
        pageInput = "";
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
    let toastTimer: ReturnType<typeof setTimeout> | undefined;

    let selectionCopied = $state(false);
    let selectionCopiedTimer: ReturnType<typeof setTimeout> | undefined;

    /** The words stay selected, so the same selection can be highlighted or copied again. */
    async function copySelection() {
        try {
            await writeClipboardText(reader.fileSelection().selectedText);
            selectionCopied = true;
            clearTimeout(selectionCopiedTimer);
            selectionCopiedTimer = setTimeout(() => (selectionCopied = false), 1500);
        } catch (error) {
            showToast(`That could not be copied (${error instanceof Error ? error.message : String(error)}). It is still selected, so try your browser's own Copy.`);
        }
    }

    async function copyToJournal(annotation: PdfAnnotation) {
        const store = getActiveDocumentStore();
        const quote = annotation.kind === "note" ? annotation.text : annotation.kind === "highlight" ? (annotation.text ?? "") : "";
        const day = todayISO();
        try {
            await appendToJournal(store, day, quoteMarkdown(quote, displayName.replace(/\.pdf$/i, ""), pdfRef, annotation.page));
            showToast(`Copied to today's journal.`, { label: "Open", run: () => openConcept(day) });
        } catch (error) {
            showToast(`That could not be copied to the journal (${error instanceof Error ? error.message : String(error)}).`);
        }
    }

    const linkPlaces = $derived<LinkPlace[]>([
        { concept: null, label: "Today's journal" },
        // The reference that opened this PDF leads, even before the index has caught up with it.
        ...[...new Set([...(reader.openedFrom ? [reader.openedFrom.concept] : []), ...(linkedFrom ?? []).map((document) => document.concept)])].map((concept) => ({
            concept,
            label: `After existing reference (${concept})`,
        })),
    ]);

    function openSave() {
        refreshLinks();
        saveOpen = true;
    }

    async function saveToDevice(bytes: Uint8Array<ArrayBuffer>, fileName: string) {
        const blob = new Blob([bytes], { type: "application/pdf" });
        if ("showSaveFilePicker" in window) {
            let handle: FileSystemFileHandle;
            try {
                handle = await window.showSaveFilePicker({ suggestedName: fileName, types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }] });
            } catch (error) {
                // Cancelled in the picker. The dialog stays open with everything as it was.
                if (error instanceof DOMException && error.name === "AbortError") throw new Error("Choose where to save the file, or untick “A file on this device”.");
                throw error;
            }
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            return;
        }
        const address = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = address;
        anchor.download = fileName;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(address), 60_000);
    }

    async function addCopyToGraph(bytes: Uint8Array<ArrayBuffer>, fileName: string, linkTo: string | null) {
        const assets = tryGetActiveAssetStore();
        const store = getActiveDocumentStore();
        if (!assets) throw new Error("This graph cannot hold a copy just now.");
        const saved = await assets.save({ name: fileName, bytes, type: "application/pdf" });
        const line = pdfLinkMarkdown(fileName.replace(/\.pdf$/i, ""), saved.ref);
        const near = linkTo === reader.openedFrom?.concept ? reader.openedFrom.line : undefined;
        const placed = linkTo !== null && (await insertAfterReference(store, linkTo, needles, line, near));
        const concept = placed ? linkTo! : await appendToJournal(store, todayISO(), `- ${line}\n`);
        showToast(placed ? `Added to the graph, after the link in ${concept}.` : "Added to the graph, with a link in today's journal.", { label: "Open", run: () => openConcept(concept) });
    }

    async function onSave(request: SaveRequest) {
        if (!reader.pdf) throw new Error("This PDF is not open.");
        let bytes: Uint8Array<ArrayBuffer>;
        try {
            bytes = await saveCopy({
                pdf: reader.pdf,
                annotations: reader.annotations,
                signatures: reader.signatures,
                flatten: request.flatten,
                password: request.password,
                currentPassword: reader.currentPassword,
            });
        } catch (error) {
            throw new Error(`The copy could not be made (${error instanceof Error ? error.message : String(error)}). Nothing was saved.`);
        }
        if (request.toFile) await saveToDevice(bytes, request.name);
        if (request.toGraph) await addCopyToGraph(bytes, request.name, request.linkTo);
        reader.markSignaturesSaved();
        reader.removePasswordAsked = false;
        if (!request.toGraph) showToast(`Saved ${request.name}.`);
    }

    function closeSave() {
        saveOpen = false;
        reader.removePasswordAsked = false;
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

    function onSignaturePlaced(blob: Blob, aspect: number) {
        signatureOpen = false;
        reader.placeSignature(URL.createObjectURL(blob), aspect);
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

    function showName(next: string) {
        displayName = next;
        workspaceService("retitleView")?.(viewKey({ kind: "asset", target }), next);
    }

    function openRename() {
        moreOpen = false;
        renameValue = displayName.replace(/\.pdf$/i, "");
        renameError = "";
        renameOpen = true;
    }

    async function submitRename(event: SubmitEvent) {
        event.preventDefault();
        if (!service) return;
        const next = renameValue.trim();
        if (next === "") {
            renameError = "Give the PDF a name.";
            return;
        }
        try {
            const renamed = await service.renameAsset(target, `${next.replace(/\.pdf$/i, "")}.pdf`, displayName);
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
    }

    async function confirmDelete() {
        if (!service || !reader.hash || deleteBusy) return;
        deleteBusy = true;
        try {
            const answer = await service.deleteAsset(target, reader.hash);
            if (answer.deleted) {
                deleteOpen = false;
                reader.discardSignatures();
                return;
            }
            deleteMessage = answer.reason === "linked" ? `It cannot be deleted while it is linked. Remove the links in ${answer.documents.join(", ")} first.` : answer.message;
        } catch (error) {
            deleteMessage = `It could not be deleted (${error instanceof Error ? error.message : String(error)}).`;
        } finally {
            deleteBusy = false;
        }
    }

    const fileSize = $derived(formatBytes(reader.status === "ready" ? (reader.bytes?.length ?? 0) : 0));

    /** Room for the file, by the browser's own estimate. A browser with no estimate is let try. */
    async function hasRoomFor(bytes: number): Promise<boolean> {
        const estimate = await navigator.storage?.estimate?.().catch(() => null);
        if (!estimate?.quota) return true;
        return estimate.quota - (estimate.usage ?? 0) > bytes * 1.1;
    }

    async function setKept(keep: boolean) {
        if (!service || keepBusy) return;
        keepBusy = true;
        keepError = "";
        try {
            if (keep && !keptOnDevice && !(await hasRoomFor(reader.bytes?.length ?? 0))) {
                throw new Error(`This device does not have room to keep ${fileSize}.`);
            }
            await service.setKeptOnDevice(target, keep);
            keptOnDevice = keep;
        } catch (error) {
            keepError = error instanceof Error ? error.message : String(error);
        } finally {
            keepBusy = false;
        }
    }

    function print() {
        printOptionsOpen = false;
        void reader.print(includeAnnotations);
    }

    const toolButtons: { tool: PdfTool; label: string; icon: string }[] = [
        { tool: "select", label: "Select text", icon: "pdf-select" },
        { tool: "highlight", label: "Highlight text", icon: "highlight" },
        { tool: "highlighter", label: "Freehand highlighter", icon: "pdf-highlighter" },
        { tool: "pen", label: "Pen", icon: "pdf-pen" },
        { tool: "note", label: "Typed note", icon: "pdf-note" },
        { tool: "eraser", label: "Eraser", icon: "pdf-eraser" },
    ];

    /** For a mouse. A finger already moves the page, so a touch screen and the phone's bar leave it out. */
    const shownTools = $derived<typeof toolButtons>(inBar || isTouchFirst() ? toolButtons : [{ tool: "hand", label: "Hand", icon: "pdf-hand" }, ...toolButtons]);

    /** Whether the buttons that turn the page float over this PDF. */
    const turningPages = $derived(reader.preferences.pageByPage && reader.pageCount > 1);

    // A pinned Command Bar button that names this type of file. An extension's come and go as it
    // starts or is switched off, so the list is read again as they do.
    const contributions = tryGetActiveContributionRegistry();
    const watchActions = createSubscriber((update) => contributions?.subscribe(COMMAND_BAR_KIND, update) ?? (() => {}));
    const fileActions = $derived.by<CommandBarItem[]>(() => {
        watchActions();
        if (!contributions || editorContext.commandBarShowing) return [];
        return listCommandBarItems(contributions).filter((item) => item.align === "end" && item.files?.includes("pdf"));
    });

    function runFileAction(action: CommandBarItem) {
        const commands = tryGetActiveCommandRegistry();
        if (commands?.has(action.command)) void commands.execute(action.command, action.args);
    }

    // What an extension can ask about this PDF while it is the file in front.
    $effect(() => registerFileSelection(target, () => reader.fileSelection()));

    /** The tools a page with no text cannot use, and why, for the button's tooltip. */
    const NEEDS_TEXT: Partial<Record<PdfTool, string>> = {
        select: "This page has no text to select.",
        highlight: "This page has no text to highlight. Use the Freehand highlighter.",
    };
    /** A tool already on stays on as the pages go by: this only stops it being turned on here. */
    const blockedHere = (tool: PdfTool) => reader.pageWithoutText && reader.tool !== tool && NEEDS_TEXT[tool] !== undefined;

    const showsColours = $derived(reader.tool === "highlight" || reader.tool === "highlighter" || reader.tool === "pen" || reader.tool === "note");
    const drawingTool = $derived(reader.tool === "pen" || reader.tool === "highlighter" ? reader.tool : null);
    /** A colour chosen with the picker, which no swatch stands for. */
    const usingCustom = $derived(!ANNOTATION_COLOURS.some(({ colour }) => colour === reader.toolColour));
    /** How thick each thickness button draws its sample, in screen pixels. */
    const WIDTH_SAMPLES = [1, 2, 3, 5];

    const toBody = (element: HTMLElement) => {
        document.body.append(element);
        return () => element.remove();
    };

    const noteAt = $derived(reader.noteEditor ? reader.noteEditorPosition() : null);
    const focusNote = (element: HTMLTextAreaElement) => element.focus();

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

    /** A place on the page, in the scroller's own coordinates, so the editor scrolls with it. */
    function noteStyle(at: NonNullable<typeof noteAt>): string {
        const page = at.pageElement;
        if (!page) return "";
        return `left:${page.offsetLeft + at.left * page.clientWidth}px;top:${page.offsetTop + at.top * page.clientHeight}px`;
    }

</script>

<svelte:window onkeydowncapture={onWindowKeydown} onpointerdowncapture={onWindowPointerdown} onclickcapture={onWindowClick} />

{#snippet icon(iconName: string)}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
    {@html iconSvg(iconName, { size: 18 })}
{/snippet}

{#snippet turnPage(direction: "previous" | "next", className: string)}
    {@const previous = direction === "previous"}
    {@const label = previous ? "Previous page" : "Next page"}
    <button type="button" class={className} aria-label={label} title={label} disabled={previous ? reader.page <= 1 : reader.page >= reader.pageCount} onclick={() => (previous ? reader.previousPage() : reader.nextPage())}>
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

{#snippet pageBox()}
    <span class="flex shrink-0 items-center gap-1 text-sm text-(--gk-text-muted)">
        <label class="sr-only" for="pdf-page-input">Page</label>
        <input
            id="pdf-page-input"
            class="w-12 rounded-md border border-gray-300 bg-(--gk-surface-0) px-1 py-0.5 text-center text-sm text-(--gk-text-default) dark:border-gray-700"
            inputmode="numeric"
            value={pageInput === "" ? reader.page : pageInput}
            oninput={(event) => (pageInput = event.currentTarget.value)}
            onblur={commitPageInput}
            onkeydown={(event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    commitPageInput();
                    event.currentTarget.blur();
                    if (inBar) closeMoreMenu();
                }
            }}
            data-testid="pdf-page-input"
        />
        <span data-testid="pdf-page-count">of {reader.pageCount}</span>
    </span>
{/snippet}

<!-- The buttons of the toolbar, in `button`'s style: the toolbar's own on a desktop, the Command Bar's where
     there is one. The page box and the zoom level are words, which the Command Bar has no room for. -->
{#snippet tools(button: string)}
    <button type="button" class={button} aria-label="Find in this PDF" title="Find in this PDF" onclick={() => reader.openFind()} data-testid="pdf-find-open">{@render icon("search")}</button>
    {@render turnPage("previous", `${button} max-sm:hidden`)}
    {#if !inBar}{@render pageBox()}{/if}
    {@render turnPage("next", `${button} max-sm:hidden`)}
    {#if !inBar}<span class="etherpk-pdf-divider max-sm:hidden"></span>{/if}
    <button type="button" class={`${button} max-sm:hidden`} aria-label="Zoom out" title="Zoom out" onclick={() => reader.zoomOut()} data-testid="pdf-zoom-out">{@render icon("zoom-out")}</button>
    {#if !inBar}<span class="w-12 shrink-0 text-center text-sm text-(--gk-text-muted) max-sm:hidden" data-testid="pdf-zoom-level">{Math.round(reader.scale * 100)}%</span>{/if}
    <button type="button" class={`${button} max-sm:hidden`} aria-label="Zoom in" title="Zoom in" onclick={() => reader.zoomIn()} data-testid="pdf-zoom-in">{@render icon("zoom-in")}</button>
    <button type="button" class={`${button} max-sm:hidden`} aria-label="Fit the width" title="Fit the width" onclick={() => reader.fitWidth()} data-testid="pdf-fit-width">{@render icon("fit")}</button>
    {#if !inBar}<span class="etherpk-pdf-divider"></span>{/if}
    {#each shownTools as entry (entry.tool)}
        <button type="button" class={button} aria-label={entry.label} title={blockedHere(entry.tool) ? NEEDS_TEXT[entry.tool] : entry.label} aria-pressed={reader.tool === entry.tool} disabled={blockedHere(entry.tool)} onclick={() => reader.setTool(entry.tool)} data-testid={`pdf-tool-${entry.tool}`} {@attach scrollIntoBar(entry.tool)}>{@render icon(entry.icon)}</button>
    {/each}
    <button type="button" class={button} aria-label="Undo" title="Undo" disabled={!reader.canUndo} onclick={() => reader.undo()} data-testid="pdf-undo">{@render icon("undo")}</button>
    <button type="button" class={button} aria-label="Redo" title="Redo" disabled={!reader.canRedo} onclick={() => reader.redo()} data-testid="pdf-redo">{@render icon("redo")}</button>
    {#if !inBar}<span class="etherpk-pdf-divider"></span>{/if}
    <button type="button" class={[button, reader.bookmarkHere && "etherpk-pdf-bookmarked"]} aria-label={reader.bookmarkHere ? "Remove the PDF Bookmark on this page" : "Add a PDF Bookmark"} title={reader.bookmarkHere ? "Remove the PDF Bookmark on this page" : "Add a PDF Bookmark"} aria-pressed={!!reader.bookmarkHere} onclick={() => reader.toggleBookmark()} data-testid="pdf-bookmark">{@render icon("bookmark")}</button>
    <button type="button" class={button} aria-label="Annotations and PDF Bookmarks" title="Annotations and PDF Bookmarks" aria-pressed={panelOpen} onclick={togglePanel} data-testid="pdf-panel-toggle">{@render icon("list")}</button>
    <button type="button" class={`${button} max-sm:hidden`} aria-label="Add your signature" title="Add your signature" onclick={() => (signatureOpen = true)} data-testid="pdf-sign">{@render icon("pdf-signature")}</button>
    <button type="button" class={button} aria-label="Save a copy" title="Save a copy" onclick={openSave} data-testid="pdf-save">{@render icon("pdf-save")}</button>
    <button type="button" class={`${button} max-sm:hidden`} aria-label="Print" title="Print" onclick={() => (printOptionsOpen = true)} data-testid="pdf-print">{@render icon("pdf-print")}</button>
{/snippet}

{#snippet moreToggle(button: string)}
    <button type="button" class={button} bind:this={moreButton} aria-label="More" title="More" aria-expanded={moreOpen} onpointerdown={inBar ? keepPress : undefined} onmousedown={inBar ? keepPress : undefined} onclick={() => (moreOpen = !moreOpen)} data-testid="pdf-more">{@render icon("more")}</button>
{/snippet}

{#snippet barStrip()}
    {#if reader.status === "ready" && !reader.immersive}
        <div class="contents" role="toolbar" aria-label="PDF tools" tabindex="-1" onpointerdown={keepPress} onmousedown={keepPress} data-testid="pdf-toolbar">
            {@render tools("command-bar__btn")}
        </div>
    {/if}
{/snippet}

{#snippet barPinned()}
    {#if reader.status === "ready" && !reader.immersive}{@render moreToggle("command-bar__btn")}{/if}
{/snippet}

{#snippet moreMenuBlock()}
    {#if moreOpen}
        <!-- Against the toolbar however many rows it has wrapped to, or the Command Bar, and with no height
         of its own, so the menu opening moves nothing. -->
        <div class="relative h-0 shrink-0">
        <div bind:this={moreMenu} class={["etherpk-pdf-more flex flex-col gap-0.5 rounded-lg border border-(--gk-surface-2) bg-(--gk-surface-0) p-1 shadow-lg", inBar && "etherpk-pdf-more--above"]} role="group" aria-label="More for this PDF" data-testid="pdf-more-menu">
            <div class="flex items-center justify-between">
                <span class="px-2 text-sm font-medium text-(--gk-text-muted)">More</span>
                <button type="button" class="pdf-tool" aria-label="Close this menu" title="Close this menu" onclick={closeMoreMenu} data-testid="pdf-more-close">{@render icon("close")}</button>
            </div>
            {#if inBar}
                <!-- The page box lives here where the toolbar is on the Command Bar. -->
                <div class="flex items-center gap-2 px-2 py-1.5 text-sm text-(--gk-text-default)" data-testid="pdf-more-page">
                    <span aria-hidden="true">Page</span>
                    {@render pageBox()}
                </div>
            {/if}
            {@render toggleRow("Page by page", reader.preferences.pageByPage, "pdf-page-by-page", (next) => reader.setPageByPage(next))}
            {@render toggleRow("Crop margins", reader.cropOn, "pdf-crop", (next) => void reader.setCrop(next))}
            {@render toggleRow("Dark pages", reader.preferences.darkPages, "pdf-dark-pages", (next) => reader.setDarkPages(next))}
            {@render toggleRow("Pen pressure", reader.preferences.penPressure, "pdf-pen-pressure", (next) => reader.updatePreferences({ penPressure: next }))}
            {#if usesTouch}
                {@render toggleRow("Keep the screen on", reader.preferences.keepScreenOn, "pdf-keep-screen", (next) => reader.setKeepScreenOn(next))}
                {@render toggleRow("Draw with finger", reader.fingerDraws, "pdf-finger-draws", (next) => (reader.fingerDraws = next))}
            {/if}
            {#if service?.backend === "synced"}
                {@render toggleRow(`Keep on this device (${fileSize})`, keptOnDevice, "pdf-keep-on-device", (next) => void setKept(next))}
                {#if keepError}<p class="px-2 text-sm text-red-700 dark:text-red-400" role="alert" data-testid="pdf-keep-error">{keepError}</p>{/if}
            {/if}
            <hr class="my-0.5 border-(--gk-surface-2)" />
            <!-- A phone alone has this: anything wider keeps the app's chrome in place. -->
            <button type="button" class="rounded-lg px-2 py-1.5 text-left text-sm text-(--gk-text-default) hover:bg-(--gk-surface-2) sm:hidden" onclick={() => { moreOpen = false; reader.setImmersive(true); }} data-testid="pdf-full-screen">Full screen</button>
            <!-- On a phone these leave the toolbar, so the page keeps the room. -->
            <button type="button" class="rounded-lg px-2 py-1.5 text-left text-sm text-(--gk-text-default) hover:bg-(--gk-surface-2) sm:hidden" onclick={() => { moreOpen = false; signatureOpen = true; }} data-testid="pdf-more-sign">Add your signature</button>
            <button type="button" class="rounded-lg px-2 py-1.5 text-left text-sm text-(--gk-text-default) hover:bg-(--gk-surface-2) sm:hidden" onclick={() => { moreOpen = false; openSave(); }} data-testid="pdf-more-save">Save a copy</button>
            <button type="button" class="rounded-lg px-2 py-1.5 text-left text-sm text-(--gk-text-default) hover:bg-(--gk-surface-2) sm:hidden" onclick={() => { moreOpen = false; printOptionsOpen = true; }} data-testid="pdf-more-print">Print</button>
            <button type="button" class="rounded-lg px-2 py-1.5 text-left text-sm text-(--gk-text-default) hover:bg-(--gk-surface-2)" onclick={toggleFavourite} data-testid="pdf-favourite">{favourite ? "Remove from Favourites" : "Add to Favourites"}</button>
            <button type="button" class="rounded-lg px-2 py-1.5 text-left text-sm text-(--gk-text-default) hover:bg-(--gk-surface-2)" onclick={downloadOriginal} data-testid="pdf-download">Download the original</button>
            {#if service}
                <button type="button" class="rounded-lg px-2 py-1.5 text-left text-sm text-(--gk-text-default) hover:bg-(--gk-surface-2)" onclick={openRename} data-testid="pdf-rename">Rename…</button>
                <button type="button" class="rounded-lg px-2 py-1.5 text-left text-sm text-(--gk-text-default) hover:bg-(--gk-surface-2)" onclick={openDelete} data-testid="pdf-delete">Delete…</button>
            {/if}
        </div>
        </div>
    {/if}
{/snippet}

<div
    bind:this={root}
    popover="manual"
    class={["etherpk-pdf-reader flex h-full flex-col", reader.immersive && "etherpk-pdf-immersive", reader.preferences.darkPages && "etherpk-pdf-dark-pages"]}
    data-testid="pdf-asset-viewer"
    data-pages={reader.pageCount || undefined}
    data-hash={reader.hash ?? undefined}
>
    {#if reader.status === "error"}
        <div class="flex flex-1 items-center justify-center p-6 text-center">
            <p class="text-sm text-(--gk-text-muted)" data-testid="pdf-asset-error">{reader.errorMessage}</p>
        </div>
    {:else if reader.status === "password"}
        <PdfPasswordPrompt {name} wrong={reader.passwordWrong} {folderGraph} onsubmit={(password, removeIt) => reader.submitPassword(password, removeIt)} />
    {:else if reader.status === "opening"}
        <p class="p-6 text-center text-sm text-(--gk-text-muted)" role="status">Opening {name}…</p>
    {:else}
        {#if !reader.immersive && !inBar}
            <div class="etherpk-pdf-toolbar flex shrink-0 flex-wrap items-center gap-0.5 border-b border-(--gk-surface-2) bg-(--gk-surface-1) px-1 py-1" role="toolbar" aria-label="PDF tools" data-testid="pdf-toolbar">
                {@render tools("pdf-tool")}
                <div class="relative shrink-0">{@render moreToggle("pdf-tool")}</div>
            </div>
        {/if}
        {#if !inBar}{@render moreMenuBlock()}{/if}
        {#if renameOpen}
            <form class="flex flex-wrap items-center gap-2 border-b border-(--gk-surface-2) bg-(--gk-surface-1) p-2" onsubmit={submitRename} data-testid="pdf-rename-form">
                <label class="text-sm font-medium text-(--gk-text-default)" for="pdf-rename-input">Name</label>
                <!-- svelte-ignore a11y_autofocus -->
                <input id="pdf-rename-input" autofocus class="min-w-40 flex-1 rounded-lg border border-gray-300 bg-(--gk-surface-0) px-2 py-1 text-sm text-(--gk-text-default) dark:border-gray-700" bind:value={renameValue} aria-invalid={renameError !== ""} onkeydown={(event) => event.key === "Escape" && (renameOpen = false)} data-testid="pdf-rename-input" />
                <button type="submit" class="rounded-lg bg-(--gk-accent) px-3 py-1 text-sm font-medium text-(--gk-surface-0)" data-testid="pdf-rename-submit">Rename</button>
                <button type="button" class="rounded-lg border border-gray-300 px-3 py-1 text-sm text-(--gk-text-default) dark:border-gray-700" onclick={() => (renameOpen = false)}>Cancel</button>
                {#if renameError}<p class="w-full text-sm text-red-700 dark:text-red-400" role="alert" data-testid="pdf-rename-error">{renameError}</p>{/if}
            </form>
        {/if}
        {#if deleteOpen}
            <div class="flex flex-wrap items-center gap-2 border-b border-(--gk-surface-2) bg-(--gk-surface-1) p-2" role="alert" data-testid="pdf-delete-confirm">
                <p class="min-w-40 flex-1 text-sm text-(--gk-text-default)">
                    Delete {displayName}, permanently{reader.annotations.length > 0 ? `, with your ${reader.annotations.length} annotation${reader.annotations.length === 1 ? "" : "s"}` : ""}? This cannot be undone.
                </p>
                <button type="button" class="rounded-lg bg-red-700 px-3 py-1 text-sm font-medium text-white disabled:opacity-60" disabled={deleteBusy} onclick={confirmDelete} data-testid="pdf-delete-submit">Delete</button>
                <button type="button" class="rounded-lg border border-gray-300 px-3 py-1 text-sm text-(--gk-text-default) dark:border-gray-700" onclick={() => (deleteOpen = false)}>Cancel</button>
                {#if deleteMessage}<p class="w-full text-sm text-red-700 dark:text-red-400" data-testid="pdf-delete-message">{deleteMessage}</p>{/if}
            </div>
        {/if}
        {#if printOptionsOpen}
            <div class="flex flex-wrap items-center gap-3 border-b border-(--gk-surface-2) bg-(--gk-surface-1) p-2" data-testid="pdf-print-options">
                <label class="flex items-center gap-2 text-sm text-(--gk-text-default)">
                    <input type="checkbox" bind:checked={includeAnnotations} data-testid="pdf-print-annotations" />
                    Include annotations
                </label>
                <button type="button" class="rounded-lg bg-(--gk-accent) px-3 py-1 text-sm font-medium text-(--gk-surface-0)" onclick={print} data-testid="pdf-print-submit">Print</button>
                <button type="button" class="rounded-lg border border-gray-300 px-3 py-1 text-sm text-(--gk-text-default) dark:border-gray-700" onclick={() => (printOptionsOpen = false)}>Cancel</button>
            </div>
        {/if}
        {#if reader.printing}
            <p class="border-b border-(--gk-surface-2) bg-(--gk-surface-1) p-2 text-sm text-(--gk-text-default)" role="status" data-testid="pdf-print-progress">Preparing page {reader.printing.done} of {reader.printing.total} to print…</p>
        {/if}
        {#if reader.printError}
            <p class="border-b border-(--gk-surface-2) bg-(--gk-surface-1) p-2 text-sm text-red-700 dark:text-red-400" role="alert" data-testid="pdf-print-error">{reader.printError}</p>
        {/if}
        {#if reader.stateProblem}
            <p class="border-b border-(--gk-surface-2) bg-(--gk-surface-1) p-2 text-sm text-red-700 dark:text-red-400" role="alert" data-testid="pdf-state-problem">{reader.stateProblem}</p>
        {/if}
        {#if reader.signatures.length > 0}
            <p class="border-b border-(--gk-surface-2) bg-(--gk-surface-1) p-2 text-sm text-(--gk-text-default)" data-testid="pdf-signature-note">
                Drag your signature into place. It stays out of your graph, so use Save a copy to keep it. A signature drawn with the pen is saved like any drawing.
            </p>
        {/if}
        {#if closeGuardOpen}
            <div class="flex flex-wrap items-center gap-2 border-b border-(--gk-surface-2) bg-(--gk-surface-1) p-2" role="alert" data-testid="pdf-close-guard">
                <p class="min-w-40 flex-1 text-sm text-(--gk-text-default)">Your signature is not saved anywhere. Save a copy, or discard it.</p>
                <button type="button" class="rounded-lg bg-(--gk-accent) px-3 py-1 text-sm font-medium text-(--gk-surface-0)" onclick={() => { closeGuardOpen = false; openSave(); }}>Save a copy</button>
                <button type="button" class="rounded-lg border border-gray-300 px-3 py-1 text-sm text-(--gk-text-default) dark:border-gray-700" onclick={() => { closeGuardOpen = false; reader.discardSignatures(); }} data-testid="pdf-close-guard-discard">Discard</button>
            </div>
        {/if}
        {#if reader.findOpen}
            <PdfFindBar {reader} />
        {/if}
        <div class="relative flex min-h-0 flex-1">
            <div class="relative min-w-0 flex-1">
                <div
                    {@attach mountViewer}
                    class="etherpk-pdf-scroller absolute inset-0 overflow-auto"
                    style:cursor={reader.tool === "pen" || reader.tool === "highlighter" || reader.tool === "eraser" || reader.tool === "note" ? "crosshair" : undefined}
                    data-tool={reader.tool}
                    data-finger-draws={reader.fingerDraws || undefined}
                    data-testid="pdf-pages"
                >
                    <div class="pdfViewer"></div>
                    {#if reader.noteEditor && noteAt}
                        <textarea
                            {@attach focusNote}
                            class="etherpk-pdf-note-editor"
                            style={noteStyle(noteAt)}
                            aria-label="Note"
                            placeholder="Type a note"
                            value={reader.noteEditor.text}
                            onblur={(event) => reader.commitNote(event.currentTarget.value)}
                            onkeydown={onNoteKeydown}
                            data-testid="pdf-note-editor"
                        ></textarea>
                    {/if}
                </div>
                {#key reader.turnFlash}
                    {#if reader.turnFlash}
                        <!-- The side that turned the page, so a person sees how far a side reaches. It takes no touches. -->
                        <div
                            class="etherpk-pdf-turn-flash"
                            data-side={reader.turnFlash.side}
                            style:width="{EDGE_TAP_SHARE * 100}%"
                            aria-hidden="true"
                            data-testid="pdf-turn-flash"
                            onanimationend={() => (reader.turnFlash = null)}
                        ></div>
                    {/if}
                {/key}
                {#if reader.pageCount > 1 && !reader.immersive && (reader.preferences.pageByPage || inBar)}
                    <!-- Over the page, in the style of a document's floating buttons. A person can turn
                         the page without finding a key, a swipe or the edge of the screen. On a touch
                         screen or a phone the buttons move out to the edges of the view, near a thumb.
                         Where the toolbar is on the Command Bar the count is the only sign of the page in
                         view, in either mode. It shows when the page changes, and takes no touches. -->
                    <div class="etherpk-pdf-page-nav" data-in-bar={inBar || undefined} role="group" aria-label="Turn the page" data-testid="pdf-page-nav">
                        {#if turningPages}{@render turnPage("previous", "pdf-tool etherpk-pdf-page-edge")}{/if}
                        <div class="etherpk-pdf-page-progress" data-gone={(inBar && (!reader.pageCountShowing || reader.hasSelection)) || undefined} data-testid="pdf-page-progress">
                            {#if !inBar}{@render turnPage("previous", "pdf-tool etherpk-pdf-page-inner")}{/if}
                            <span class="px-1 text-sm whitespace-nowrap text-(--gk-text-default)">{reader.page} of {reader.pageCount}</span>
                            {#if !inBar}{@render turnPage("next", "pdf-tool etherpk-pdf-page-inner")}{/if}
                        </div>
                        {#if turningPages}{@render turnPage("next", "pdf-tool etherpk-pdf-page-edge")}{/if}
                    </div>
                {/if}
                {#if fileActions.length > 0 && !reader.immersive}
                    <!-- Level with the page controls. Where the layout has a Command Bar, these buttons are on it. -->
                    <div class="etherpk-pdf-file-actions" data-beside-next={turningPages || undefined}>
                        {#each fileActions as action (action.id)}
                            <button
                                type="button"
                                class="etherpk-pdf-file-action"
                                aria-label={action.label}
                                title={action.label}
                                onpointerdown={(event) => event.preventDefault()}
                                onmousedown={(event) => event.preventDefault()}
                                onclick={() => runFileAction(action)}
                                data-testid="pdf-file-action"
                                data-command={action.command}
                            >
                                <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
                                {@html iconSvg(action.icon, { size: 18 })}
                            </button>
                        {/each}
                    </div>
                {/if}
                {#if showsColours && !reader.immersive}
                    <!-- Over the page, so choosing a tool never moves the page under the pointer. -->
                    <!-- On a phone they would cover the top of the page, so they tuck to its right edge, behind a
                         button that shows the colour in hand and points to where they come out. -->
                    <div class="etherpk-pdf-tool-options" data-open={reader.toolOptionsOpen || undefined} data-testid="pdf-tool-options">
                        <button
                            type="button"
                            class="etherpk-pdf-tool-options-toggle"
                            aria-label="Colour and thickness"
                            title="Colour and thickness"
                            aria-expanded={reader.toolOptionsOpen}
                            aria-controls="pdf-tool-options-list"
                            onclick={() => (reader.toolOptionsOpen = !reader.toolOptionsOpen)}
                            data-testid="pdf-tool-options-toggle"
                        >
                            <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
                            {@html iconSvg(reader.toolOptionsOpen ? "pdf-page-next" : "pdf-page-previous")}
                            <span class="size-5 rounded-full border border-gray-400" style:background-color={reader.toolColour} data-testid="pdf-tool-options-colour"></span>
                        </button>
                        <div id="pdf-tool-options-list" class="etherpk-pdf-colours flex flex-wrap items-center justify-center gap-1 rounded-2xl border border-(--gk-surface-2) bg-(--gk-surface-0) p-1 shadow">
                        <div class="flex flex-wrap items-center justify-center gap-1" role="group" aria-label="Colour" data-testid="pdf-colours">
                            {#each ANNOTATION_COLOURS as { colour, label } (colour)}
                                {@const on = reader.toolColour === colour}
                                <button type="button" class={["size-6 rounded-full border pointer-coarse:size-8", on ? "border-(--gk-text-strong) ring-2 ring-(--gk-text-strong)" : "border-gray-400"]} style:background-color={colour} aria-label={label} title={label} aria-pressed={on} onclick={() => reader.pickColour(colour)}></button>
                            {/each}
                            <label class={["etherpk-pdf-custom-colour relative size-6 cursor-pointer rounded-full pointer-coarse:size-8", usingCustom && "ring-2 ring-(--gk-text-strong)"]} title={usingCustom ? `Custom colour, ${colourName(reader.toolColour)}` : "Custom colour"}>
                                <span class="absolute inset-1 rounded-full border border-(--gk-surface-0)" style:background-color={usingCustom ? reader.toolColour : reader.customColour}></span>
                                <input type="color" class="absolute inset-0 size-full cursor-pointer opacity-0" aria-label="Custom colour" value={usingCustom ? reader.toolColour : reader.customColour} oninput={(event) => reader.pickCustomColour(event.currentTarget.value)} data-testid="pdf-custom-colour" />
                            </label>
                        </div>
                        {#if drawingTool}
                            {@const tool = drawingTool}
                            <div class="flex items-center gap-1 sm:border-l sm:border-(--gk-surface-2) sm:pl-1" role="group" aria-label="Line thickness" data-testid="pdf-stroke-widths">
                                {#each STROKE_WIDTHS[tool] as width, index (width)}
                                    {@const on = reader.strokeWidth(tool) === width}
                                    <button type="button" class={["flex size-6 items-center justify-center rounded-md text-(--gk-text-default) pointer-coarse:size-8", on ? "bg-(--gk-surface-2) ring-2 ring-(--gk-text-strong)" : "hover:bg-(--gk-surface-2)"]} aria-label={STROKE_WIDTH_NAMES[index]} title={STROKE_WIDTH_NAMES[index]} aria-pressed={on} onclick={() => reader.setStrokeWidth(tool, width)} data-testid={`pdf-stroke-width-${index}`}>
                                        <span class="w-4 rounded-full bg-current" style:height={`${WIDTH_SAMPLES[index]}px`}></span>
                                    </button>
                                {/each}
                            </div>
                        {/if}
                        </div>
                    </div>
                {/if}
                {#if reader.hasSelection && reader.tool !== "highlight"}
                    <div class={["etherpk-pdf-selection-actions", turningPages && "etherpk-pdf-selection-actions--raised"]} role="group" aria-label="Selected text" data-testid="pdf-selection-actions">
                        <!-- A press here leaves the selection and the focus where they are, as the file actions' does. -->
                        <button type="button" class="etherpk-pdf-selection-action" onpointerdown={(event) => event.preventDefault()} onmousedown={(event) => event.preventDefault()} onclick={() => reader.highlightSelection()} data-testid="pdf-highlight-selection">{@render icon("highlight")}Highlight</button>
                        <button type="button" class="etherpk-pdf-selection-action" onpointerdown={(event) => event.preventDefault()} onmousedown={(event) => event.preventDefault()} onclick={copySelection} data-testid="pdf-copy-selection">{@render icon(selectionCopied ? "check" : "copy")}{selectionCopied ? "Copied" : "Copy"}</button>
                    </div>
                {/if}
            </div>
            {#if panelOpen}
                <PdfSidePanel {reader} {linkedFrom} onclose={togglePanel} onopendocument={(concept) => openConcept(concept)} oncopytojournal={copyToJournal} />
            {/if}
        </div>
        {#if inBar}{@render moreMenuBlock()}{/if}
        {#if reader.immersive}
            <button type="button" class="etherpk-pdf-page-chip flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-2 text-sm text-white" aria-label={`Leave full screen, page ${reader.page} of ${reader.pageCount}`} title="Leave full screen" onclick={() => reader.setImmersive(false)} data-testid="pdf-show-controls">
                {reader.page} of {reader.pageCount}
                {@render icon("pdf-full-screen-exit")}
            </button>
        {/if}
    {/if}
    {#if toast}
        <div class="etherpk-pdf-toast flex items-center gap-3 rounded-lg bg-gray-900 px-3 py-2 text-sm text-white shadow-lg" role="status" data-testid="pdf-toast">
            <span>{toast}</span>
            {#if toastAction}
                <button type="button" class="font-medium underline" onclick={toastAction.run} data-testid="pdf-toast-action">{toastAction.label}</button>
            {/if}
        </div>
    {/if}
</div>

<!-- Held at the top of the page: dockview's pane contains anything fixed inside it. -->
<div {@attach toBody}>
{#if signatureOpen}
    <SignatureDialog open={signatureOpen} usePressure={reader.preferences.penPressure} onclose={() => (signatureOpen = false)} onplace={onSignaturePlaced} />
{/if}
{#if reader.status === "ready"}
    <PdfSaveDialog
        open={saveOpen || reader.removePasswordAsked}
        name={displayName}
        annotated={reader.annotations.length > 0 || reader.hasFormValues()}
        signed={reader.signatures.length > 0}
        hasPassword={reader.protectedByPassword}
        startWithPasswordRemoved={reader.removePasswordAsked}
        {folderGraph}
        hasDigitalSignature={digitalSignature}
        {linkPlaces}
        defaultLink={reader.openedFrom?.concept ?? linkedFrom?.[0]?.concept ?? null}
        onclose={closeSave}
        onsave={onSave}
    />
{/if}
</div>

<style>
    .etherpk-pdf-reader :global(.pdf-tool) {
        display: inline-flex;
        flex-shrink: 0;
        align-items: center;
        justify-content: center;
        border-radius: 0.5rem;
        padding: 0.375rem;
        color: var(--gk-text-default);
    }
    @media (pointer: coarse) {
        .etherpk-pdf-reader :global(.pdf-tool) {
            padding: 0.625rem;
        }
    }
    /* The display above would beat Tailwind's utility, which sits in a lower layer. */
    @media (width < 40rem) {
        .etherpk-pdf-reader :global(.pdf-tool.max-sm\:hidden) {
            display: none;
        }
    }
    .etherpk-pdf-reader :global(.pdf-tool:hover:not(:disabled)) {
        background: var(--gk-surface-2);
    }
    .etherpk-pdf-reader :global(.pdf-tool[aria-pressed="true"]) {
        background: var(--gk-surface-2);
        color: var(--gk-accent);
        box-shadow: inset 0 0 0 1px var(--gk-accent);
    }
    /* A page with a PDF Bookmark: the icon filled in, as the ribbon on the page is. On the Command Bar too. */
    :global(.etherpk-pdf-bookmarked svg) {
        fill: currentColor;
    }
    .etherpk-pdf-reader :global(.pdf-tool:disabled) {
        color: var(--gk-text-subtle);
        cursor: default;
    }
    .etherpk-pdf-divider {
        margin-inline: 0.25rem;
        align-self: stretch;
        width: 1px;
        flex-shrink: 0;
        background: var(--gk-surface-2);
    }
    .etherpk-pdf-reader {
        position: relative;
        background: var(--gk-surface-2);
    }
    /* A phone reading: the PDF over the app's own chrome, which comes back with a tap. */
    .etherpk-pdf-immersive {
        position: fixed;
        inset: 0;
        z-index: var(--z-window, 40);
        margin: 0;
        border: 0;
        width: 100%;
        height: 100%;
        max-width: none;
        max-height: none;
        padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
    }
    /* A popover is hidden until shown. This one is the tab's own content until it goes full-screen. */
    .etherpk-pdf-reader[popover]:not(:popover-open) {
        display: flex;
        position: relative;
        inset: auto;
        margin: 0;
        padding: 0;
        border: 0;
        width: auto;
        max-width: none;
        max-height: none;
        overflow: visible;
    }
    .etherpk-pdf-more {
        position: absolute;
        top: 0.25rem;
        right: 0.5rem;
        z-index: 20;
        /* A set width: a row's words changing must not move the rows under the pointer. */
        width: min(20rem, calc(100% - 1rem));
        max-height: 70dvh;
        overflow-y: auto;
    }
    /* Up from the Command Bar, where its button is. */
    .etherpk-pdf-more--above {
        top: auto;
        bottom: 0.25rem;
    }
    .etherpk-pdf-tool-options {
        position: absolute;
        top: 0.5rem;
        left: 50%;
        transform: translateX(-50%);
        z-index: 10;
        width: max-content;
        max-width: calc(100% - 1rem);
    }
    .etherpk-pdf-tool-options-toggle {
        display: none;
    }
    @media (width < 40rem) {
        .etherpk-pdf-tool-options {
            right: 0;
            left: auto;
            transform: none;
            display: flex;
            flex-direction: row-reverse;
            align-items: flex-start;
            gap: 0.25rem;
            max-width: calc(100% - 0.75rem);
        }
        /* Held against the page's edge, as a tab to pull out. */
        .etherpk-pdf-tool-options-toggle {
            display: inline-flex;
            flex-shrink: 0;
            align-items: center;
            gap: 0.125rem;
            height: 2.75rem;
            padding: 0 0.5rem 0 0.25rem;
            border: 1px solid var(--gk-border-strong, var(--gk-surface-2));
            border-right: 0;
            border-radius: 0.75rem 0 0 0.75rem;
            background: var(--gk-surface-1);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
            color: var(--gk-text-default);
        }
        .etherpk-pdf-colours {
            min-width: 0;
        }
        .etherpk-pdf-tool-options:not([data-open]) .etherpk-pdf-colours {
            display: none;
        }
    }
    /* Reads as "any colour" with the current choice at its centre. */
    .etherpk-pdf-custom-colour {
        background: conic-gradient(#ef4444, #eab308, #22c55e, #06b6d4, #3b82f6, #a855f7, #ef4444);
    }
    .etherpk-pdf-custom-colour:focus-within {
        outline: 2px solid var(--gk-accent);
        outline-offset: 1px;
    }
    /* Equal columns, so that Copy turning into Copied moves neither button. */
    .etherpk-pdf-selection-actions {
        position: absolute;
        bottom: 1rem;
        left: 50%;
        transform: translateX(-50%);
        z-index: 10;
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
    /* Above the buttons that turn the page, which have this part of the view. */
    .etherpk-pdf-selection-actions--raised {
        bottom: calc(env(safe-area-inset-bottom) + 5.25rem);
    }
    .etherpk-pdf-selection-action {
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
    .etherpk-pdf-selection-action:hover {
        background: var(--gk-surface-2);
    }
    .etherpk-pdf-selection-action:focus-visible {
        outline: 2px solid var(--gk-accent);
        outline-offset: -2px;
    }
    @media (pointer: coarse) {
        .etherpk-pdf-selection-action {
            min-height: 2.75rem;
        }
    }
    .etherpk-pdf-file-actions {
        position: absolute;
        right: 1.5rem;
        bottom: calc(env(safe-area-inset-bottom) + 2rem);
        z-index: 10;
        display: flex;
        gap: 0.25rem;
    }
    .etherpk-pdf-file-action {
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
    .etherpk-pdf-file-action:hover {
        background: var(--gk-surface-2);
    }
    /* Across the view, with the count in its middle whether or not the edge buttons show. Lifted
       clear of a horizontal scrollbar. Only the buttons take the pointer: the gaps are the page's. */
    .etherpk-pdf-page-nav {
        position: absolute;
        right: 0.75rem;
        bottom: calc(env(safe-area-inset-bottom) + 2rem);
        left: 0.75rem;
        z-index: 10;
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        pointer-events: none;
    }
    /* As `EndOfDocument.svelte` draws a document's floating buttons. */
    .etherpk-pdf-page-progress,
    .etherpk-pdf-reader :global(.pdf-tool.etherpk-pdf-page-edge) {
        pointer-events: auto;
        border: 1px solid var(--gk-border-strong, var(--gk-surface-2));
        background: var(--gk-surface-1);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
    }
    .etherpk-pdf-page-progress {
        grid-column: 2;
        display: flex;
        align-items: center;
        gap: 0.25rem;
        min-height: 2.5rem;
        padding: 0 0.25rem;
        border-radius: 0.75rem;
    }
    .etherpk-pdf-reader :global(.pdf-tool.etherpk-pdf-page-edge) {
        display: none;
        width: 2.75rem;
        height: 2.75rem;
        border-radius: 0.75rem;
    }
    .etherpk-pdf-reader :global(.pdf-tool.etherpk-pdf-page-edge:last-child) {
        grid-column: 3;
        justify-self: end;
    }
    @media (pointer: coarse), (width < 40rem) {
        .etherpk-pdf-reader :global(.pdf-tool.etherpk-pdf-page-edge) {
            display: inline-flex;
        }
        .etherpk-pdf-reader :global(.pdf-tool.etherpk-pdf-page-inner) {
            display: none;
        }
        .etherpk-pdf-page-progress {
            min-height: 2.75rem;
            padding: 0 0.5rem;
        }
        .etherpk-pdf-file-action {
            width: 2.75rem;
            height: 2.75rem;
        }
        /* The next page button has this corner here, so these sit just left of it. */
        .etherpk-pdf-file-actions[data-beside-next] {
            right: calc(0.75rem + 2.75rem + 0.25rem);
        }
    }
    /* Where the toolbar is on the Command Bar: the buttons at the edges with a mouse too, because the
       count goes away, and the count passes a touch through to the page under it. */
    .etherpk-pdf-page-nav[data-in-bar] :global(.pdf-tool.etherpk-pdf-page-edge) {
        display: inline-flex;
    }
    .etherpk-pdf-page-nav[data-in-bar] .etherpk-pdf-page-progress {
        min-height: 2.75rem;
        padding: 0 0.5rem;
        pointer-events: none;
        transition:
            opacity 150ms ease-out,
            visibility 150ms;
    }
    .etherpk-pdf-page-nav[data-in-bar] .etherpk-pdf-page-progress[data-gone] {
        opacity: 0;
        visibility: hidden;
    }
    @media (prefers-reduced-motion: reduce) {
        .etherpk-pdf-page-nav[data-in-bar] .etherpk-pdf-page-progress {
            transition: none;
        }
    }
    /* Mid grey, because what is under it is a white page or a dark one whatever the theme. Under the
       page buttons. Taken away when the animation ends, which still runs with reduced motion, only
       without the fade. */
    .etherpk-pdf-turn-flash {
        position: absolute;
        top: 0;
        bottom: 0;
        z-index: 9;
        background: rgb(128 128 128 / 0.3);
        pointer-events: none;
        animation: etherpk-pdf-turn-flash 200ms ease-out both;
    }
    .etherpk-pdf-turn-flash[data-side="previous"] {
        left: 0;
    }
    .etherpk-pdf-turn-flash[data-side="next"] {
        right: 0;
    }
    @keyframes etherpk-pdf-turn-flash {
        0%,
        35% {
            opacity: 1;
        }
        100% {
            opacity: 0;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .etherpk-pdf-turn-flash {
            animation-timing-function: step-end;
        }
    }
    .etherpk-pdf-page-chip {
        position: absolute;
        bottom: calc(env(safe-area-inset-bottom) + 0.75rem);
        right: 0.75rem;
        z-index: 10;
    }
    .etherpk-pdf-toast {
        position: absolute;
        bottom: 1rem;
        left: 50%;
        transform: translateX(-50%);
        z-index: 30;
        max-width: calc(100% - 2rem);
    }
    :global(.etherpk-pdf-panel) {
        width: 20rem;
        flex-shrink: 0;
    }
    @media (max-width: 640px) {
        :global(.etherpk-pdf-panel) {
            position: absolute;
            inset: 0;
            width: 100%;
            z-index: 15;
        }
    }
    /* Finger scrolling and the reader's own pinch. The browser's pinch would scale the whole app. */
    .etherpk-pdf-scroller {
        touch-action: pan-x pan-y;
        background: var(--gk-surface-2);
    }
    /* A finger that draws: the browser must not take the same move for a scroll. Two fingers still
       zoom and move the page, through the reader's own handling (`pdf-pinch.ts`). */
    .etherpk-pdf-scroller[data-tool="hand"] {
        cursor: grab;
        user-select: none;
    }
    /* The drag sets this itself (`pdf-hand-pan.ts`). */
    :global(.etherpk-pdf-scroller[data-tool="hand"][data-panning]) {
        cursor: grabbing;
    }
    .etherpk-pdf-scroller[data-tool="hand"] :global(.textLayer) {
        pointer-events: none;
    }
    .etherpk-pdf-scroller[data-finger-draws]:is([data-tool="pen"], [data-tool="highlighter"], [data-tool="eraser"]) :global(.etherpk-pdf-overlay) {
        touch-action: none;
    }
    /* The same for a finger that selects text to highlight (`pdf-text-drag.ts`), with no overlay in the way. */
    .etherpk-pdf-scroller[data-finger-draws][data-tool="highlight"],
    .etherpk-pdf-scroller[data-tool="select"] {
        touch-action: none;
    }
    .etherpk-pdf-scroller[data-finger-draws][data-tool="highlight"] :global(.textLayer),
    .etherpk-pdf-scroller[data-tool="select"] :global(.textLayer) {
        -webkit-touch-callout: none;
    }
    .etherpk-pdf-scroller[data-tool="pen"] :global(.etherpk-pdf-overlay),
    .etherpk-pdf-scroller[data-tool="highlighter"] :global(.etherpk-pdf-overlay),
    .etherpk-pdf-scroller[data-tool="eraser"] :global(.etherpk-pdf-overlay),
    .etherpk-pdf-scroller[data-tool="note"] :global(.etherpk-pdf-overlay) {
        pointer-events: auto;
    }
    .etherpk-pdf-scroller :global(.pdfViewer .page) {
        box-shadow: var(--gk-shadow, 0 1px 4px rgb(0 0 0 / 0.25));
    }
    /* pdf.js numbers a form's fields upward in the page's stacking order, so a stacking context of
       their own keeps the later ones under what the person drew or placed. */
    .etherpk-pdf-scroller :global(.annotationLayer) {
        z-index: 1;
    }
    /* pdf.js tints a check box's own picture with a filter that floods its box, and the flood paints
       even while the tab is hidden behind another, over whatever is in front. The same tint as the
       background of the input, lifted above the picture, goes away with the tab. */
    .etherpk-pdf-scroller :global(.annotationLayer .buttonWidgetAnnotation [data-canvas-name]) {
        filter: none;
    }
    .etherpk-pdf-scroller :global(.annotationLayer .buttonWidgetAnnotation:is(.checkBox, .radioButton) input) {
        position: relative;
    }
    .etherpk-pdf-scroller :global(.annotationLayer .buttonWidgetAnnotation:is(.checkBox, .radioButton) input:not(:focus)) {
        background-image: var(--annotation-unfocused-field-background);
    }
    .etherpk-pdf-scroller :global(.etherpk-pdf-overlay) {
        position: absolute;
        inset: 0;
        z-index: 5;
        pointer-events: none;
    }
    .etherpk-pdf-scroller :global(.etherpk-pdf-svg) {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        overflow: visible;
        pointer-events: none;
    }
    .etherpk-pdf-scroller :global(.etherpk-pdf-svg [data-kind="highlight"]),
    .etherpk-pdf-scroller :global(.etherpk-pdf-svg [data-kind="highlighter"]) {
        mix-blend-mode: multiply;
    }
    .etherpk-pdf-dark-pages .etherpk-pdf-scroller :global(.etherpk-pdf-svg [data-kind="highlight"]),
    .etherpk-pdf-dark-pages .etherpk-pdf-scroller :global(.etherpk-pdf-svg [data-kind="highlighter"]) {
        mix-blend-mode: screen;
    }
    .etherpk-pdf-scroller :global(.etherpk-pdf-items) {
        position: absolute;
        inset: 0;
        pointer-events: none;
    }
    .etherpk-pdf-scroller :global(.etherpk-pdf-note) {
        position: absolute;
        pointer-events: auto;
        max-width: 60%;
        padding: 0.1em 0.25em;
        border-radius: 2px;
        background: rgb(255 251 200 / 0.92);
        color: var(--note-colour);
        font-family: Helvetica, Arial, sans-serif;
        font-size: calc(var(--note-size) * var(--total-scale-factor, 1) * 1px);
        line-height: 1.25;
        text-align: left;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        box-shadow: 0 0 0 1px rgb(0 0 0 / 0.15);
    }
    .etherpk-pdf-scroller :global(.etherpk-pdf-signature) {
        position: absolute;
        pointer-events: auto;
        cursor: move;
        touch-action: none;
        outline: 1px dashed var(--gk-accent);
    }
    .etherpk-pdf-scroller :global(.etherpk-pdf-signature img) {
        width: 100%;
        height: 100%;
        object-fit: contain;
    }
    .etherpk-pdf-scroller :global(.etherpk-pdf-signature-remove) {
        position: absolute;
        top: -0.9rem;
        right: -0.9rem;
        width: 1.75rem;
        height: 1.75rem;
        border: 1px solid var(--gk-border-strong, var(--gk-surface-2));
        border-radius: 9999px;
        background: var(--gk-surface-1);
        color: var(--gk-text-strong);
        font-size: 1rem;
        line-height: 1;
    }
    .etherpk-pdf-scroller :global(.etherpk-pdf-signature-resize) {
        position: absolute;
        right: -0.5rem;
        bottom: -0.5rem;
        width: 1rem;
        height: 1rem;
        border-radius: 9999px;
        background: var(--gk-accent);
        cursor: nwse-resize;
    }
    .etherpk-pdf-scroller :global(.etherpk-pdf-bookmark-flag) {
        position: absolute;
        top: 0;
        left: 0.75rem;
        width: 0.875rem;
        height: 1.375rem;
        /* The ribbon the editor draws on a bookmarked line. */
        background-color: var(--gk-accent);
        clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 72%, 0 100%);
        pointer-events: none;
    }
    .etherpk-pdf-note-editor {
        position: absolute;
        z-index: 20;
        width: min(18rem, 80%);
        min-height: 5rem;
        padding: 0.5rem;
        border: 1px solid var(--gk-accent);
        border-radius: 0.375rem;
        background: var(--gk-surface-0);
        color: var(--gk-text-default);
        font-size: 0.875rem;
    }
    /* Printing: only the prepared pages show. */
    :global(.etherpk-pdf-print) {
        display: none;
    }
    @media print {
        :global(body.etherpk-pdf-printing > *:not(.etherpk-pdf-print)) {
            display: none !important;
        }
        :global(body.etherpk-pdf-printing .etherpk-pdf-print) {
            display: block;
        }
        :global(.etherpk-pdf-print img) {
            display: block;
            break-after: page;
        }
    }
</style>
