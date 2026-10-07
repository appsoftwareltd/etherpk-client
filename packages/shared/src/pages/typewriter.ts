/** How long each step of the typewriter lasts. */
export interface TypewriterTiming {
    /** How long a whole word stays on screen. */
    holdMs: number
    /** The pause between one deleted character and the next. */
    deleteMs: number
    /** The pause between one typed character and the next. */
    typeMs: number
}

/** One state of the typed text, shown for `waitMs` before the next frame replaces it. */
export interface TypewriterFrame {
    text: string
    waitMs: number
    /** True while a whole word is held: a terminal's caret blinks then, and stays solid while typing. */
    holding: boolean
}

/**
 * The frames of a terminal-style typewriter that types each word over the one before it: the
 * word on screen is held, deleted a character at a time, and the next typed a character at a
 * time. It starts on the first word and ends on it again, so the text it settles on is the text
 * the page had before it started. One word, or none, gives nothing to animate.
 *
 * Plain data rather than timers, so the sequence can be tested without a clock and the component
 * that plays it only has to step through the list.
 */
export function typewriterFrames(words: readonly string[], timing: TypewriterTiming): TypewriterFrame[] {
    const [first] = words
    if (first === undefined) return []

    const frames: TypewriterFrame[] = [{ text: first, waitMs: timing.holdMs, holding: true }]
    if (words.length < 2) return frames

    // Characters, not UTF-16 units, so a word with an emoji or an accent is never cut in half.
    let shown = Array.from(first)
    for (const word of [...words.slice(1), first]) {
        while (shown.length > 0) {
            shown = shown.slice(0, -1)
            // The last deletion leaves nothing, and the next thing to happen is the first keystroke.
            frames.push({ text: shown.join(''), waitMs: shown.length > 0 ? timing.deleteMs : timing.typeMs, holding: false })
        }
        const target = Array.from(word)
        for (let length = 1; length <= target.length; length++) {
            const whole = length === target.length
            frames.push({ text: target.slice(0, length).join(''), waitMs: whole ? timing.holdMs : timing.typeMs, holding: whole })
        }
        shown = target
    }
    return frames
}
