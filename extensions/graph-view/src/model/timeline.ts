/**
 * The [[Graph View]]'s time-lapse: on which day each concept and line first appears, so the
 * whole graph can be replayed day by day.
 *
 * Journal days are the only dates there are. A page has no creation date the index can reach
 * (the Server Backend keeps none, and a folder's modification time changes on every save), so
 * a concept is dated by the first [[Journal Entry]] that links to it, a journal entry by its own
 * day, and a line by the later of its two ends. A concept no journal entry ever mentions has no
 * date and is shown from the start.
 */
import type { LinkGraph } from '@appsoftwareltd/etherpk-extension-api'

export interface Timeline {
    /** Every day on which something first appears, earliest first. */
    days: string[]
    /** `YYYY-MM-DD`, or null for a concept present from the start. */
    conceptDay(key: string): string | null
    /** The later of the two ends' days, or null when both are present from the start. */
    lineDay(a: string, b: string): string | null
}

const earlier = (a: string | undefined, b: string) => (a === undefined || b < a ? b : a)

export function timelineOf(data: LinkGraph): Timeline {
    const dayOf = new Map<string, string>()
    // Only a journal entry named for a day that exists dates anything (CONTEXT.md, Journal Concept):
    // the index says which, by giving it its `day`.
    const journalDay = data.concepts.map((concept) => (concept.kind === 'journal' ? concept.day : undefined))
    data.concepts.forEach((concept, index) => {
        const day = journalDay[index]
        if (day) dayOf.set(concept.key, day)
    })
    for (const link of data.links) {
        const day = journalDay[link.source]
        const target = data.concepts[link.target]
        if (day && target) dayOf.set(target.key, earlier(dayOf.get(target.key), day))
    }
    const conceptDay = (key: string) => dayOf.get(key) ?? null
    return {
        days: [...new Set(dayOf.values())].sort(),
        conceptDay,
        lineDay(a, b) {
            const first = conceptDay(a)
            const second = conceptDay(b)
            if (first === null) return second
            if (second === null) return first
            return first > second ? first : second
        },
    }
}
