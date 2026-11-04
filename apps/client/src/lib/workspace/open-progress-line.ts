/**
 * The count on the graph opening screen, such as "Indexing 0900 of 2932 documents…".
 *
 * Every line of one run has the same number of characters, so in a fixed-width font neither the
 * line nor the progress bar sized to it changes width as the count runs. That is why the count is
 * padded to the total's digits, why the verbs are padded to one length ("Loading" gives way to
 * "Indexing" during a cold open), and why there are no thousands separators, which appear only
 * once the count reaches four digits.
 */

const VERBS = { loading: 'Loading ', indexing: 'Indexing' } as const

export function openProgressLine(step: keyof typeof VERBS, progress: { done: number; total: number }): string {
    const total = String(progress.total)
    const done = String(progress.done).padStart(total.length, '0')
    return `${VERBS[step]} ${done} of ${total} documents…`
}
