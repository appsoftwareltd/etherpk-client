<script lang="ts">
    /**
     * The [[Agent Chats View]] (ADR 0147): every Agent Chat of the open graph kept on this device,
     * saved or not, in the right Sidebar. A chat chosen here, by its name or a press anywhere on its
     * row that is not a control, shows in full, where it can be continued and saved, and its home
     * document opens beside it. New chat starts a chat without a document here, which a Save puts at
     * the end of today's Journal Entry. Chats can be renamed, and deleted one at a time, ticked
     * together, or all at once.
     *
     * Deleting is permanent: a chat lives only on this device, so it asks first, saying how many.
     */
    import type { Attachment } from "svelte/attachments";
    import { createSubscriber, SvelteSet } from "svelte/reactivity";

    import type { AgentChats } from "../chat/chats.svelte";
    import { type Chat, savedState } from "../chat/model";
    import type { ChatActions } from "./actions";
    import ChatPanel from "./ChatPanel.svelte";
    import RobotIcon from "./RobotIcon.svelte";
    import { since } from "./time";

    const {
        chats,
        actions,
        activeDocument,
        onActiveDocumentChanged,
    }: {
        chats: AgentChats;
        actions: ChatActions;
        activeDocument: () => string | null;
        onActiveDocumentChanged: (listener: () => void) => () => void;
    } = $props();

    const activeChanged = $derived(createSubscriber((update) => onActiveDocumentChanged(update)));
    const active = $derived.by(() => {
        activeChanged();
        return activeDocument();
    });

    let onlyActive = $state(false);
    const ticked = new SvelteSet<string>();
    /** What is waiting for the person to confirm deleting: some chats, or all of them. */
    let confirming = $state<{ ids: string[]; label: string } | null>(null);
    let renaming = $state<string | null>(null);
    let renameText = $state("");
    let notice = $state<string | null>(null);

    /** The chats with something asked in them: one just opened is listed from its first question. */
    const listed = $derived(chats.chats.filter((chat) => chat.exchanges.length > 0));
    const shown = $derived(onlyActive && active ? listed.filter((chat) => chat.home === active) : listed);

    function open(chat: Chat) {
        chats.selected = chat.id;
        if (chat.home !== null && !chats.withoutDocument(chat)) actions.openDocument(chat.home);
    }

    /** Back to the list: a chat left with nothing asked in it is not kept. */
    function backToList() {
        const id = chats.selected;
        chats.selected = null;
        if (id) chats.discardIfEmpty(id);
    }

    /** Where a row says its chat belongs. */
    function homeLabel(chat: Chat): string {
        if (chat.home === null) return "No document";
        return chats.homeDeleted(chat) ? `${chat.home} (deleted)` : chat.home;
    }

    /**
     * A press on a row's body opens its chat, as a press on its name does; a press on one of the
     * row's controls is that control's. The name stays the row's keyboard way in, so the row
     * itself takes no focus.
     */
    function opensOnPress(chat: Chat): Attachment<HTMLElement> {
        return (row) => {
            const onClick = (event: MouseEvent) => {
                if ((event.target as Element | null)?.closest("button, a, input, label, textarea")) return;
                if (renaming === chat.id) return;
                open(chat);
            };
            row.addEventListener("click", onClick);
            return () => row.removeEventListener("click", onClick);
        };
    }

    function toggle(id: string) {
        if (ticked.has(id)) ticked.delete(id);
        else ticked.add(id);
    }

    function askDelete(ids: string[], label: string) {
        confirming = { ids, label };
    }

    async function confirmDelete() {
        if (!confirming) return;
        const { ids } = confirming;
        confirming = null;
        await chats.remove(ids);
        for (const id of ids) ticked.delete(id);
        notice = ids.length === 1 ? "Chat deleted." : `${ids.length} chats deleted.`;
    }

    function startRename(chat: Chat) {
        renaming = chat.id;
        renameText = chat.title;
    }

    function finishRename(commit: boolean) {
        if (commit && renaming) chats.rename(renaming, renameText);
        renaming = null;
    }

    function renameKey(event: KeyboardEvent) {
        if (event.key === "Enter") {
            event.preventDefault();
            finishRename(true);
        } else if (event.key === "Escape") {
            event.preventDefault();
            finishRename(false);
        }
    }

    function focusInput(element: HTMLInputElement) {
        element.focus();
        element.select();
    }
