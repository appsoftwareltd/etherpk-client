<script lang="ts">
    /**
     * What an `/Agent` opening draws (ADR 0147), inline beneath the line on a desktop, or over the
     * whole window on a phone: the picker while the person chooses a chat, then the chat.
     */
    import type { InlinePanel } from "@appsoftwareltd/etherpk-extension-api";

    import type { AgentChats } from "../chat/chats.svelte";
    import type { Chat } from "../chat/model";
    import type { ChatActions } from "./actions";
    import ChatPanel from "./ChatPanel.svelte";
    import { openingHeight } from "./heights";
    import type { ChatSession } from "./session.svelte";
    import StartPicker from "./StartPicker.svelte";

    const {
        chats,
        home,
        session,
        where,
        panel,
        actions,
        onChoose,
        onNew,
        onClose,
        onSaved,
    }: {
        chats: AgentChats;
        home: string;
        session: ChatSession;
        where: "inline" | "window";
        /** The inline panel this opening sits in, through which Save writes. */
        panel: InlinePanel | null;
        actions: ChatActions;
        /** Resume a chat here, making this document its home if it had none. */
        onChoose: (chat: Chat) => void;
        /** Start a new chat about this document. */
        onNew: () => void;
        onClose: () => void;
        /** After a Save: on a phone, back to the document where it landed. */
        onSaved?: () => void;
    } = $props();

    // The inline panel's height follows what it shows (heights.ts): it grows once, when the chat
    // gets its first question, and the panel is an outside thing this keeps in step.
    $effect(() => {
        if (where === "inline" && panel) panel.resize(openingHeight(chats, session.chatId, home));
    });
</script>

{#if session.chatId === null}
    <StartPicker {chats} {home} {onChoose} {onNew} onCancel={onClose} />
{:else}
    <ChatPanel
        {chats}
        chatId={session.chatId}
        {where}
        {panel}
        openDocument={actions.openDocument}
        openSettings={actions.openSettings}
        onOpenInView={where === "inline" ? () => session.chatId && actions.openInView(session.chatId) : undefined}
        onClose={where === "inline" ? onClose : undefined}
        saveTarget={() => (panel?.isOpen ? Promise.resolve(panel) : actions.saveTarget(session.chatId ?? ""))}
        {onSaved}
        autofocus
    />
{/if}
