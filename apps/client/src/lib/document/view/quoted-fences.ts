/**
 * What a read-only quote shows for a fence an extension draws (ADR 0146): the answer of its
 * registration's `quote`, a picture drawn in the app's theme or a link, which the reference lists of
 * the Backlinks panel and the section beneath a document show where the editor would mount the
 * widget (`QuotedFence.svelte`). A quote never mounts the widget itself: a widget is made for the
 * document's column, and the extensions keep that column's width as one value for every widget
 * they draw, which a narrower panel would change under the document.
 *
 * - **Checked**, as the publisher checks a `publish` answer (`fence-answer.ts`), and an SVG cleaned
 *   (`security/svg-file.ts`).
 * - **Kept.** The answers last given are kept, by the registration that gave them, the fence's text,
 *   its document and the theme, so a reference shown again, or the same block in another list,
 *   shows at once without asking the extension again. An extension started again registers anew,
 *   and is asked afresh, and so is one whose own settings changed (`quotesChanged`), since a
 *   setting can change what it may show, such as a video's thumbnail.
 * - **In time, or not at all.** An answer that has not come within {@link ANSWER_MS} is a failure.
 *   A failure is not kept, so the next showing asks again.
 *
 * Framework-free: `QuotedFence.svelte` shows the answers, and only it knows the lists.
 */
import type { PublishedFence, QuoteFenceRequest } from '@appsoftwareltd/etherpk-extension-api'

import { cleanedFencePicture } from '$lib/security/svg-file'

import { checkedFenceAnswer } from '../fence-answer'
import type { InteractiveFence } from './augmentations/interactive-fence-contract'

export interface QuotedFences {
    /**
     * The registration's answer for this fence: kept, or asked for now. Null when it has no `quote`,
     * or answered that it shows nothing. Rejects when it threw, did not answer in time, or answered
     * with something a quote cannot show.
     */
    quote(fence: InteractiveFence, request: QuoteFenceRequest): Promise<PublishedFence | null>
}

export interface QuotedFencesOptions {
    /** How many answers are kept; the one shown longest ago is let go first. */
    capacity?: number
    /** How long an answer may take before it is a failure. */
    answerMs?: number
}

/** Answers kept at once: a panel's worth of drawings, whose pictures can carry their fonts. */
const KEPT_ANSWERS = 24
/**
 * How long an extension may take to answer: long enough for Excalidraw to load itself for the
 * first drawing on a slow connection, short enough that a quote never waits for good.
 */
const ANSWER_MS = 30_000

/** The answer, or a failure once `ms` have passed without one. */
function inTime<T>(answer: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`it did not answer within ${Math.round(ms / 1000)} seconds`)), ms)
    })
    return Promise.race([answer, late]).finally(() => clearTimeout(timer))
}

export function createQuotedFences(options: QuotedFencesOptions = {}): QuotedFences {
    const capacity = options.capacity ?? KEPT_ANSWERS
    const answerMs = options.answerMs ?? ANSWER_MS
    /**
     * Each registration's number, so the keys of a registration made again never match the old. A
     * registration whose extension's settings changed takes a new number, and its old answers, no
     * longer reached, are let go in their turn.
     */
    const registrations = new WeakMap<InteractiveFence, number>()
    let next = 0
    /** Kept answers, the one shown longest ago first: a Map keeps the order entries were set in. */
    const answers = new Map<string, Promise<PublishedFence | null>>()

    function idOf(fence: InteractiveFence): number {
        let id = registrations.get(fence)
        if (id === undefined) {
            id = next++
            registrations.set(fence, id)
            // Heard for as long as the registration lasts: its extension stops hearing as it stops.
            fence.quotesChanged?.(() => registrations.set(fence, next++))
        }
        return id
    }

    function keyOf(fence: InteractiveFence, request: QuoteFenceRequest): string {
        return JSON.stringify([idOf(fence), request.dark, request.info, request.document, request.body])
    }

    return {
        quote(fence, request) {
            const quote = fence.quote
            if (!quote) return Promise.resolve(null)
            const key = keyOf(fence, request)
            const kept = answers.get(key)
            if (kept) {
                // Shown again: now the one shown most recently.
                answers.delete(key)
                answers.set(key, kept)
                return kept
            }
            // Whatever the extension does, a promise to wait on and catch: a throw is a rejection.
            const answer = (async () => cleanedFencePicture(checkedFenceAnswer(await quote.call(fence, { ...request, body: [...request.body] }))))()
            const asked = inTime(answer, answerMs)
            answers.set(key, asked)
            asked.catch(() => {
                if (answers.get(key) === asked) answers.delete(key)
            })
            for (const oldest of answers.keys()) {
                if (answers.size <= capacity) break
                answers.delete(oldest)
            }
            return asked
        },
    }
}

/** The answers every quote in the app shares: keyed by registration, so graphs never share one. */
export const quotedFences: QuotedFences = createQuotedFences()
