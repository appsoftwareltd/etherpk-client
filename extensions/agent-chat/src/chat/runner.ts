/**
 * The model's turn in an [[Agent Chat]] (ADR 0147): the question's Context Grant read now, the
 * model's instructions, the chat so far, and the answer streamed into the exchange as it arrives,
 * with the model's reasoning where it streams any.
 *
 * The exchange is the chat's own reactive record, so both places that show the chat (inline and the
 * Agent Chats View) draw each piece as it lands. An answer ends `done`, `stopped` (the person pressed
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
import { promptlessMessage, type Exchange } from './model'

/** The most steps one answer may take: each tool call and its answer is one. */
export const MAX_STEPS = 12

/** An answer that ended with no text: shown as its error, so the person is never left with an empty answer. */
export const NO_ANSWER = 'The model finished without an answer. Answer again, or ask a narrower question.'

export interface RunTurnInput {
    /** The chat's earlier exchanges, oldest first. */
    history: readonly Exchange[]
    /** The exchange being answered, filled in place. */
    exchange: Exchange
    /** The chat's home document, or null for a chat without a document. */
    home: string | null
    connection: ModelConnection
    model: ModelInfo
    documents: ExtensionDocuments
    /** The outline around the chat's bullet, sent under Block siblings and ancestors; null otherwise. */
    block: string | null
    /** The home is a Draft, not written yet: it has no text, which the model and the person are told. */
    homeUnwritten?: boolean
    /** Whether this answer may search the web: asked for, and the provider can. */
    webSearch: boolean
    signal: AbortSignal
    /** Make an image ready to send (`context.assets.prepareImage`). */
    prepareImage(image: Blob): Promise<Blob>
    /** Today as `YYYY-MM-DD`, at the moment of sending. */
    today: string
    /** The person's Agent Instruction, sent with every question; empty for none. */
    agentInstruction?: string
    /** Told when the answer grows, a tool chip changes or the answer ends, so the chat is kept. */
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

async function userContent(exchange: Exchange, prepare: (image: Blob) => Promise<Blob>): Promise<UserContent> {
    // Sent with no prompt: the model is told where the question is (`promptlessMessage`).
    const text = exchange.question.trim() === '' ? promptlessMessage(exchange.grant) : exchange.question
    if (exchange.images.length === 0) return text
    return [{ type: 'text', text }, ...(await Promise.all(exchange.images.map((image) => imagePart(image.blob, prepare))))]
}

/** The chat so far as messages: each earlier exchange that has an answer, then the question asked now. */
async function chatMessages(history: readonly Exchange[], exchange: Exchange, prepare: (image: Blob) => Promise<Blob>): Promise<ModelMessage[]> {
    const messages: ModelMessage[] = []
    for (const earlier of history) {
        if (earlier.answer.trim() === '' || earlier.status === 'failed') continue
        messages.push({ role: 'user', content: await userContent(earlier, prepare) })
        messages.push({ role: 'assistant', content: earlier.answer })
    }
    messages.push({ role: 'user', content: await userContent(exchange, prepare) })
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
    const { exchange, signal } = input
    const readsGraph = exchange.grant === 'graph' && input.model.tools
    try {
        const context = await assembleContext(exchange.grant, input.home, input.documents, undefined, input.block)
        // Shown under the question: exactly what was sent, and what was left out.
        const excerpt = context.documents.some((doc) => doc.excerpt)
        const unwritten = input.homeUnwritten === true && exchange.grant !== 'nothing'
        exchange.context = { included: context.included, leftOut: context.leftOut.map((doc) => doc.name), ...(excerpt ? { excerpt } : {}), ...(unwritten ? { unwritten } : {}) }
        input.changed()
        const system = instructions({
            grant: exchange.grant,
            home: input.home,
            context,
            homeUnwritten: input.homeUnwritten === true,
            today: input.today,
            formatGuide: exchange.grant === 'nothing' ? '' : input.documents.formatGuide(),
            canSearchGraph: readsGraph,
            agentInstruction: input.agentInstruction,
        })
        const messages = await chatMessages(input.history, exchange, input.prepareImage)
        const { model, tools: searchTools } = await (input.providerModel ?? providerModel)(input.connection, exchange.modelId, input.webSearch)
        const tools: ToolSet = readsGraph ? { ...graphTools(input.documents), ...searchTools } : searchTools
        if (signal.aborted) {
            exchange.status = 'stopped'
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
            // An error arrives as an `error` part below and is shown in the exchange; the SDK's own
            // handler would also write it to the console.
            onError: () => {},
        })
        let steps = 0
        for await (const part of result.fullStream) {
            switch (part.type) {
                case 'start-step':
                    // Text from a later step (after a tool call) starts a new paragraph.
                    steps += 1
                    if (steps > 1 && exchange.answer.trim() !== '' && !exchange.answer.endsWith('\n\n')) exchange.answer += '\n\n'
                    break
                case 'text-delta':
                    exchange.answer += part.text
                    // Kept as it streams, at most about once a second, so a tab closed mid-answer
                    // keeps what had arrived.
                    input.changed()
                    break
                case 'reasoning-delta':
                    // A reasoning model's thinking, shown while it works and never sent back.
                    exchange.reasoning = (exchange.reasoning ?? '') + part.text
                    input.changed()
                    break
                case 'tool-call':
                    if ((GRAPH_TOOL_NAMES as readonly string[]).includes(part.toolName) || part.toolName === 'web_search' || part.toolName === 'google_search') {
                        exchange.tools.push({ id: `${exchange.id}-tool-${exchange.tools.length}`, callId: part.toolCallId, summary: summarizeToolCall(part.toolName, part.input), status: 'running' })
                        input.changed()
                    }
                    break
                case 'tool-result':
                case 'tool-error': {
                    // The latest running call with that id: a provider may use one id in two steps.
                    const chip = exchange.tools.findLast((candidate) => candidate.callId === part.toolCallId && candidate.status === 'running')
                    if (chip) chip.status = part.type === 'tool-result' ? 'done' : 'failed'
                    break
                }
                case 'source':
                    if (part.sourceType === 'url' && !exchange.sources.some((source) => source.url === part.url)) {
                        exchange.sources.push({ url: part.url, title: part.title ?? new URL(part.url).hostname })
                    }
                    break
                case 'error':
                    throw part.error
                case 'abort':
                    exchange.status = 'stopped'
                    break
            }
        }
        if (exchange.status === 'streaming') {
            if (signal.aborted) exchange.status = 'stopped'
            else if (exchange.answer.trim() === '') {
                exchange.status = 'failed'
                exchange.error = NO_ANSWER
            } else exchange.status = 'done'
        }
    } catch (error) {
        if (signal.aborted) {
            exchange.status = 'stopped'
        } else {
            exchange.status = 'failed'
            exchange.error = failureMessage(error, input.connection)
        }
    } finally {
        for (const chip of exchange.tools) if (chip.status === 'running') chip.status = exchange.status === 'done' ? 'done' : 'failed'
        input.changed()
    }
}