</script>

<div class="ac-view" data-testid="agent-chats-view">
    {#if chats.selected && chats.get(chats.selected)}
        <ChatPanel
            {chats}
            chatId={chats.selected}
            where="view"
            openDocument={actions.openDocument}
            openSettings={actions.openSettings}
            onClose={backToList}
            saveTarget={() => actions.saveTarget(chats.selected ?? "")}
            autofocus={(chats.get(chats.selected)?.exchanges.length ?? 0) === 0}
        />
    {:else}
        <header class="ac-view-head">
            <div class="ac-view-title-row">
                <h2 class="ac-view-title"><RobotIcon class="size-4 text-(--gk-text-muted)" />Agent Chats</h2>
                <button type="button" class="gk-button gk-button--primary gk-button--small" onclick={actions.startWithoutDocument} data-testid="agent-chats-new">New chat</button>
            </div>
            <p class="ac-view-note">Kept on this device only. Start one here, or type <kbd>/Agent</kbd> in a document.</p>
            {#if listed.length > 0}
                <div class="ac-view-tools">
                    {#if active}
                        <label class="ac-view-check">
                            <input type="checkbox" class="gk-checkbox" bind:checked={onlyActive} data-testid="agent-chats-only-active" />
                            <span>Only {active}</span>
                        </label>
                    {/if}
                    {#if ticked.size > 0}
                        <button type="button" class="gk-button" onclick={() => askDelete([...ticked], ticked.size === 1 ? "the ticked chat" : `${ticked.size} ticked chats`)} data-testid="agent-chats-delete-ticked">Delete ticked</button>
                    {/if}
                    <button type="button" class="gk-button" onclick={() => askDelete(listed.map((chat) => chat.id), listed.length === 1 ? "the only chat" : `all ${listed.length} chats`)} data-testid="agent-chats-delete-all">Delete all</button>
                </div>
            {/if}
            {#if confirming}
                <div class="ac-confirm" role="alert" data-testid="agent-chats-confirm">
                    <p>Delete {confirming.label} from this device? A deleted chat cannot be brought back. What you saved into documents stays.</p>
                    <div class="ac-confirm-actions">
                        <button type="button" class="gk-button gk-button--danger" onclick={confirmDelete} data-testid="agent-chats-confirm-delete">Delete</button>
                        <button type="button" class="gk-button" onclick={() => (confirming = null)}>Cancel</button>
                    </div>
                </div>
            {/if}
            {#if notice}<p class="ac-view-note" role="status">{notice}</p>{/if}
            {#if chats.loadError}<p class="ac-view-error" role="alert">{chats.loadError}</p>{/if}
        </header>
        {#if !chats.loaded}
            <p class="ac-view-note ac-view-pad">Loading chats…</p>
        {:else if shown.length === 0}
            <p class="ac-view-note ac-view-pad" data-testid="agent-chats-empty">{listed.length === 0 ? "No chats on this device yet." : `No chats about ${active}.`}</p>
        {:else}
            <ul class="ac-view-list">
                {#each shown as chat (chat.id)}
                    <li class="ac-view-row" data-testid="agent-chats-row" {@attach opensOnPress(chat)}>
                        <input type="checkbox" class="gk-checkbox" checked={ticked.has(chat.id)} onchange={() => toggle(chat.id)} aria-label={`Tick ${chat.title}`} />
                        <div class="ac-view-main">
                            {#if renaming === chat.id}
                                <input class="gk-input ac-view-rename" bind:value={renameText} onkeydown={renameKey} onblur={() => finishRename(true)} aria-label="Chat name" {@attach focusInput} />
                            {:else}
                                <button type="button" class="ac-view-open" onclick={() => open(chat)} data-testid="agent-chats-open">{chat.title}</button>
                            {/if}
                            <span class="ac-view-meta">
                                {homeLabel(chat)}, {since(chat.updatedAt)}, {savedState(chat)}{chats.isRunning(chat.id) ? ", answering" : ""}
                            </span>
                            <!-- Under the title rather than beside it, so a narrow sidebar never squeezes the title. -->
                            <span class="ac-view-actions">
                                <button type="button" class="gk-button gk-button--quiet gk-button--small" onclick={() => startRename(chat)} aria-label={`Rename ${chat.title}`}>Rename</button>
                                <button type="button" class="gk-button gk-button--quiet gk-button--small" onclick={() => askDelete([chat.id], `"${chat.title}"`)} aria-label={`Delete ${chat.title}`} data-testid="agent-chats-delete">Delete</button>
                            </span>
                        </div>
                    </li>
                {/each}
            </ul>
        {/if}
    {/if}
</div>

<style>
    .ac-view {
        height: 100%;
        display: flex;
        flex-direction: column;
        min-height: 0;
        background: var(--gk-surface-0);
        color: var(--gk-text-default);
        font-family: var(--gk-sans);
    }
    .ac-view-head {
        padding: 0.75rem;
        border-bottom: 1px solid var(--gk-border-soft);
    }
    .ac-view-title-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
    }
    .ac-view-title {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin: 0;
        font-size: 0.9375rem;
        font-weight: 600;
        color: var(--gk-text-strong);
    }
    .ac-view-note {
        margin: 0.25rem 0 0;
        font-size: 0.875rem;
        color: var(--gk-text-muted);
    }
    .ac-view-note kbd {
        font-family: var(--gk-mono);
        font-size: max(0.875rem, 0.9em);
    }
    .ac-view-pad {
        padding: 0.75rem;
    }
    .ac-view-error {
        margin: 0.375rem 0 0;
        font-size: 0.875rem;
        color: var(--gk-text-danger);
    }
    .ac-view-tools {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
        margin-top: 0.5rem;
    }
    .ac-view-check {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        font-size: 0.875rem;
        margin-right: auto;
    }
    .ac-confirm {
        margin-top: 0.5rem;
        padding: 0.5rem;
        border-radius: 0.5rem;
        background: var(--gk-danger-surface);
        font-size: 0.875rem;
    }
    .ac-confirm p {
        margin: 0;
    }
    .ac-confirm-actions {
        display: flex;
        gap: 0.5rem;
        margin-top: 0.5rem;
    }
    .ac-view-list {
        flex: 1;
        overflow-y: auto;
        margin: 0;
        padding: 0.25rem 0;
        list-style: none;
    }
    .ac-view-row {
        display: flex;
        align-items: flex-start;
        gap: 0.5rem;
        padding: 0.5rem 0.75rem;
        border-bottom: 1px solid var(--gk-border-soft);
        cursor: pointer;
    }
    .ac-view-row:hover {
        background: var(--gk-surface-1);
    }
    .ac-view-row input[type="checkbox"] {
        margin-top: 0.25rem;
    }
    .ac-view-main {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 0.125rem;
    }
    .ac-view-open {
        text-align: left;
        background: none;
        border: 0;
        padding: 0;
        font: inherit;
        font-size: 0.9375rem;
        font-weight: 500;
        color: var(--gk-text-default);
        cursor: pointer;
        overflow-wrap: anywhere;
    }
    .ac-view-open:hover {
        color: var(--gk-accent);
    }
    /* EtherPK's own field (`gk-input`), at the size of the title it stands in for, so the row
       keeps its height while the chat is renamed. */
    .ac-view-rename {
        font: inherit;
        font-size: 0.9375rem;
        padding: 0.125rem 0.25rem;
    }
    .ac-view-meta {
        font-size: 0.875rem;
        color: var(--gk-text-muted);
        overflow-wrap: anywhere;
    }
    /* Quiet buttons (`gk-button--quiet`), pulled left by their own padding so their words line up
       with the title and the line above. */
    .ac-view-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.25rem;
        margin-left: -0.5rem;
    }
    .ac-view-open:focus-visible {
        outline: 2px solid var(--gk-accent);
        outline-offset: 1px;
    }
</style>
