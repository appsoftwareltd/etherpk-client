<script lang="ts">
    /**
     * On a phone, `/Agent` opens the chat over the whole window, and leaves this short line in the
     * document where it was typed (ADR 0147): it names the chat, opens it again, and is where a
     * Save from the window writes.
     */
    import type { AgentChats } from "../chat/chats.svelte";
    import type { ChatSession } from "./session.svelte";

    const { chats, session, onOpen, onClose }: { chats: AgentChats; session: ChatSession; onOpen: () => void; onClose: () => void } = $props();

    const title = $derived(session.chatId ? (chats.get(session.chatId)?.title ?? "Agent Chat") : "Agent Chat");
</script>

<div class="ac-stub" data-testid="agent-chat-stub">
    <span class="ac-stub-title">Agent Chat: {title}</span>
    <button type="button" class="ac-stub-button" onclick={onOpen} data-testid="agent-chat-stub-open">Open</button>
    <button type="button" class="ac-stub-button" onclick={onClose} aria-label="Close the chat">×</button>
</div>

<style>
    .ac-stub {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        height: 100%;
        box-sizing: border-box;
        padding: 0 0.5rem 0 0.75rem;
        border: 2px solid var(--gk-border-strong);
        border-radius: 0.75rem;
        background: var(--gk-surface-1);
        color: var(--gk-text-default);
        font-family: var(--gk-sans);
    }
    .ac-stub-title {
        flex: 1;
        min-width: 0;
        font-size: 0.9375rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .ac-stub-button {
        min-width: 2.75rem;
        min-height: 2.25rem;
        padding: 0 0.875rem;
        font-size: 0.875rem;
        font-weight: 500;
        border-radius: 0.5rem;
        border: 1px solid var(--gk-border-strong);
        background: var(--gk-surface-0);
        color: var(--gk-text-default);
    }
</style>
