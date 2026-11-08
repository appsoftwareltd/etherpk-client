/**
 * How fast a person reads, against foliate's estimate, which is the text left over a fixed number. Held
 * on the device, and nothing about it leaves. A turn only counts when it looks like reading: a jump, a
 * skim or a walk away tells nothing about a person's pace.
 */
export interface ReadingPace {
    /** Minutes this person takes for one minute of the estimate. */
    factor: number
    samples: number
}

export const NEW_PACE: ReadingPace = { factor: 1, samples: 0 }

/** Fewer turns than this say little, so the estimate stands until there are as many. */
const SAMPLES_TO_TRUST = 5
/** A later turn counts for this share at least, so a person's pace can change. */
const MOST_REMEMBERED = 200
const SHORTEST_TURN_MINUTES = 2 / 60
const LONGEST_TURN_MINUTES = 5
const LONGEST_ESTIMATE_MINUTES = 5
const FACTOR_RANGE = { min: 0.2, max: 5 }

function looksLikeReading(estimateMinutes: number, elapsedMinutes: number): boolean {
    return estimateMinutes > 0 && estimateMinutes <= LONGEST_ESTIMATE_MINUTES && elapsedMinutes >= SHORTEST_TURN_MINUTES && elapsedMinutes <= LONGEST_TURN_MINUTES
}

/** The pace after one turn of the page, or the same pace when the turn says nothing about it. */
export function paceAfterTurn(pace: ReadingPace, estimateMinutes: number, elapsedMinutes: number): ReadingPace {
    if (!looksLikeReading(estimateMinutes, elapsedMinutes)) return pace
    const ratio = Math.min(FACTOR_RANGE.max, Math.max(FACTOR_RANGE.min, elapsedMinutes / estimateMinutes))
    const weight = Math.min(pace.samples, MOST_REMEMBERED)
    return { factor: (pace.factor * weight + ratio) / (weight + 1), samples: pace.samples + 1 }
}

/** The estimate, as this person's pace makes it. */
export function paceMinutes(pace: ReadingPace, estimateMinutes: number): number {
    return pace.samples >= SAMPLES_TO_TRUST ? estimateMinutes * pace.factor : estimateMinutes
}

/** Whether a stretch of time between turns counts as time spent reading today. */
export function countsAsReading(elapsedMinutes: number): boolean {
    return elapsedMinutes > 0 && elapsedMinutes <= LONGEST_TURN_MINUTES
}

export function sanitizePace(raw: unknown): ReadingPace {
    const { factor, samples } = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const good = typeof factor === 'number' && factor >= FACTOR_RANGE.min && factor <= FACTOR_RANGE.max && typeof samples === 'number' && samples >= 0
    return good ? { factor, samples } : NEW_PACE
}

/** Minutes as a person reads them: "12 min", "2 h 5 min". */
export function formatMinutes(minutes: number): string {
    const rounded = Math.round(minutes)
    if (rounded < 1) return 'under a minute'
    if (rounded < 60) return `${rounded} min`
    const hours = Math.floor(rounded / 60)
    return rounded % 60 === 0 ? `${hours} h` : `${hours} h ${rounded % 60} min`
}
