<script lang="ts">
    /**
     * One [[Agent Chat]], as the inline panel, the full window on a phone and the Agent Chats View
     * all draw it (ADR 0147). The chat itself lives in `AgentChats`, so the same chat open in two
     * places shows the same turns, and a message sent or a Stop pressed in one shows in both.
     *
     * - The header names the chat and holds what the next message goes with: the model, chosen from
     *   a list the person can filter, the Context Grant, and web search where the provider has it.
     * - Each turn shows the question, the documents that were sent with it, a chip for each
     *   document the model read under the whole graph, the answer as it streams, and its sources.
     * - Save turns the chat into a choice of turns, a box at each turn's top left, and writes the
     *   ticked ones into the home document as outline blocks. The ticks are kept while this panel is
     *   open: every turn not yet saved starts ticked, a new one arrives ticked, and a turn unticks
     *   itself once saved, so a second Save never writes it twice.
     * - Under the outline, the document, or the document and its links, Send works with the field
     *   empty, since what is sent may hold the question; the field says so.
     */
    import type { InlinePanel } from "@appsoftwareltd/etherpk-extension-api";
    import { SvelteMap } from "svelte/reactivity";
    import type { Attachment } from "svelte/attachments";
    import { untrack } from "svelte";

    import type { AgentChats } from "../chat/chats.svelte";
    import { type ChatImage, composerPlaceholder, GRANT_HINTS, GRANT_LABELS, type GrantLevel, newId, questionText, type Turn } from "../chat/model";
    import { PROVIDERS } from "../providers/catalogue";
    import Listbox from "./Listbox.svelte";
    import Markdown from "./Markdown.svelte";
    import ModelCombobox, { type ModelGroup } from "./ModelCombobox.svelte";
    import RobotIcon from "./RobotIcon.svelte";

    const {
        chats,
        chatId,
        where,
        panel = null,
        openDocument,
        openSettings,
        onOpenInView,
        onClose,
        saveTarget,
        onSaved,
        autofocus = false,
    }: {
        chats: AgentChats;
        chatId: string;
        /** Where the chat is drawn, which decides its header's buttons. */
        where: "inline" | "window" | "view";
        /** The inline panel the chat sits in, through which Save writes. */
        panel?: InlinePanel | null;
        openDocument: (name: string) => void;
        openSettings: () => void;
        /** Inline: show the chat in the Agent Chats View. */
        onOpenInView?: () => void;
        /** Close the inline panel, or go back to the list in the view. */
        onClose?: () => void;
        /** Where a Save from the view or the window writes, found or opened when asked. */
        saveTarget?: () => Promise<InlinePanel | null>;
        /** After a Save landed: on a phone, back to the document. */
        onSaved?: () => void;
        autofocus?: boolean;
    } = $props();

    const chat = $derived(chats.get(chatId));
    const running = $derived(chats.isRunning(chatId));
    const connection = $derived(chat ? chats.connectionOf(chat) : null);
    const model = $derived(chat ? chats.modelInfo(chat) : null);
    const orphaned = $derived(chat ? chats.isOrphaned(chat) : false);
    const blocked = $derived(chat ? chats.cannotSend(chat) : null);
    const takesImages = $derived(model?.images ?? connection?.provider !== "local");

    // Every connection's model list, asked for as the chat shows and again when the connections
    // change, so the picker can offer them all. Fetching is the side effect here, not derived state.
    $effect(() => {
        void chats.settings.connections.length;
        untrack(() => chats.loadModels());
    });

    let draft = $state("");
    let images = $state<ChatImage[]>([]);
    /** A note about the composer, such as an image the model cannot take. */
    let composerNote = $state<string | null>(null);
    /** What just happened, said once to a screen reader and shown under the header. */
    let notice = $state<string | null>(null);
    // A notice confirms something the person can see (the saved block, the copied answer), so it
    // goes after a few seconds rather than taking the header's room for good.
    $effect(() => {
        if (!notice) return;
        const shown = notice;
        const timer = setTimeout(() => {
            if (notice === shown) notice = null;
        }, 8000);
        return () => clearTimeout(timer);
    });
    let saveMode = $state(false);
    let saveBusy = $state(false);
    /** How many of the saved turns' images are in the graph so far, while a Save adds them. */
    let saveProgress = $state<{ done: number; total: number } | null>(null);
    /** Each turn's tick as the person left it while this panel is open; a turn not in it is ticked unless saved. */
    const choices = new SvelteMap<string, boolean>();
    const isTicked = (turn: Turn) => choices.get(turn.id) ?? !turn.saved;
    /** The turns a Save can take: every one but a turn still being answered. */
    const pickable = $derived(chat ? chat.turns.filter((turn) => turn.status !== "streaming") : []);
    const tickedIds = $derived(pickable.filter(isTicked).map((turn) => turn.id));

    // ── The model, the grant and web search ──────────────────────────────────────────────────

    const modelOptions = $derived.by(() => {
        if (!chat) return [];
        return chats.settings.connections.map((candidate) => {
            const list = chats.models.get(candidate.id);
            const models = list?.status === "ready" ? list.models.filter((entry) => chat.grant !== "graph" || entry.tools) : [];
            // The chat's own model stays offered while its list loads or after it failed.
            const own = chat.connectionId === candidate.id && chat.modelId && !models.some((entry) => entry.id === chat.modelId) ? [{ id: chat.modelId, label: chat.modelId }] : [];
            return { connection: candidate, models: [...own, ...models], status: list?.status ?? "loading", error: list?.status === "failed" ? list.error : null };
        });
    });
    const modelError = $derived(modelOptions.find((group) => group.connection.id === chat?.connectionId)?.error ?? null);
    const selectedModel = $derived(chat?.connectionId && chat.modelId ? `${chat.connectionId}\n${chat.modelId}` : "");
    /** The models as the picker groups them: by connection, named only where there are several. */
    const modelGroups = $derived<ModelGroup[]>(
        modelOptions.map((group) => ({
            key: group.connection.id,
            label: modelOptions.length > 1 ? group.connection.name || PROVIDERS[group.connection.provider].label : null,
            status: group.status,
            models: group.models.map((entry) => ({ key: `${group.connection.id}\n${entry.id}`, label: entry.label, id: entry.id })),
        })),
    );
    const grantOptions = $derived(chat ? chats.grantsFor(chat).map((grant) => ({ value: grant, label: GRANT_LABELS[grant] })) : []);
    const fieldId = $props.id();

    function chooseModel(key: string) {
        const [connectionId, modelId] = key.split("\n");
        if (connectionId && modelId) chats.setModel(chatId, connectionId, modelId);
    }

    function chooseGrant(grant: GrantLevel) {
        chats.setGrant(chatId, grant);
    }

    // ── The transcript ───────────────────────────────────────────────────────────────────────

    let transcript = $state<HTMLElement | null>(null);
    /** Whether the person is at the bottom, so new text keeps them there; scrolled up, it leaves them be. */
    let following = true;

    function onScroll() {
        if (!transcript) return;
        following = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 32;
    }

    $effect(() => {
        // Follow the last turn as it grows.
        const last = chat?.turns.at(-1);
        void last?.answer;
        void last?.tools.length;
        void chat?.turns.length;
        if (transcript && following) untrack(() => transcript!.scrollTo({ top: transcript!.scrollHeight }));
    });

    /** A "Thinking" line for a turn with no text yet, shown only after a moment so it never flashes. */
    let slow = $state(false);
    $effect(() => {
        const waiting = running && (chat?.turns.at(-1)?.answer ?? "") === "";
        if (!waiting) {
            slow = false;
            return;
        }
        const timer = setTimeout(() => (slow = true), 400);
        return () => clearTimeout(timer);
    });

    function grantChanged(turns: Turn[], index: number): boolean {
        return index > 0 && turns[index - 1].grant !== turns[index].grant;
    }

    // ── The composer ─────────────────────────────────────────────────────────────────────────

    const focusComposer: Attachment<HTMLTextAreaElement> = (element) => {
        if (autofocus) requestAnimationFrame(() => element.focus({ preventScroll: true }));
    };

    let composer = $state<HTMLTextAreaElement | null>(null);

    /** The field grows with what is typed, to a limit, from the height of the buttons beside it. */
    function grow(event: Event) {
        const area = event.currentTarget as HTMLTextAreaElement;
        area.style.height = "auto";
        // The field is border-box: its scroll height leaves out the two borders.
        area.style.height = `${Math.min(area.scrollHeight + 2, 180)}px`;
    }

    function addImages(files: Iterable<File>) {
        const list = [...files].filter((file) => file.type.startsWith("image/"));
        if (list.length === 0) return false;
        if (!takesImages) {
            composerNote = `${model?.label ?? "This model"} does not take images. Choose a model that does to send a picture.`;
            return true;
        }
        composerNote = null;
        images = [...images, ...list.map((file) => ({ id: newId("image"), name: file.name || "image.png", blob: file }))];
        return true;
    }

    function onPaste(event: ClipboardEvent) {
        const files = event.clipboardData?.files;
        if (files && files.length > 0 && addImages(files)) event.preventDefault();
    }

    function onDrop(event: DragEvent) {
        const files = event.dataTransfer?.files;
        if (files && files.length > 0 && addImages(files)) event.preventDefault();
    }

    function removeImage(id: string) {
        images = images.filter((image) => image.id !== id);
    }

    function pickImages(event: Event) {
        const input = event.currentTarget as HTMLInputElement;
        if (input.files) addImages(input.files);
        input.value = "";
    }

    function send() {
        if (!chat || running || blocked) return;
        // Nothing typed where a prompt is needed: Send takes the person to the field rather than doing nothing.
        if (draft.trim() === "" && images.length === 0 && !chats.canSendEmpty(chat)) {
            composer?.focus();
            return;
        }
        const question = draft;
        const sending = images;
        draft = "";
        images = [];
        composerNote = null;
        following = true;
        void chats.send(chatId, question, sending);
    }

    function onKeydown(event: KeyboardEvent) {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            send();
        }
    }

    // ── Save ─────────────────────────────────────────────────────────────────────────────────

    function startSave() {
        if (!chat) return;
        saveMode = true;
        notice = null;
    }

    async function save() {
        if (!chat || saveBusy || tickedIds.length === 0) return;
        saveBusy = true;
        try {
            const target = where === "inline" && panel?.isOpen ? panel : ((await saveTarget?.()) ?? null);
            if (!target) {
                notice = `Could not open ${chat.home} to save into it. Open the document, then save again.`;
                return;
            }
            const saving = [...tickedIds];
            const count = saving.length;
            if (await chats.save(chatId, saving, target, (done, total) => (saveProgress = { done, total }))) {
                // Saved turns untick themselves, so the next Save offers only what is new.
                for (const id of saving) choices.set(id, false);
                notice = `Saved ${count} ${count === 1 ? "turn" : "turns"} into ${chat.home}.`;
                saveMode = false;
                onSaved?.();
            } else {
                notice = `Could not save into ${chat.home}: the document cannot be written just now.`;
            }
        } finally {
            saveBusy = false;
            saveProgress = null;
        }
    }

    function toggleTick(turn: Turn) {
        choices.set(turn.id, !isTicked(turn));
    }

    function tickAll(on: boolean) {
        for (const turn of pickable) choices.set(turn.id, on);
    }

    async function copyAnswer(turn: Turn) {
        try {
            await navigator.clipboard.writeText(turn.answer);
            notice = "Answer copied.";
        } catch {
            notice = "The browser did not allow copying. Select the answer to copy it.";
        }
    }
