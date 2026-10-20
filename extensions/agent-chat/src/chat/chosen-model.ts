/**
 * The model a person last chose in a chat's model picker, which every new chat starts on until the
 * page reloads (Agent Chat refinements, 2026-10-20). It is kept in this module, so it holds across
 * every graph opened in the tab, and is never written anywhere: the person's default stays what
 * their settings say.
 *
 * It gives way to the settings when they change what a new chat starts on (the primary connection,
 * or that connection's default model), since that is the newer choice, and when its connection is
 * removed.
 */
import { type AgentChatSettings, defaultConnection } from '../settings/connections'

export interface ChosenModel {
    connectionId: string
    modelId: string
}

/** The last choice, and what the settings' default was when it was made. */
let chosen: { model: ChosenModel; defaultWas: string } | null = null

/** What the settings start a new chat on, as one value a change to it can be told by. */
function settingsDefault(settings: AgentChatSettings): string {
    const connection = defaultConnection(settings)
    return connection ? `${connection.id}\n${connection.defaultModel}` : ''
}

/** The person chose a model in a chat's picker. */
export function noteChosenModel(model: ChosenModel, settings: AgentChatSettings): void {
    chosen = { model: { ...model }, defaultWas: settingsDefault(settings) }
}

/** The connection and model a new chat starts on now. */
export function startingModel(settings: AgentChatSettings): { connectionId: string | null; modelId: string | null } {
    if (chosen && (chosen.defaultWas !== settingsDefault(settings) || !settings.connections.some((connection) => connection.id === chosen?.model.connectionId))) {
        chosen = null
    }
    if (chosen) return { ...chosen.model }
    const connection = defaultConnection(settings)
    return { connectionId: connection?.id ?? null, modelId: connection?.defaultModel || null }
}

/** Forget the choice, as a reload does. For tests. */
export function forgetChosenModel(): void {
    chosen = null
}
