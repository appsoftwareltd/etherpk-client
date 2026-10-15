/**
 * Running one turn of an [[Agent Chat]] (ADR 0147): the turn's Context Grant read now, the model's
 * instructions, the chat so far, and the answer streamed into the turn as it arrives.
 *
 * The turn is the chat's own reactive record, so both places that show the chat (inline and the
 * Agent Chats View) draw each piece as it lands. A turn ends `done`, `stopped` (the person pressed
 * Stop, or the chat was closed) or `failed`, with a message that says what to do next.
 *
 * Imported by the chat state when a chat first sends, so the AI SDK stays out of the Client's first
 * download.
 */
import type { ExtensionDocuments } from '@appsoftwareltd/etherpk-extension-api'
import { APICallError, isStepCount, type ModelMessage, streamText, type ToolSet, type UserContent } from 'ai'

import { assembleContext } from '../grants/assemble'
import { instructions } from '../grants/instructions'
import { GRAPH_TOOL_NAMES, graphTools, summarizeToolCall } from '../grants/tools'
import { type ProviderModel, providerModel } from '../providers/language-model'
import { errorForStatus, type ModelInfo, ProviderError, unreachable } from '../providers/models'
import type { ModelConnection } from '../settings/connections'
import type { Turn } from './model'

/** The most steps one turn may take: each tool call and its answer is one. */
export const MAX_STEPS = 12

/** A turn that ended with no text: shown as its error, so the person is never left with an empty answer. */
export const NO_ANSWER = 'The model finished without an answer. Answer again, or ask a narrower question.'

export interface RunTurnInput {
    /** The chat's earlier turns, oldest first. */
    history: readonly Turn[]
    /** The turn being answered, filled in place. */
    turn: Turn
    home: string
    connection: ModelConnection
    model: ModelInfo
    documents: ExtensionDocuments
    /** The outline around the chat's bullet, sent under Block siblings and ancestors; null otherwise. */
    block: string | null
    /** The home is a Draft, not written yet: it has no text, which the model and the person are told. */
    homeUnwritten?: boolean
    /** Whether this turn may search the web: asked for, and the provider can. */
    webSearch: boolean
    signal: AbortSignal
    /** Make an image ready to send (`context.assets.prepareImage`). */
    prepareImage(image: Blob): Promise<Blob>
    /** Today as `YYYY-MM-DD`, at the moment of sending. */
    today: string
    /** Told when a tool chip or the turn's state changes, so the chat is kept. */
    changed(): void
    /** The model to call; the provider's own unless a test supplies one. */
    providerModel?: (connection: ModelConnection, modelId: string, webSearch: boolean) => Promise<ProviderModel>
}

// The AI SDK writes its warnings (deprecations, a provider ignoring a setting) to the console of
// every person's browser; they are for whoever builds the extension, who reads them in its tests.
;(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false

/** An image as the model takes it: its bytes and its type, as a file part. */
async function imagePart(image: Blob, prepare: (image: Blob) => Promise<Blob>) {
    let prepared = image
    try {
        prepared = await prepare(image)
    } catch {
        // An image the browser cannot read is sent as it was; the provider says if it refuses.
    }
    return { type: 'file' as const, data: new Uint8Array(await prepared.arrayBuffer()), mediaType: prepared.type || image.type || 'image' }
}

async function userContent(turn: Turn, prepare: (image: Blob) => Promise<Blob>): Promise<UserContent> {
    if (turn.images.length === 0) return turn.question
    return [{ type: 'text', text: turn.question }, ...(await Promise.all(turn.images.map((image) => imagePart(image.blob, prepare))))]
}

/** The chat so far as messages: each earlier turn that has an answer, then the question asked now. */
async function chatMessages(history: readonly Turn[], turn: Turn, prepare: (image: Blob) => Promise<Blob>): Promise<ModelMessage[]> {
    const messages: ModelMessage[] = []
    for (const earlier of history) {
        if (earlier.answer.trim() === '' || earlier.status === 'failed') continue
        messages.push({ role: 'user', content: await userContent(earlier, prepare) })
        messages.push({ role: 'assistant', content: earlier.answer })
    }
    messages.push({ role: 'user', content: await userContent(turn, prepare) })
    return messages
}

/** A provider's reason for an error, from its answer's body, when it gave one. */
function providerDetail(body: string | undefined): string {
    if (!body) return ''
    try {
        const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown }
        const message = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? parsed.message)
        return typeof message === 'string' ? message.slice(0, 200) : ''
    } catch {
        return ''
    }
}

