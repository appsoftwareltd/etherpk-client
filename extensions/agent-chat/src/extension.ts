/**
 * The [[Agent Chat]] extension's entry module (ADR 0147): ask a language model about your notes
 * from inside a document, through your own [[Model Connection]], with the chat kept on this device
 * until you save the turns you want into the document.
 *
 * Compiled into the Client, which calls `activate` as each graph opens. It reaches the Client only
 * through the Extension API, its Proposed part included, and imports nothing of the Client's. The
 * AI SDK is loaded the first time a chat sends, so none of it is in the Client's first download.
 *
 * `settingsSections` adds the Model Connections to the Agents settings, on the Graphs page and in a
 * graph's settings, where they can be set up with no graph open.
 */
import type { ExtensionContext, SettingsSection } from '@appsoftwareltd/etherpk-extension-api'

import { registerAgentChat } from './register'
import ChatHost from './ui/ChatHost.svelte'
import ChatsView from './ui/ChatsView.svelte'
import ConnectionsSection from './ui/ConnectionsSection.svelte'
import { mountComponent } from './ui/mount'
import PhoneStub from './ui/PhoneStub.svelte'
import { chatSession } from './ui/session.svelte'

export function activate(context: ExtensionContext): () => void {
    const chats = registerAgentChat(context, {
        session: chatSession,
        view: (chats, actions, active) => ({
            mount: (element) => mountComponent(ChatsView, element, { chats, actions, activeDocument: active.get, onActiveDocumentChanged: active.subscribe }),
        }),
        opening: (host, props) => mountComponent(ChatHost, host, { ...props }),
        stub: (host, props) => mountComponent(PhoneStub, host, { ...props }),
    })
    return () => chats.dispose()
}

export const settingsSections: readonly SettingsSection[] = [
    {
        id: 'model-connections',
        tab: 'agents',
        mount: (element, context) => mountComponent(ConnectionsSection, element, { context }),
    },
]
