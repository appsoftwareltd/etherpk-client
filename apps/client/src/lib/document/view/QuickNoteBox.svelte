<script lang="ts" module>
    /** A file chosen for a note and not yet stored: what the box shows above the text. */
    export interface QuickNoteBoxFile {
        id: string;
        name: string;
        size: number;
        /** An object URL for a picture's thumbnail. A file that is not a picture has none. */
        previewUrl?: string;
    }
</script>

<script lang="ts">
    /**
     * The box a [[Quick Note]] is written in, on both surfaces that write one: the [[Quick Notes
     * View]] and the [[Share Target]]'s page (ADR 0186). One component, so the link button, the
     * name list and the file rows are in the same place and behave the same on each.
     *
     * A textarea, not an editor, so the three things the document editor does for a wikilink are
     * done over the text and the caret (`quick-note-link.ts`): `[[ ]]` wraps the selection or
     * inserts an empty pair, typing `[` over a selection wraps it, and while the caret is inside
     * an open `[[` the names that match show in a list directly under the text. The list is under
     * the box and not at the caret because a textarea gives no caret position, and under the box
     * is above a phone's keyboard.
     *
     * The box knows nothing about a graph. Its owner passes the names (`concepts`), and when it
     * has none to pass, the brackets stay as typed and `namesHint` says why no list shows. Files
     * are the owner's too: the box shows the ones it is given and reports the ones picked,
     * pasted or dropped. What Enter does outside the list is the owner's decision (`onkey`).
     */
    import { tick } from "svelte";

    import { formatBytes } from "@appsoftwareltd/etherpk-shared";

    import type { ConceptCandidate } from "../index-db";
    import { acceptQuickNoteLink, quickNoteLinkQuery, quickNoteLinkRows, surroundWithWikilink } from "../quick-note-link";
    import type { WikilinkCompletion } from "./augmentations/wikilink-complete-core";

    let {
        value = $bindable(""),
        testid,
        label,
        placeholder = "",
        maxlength,
        roomy = false,
        readonly = false,
        invalid = false,
        describedBy,
        concepts,
        namesHint = "",
        files = [],
        filesLoading = false,
        onaddfiles,
        onremovefile,
        oninput,
        onkey,
    }: {
        value?: string;
        /** The textarea's test id; the box's other parts are named from it. */
        testid: string;
        label: string;
        placeholder?: string;
        maxlength?: number;
        /** The share page's size: larger text and corners than the sidebar's box. */
        roomy?: boolean;
        readonly?: boolean;
        invalid?: boolean;
        describedBy?: string;
        /** The graph's names, read when the caret is in a link. Absent when they cannot be read. */
        concepts?: () => readonly ConceptCandidate[];
        /** Said under the box, in a link, when there are no names to offer. */
        namesHint?: string;
        files?: readonly QuickNoteBoxFile[];
        /** Files are on their way into `files`: a row holds their place so the text does not jump. */
        filesLoading?: boolean;
        /** Absent, the box takes no files: no attach button, and a paste or drop is left alone. */
        onaddfiles?: (files: File[]) => void;
        onremovefile?: (id: string) => void;
        oninput?: () => void;
        /** A key the list did not take. Return true when it was handled. */
        onkey?: (event: KeyboardEvent) => boolean;
    } = $props();

    let textarea = $state<HTMLTextAreaElement | undefined>();
    let picker = $state<HTMLInputElement | undefined>();
    /** The names offered for the link the caret is in; empty when it is in none. */
    let rows = $state.raw<WikilinkCompletion[]>([]);
    let active = $state(0);
    /** The caret is in a link and there are no names to read, so the hint shows instead of a list. */
    let unnamed = $state(false);
    /** A file is being dragged over the box. */
    let dropping = $state(false);

    const listId = $derived(`${testid}-names`);
    const open = $derived(rows.length > 0);

    export function focus() {
        textarea?.focus();
    }

    /** Work out the list from where the caret is now. Called after anything that moves it. */
    function refresh() {
        const box = textarea;
        if (!box || readonly || box.selectionStart !== box.selectionEnd) {
            rows = [];
            unnamed = false;
            return;
        }
        const inLink = quickNoteLinkQuery(box.value, box.selectionStart) !== null;
        const names = concepts?.();
        rows = inLink && names ? quickNoteLinkRows(names, box.value, box.selectionStart) : [];
        unnamed = inLink && !names;
        if (active >= rows.length) active = 0;
    }

    function close() {
        rows = [];
        unnamed = false;
    }

    /** Put `text` in the box with the caret at `[from, to)`, once the DOM holds the new text. */
    async function write(text: string, from: number, to: number) {
        value = text;
        oninput?.();
        await tick();
        textarea?.focus();
        textarea?.setSelectionRange(from, to);
        active = 0;
        refresh();
    }

    function link() {
        const box = textarea;
        if (!box || readonly) return;
        const next = surroundWithWikilink(box.value, box.selectionStart, box.selectionEnd);
        if (next) void write(next.text, next.from, next.to);
        else box.focus();
    }

    function accept(row: WikilinkCompletion) {
        const box = textarea;
        if (!box) return;
        const next = acceptQuickNoteLink(box.value, box.selectionStart, row.label);
        if (next) void write(next.text, next.caret, next.caret);
    }

    /** A key the open list takes: the arrows move the active row, Enter or Tab accepts it, Escape closes. */
    function listKey(event: KeyboardEvent): boolean {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            active = (active + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
            return true;
        }
        const accepts = event.key === "Tab" || (event.key === "Enter" && !event.ctrlKey && !event.metaKey);
        if (accepts) accept(rows[active]);
        else if (event.key === "Escape") close();
        return accepts || event.key === "Escape";
    }

    /** `[` typed over a selection wraps it, as the editor does. */
    function surroundKey(event: KeyboardEvent): boolean {
        const box = textarea;
        if (event.key !== "[" || !box || readonly || box.selectionStart === box.selectionEnd) return false;
        const next = surroundWithWikilink(box.value, box.selectionStart, box.selectionEnd);
        if (next) void write(next.text, next.from, next.to);
        return next !== null;
    }

    function onKeydown(event: KeyboardEvent) {
        if (event.isComposing) return;
        const taken = (open && listKey(event)) || surroundKey(event) || onkey?.(event) === true;
        if (taken) event.preventDefault();
    }

    function onInput() {
        active = 0;
        refresh();
        oninput?.();
    }

    function take(list: FileList | null | undefined): boolean {
        const picked = list ? [...list] : [];
        if (picked.length === 0 || !onaddfiles || readonly) return false;
        onaddfiles(picked);
        return true;
    }

    function onPaste(event: ClipboardEvent) {
        // Text on the clipboard pastes as text even when a picture rides along with it.
        if (event.clipboardData?.getData("text/plain")) return;
        if (take(event.clipboardData?.files)) event.preventDefault();
    }

    function onDrop(event: DragEvent) {
        dropping = false;
        if (take(event.dataTransfer?.files)) event.preventDefault();
    }

    function onDragOver(event: DragEvent) {
        if (!onaddfiles || readonly || !event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
        dropping = true;
    }

    function onPicked() {
        take(picker?.files);
        // The same file can be picked again after it was removed.
        if (picker) picker.value = "";
    }
</script>

<div
    class={[
        "overflow-hidden border bg-(--gk-surface-1) focus-within:border-(--gk-accent)",
        roomy ? "rounded-xl" : "rounded-md",
        invalid ? "border-(--gk-text-danger)" : dropping ? "border-(--gk-accent)" : roomy ? "border-(--gk-border-strong)" : "border-(--gk-border-soft)",
    ]}
    style:font-family="var(--gk-sans, 'Inter', system-ui, sans-serif)"
    ondragover={onDragOver}
    ondragleave={() => (dropping = false)}
    ondrop={onDrop}
    role="group"
    aria-label={label}
>
    {#if filesLoading && files.length === 0}
        <p class="flex h-16 items-center border-b border-(--gk-border-soft) px-3 text-sm text-(--gk-text-muted)" role="status" data-testid="{testid}-files-loading">
            Reading the file…
        </p>
    {/if}
    {#if files.length > 0}
        <ul class="divide-y divide-(--gk-border-soft) border-b border-(--gk-border-soft)" data-testid="{testid}-files" aria-label="Files">
            {#each files as file (file.id)}
                <li class="flex items-center gap-3 px-3 py-2" data-testid="{testid}-file">
                    {#if file.previewUrl}
                        <img src={file.previewUrl} alt="" class="size-12 shrink-0 rounded-md border border-(--gk-border-soft) object-cover" />
                    {:else}
                        <span class="flex size-12 shrink-0 items-center justify-center rounded-md border border-(--gk-border-soft) text-(--gk-text-muted)">
                            <svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                            </svg>
                        </span>
                    {/if}
                    <span class="min-w-0 flex-1">
                        <span class="block truncate text-sm text-(--gk-text-strong)">{file.name}</span>
                        <span class="block text-sm text-(--gk-text-muted)">{formatBytes(file.size)}</span>
                    </span>
                    {#if onremovefile && !readonly}
                        <button
                            type="button"
                            onclick={() => onremovefile(file.id)}
                            aria-label="Remove {file.name}"
                            title="Remove {file.name}"
                            data-testid="{testid}-file-remove"
                            class="shrink-0 rounded-md p-1.5 text-(--gk-text-muted) hover:bg-(--gk-surface-2) hover:text-(--gk-text-strong) pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                        >
                            <svg class="mx-auto size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M6 6l12 12M6 18L18 6" />
                            </svg>
                        </button>
                    {/if}
                </li>
            {/each}
        </ul>
    {/if}

    <textarea
        bind:this={textarea}
        bind:value
        oninput={onInput}
        onkeydown={onKeydown}
        onkeyup={(event) => {
            // The caret moved without the text changing.
            if (event.key.startsWith("Arrow") && !open) refresh();
            else if (event.key === "Home" || event.key === "End") refresh();
        }}
        onclick={refresh}
        onblur={close}
        onpaste={onPaste}
        data-testid={testid}
        aria-label={label}
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        {readonly}
        {placeholder}
        {maxlength}
        rows="3"
        spellcheck="false"
        class={[
            "block w-full resize-none overflow-y-auto border-0 bg-transparent text-(--gk-text-strong) field-sizing-content placeholder:text-(--gk-text-subtle) focus:outline-none",
            roomy ? "max-h-72 min-h-24 px-4 py-3 text-base" : "max-h-60 min-h-18 px-2 py-1.5 text-sm",
        ]}
    ></textarea>

    <!-- The list keeps focus in the text: a press on a row must not blur the box, which would
         close the list before the press lands. -->
    <ul
        id={listId}
        role="listbox"
        aria-label="Pages"
        hidden={!open}
        data-testid="{testid}-names"
        class="border-t border-(--gk-border-soft) bg-(--gk-surface-0) p-1"
        onpointerdown={(event) => event.preventDefault()}
    >
        {#each rows as row, index (row.kind + row.label)}
            <!-- svelte-ignore a11y_click_events_have_key_events (the textarea is the combobox: arrows move the active row and Enter accepts it) -->
            <li
                id="{listId}-{index}"
                role="option"
                aria-selected={index === active}
                data-testid="{testid}-name"
                data-kind={row.kind}
                class={[
                    "flex cursor-pointer items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-sm pointer-coarse:py-2.5",
                    index === active ? "bg-(--gk-selection) text-(--gk-text-strong)" : "text-(--gk-text-default) hover:bg-(--gk-surface-2)",
                ]}
                onclick={() => accept(row)}
            >
                <span class="min-w-0 truncate">{row.label}</span>
                <!-- On the selection fill the muted grey falls under 4.5:1 in the dark theme. -->
                <span class={["shrink-0", index === active ? "text-(--gk-text-default)" : "text-(--gk-text-muted)"]}
                    >{row.kind === "create" ? "New page" : row.detail}</span
                >
            </li>
        {/each}
    </ul>

    {#if !readonly}
        <div class="flex flex-wrap items-center gap-1.5 border-t border-(--gk-border-soft) px-1.5 py-1.5">
            <button
                type="button"
                onclick={link}
                onpointerdown={(event) => event.preventDefault()}
                data-testid="{testid}-link"
                aria-label="Link to a page"
                title="Link to a page"
                class="inline-flex items-center gap-1.5 rounded-md border border-(--gk-border-strong) bg-(--gk-surface-1) px-2.5 py-1 text-sm font-medium text-(--gk-text-default) hover:bg-(--gk-surface-2) hover:text-(--gk-text-strong) pointer-coarse:min-h-11"
            >
                <span class="font-mono font-semibold" aria-hidden="true">[[ ]]</span>
            </button>
            {#if onaddfiles}
                <button
                    type="button"
                    onclick={() => picker?.click()}
                    data-testid="{testid}-attach"
                    aria-label="Attach a file"
                    title="Attach a file"
                    class="inline-flex items-center gap-1.5 rounded-md border border-(--gk-border-strong) bg-(--gk-surface-1) px-2.5 py-1 text-sm font-medium text-(--gk-text-default) hover:bg-(--gk-surface-2) hover:text-(--gk-text-strong) pointer-coarse:min-h-11"
                >
                    <svg class="size-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                        <path stroke-linecap="round" stroke-linejoin="round" d="m18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94A3 3 0 1 1 19.5 7.372L8.552 18.32m.009-.01-.01.01m5.699-9.941-7.81 7.81a1.5 1.5 0 0 0 2.112 2.13" />
                    </svg>
                    Attach
                </button>
                <input bind:this={picker} type="file" multiple hidden onchange={onPicked} data-testid="{testid}-picker" />
            {/if}
            {#if unnamed && namesHint}
                <span class="ml-auto pr-1 text-sm text-(--gk-text-muted)" data-testid="{testid}-names-hint" role="status">{namesHint}</span>
            {/if}
        </div>
    {/if}
</div>