/** What went wrong, in the person's words. */
export function failureMessage(error: unknown, connection: ModelConnection): string {
    if (error instanceof ProviderError) return error.message
    if (APICallError.isInstance(error)) {
        if (error.statusCode !== undefined) return errorForStatus(connection, error.statusCode, providerDetail(error.responseBody)).message
        return unreachable(connection).message
    }
    if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) return unreachable(connection).message
    const text = error instanceof Error ? error.message : String(error)
    return `The answer stopped with an error: ${text.slice(0, 300)}. Try again, or choose another model.`
}

export async function runTurn(input: RunTurnInput): Promise<void> {
    const { turn, signal } = input
    const readsGraph = turn.grant === 'graph' && input.model.tools
    try {
        const context = await assembleContext(turn.grant, input.home, input.documents, undefined, input.block)
        // Shown under the question: exactly what was sent, and what was left out.
        const excerpt = context.documents.some((doc) => doc.excerpt)
        const unwritten = input.homeUnwritten === true && turn.grant !== 'nothing'
        turn.context = { included: context.included, leftOut: context.leftOut.map((doc) => doc.name), ...(excerpt ? { excerpt } : {}), ...(unwritten ? { unwritten } : {}) }
        input.changed()
        const system = instructions({
            grant: turn.grant,
            home: input.home,
            context,
            homeUnwritten: input.homeUnwritten === true,
            today: input.today,
            formatGuide: turn.grant === 'nothing' ? '' : input.documents.formatGuide(),
            canSearchGraph: readsGraph,
        })
        const messages = await chatMessages(input.history, turn, input.prepareImage)
        const { model, tools: searchTools } = await (input.providerModel ?? providerModel)(input.connection, turn.modelId, input.webSearch)
        const tools: ToolSet = readsGraph ? { ...graphTools(input.documents), ...searchTools } : searchTools
        if (signal.aborted) {
            turn.status = 'stopped'
            return
        }
        const result = streamText({
            model,
            system,
            messages,
            tools: Object.keys(tools).length > 0 ? tools : undefined,
            stopWhen: isStepCount(MAX_STEPS),
            // The last step may call no tool, so a model that would go on reading answers with
            // what it has read rather than running out of steps with nothing written.
            prepareStep: ({ stepNumber }) => (stepNumber >= MAX_STEPS - 1 ? { toolChoice: 'none' } : undefined),
            abortSignal: signal,
            maxRetries: 1,
            // An error arrives as an `error` part below and is shown in the turn; the SDK's own
            // handler would also write it to the console.
            onError: () => {},
        })
        let steps = 0
        for await (const part of result.fullStream) {
            switch (part.type) {
                case 'start-step':
                    // Text from a later step (after a tool call) starts a new paragraph.
                    steps += 1
                    if (steps > 1 && turn.answer.trim() !== '' && !turn.answer.endsWith('\n\n')) turn.answer += '\n\n'
                    break
                case 'text-delta':
                    turn.answer += part.text
                    break
                case 'tool-call':
                    if ((GRAPH_TOOL_NAMES as readonly string[]).includes(part.toolName) || part.toolName === 'web_search' || part.toolName === 'google_search') {
                        turn.tools.push({ id: `${turn.id}-tool-${turn.tools.length}`, callId: part.toolCallId, summary: summarizeToolCall(part.toolName, part.input), status: 'running' })
                        input.changed()
                    }
                    break
                case 'tool-result':
                case 'tool-error': {
                    // The latest running call with that id: a provider may use one id in two steps.
                    const chip = turn.tools.findLast((candidate) => candidate.callId === part.toolCallId && candidate.status === 'running')
                    if (chip) chip.status = part.type === 'tool-result' ? 'done' : 'failed'
                    break
                }
                case 'source':
                    if (part.sourceType === 'url' && !turn.sources.some((source) => source.url === part.url)) {
                        turn.sources.push({ url: part.url, title: part.title ?? new URL(part.url).hostname })
                    }
                    break
                case 'error':
                    throw part.error
                case 'abort':
                    turn.status = 'stopped'
                    break
            }
        }
        if (turn.status === 'streaming') {
            if (signal.aborted) turn.status = 'stopped'
            else if (turn.answer.trim() === '') {
                turn.status = 'failed'
                turn.error = NO_ANSWER
            } else turn.status = 'done'
        }
    } catch (error) {
        if (signal.aborted) {
            turn.status = 'stopped'
        } else {
            turn.status = 'failed'
            turn.error = failureMessage(error, input.connection)
        }
    } finally {
        for (const chip of turn.tools) if (chip.status === 'running') chip.status = turn.status === 'done' ? 'done' : 'failed'
        input.changed()
    }
}
