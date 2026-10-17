<script lang="ts">
    /**
     * What `/Agent` shows when there is a chat to go back to (ADR 0147): a new chat first, then the
     * document's own chats, newest first, then the chats whose document was deleted. Resuming one
     * of those makes this document its home.
     */
    import type { Attachment } from "svelte/attachments";

    import type { AgentChats } from "../chat/chats.svelte";
    import { type Chat, savedState } from "../chat/model";
    import { onEscape } from "./escape";
    import { since } from "./time";

    const {
        chats,
        home,
        onChoose,
        onNew,
        onCancel,
    }: {
        chats: AgentChats;
        home: string;
        onChoose: (chat: Chat) => void;
        onNew: () => void;
        onCancel: () => void;
    } = $props();

    const own = $derived(chats.chatsFor(home));
    const orphans = $derived(chats.orphans());

    const focusFirst: Attachment<HTMLButtonElement> = (button) => {
        requestAnimationFrame(() => button.focus({ preventScroll: true }));
    };

</script>

{#snippet row(chat: Chat)}
    <li>
        <button type="button" class="ac-pick-row" onclick={() => onChoose(chat)} data-testid="agent-chat-resume">
            <span class="ac-pick-title">{chat.title}</span>
            <span class="ac-pick-meta">{since(chat.updatedAt)}, {savedState(chat)}</span>
        </button>
    </li>
{/snippet}

<div class="ac-picker" role="group" aria-label="Start or resume an Agent Chat" data-testid="agent-chat-picker" {@attach onEscape(onCancel)}>
    <div class="ac-picker-head">
        <button type="button" class="gk-button gk-button--primary ac-new" onclick={onNew} data-testid="agent-chat-new" {@attach focusFirst}>New Agent Chat in {home}</button>
        <button type="button" class="gk-icon-button ac-glyph" onclick={onCancel} aria-label="Close">×</button>
    </div>
    {#if own.length > 0}
        <h4 class="ac-pick-heading">Chats about {home}</h4>
        <ul class="ac-pick-list">{#each own as chat (chat.id)}{@render row(chat)}{/each}</ul>
    {/if}
    {#if orphans.length > 0}
        <h4 class="ac-pick-heading">Chats without a document</h4>
        <p class="ac-pick-note">Their document was deleted. Resuming one here makes {home} its document.</p>
        <ul class="ac-pick-list">{#each orphans as chat (chat.id)}{@render row(chat)}{/each}</ul>
    {/if}
</div>

<style>
    .ac-picker {
        height: 100%;
        overflow-y: auto;
        padding: 0.75rem;
        border: 1px solid var(--gk-border-soft);
        border-radius: 0.75rem;
        background: var(--gk-surface-0);
        color: var(--gk-text-default);
        font-family: var(--gk-sans);
        box-sizing: border-box;
    }
    .ac-picker-head {
        display: flex;
        gap: 0.5rem;
        align-items: center;
    }
    /* EtherPK's primary button (`gk-button--primary`), filling the row, its words at the start and
       free to wrap, since they carry the document's name. */
    .ac-new {
        flex: 1;
        justify-content: flex-start;
        text-align: left;
        white-space: normal;
    }
    /* The close cross, drawn as a character, at the size an icon would be. */
    .ac-glyph {
        font-size: 1rem;
    }
    .ac-pick-heading {
        margin: 0.875rem 0 0.375rem;
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--gk-text-muted);
    }
    .ac-pick-note {
        margin: 0 0 0.375rem;
        font-size: 0.875rem;
        color: var(--gk-text-muted);
    }
    .ac-pick-list {
        margin: 0;
        padding: 0;
        list-style: none;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }
    .ac-pick-row {
        width: 100%;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.125rem;
        text-align: left;
        padding: 0.375rem 0.625rem;
        border-radius: 0.5rem;
        border: 1px solid var(--gk-border-soft);
        background: var(--gk-surface-1);
        color: var(--gk-text-default);
        cursor: pointer;
    }
    .ac-pick-row:hover {
        background: var(--gk-surface-2);
    }
    .ac-pick-title {
        font-size: 0.9375rem;
        font-weight: 500;
    }
    .ac-pick-meta {
        font-size: 0.875rem;
        color: var(--gk-text-muted);
    }
    .ac-pick-row:focus-visible {
        outline: 2px solid var(--gk-accent);
        outline-offset: 1px;
    }
</style>