</script>

{#if chat}
    <section class="ac-chat" class:ac-chat--inline={where === "inline"} aria-label={`Agent Chat: ${chat.title}`} data-testid="agent-chat" data-chat-id={chat.id} data-where={where}>
        <header class="ac-header">
            <div class="ac-header-row">
                <RobotIcon class="size-4 text-(--gk-text-muted)" />
                <h3 class="ac-title" title={chat.title}>{chat.title}</h3>
                <div class="ac-actions">
                    {#if chat.turns.length > 0 && !saveMode}
                        <button type="button" class="ac-button ac-primary" onclick={startSave} disabled={running} data-testid="agent-chat-save">Save</button>
                    {/if}
                    {#if where === "inline" && onOpenInView}
                        <button type="button" class="ac-button" onclick={onOpenInView} data-testid="agent-chat-open-in-view">Open in side panel</button>
                    {/if}
                    {#if onClose}
                        <button type="button" class="ac-button ac-icon" onclick={onClose} aria-label={where === "view" ? "Back to all chats" : "Close the chat"} data-testid="agent-chat-close">
                            {#if where === "view"}<span aria-hidden="true">←</span>{:else}<span aria-hidden="true">×</span>{/if}
                        </button>
                    {/if}
                </div>
            </div>
            <div class="ac-controls">
                <div class="ac-field">
                    <label class="ac-label" for={`${fieldId}-model`}>Model</label>
                    <ModelCombobox
                        id={`${fieldId}-model`}
                        class="w-64 max-w-full @max-[48rem]:w-full"
                        groups={modelGroups}
                        value={selectedModel}
                        onChange={chooseModel}
                        disabled={running || chats.settings.connections.length === 0}
                        testid="agent-chat-model"
                    />
                </div>
                <div class="ac-field">
                    <span class="ac-label" id={`${fieldId}-context`}>Context</span>
                    <Listbox class="w-64 max-w-full @max-[48rem]:w-full" options={grantOptions} value={chat.grant} onChange={chooseGrant} labelledBy={`${fieldId}-context`} disabled={running} testid="agent-chat-grant" />
                </div>
                {#if chats.canSearchWeb(chat)}
                    <label class="ac-check" title="Each new chat starts as set in Settings, Agents, and this chat can change it.">
                        <input type="checkbox" checked={chat.webSearch} onchange={(event) => chats.setWebSearch(chatId, event.currentTarget.checked)} disabled={running} data-testid="agent-chat-web-search" />
                        <span>Search the web</span>
                    </label>
                {/if}
            </div>
            {#if modelError}
                <p class="ac-hint ac-warning" role="alert">
                    Could not list the models: {modelError}
                    <button type="button" class="ac-text-button" onclick={() => chat.connectionId && chats.modelsFor(chat.connectionId, { fresh: true })}>Try again</button>
                </p>
            {/if}
            {#if orphaned}
                <p class="ac-hint ac-warning" data-testid="agent-chat-orphaned">{chat.home} has been deleted. You can still read and continue this chat, but it can no longer read that document.</p>
            {/if}
            {#if notice}<p class="ac-hint" role="status" data-testid="agent-chat-notice">{notice}</p>{/if}
        </header>

        <div class="ac-transcript" bind:this={transcript} onscroll={onScroll} data-testid="agent-chat-transcript">
            {#if chat.turns.length === 0}
                <div class="ac-empty" data-testid="agent-chat-empty">
                    {#if chats.settings.connections.length === 0}
                        <p>To chat, add a model connection: your own key for Anthropic, OpenAI, Gemini or OpenRouter, or a model running on this computer.</p>
                        <button type="button" class="ac-button ac-primary" onclick={openSettings} data-testid="agent-chat-add-connection">Add a model connection</button>
                    {:else}
                        <!-- The robot says what this is; its words are for a screen reader. -->
                        <RobotIcon class="size-8 text-(--gk-text-muted)" />
                        <p class="ac-visually-hidden">Chat with your agent.</p>
                        <p class="ac-muted" data-testid="agent-chat-grant-hint">{GRANT_HINTS[chat.grant]}</p>
                        <p class="ac-muted">Chat turn data is only added to the document when you save it.</p>
                    {/if}
                </div>
            {/if}
            {#each chat.turns as turn, index (turn.id)}
                {#if grantChanged(chat.turns, index)}
                    <p class="ac-divider">Context now: {GRANT_LABELS[turn.grant]}</p>
                {/if}
                <article class="ac-turn" class:ac-turn--picking={saveMode} data-testid="agent-chat-turn" data-status={turn.status}>
                    {#if saveMode}
                        <label class="ac-tick">
                            <input type="checkbox" checked={isTicked(turn) && turn.status !== "streaming"} onchange={() => toggleTick(turn)} disabled={turn.status === "streaming"} data-testid="agent-chat-save-tick" />
                            <span class="ac-visually-hidden">Save this turn: {questionText(turn) || "an image"}</span>
                        </label>
                    {/if}
                    <div class="ac-turn-body">
                        <div class="ac-question-row">
                            <div class="ac-question" data-testid="agent-chat-question">
                                <p class="ac-question-text" class:ac-question-text--sent={turn.question.trim() === "" && turn.images.length === 0}>{questionText(turn)}</p>
                                {#if turn.images.length > 0}
                                    <p class="ac-muted">{turn.images.length === 1 ? "1 image" : `${turn.images.length} images`}</p>
                                {/if}
                            </div>
                        </div>
                        {#if turn.saved}
                            <p class="ac-badge" title="Saved into the document" data-testid="agent-chat-saved">
                                <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" class="size-4">
                                    <path
                                        fill-rule="evenodd"
                                        d="M3 3.5A1.5 1.5 0 0 1 4.5 2h6.879a1.5 1.5 0 0 1 1.06.44l4.122 4.12A1.5 1.5 0 0 1 17 7.622V16.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 16.5v-13Zm10.857 5.691a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 0 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z"
                                        clip-rule="evenodd"
                                    />
                                </svg>
                                <span class="ac-visually-hidden">Saved into the document</span>
                            </p>
                        {/if}
                        {#if turn.context?.unwritten}
                            <p class="ac-context" data-testid="agent-chat-context">{chat.home} has no text yet, so nothing of it was sent.</p>
                        {:else if turn.context && turn.context.included.length > 0}
                            <p class="ac-context" data-testid="agent-chat-context">
                                Sent with this question:
                                {#if turn.context.excerpt}the outline around this chat in{/if}
                                {#each turn.context.included as name, i (name)}<button type="button" class="ac-text-button" onclick={() => openDocument(name)}>{name}</button>{i < turn.context.included.length - 1 ? ", " : ""}{/each}
                                {#if turn.context.leftOut.length > 0}. Left out because they are too long: {turn.context.leftOut.join(", ")}{/if}
                            </p>
                        {/if}
                        {#if turn.tools.length > 0}
                            <ul class="ac-chips" aria-label="What the model read">
                                {#each turn.tools as tool (tool.id)}
                                    <li class="ac-chip" data-status={tool.status} data-testid="agent-chat-tool">
                                        <span aria-hidden="true">{tool.status === "running" ? "…" : tool.status === "done" ? "✓" : "!"}</span>
                                        {tool.summary}
                                    </li>
                                {/each}
                            </ul>
                        {/if}
                        <div class="ac-answer" data-testid="agent-chat-answer">
                            {#if turn.answer}
                                <Markdown markdown={turn.answer} {openDocument} />
                            {:else if turn.status === "streaming" && slow}
                                <p class="ac-muted ac-thinking" data-testid="agent-chat-thinking"><span class="ac-spinner" aria-hidden="true" data-testid="agent-chat-spinner"></span>Thinking…</p>
                            {/if}
                        </div>
                        {#if turn.sources.length > 0}
                            <p class="ac-sources">
                                Sources:
                                {#each turn.sources as source, i (source.url)}<a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>{i < turn.sources.length - 1 ? ", " : ""}{/each}
                            </p>
                        {/if}
                        {#if turn.status === "failed"}
                            <p class="ac-error" role="alert" data-testid="agent-chat-error">{turn.error ?? "The answer failed."}</p>
                        {:else if turn.status === "stopped"}
                            <p class="ac-muted" data-testid="agent-chat-stopped">Stopped.</p>
                        {/if}
                        <div class="ac-turn-meta">
                            <span class="ac-muted">{turn.modelLabel}</span>
                            {#if turn.status === "done" && turn.answer}
                                <button type="button" class="ac-text-button" onclick={() => copyAnswer(turn)}>Copy</button>
                            {/if}
                            {#if index === chat.turns.length - 1 && !running && (turn.status === "failed" || turn.status === "stopped" || turn.status === "done") && !saveMode}
                                <button type="button" class="ac-text-button" onclick={() => chats.retry(chatId)} data-testid="agent-chat-retry">{turn.status === "done" ? "Answer again" : "Retry"}</button>
                            {/if}
                        </div>
                    </div>
                </article>
            {/each}
        </div>

        {#if saveMode}
            <footer class="ac-composer ac-save">
                <p class="ac-hint">Choose the turns to save into {chat.home}.</p>
                <div class="ac-pick-actions">
                    <button type="button" class="ac-button" onclick={() => tickAll(true)} disabled={tickedIds.length === pickable.length} data-testid="agent-chat-select-all">Select all</button>
                    <button type="button" class="ac-button" onclick={() => tickAll(false)} disabled={tickedIds.length === 0} data-testid="agent-chat-deselect-all">Deselect all</button>
                </div>
                {#if saveProgress}
                    <div class="ac-progress" data-testid="agent-chat-save-progress">
                        <p class="ac-hint" role="status">Adding images to the graph: {saveProgress.done} of {saveProgress.total}</p>
                        <div
                            class="ac-progress-track"
                            role="progressbar"
                            aria-label="Images added to the graph"
                            aria-valuemin={0}
                            aria-valuemax={saveProgress.total}
                            aria-valuenow={saveProgress.done}
                        >
                            <div class="ac-progress-bar" style:width={`${Math.max(6, Math.round((saveProgress.done / saveProgress.total) * 100))}%`}></div>
                        </div>
                    </div>
                {/if}
                <div class="ac-save-actions">
                    <button type="button" class="ac-button ac-primary" onclick={save} aria-disabled={saveBusy || tickedIds.length === 0} aria-busy={saveBusy} data-testid="agent-chat-save-confirm">
                        {saveBusy ? "Saving…" : tickedIds.length === 1 ? "Save 1 turn" : `Save ${tickedIds.length} turns`}
                    </button>
                    <button type="button" class="ac-button" onclick={() => (saveMode = false)} data-testid="agent-chat-save-cancel">Cancel</button>
                </div>
            </footer>
        {:else}
            <footer class="ac-composer" ondragover={(event) => event.preventDefault()} ondrop={onDrop}>
                {#if images.length > 0}
                    <ul class="ac-attachments" aria-label="Images to send">
                        {#each images as image (image.id)}
                            <li class="ac-chip">
                                {image.name}
                                <button type="button" class="ac-text-button" onclick={() => removeImage(image.id)} aria-label={`Remove ${image.name}`}>Remove</button>
                            </li>
                        {/each}
                    </ul>
                {/if}
                <div class="ac-compose-row">
                    <textarea
                        class="ac-input"
                        rows="1"
                        bind:this={composer}
                        bind:value={draft}
                        oninput={grow}
                        onkeydown={onKeydown}
                        onpaste={onPaste}
                        placeholder={blocked ? "Add a model connection first" : composerPlaceholder(chats.sendingGrant(chat))}
                        aria-label="Message"
                        aria-describedby={`${chatId}-composer-keys${blocked || composerNote ? ` ${chatId}-composer-note` : ""}`}
                        data-testid="agent-chat-input"
                        {@attach focusComposer}
                    ></textarea>
                    {#if takesImages}
                        <label class="ac-button ac-attach" title="Add an image">
                            <input type="file" accept="image/*" multiple class="ac-visually-hidden" onchange={pickImages} />
                            <span aria-hidden="true">+</span><span class="ac-visually-hidden">Add an image</span>
                        </label>
                    {/if}
                    {#if running}
                        <button type="button" class="ac-button" onclick={() => chats.stop(chatId)} data-testid="agent-chat-stop">Stop</button>
                    {:else}
                        <button type="button" class="ac-button ac-primary" onclick={send} data-testid="agent-chat-send">Send</button>
                    {/if}
                </div>
                <p id={`${chatId}-composer-keys`} class="ac-visually-hidden">Enter sends. Shift and Enter start a new line.</p>
                {#if blocked || composerNote}
                    <p id={`${chatId}-composer-note`} class="ac-hint" data-testid="agent-chat-composer-note">{composerNote ?? blocked}</p>
                {/if}
            </footer>
        {/if}
    </section>
{:else}
    <p class="ac-muted ac-gone" role="status">This chat has been deleted.</p>
{/if}

<style>
    .ac-chat {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        background: var(--gk-surface-0);
        color: var(--gk-text-default);
        font-family: var(--gk-sans);
        font-size: 0.9375rem;
        /* Its own, not the editor's taller line height, which an inline panel would otherwise take. */
        line-height: 1.5;
        /* The header's controls lay out by the chat's own width, which a phone or the Sidebar narrows. */
        container-type: inline-size;
    }
    /* Drawn as the outliner's guide lines are (2px, the strong border colour), so the chat stands
       apart from the document around it. */
    .ac-chat--inline {
        border: 2px solid var(--gk-border-strong);
        border-radius: 0.75rem;
        overflow: hidden;
    }
    .ac-header {
        padding: 0.5rem 0.75rem;
        border-bottom: 1px solid var(--gk-border-soft);
        background: var(--gk-surface-1);
    }
    .ac-header-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }
    .ac-title {
        flex: 1;
        min-width: 0;
        margin: 0;
        font-size: 0.9375rem;
        font-weight: 600;
        color: var(--gk-text-strong);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .ac-actions {
        display: flex;
        gap: 0.375rem;
        flex-shrink: 0;
    }
    .ac-controls {
        display: flex;
        flex-wrap: wrap;
        gap: 0.375rem 0.75rem;
        margin-top: 0.375rem;
        align-items: center;
    }
    .ac-field {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        min-width: 0;
    }
    .ac-label {
        font-size: 0.875rem;
        color: var(--gk-text-muted);
    }
    .ac-check {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        font-size: 0.875rem;
    }
    /* Narrow, the labels and fields line up as a table: labels in one column, fields filling the
       other, and Search the web on a row of its own. */
    @container (width < 48rem) {
        .ac-controls {
            display: grid;
            grid-template-columns: auto minmax(0, 1fr);
            align-items: center;
            gap: 0.375rem 0.625rem;
        }
        .ac-field {
            display: contents;
        }
        .ac-check {
            grid-column: 1 / -1;
        }
    }
    .ac-check input {
        accent-color: var(--gk-accent);
    }
    .ac-hint {
        margin: 0.375rem 0 0;
        font-size: 0.875rem;
        color: var(--gk-text-muted);
    }
    .ac-warning {
        color: var(--gk-text-warning);
    }
    .ac-transcript {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 0.75rem;
        display: flex;
        flex-direction: column;
        gap: 1rem;
        overscroll-behavior: contain;
    }
    .ac-empty {
        margin: auto 0;
        text-align: center;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.75rem;
    }
    .ac-empty p {
        margin: 0;
        max-width: 42rem;
    }
    .ac-muted {
        margin: 0;
        font-size: 0.875rem;
        color: var(--gk-text-muted);
    }
    /* Waiting for the answer's first words: a turning ring beside the line, still under reduced motion. */
    .ac-thinking {
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }
    .ac-spinner {
        flex-shrink: 0;
        width: 0.875rem;
        height: 0.875rem;
        border-radius: 999px;
        border: 2px solid var(--gk-border-strong);
        border-top-color: var(--gk-accent);
        animation: ac-spin 0.8s linear infinite;
    }
    @keyframes ac-spin {
        to {
            transform: rotate(360deg);
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .ac-spinner {
            animation: none;
        }
    }
    .ac-divider {
        margin: 0;
        text-align: center;
        font-size: 0.875rem;
        color: var(--gk-text-muted);
    }
    .ac-turn {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
    }
    /* Choosing turns to save: each turn's box at its top left, the turn beside it. */
    .ac-turn--picking {
        grid-template-columns: auto minmax(0, 1fr);
        column-gap: 0.5rem;
        align-items: start;
    }
    .ac-turn-body {
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
        min-width: 0;
    }
    .ac-question-row {
        display: flex;
        align-items: flex-start;
        gap: 0.5rem;
        justify-content: flex-end;
    }
    .ac-question {
        max-width: 85%;
        padding: 0.375rem 0.625rem;
        border-radius: 0.75rem;
        background: var(--gk-surface-2);
    }
    .ac-question-text {
        margin: 0;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
    }
    .ac-tick {
        display: flex;
        padding: 0.25rem;
        cursor: pointer;
    }
    .ac-tick input {
        width: 1rem;
        height: 1rem;
        margin: 0;
        accent-color: var(--gk-accent);
    }
    @media (pointer: coarse) {
        .ac-tick {
            padding: 0.625rem;
        }
        .ac-tick input {
            width: 1.25rem;
            height: 1.25rem;
        }
    }
    /* A turn sent with no prompt reads as what was sent, set apart from words the person wrote. */
    .ac-question-text--sent {
        font-style: italic;
        color: var(--gk-text-muted);
    }
    .ac-badge {
        align-self: flex-end;
        display: flex;
        margin: 0;
        color: var(--gk-accent);
    }
    .ac-context,
    .ac-sources {
        margin: 0;
        font-size: 0.875rem;
        color: var(--gk-text-muted);
    }
    .ac-sources a {
        color: var(--gk-accent);
    }
    /* What a Save is adding to the graph: a bar that fills image by image, and moves while one uploads. */
    .ac-progress {
        margin-top: 0.375rem;
    }
    .ac-progress-track {
        position: relative;
        height: 0.375rem;
        margin-top: 0.375rem;
        border-radius: 999px;
        background: var(--gk-surface-2);
        overflow: hidden;
    }
    .ac-progress-bar {
        height: 100%;
        border-radius: inherit;
        background: var(--gk-accent);
        transition: width 160ms ease-out;
        animation: ac-progress-pulse 1.2s ease-in-out infinite;
    }
    @keyframes ac-progress-pulse {
        50% {
            filter: brightness(1.25);
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .ac-progress-bar {
            transition: none;
            animation: none;
        }
    }
    .ac-chips,
    .ac-attachments {
        display: flex;
        flex-wrap: wrap;
        gap: 0.375rem;
        margin: 0;
        padding: 0;
        list-style: none;
    }
    /* The images about to be sent, clear of the field beneath them. */
    .ac-attachments {
        margin-bottom: 0.5rem;
    }
    .ac-chip {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        font-size: 0.875rem;
        padding: 0.0625rem 0.5rem;
        border-radius: 999px;
        border: 1px solid var(--gk-border-soft);
        color: var(--gk-text-muted);
        background: var(--gk-surface-1);
    }
    .ac-chip[data-status="failed"] {
        color: var(--gk-text-danger);
    }
    .ac-error {
        margin: 0;
        font-size: 0.875rem;
        color: var(--gk-text-danger);
        background: var(--gk-danger-surface);
        padding: 0.375rem 0.5rem;
        border-radius: 0.5rem;
    }
    .ac-turn-meta {
        display: flex;
        gap: 0.75rem;
        align-items: center;
    }
    .ac-composer {
        border-top: 1px solid var(--gk-border-soft);
        padding: 0.5rem 0.75rem 0.625rem;
        background: var(--gk-surface-0);
    }
    .ac-compose-row {
        display: flex;
        gap: 0.375rem;
        align-items: flex-end;
    }
    /* The field and the buttons beside it are one height, 2.5rem, until the field grows. */
    .ac-input {
        flex: 1;
        min-width: 0;
        box-sizing: border-box;
        height: 2.5rem;
        min-height: 2.5rem;
        resize: none;
        font: inherit;
        font-size: 0.9375rem;
        line-height: 1.5rem;
        padding: 0.4375rem 0.625rem;
        border: 1px solid var(--gk-border-strong);
        border-radius: 0.5rem;
        background: var(--gk-surface-0);
        color: var(--gk-text-default);
        max-height: 180px;
    }
    .ac-save-actions,
    .ac-pick-actions {
        display: flex;
        gap: 0.5rem;
        margin-top: 0.5rem;
    }
    .ac-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.25rem;
        font-size: 0.875rem;
        font-weight: 500;
        padding: 0.3125rem 0.625rem;
        min-height: 2rem;
        border-radius: 0.5rem;
        border: 1px solid var(--gk-border-strong);
        background: var(--gk-surface-0);
        color: var(--gk-text-default);
        cursor: pointer;
        white-space: nowrap;
    }
    /*
     * Every state keeps its text at 4.5:1 or more in both themes (ADR 0106): the plain button's text
     * on its surface, the primary's surface-0 text on the accent and on the accent's hover, and a
     * disabled button of either kind as muted text on a grey fill. Hover never reaches a disabled
     * button, so its text never sits on a colour it was not chosen for.
     */
    .ac-button:hover:not(:disabled, [aria-disabled="true"]) {
        background: var(--gk-surface-2);
    }
    .ac-button[aria-disabled="true"],
    .ac-button:disabled {
        cursor: not-allowed;
        color: var(--gk-text-subtle);
    }
    .ac-primary {
        background: var(--gk-accent);
        border-color: var(--gk-accent);
        color: var(--gk-surface-0);
    }
    .ac-primary:hover:not(:disabled, [aria-disabled="true"]) {
        background: var(--gk-accent-hover);
        border-color: var(--gk-accent-hover);
    }
    .ac-primary:disabled,
    .ac-primary[aria-disabled="true"] {
        background: var(--gk-surface-2);
        border-color: var(--gk-border-soft);
        color: var(--gk-text-muted);
    }
    .ac-icon {
        min-width: 2rem;
        padding: 0.3125rem;
        font-size: 1rem;
    }
    .ac-compose-row .ac-button {
        box-sizing: border-box;
        height: 2.5rem;
        min-height: 2.5rem;
        padding-inline: 0.875rem;
    }
    .ac-compose-row .ac-attach {
        width: 2.5rem;
        padding: 0;
        font-size: 1.125rem;
    }
    .ac-text-button {
        background: none;
        border: 0;
        padding: 0;
        font: inherit;
        font-size: 0.875rem;
        color: var(--gk-accent);
        cursor: pointer;
        text-decoration: underline;
        text-underline-offset: 2px;
    }
    .ac-button:focus-visible,
    .ac-text-button:focus-visible,
    .ac-input:focus-visible {
        outline: 2px solid var(--gk-accent);
        outline-offset: 1px;
    }
    .ac-visually-hidden {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
    }
    .ac-gone {
        padding: 1rem;
    }
</style>
