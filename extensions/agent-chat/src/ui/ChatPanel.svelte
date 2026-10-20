<script lang="ts">
    /**
     * One [[Agent Chat]], as the inline panel, the full window on a phone and the Agent Chats View
     * all draw it (ADR 0147). The chat itself lives in `AgentChats`, so the same chat open in two
     * places shows the same turns, and a message sent or a Stop pressed in one shows in both.
     *
     * - The header names the chat and holds what the next message goes with: the model, chosen from
     *   a list the person can filter, the Context Grant, and web search where the provider has it.
     * - Each exchange shows the person's turn, the documents that were sent with it, a chip for each
     *   document the model read under the whole graph, the model's reasoning while it streams any,
     *   the answer as it streams, and its sources.
     * - Save turns the chat into a choice of turns, a box at the left of each, the person's and the
     *   model's apart, and writes the ticked ones as outline blocks: into the home document, or for
     *   a chat without a document at the end of today's Journal Entry. The ticks are kept while this
     *   panel is open: every turn not yet saved starts ticked, a new one arrives ticked, and a turn
     *   unticks itself once saved, so a second Save never writes it twice.
     * - Under the outline, the document, or the document and its links, Send works with the field
     *   empty, since what is sent may hold the question; the field says so.
     */
    import type { InlinePanel } from "@appsoftwareltd/etherpk-extension-api";
    import { SvelteMap } from "svelte/reactivity";
    import type { Attachment } from "svelte/attachments";
    import { tick, untrack } from "svelte";

    import type { AgentChats } from "../chat/chats.svelte";
    import { type ChatImage, composerPlaceholder, type Exchange, GRANT_HINTS, GRANT_LABELS, type GrantLevel, hasAnswer, newId, questionText, type SavePick } from "../chat/model";
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
        initialPrompt = "",
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
        /** What the message field starts with: the text of the line `/Agent` was typed on. Not sent until the person sends it. */
        initialPrompt?: string;
    } = $props();

    const chat = $derived(chats.get(chatId));
    const running = $derived(chats.isRunning(chatId));
    const connection = $derived(chat ? chats.connectionOf(chat) : null);
    const model = $derived(chat ? chats.modelInfo(chat) : null);
    const noDocument = $derived(chat ? chats.withoutDocument(chat) : false);
    const homeDeleted = $derived(chat ? chats.homeDeleted(chat) : false);
    /** Where a Save from this chat writes, as a sentence names it. */
    const destination = $derived(chat && !noDocument && chat.home !== null ? chat.home : "today's journal");
    const blocked = $derived(chat ? chats.cannotSend(chat) : null);
    const takesImages = $derived(model?.images ?? connection?.provider !== "local");

    // Every connection's model list, asked for as the chat shows and again when the connections
    // change, so the picker can offer them all. Fetching is the side effect here, not derived state.
    $effect(() => {
        void chats.settings.connections.length;
        untrack(() => chats.loadModels());
    });

    // The line's text, once, or what was typed here before the chat was closed: the field is the
    // person's from then on.
    let draft = $state(untrack(() => initialPrompt || chats.draftFor(chatId)));

    /** Keep what is typed, so the chat closed and opened again still has it. */
    function keepDraft(event: Event) {
        chats.keepDraft(chatId, (event.currentTarget as HTMLTextAreaElement).value);
    }

    /** The chat's own element, which takes the keyboard from a press on its text. */
    let section = $state<HTMLElement | null>(null);

    /**
     * Escape leaves the choice of turns to save, or else closes the chat, saving nothing: the chat
     * is kept on the device, and `/Agent` offers it again. Where the chat has no close of its own (a
     * phone's window), the window closes itself on Escape. A list open in the header takes the key
     * first and closes: this is Svelte's own handler, so it hears the key after the list's, and not
     * at all once the list has stopped it.
     */
    function onSectionKeydown(event: KeyboardEvent) {
        if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
        if (saveMode) {
            event.preventDefault();
            void leaveSave();
            return;
        }
        if (!onClose) return;
        event.preventDefault();
        onClose();
    }
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

    /** One turn a Save can keep: the person's question, or the model's answer to it. */
    type Side = "question" | "answer";
    interface Pickable {
        exchange: Exchange;
        side: Side;
    }
    /** Each turn's tick as the person left it while this panel is open; a turn not in it is ticked unless saved. */
    const choices = new SvelteMap<string, boolean>();
    const tickKey = (exchange: Exchange, side: Side) => `${exchange.id}:${side}`;
    const savedSide = (exchange: Exchange, side: Side) => (side === "question" ? exchange.questionSaved : exchange.answerSaved);
    const isTicked = (exchange: Exchange, side: Side) => choices.get(tickKey(exchange, side)) ?? !savedSide(exchange, side);
    /** The turns a Save can take: every question but one still being answered, and every answer that came. */
    const pickable = $derived<Pickable[]>(
        chat
            ? chat.exchanges.flatMap((exchange): Pickable[] =>
                  exchange.status === "streaming" ? [] : [{ exchange, side: "question" }, ...(hasAnswer(exchange) ? [{ exchange, side: "answer" as const }] : [])],
              )
            : [],
    );
    const ticked = $derived(pickable.filter((turn) => isTicked(turn.exchange, turn.side)));
    /** The ticked turns as a Save takes them, an exchange's two together. */
    const picks = $derived.by<SavePick[]>(() => {
        const byId = new Map<string, SavePick>();
        for (const turn of ticked) {
            const pick = byId.get(turn.exchange.id) ?? { id: turn.exchange.id, question: false, answer: false };
            pick[turn.side] = true;
            byId.set(turn.exchange.id, pick);
        }
        return [...byId.values()];
    });
    /** Whether the ticks are exactly `sides`: every turn of those sides, and none of the others. */
    const tickedOnly = (sides: readonly Side[]) => pickable.every((turn) => isTicked(turn.exchange, turn.side) === sides.includes(turn.side));

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
        // Follow the last exchange as it grows.
        const last = chat?.exchanges.at(-1);
        void last?.answer;
        void last?.reasoning;
        void last?.tools.length;
        void chat?.exchanges.length;
        if (transcript && following) untrack(() => transcript!.scrollTo({ top: transcript!.scrollHeight }));
    });

    /** A "Thinking" line for an answer with no text yet, shown only after a moment so it never flashes. */
    let slow = $state(false);
    $effect(() => {
        const waiting = running && (chat?.exchanges.at(-1)?.answer ?? "") === "";
        if (!waiting) {
            slow = false;
            return;
        }
        const timer = setTimeout(() => (slow = true), 400);
        return () => clearTimeout(timer);
    });

    function grantChanged(exchanges: Exchange[], index: number): boolean {
        return index > 0 && exchanges[index - 1].grant !== exchanges[index].grant;
    }

    // ── The composer ─────────────────────────────────────────────────────────────────────────

    const focusComposer: Attachment<HTMLTextAreaElement> = (element) => {
        requestAnimationFrame(() => {
            // A prompt the field starts with is as tall as its lines, with the caret after it.
            if (element.value !== "") fitHeight(element);
            if (!autofocus) return;
            element.focus({ preventScroll: true });
            element.setSelectionRange(element.value.length, element.value.length);
        });
    };

    let composer = $state<HTMLTextAreaElement | null>(null);

    /** The field grows with what is typed, to a limit, from the height of the buttons beside it. */
    function fitHeight(area: HTMLTextAreaElement) {
        area.style.height = "auto";
        // The field is border-box: its scroll height leaves out the two borders.
        area.style.height = `${Math.min(area.scrollHeight + 2, 180)}px`;
    }

    function grow(event: Event) {
        fitHeight(event.currentTarget as HTMLTextAreaElement);
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
        chats.keepDraft(chatId, "");
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

    /** Choose the turns to save, the keyboard on the Save that writes them. */
    async function startSave() {
        if (!chat) return;
        saveMode = true;
        notice = null;
        await tick();
        section?.querySelector<HTMLElement>('[data-testid="agent-chat-save-confirm"]')?.focus();
    }

    /** Back from choosing turns, the keyboard on the Save that started it. */
    async function leaveSave() {
        saveMode = false;
        await tick();
        section?.querySelector<HTMLElement>('[data-testid="agent-chat-save"]')?.focus();
    }

    async function save() {
        if (!chat || saveBusy || ticked.length === 0) return;
        saveBusy = true;
        // Named now: the place a Save goes is fixed when it starts.
        const into = destination;
        try {
            const target = where === "inline" && panel?.isOpen ? panel : ((await saveTarget?.()) ?? null);
            if (!target) {
                notice = `Could not open ${into} to save into it. Open it, then save again.`;
                return;
            }
            const saving = [...ticked];
            const count = saving.length;
            if (await chats.save(chatId, picks, target, (done, total) => (saveProgress = { done, total }))) {
                // Saved turns untick themselves, so the next Save offers only what is new.
                for (const turn of saving) choices.set(tickKey(turn.exchange, turn.side), false);
                notice = `Saved ${count} ${count === 1 ? "turn" : "turns"} into ${into}.`;
                saveMode = false;
                onSaved?.();
            } else {
                notice = `Could not save into ${into}: it cannot be written just now, or the turns would break its outline where the chat is. Open the chat on another line, then save again.`;
            }
        } finally {
            saveBusy = false;
            saveProgress = null;
        }
    }

    function toggleTick(exchange: Exchange, side: Side) {
        choices.set(tickKey(exchange, side), !isTicked(exchange, side));
    }

    /** Tick every turn of `sides` and untick the rest: All, None, Mine or the agent's. */
    function tickOnly(sides: readonly Side[]) {
        for (const turn of pickable) choices.set(tickKey(turn.exchange, turn.side), sides.includes(turn.side));
    }

    async function copyAnswer(exchange: Exchange) {
        try {
            await navigator.clipboard.writeText(exchange.answer);
            notice = "Answer copied.";
        } catch {
            notice = "The browser did not allow copying. Select the answer to copy it.";
        }
    }
</script>

{#snippet saveTick(exchange: Exchange, side: Side, label: string)}
    <label class="ac-tick">
        <input type="checkbox" class="gk-checkbox" checked={isTicked(exchange, side)} onchange={() => toggleTick(exchange, side)} data-testid="agent-chat-save-tick" data-side={side} />
        <span class="ac-visually-hidden">{label}</span>
    </label>
{/snippet}

{#snippet savedBadge()}
    <span class="ac-badge" title="Saved" data-testid="agent-chat-saved">
        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" class="size-4">
            <path
                fill-rule="evenodd"
                d="M3 3.5A1.5 1.5 0 0 1 4.5 2h6.879a1.5 1.5 0 0 1 1.06.44l4.122 4.12A1.5 1.5 0 0 1 17 7.622V16.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 16.5v-13Zm10.857 5.691a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 0 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z"
                clip-rule="evenodd"
            />
        </svg>
        <span class="ac-visually-hidden">Saved</span>
    </span>
{/snippet}

{#if chat}
    <!-- It takes the keyboard from a press on its text, so its text can be selected and Escape closes it. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape from anywhere in the chat: its own controls take every other key) -->
    <section
        class="ac-chat"
        class:ac-chat--inline={where === "inline"}
        aria-label={`Agent Chat: ${chat.title}`}
        data-testid="agent-chat"
        data-chat-id={chat.id}
        data-where={where}
        tabindex="-1"
        bind:this={section}
        onkeydown={onSectionKeydown}
    >
        <header class="ac-header">
            <div class="ac-header-row">
                <RobotIcon class="size-4 text-(--gk-text-muted)" />
                <h3 class="ac-title" title={chat.title}>{chat.title}</h3>
                <div class="ac-actions">
                    {#if chat.exchanges.length > 0 && !saveMode}
                        {#if noDocument}
                            <!-- A chat without a document saves at the end of today's journal: the calendar says where. -->
                            <button type="button" class="gk-button gk-button--primary ac-save-journal" onclick={startSave} disabled={running} aria-label="Save to today's journal" title="Save to the end of today's journal" data-testid="agent-chat-save">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="size-4">
                                    <path d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0V11.25A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" />
                                </svg>
                                Save
                            </button>
                        {:else}
                            <button type="button" class="gk-button gk-button--primary" onclick={startSave} disabled={running} data-testid="agent-chat-save">Save</button>
                        {/if}
                    {/if}
                    {#if where === "inline" && onOpenInView}
                        <button type="button" class="gk-button" onclick={onOpenInView} data-testid="agent-chat-open-in-view">Open in side panel</button>
                    {/if}
                    {#if onClose}
                        <button type="button" class="gk-icon-button ac-glyph" onclick={onClose} aria-label={where === "view" ? "Back to all chats" : "Close the chat"} data-testid="agent-chat-close">
                            {#if where === "view"}<span aria-hidden="true">←</span>{:else}<span aria-hidden="true">×</span>{/if}
                        </button>
                    {/if}
                </div>
            </div>
            <div class="ac-controls">
                <div class="ac-field">
                    <label class="gk-label" for={`${fieldId}-model`}>Model</label>
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
                    <span class="gk-label" id={`${fieldId}-context`}>Context</span>
                    <Listbox class="w-64 max-w-full @max-[48rem]:w-full" options={grantOptions} value={chat.grant} onChange={chooseGrant} labelledBy={`${fieldId}-context`} disabled={running} testid="agent-chat-grant" />
                </div>
                {#if chats.canSearchWeb(chat)}
                    <label class="gk-label ac-check" title="Each new chat starts as set in Settings, Agents, and this chat can change it.">
                        <input type="checkbox" class="gk-checkbox" checked={chat.webSearch} onchange={(event) => chats.setWebSearch(chatId, event.currentTarget.checked)} disabled={running} data-testid="agent-chat-web-search" />
                        <span>Search the web</span>
                    </label>
                {/if}
            </div>
            {#if modelError}
                <p class="gk-hint ac-hint ac-warning" role="alert">
                    Could not list the models: {modelError}
                    <button type="button" class="gk-link" onclick={() => chat.connectionId && chats.modelsFor(chat.connectionId, { fresh: true })}>Try again</button>
                </p>
            {/if}
            {#if homeDeleted}
                <p class="gk-hint ac-hint ac-warning" data-testid="agent-chat-orphaned">{chat.home} has been deleted. You can still read and continue this chat, but it can no longer read that document, and a Save goes to today's journal.</p>
            {/if}
            {#if notice}<p class="gk-hint ac-hint" role="status" data-testid="agent-chat-notice">{notice}</p>{/if}
        </header>

        <div class="ac-transcript" bind:this={transcript} onscroll={onScroll} data-testid="agent-chat-transcript">
            {#if chat.exchanges.length === 0}
                <div class="ac-empty" data-testid="agent-chat-empty">
                    {#if chats.settings.connections.length === 0}
                        <p>To chat, add a model connection: your own key for Anthropic, OpenAI, Gemini or OpenRouter, or a model running on this computer.</p>
                        <button type="button" class="gk-button gk-button--primary" onclick={openSettings} data-testid="agent-chat-add-connection">Add a model connection</button>
                    {:else}
                        <!-- The robot says what this is; its words are for a screen reader. -->
                        <RobotIcon class="size-8 text-(--gk-text-muted)" />
                        <p class="ac-visually-hidden">Chat with your agent.</p>
                        <p class="ac-muted" data-testid="agent-chat-grant-hint">{GRANT_HINTS[chat.grant]}</p>
                        <p class="ac-muted">{noDocument ? "Chat turn data is only added to today's journal when you save it." : "Chat turn data is only added to the document when you save it."}</p>
                    {/if}
                </div>
            {/if}
            {#each chat.exchanges as exchange, index (exchange.id)}
                {#if grantChanged(chat.exchanges, index)}
                    <p class="ac-divider">Context now: {GRANT_LABELS[exchange.grant]}</p>
                {/if}
                <article class="ac-exchange" data-testid="agent-chat-exchange" data-status={exchange.status}>
                    <div class="ac-turn" class:ac-turn--picking={saveMode} data-testid="agent-chat-turn" data-side="question">
                        {#if saveMode}{@render saveTick(exchange, "question", `Save your turn: ${questionText(exchange) || "an image"}`)}{/if}
                        <div class="ac-turn-body">
                            <div class="ac-question-row">
                                {#if exchange.questionSaved}{@render savedBadge()}{/if}
                                <div class="ac-question" data-testid="agent-chat-question">
                                    <p class="ac-question-text" class:ac-question-text--sent={exchange.question.trim() === "" && exchange.images.length === 0}>{questionText(exchange)}</p>
                                    {#if exchange.images.length > 0}
                                        <p class="ac-muted">{exchange.images.length === 1 ? "1 image" : `${exchange.images.length} images`}</p>
                                    {/if}
                                </div>
                            </div>
                            {#if exchange.context?.unwritten}
                                <p class="ac-context" data-testid="agent-chat-context">{chat.home} has no text yet, so nothing of it was sent.</p>
                            {:else if exchange.context && exchange.context.included.length > 0}
                                <p class="ac-context" data-testid="agent-chat-context">
                                    Sent with this question:
                                    {#if exchange.context.excerpt}the outline around this chat in{/if}
                                    {#each exchange.context.included as name, i (name)}<button type="button" class="gk-link" onclick={() => openDocument(name)}>{name}</button>{i < exchange.context.included.length - 1 ? ", " : ""}{/each}
                                    {#if exchange.context.leftOut.length > 0}. Left out because they are too long: {exchange.context.leftOut.join(", ")}{/if}
                                </p>
                            {/if}
                        </div>
                    </div>
                    <div class="ac-turn" class:ac-turn--picking={saveMode} data-testid="agent-chat-turn" data-side="answer">
                        {#if saveMode}
                            {#if hasAnswer(exchange)}
                                {@render saveTick(exchange, "answer", `Save the agent's answer to: ${questionText(exchange) || "an image"}`)}
                            {:else}
                                <span class="ac-tick ac-tick--none" aria-hidden="true"></span>
                            {/if}
                        {/if}
                        <div class="ac-turn-body">
                            {#if exchange.tools.length > 0}
                                <ul class="ac-chips" aria-label="What the model read">
                                    {#each exchange.tools as tool (tool.id)}
                                        <li class="ac-chip" data-status={tool.status} data-testid="agent-chat-tool">
                                            <span aria-hidden="true">{tool.status === "running" ? "…" : tool.status === "done" ? "✓" : "!"}</span>
                                            {tool.summary}
                                        </li>
                                    {/each}
                                </ul>
                            {/if}
                            {#if exchange.reasoning}
                                <!-- Open while the model thinks, folded once the answer starts; the person can open it again. -->
                                <details class="ac-reasoning" open={exchange.status === "streaming" && exchange.answer === ""} data-testid="agent-chat-reasoning">
                                    <summary>
                                        {#if exchange.status === "streaming" && exchange.answer === ""}<span class="ac-spinner" aria-hidden="true"></span>Thinking…{:else}What the model thought{/if}
                                    </summary>
                                    <p class="ac-reasoning-text">{exchange.reasoning}</p>
                                </details>
                            {/if}
                            <div class="ac-answer" data-testid="agent-chat-answer">
                                {#if exchange.answer}
                                    <Markdown markdown={exchange.answer} {openDocument} />
                                {:else if exchange.status === "streaming" && slow && !exchange.reasoning}
                                    <p class="ac-muted ac-thinking" data-testid="agent-chat-thinking"><span class="ac-spinner" aria-hidden="true" data-testid="agent-chat-spinner"></span>Thinking…</p>
                                {/if}
                            </div>
                            {#if exchange.sources.length > 0}
                                <p class="ac-sources">
                                    Sources:
                                    {#each exchange.sources as source, i (source.url)}<a class="gk-link" href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>{i < exchange.sources.length - 1 ? ", " : ""}{/each}
                                </p>
                            {/if}
                            {#if exchange.status === "failed"}
                                <p class="ac-error" role="alert" data-testid="agent-chat-error">{exchange.error ?? "The answer failed."}</p>
                            {:else if exchange.status === "stopped"}
                                <p class="ac-muted" data-testid="agent-chat-stopped">Stopped.</p>
                            {/if}
                            <div class="ac-turn-meta">
                                <span class="ac-muted">{exchange.modelLabel}</span>
                                {#if exchange.answerSaved && hasAnswer(exchange)}{@render savedBadge()}{/if}
                                {#if exchange.status === "done" && exchange.answer}
                                    <button type="button" class="gk-link" onclick={() => copyAnswer(exchange)}>Copy</button>
                                {/if}
                                {#if index === chat.exchanges.length - 1 && !running && (exchange.status === "failed" || exchange.status === "stopped" || exchange.status === "done") && !saveMode}
                                    <button type="button" class="gk-link" onclick={() => chats.retry(chatId)} data-testid="agent-chat-retry">{exchange.status === "done" ? "Answer again" : "Retry"}</button>
                                {/if}
                            </div>
                        </div>
                    </div>
                </article>
            {/each}
        </div>

        {#if saveMode}
            <footer class="ac-composer ac-save">
                <p class="gk-hint ac-hint">{noDocument ? "Choose the turns to save at the end of today's journal." : `Choose the turns to save into ${destination}.`}</p>
                <div class="ac-pick-actions" role="group" aria-label="Choose turns">
                    <button type="button" class="gk-button" onclick={() => tickOnly(["question", "answer"])} disabled={tickedOnly(["question", "answer"])} data-testid="agent-chat-select-all">All</button>
                    <button type="button" class="gk-button" onclick={() => tickOnly([])} disabled={tickedOnly([])} data-testid="agent-chat-deselect-all">None</button>
                    <button type="button" class="gk-button" onclick={() => tickOnly(["question"])} disabled={tickedOnly(["question"])} aria-label="Only my turns" data-testid="agent-chat-select-mine">Mine</button>
                    <button type="button" class="gk-button" onclick={() => tickOnly(["answer"])} disabled={tickedOnly(["answer"])} aria-label="Only the agent's turns" data-testid="agent-chat-select-agents">Agent's</button>
                </div>
                {#if saveProgress}
                    <div class="ac-progress" data-testid="agent-chat-save-progress">
                        <p class="gk-hint ac-hint" role="status">Adding images to the graph: {saveProgress.done} of {saveProgress.total}</p>
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
                    <button type="button" class="gk-button gk-button--primary" onclick={save} aria-disabled={saveBusy || ticked.length === 0} aria-busy={saveBusy} data-testid="agent-chat-save-confirm">
                        {saveBusy ? "Saving…" : ticked.length === 1 ? "Save 1 turn" : `Save ${ticked.length} turns`}
                    </button>
                    <button type="button" class="gk-button" onclick={leaveSave} data-testid="agent-chat-save-cancel">Cancel</button>
                </div>
            </footer>
        {:else}
            <footer class="ac-composer" ondragover={(event) => event.preventDefault()} ondrop={onDrop}>
                {#if images.length > 0}
                    <ul class="ac-attachments" aria-label="Images to send">
                        {#each images as image (image.id)}
                            <li class="ac-chip">
                                {image.name}
                                <button type="button" class="gk-link" onclick={() => removeImage(image.id)} aria-label={`Remove ${image.name}`}>Remove</button>
                            </li>
                        {/each}
                    </ul>
                {/if}
                <div class="ac-compose-row">
                    <textarea
                        class="gk-input ac-compose-input"
                        rows="1"
                        bind:this={composer}
                        bind:value={draft}
                        oninput={(event) => {
                            grow(event);
                            keepDraft(event);
                        }}
                        onkeydown={onKeydown}
                        onpaste={onPaste}
                        placeholder={blocked ? "Add a model connection first" : composerPlaceholder(chats.sendingGrant(chat))}
                        aria-label="Message"
                        aria-describedby={`${chatId}-composer-keys${blocked || composerNote ? ` ${chatId}-composer-note` : ""}`}
                        data-testid="agent-chat-input"
                        {@attach focusComposer}
                    ></textarea>
                    {#if takesImages}
                        <label class="gk-button ac-attach" title="Add an image">
                            <input type="file" accept="image/*" multiple class="ac-visually-hidden" onchange={pickImages} />
                            <span aria-hidden="true">+</span><span class="ac-visually-hidden">Add an image</span>
                        </label>
                    {/if}
                    {#if running}
                        <button type="button" class="gk-button" onclick={() => chats.stop(chatId)} data-testid="agent-chat-stop">Stop</button>
                    {:else}
                        <button type="button" class="gk-button gk-button--primary" onclick={send} data-testid="agent-chat-send">Send</button>
                    {/if}
                </div>
                <p id={`${chatId}-composer-keys`} class="ac-visually-hidden">Enter sends. Shift and Enter start a new line.</p>
                {#if blocked || composerNote}
                    <p id={`${chatId}-composer-note`} class="gk-hint ac-hint" data-testid="agent-chat-composer-note">{composerNote ?? blocked}</p>
                {/if}
            </footer>
        {/if}
    </section>
{:else}
    <p class="ac-muted ac-gone" role="status">This chat has been deleted.</p>
{/if}

<style>
    .ac-chat:focus {
        outline: none;
    }
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
    /* The header is a toolbar, so its pickers keep to a line's height, as the Client's compact
       selects do: EtherPK's own field (ADR 0151), with less room above and below the text. */
    .ac-controls :global(.gk-input),
    .ac-controls :global(.gk-select) {
        padding-block: 0.25rem;
    }
    /* The box and its words on one line. The words are a field's label (`gk-label`), as Model and
       Context are. */
    .ac-check {
        display: flex;
        align-items: center;
        gap: 0.375rem;
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
    /* The room above a hint. Its size and colour are EtherPK's `gk-hint`. */
    .ac-hint {
        margin: 0.375rem 0 0;
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
    /* The person's turn, then the model's. */
    .ac-exchange {
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
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
    /* The box is EtherPK's `gk-checkbox`, a little larger on a touch screen. */
    @media (pointer: coarse) {
        .ac-tick {
            padding: 0.625rem;
        }
        .ac-tick input {
            width: 1.25rem;
            height: 1.25rem;
        }
    }
    /* An exchange sent with no prompt reads as what was sent, set apart from words the person wrote. */
    .ac-question-text--sent {
        font-style: italic;
        color: var(--gk-text-muted);
    }
    .ac-badge {
        display: flex;
        align-self: center;
        color: var(--gk-accent);
    }
    /* A turn with nothing to save keeps the column its box would take, so the turns stay in line. */
    .ac-tick--none {
        width: 1rem;
        height: 1rem;
        box-sizing: content-box;
    }
    @media (pointer: coarse) {
        .ac-tick--none {
            width: 1.25rem;
            height: 1.25rem;
        }
    }
    /* The calendar and the word, side by side. */
    .ac-save-journal {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
    }
    .ac-reasoning {
        font-size: 0.875rem;
        color: var(--gk-text-muted);
    }
    .ac-reasoning summary {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        cursor: pointer;
        list-style-position: outside;
    }
    .ac-reasoning summary:focus-visible {
        outline: 2px solid var(--gk-accent);
        outline-offset: 2px;
        border-radius: 0.25rem;
    }
    .ac-reasoning-text {
        margin: 0.25rem 0 0;
        padding-left: 0.75rem;
        border-left: 2px solid var(--gk-border-soft);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
    }
    .ac-context,
    .ac-sources {
        margin: 0;
        font-size: 0.875rem;
        color: var(--gk-text-muted);
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
    /* The model's name and the turn's links, all at the line's 14px: a `gk-link` takes the size of
       the text around it. */
    .ac-turn-meta {
        display: flex;
        gap: 0.75rem;
        align-items: center;
        font-size: 0.875rem;
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
    /*
     * EtherPK's own field (`gk-input`) and buttons (`gk-button`, ADR 0151), laid out as one row of
     * one height, 2.5rem, until the field grows. On a touch screen the kit makes its buttons 2.75rem
     * tall, and the field and the square image button follow.
     */
    .ac-compose-input {
        flex: 1;
        box-sizing: border-box;
        height: 2.5rem;
        min-height: 2.5rem;
        max-height: 180px;
        resize: none;
    }
    .ac-save-actions,
    .ac-pick-actions {
        display: flex;
        gap: 0.5rem;
        margin-top: 0.5rem;
    }
    .ac-compose-row .gk-button {
        box-sizing: border-box;
        height: 2.5rem;
        padding-inline: 0.875rem;
    }
    .ac-compose-row .ac-attach {
        width: 2.5rem;
        padding: 0;
        font-size: 1.125rem;
    }
    /* The image button is a label round a hidden file input, and the input takes the keyboard. */
    .ac-attach:has(input:focus-visible) {
        outline: 2px solid var(--gk-accent);
        outline-offset: 2px;
    }
    @media (pointer: coarse) {
        .ac-compose-input {
            min-height: 2.75rem;
        }
        .ac-compose-row .ac-attach {
            width: 2.75rem;
        }
    }
    /* A close or back arrow drawn as a character, at the size an icon would be. */
    .ac-glyph {
        font-size: 1rem;
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
