/**
 * [[Template Variable]]s: the `{{name}}` text in a [[Template]] that is filled in when the
 * Template is copied (ADR 0144).
 *
 * Every variable gives plain text, so a link is written around one (`[[{{date}}]]`). The date
 * variables read the context's `day`, which is the receiving [[Journal Entry]]'s own day or
 * today anywhere else; the time variables read the clock. A name this module does not know is
 * copied as written, so `{{name}}` in a Handlebars sample survives a copy, and a backslash before
 * the braces (`\{{date}}`) writes the braces literally.
 *
 * Pure and framework-free: the Client's insert command, the Journal Template's [[Draft]] and the
 * Headless Client all render through `renderTemplate`.
 */

import { formatISODate, parseISODate, shiftDate, todayISO } from '../calendar/month-grid-core'
import { isJournalConcept } from '../journal-concept'

export interface TemplateContext {
    /** The ISO day the date variables mean: the receiving journal entry's day, or today. */
    day: string
    /** The moment of the copy, read by the time variables. */
    now: Date
    /** The receiving document's name, the day for a journal entry. */
    title: string
}

export interface RenderedTemplate {
    /** The body with every known variable filled in and every `{{cursor}}` removed. */
    text: string
    /** Where the first `{{cursor}}` stood in `text`, or null when there was none. */
    cursor: number | null
}

export interface TemplateVariableSpan {
    from: number
    to: number
    /** Whether `renderTemplate` fills this one in. An unknown name is copied as written. */
    known: boolean
}

/**
 * Double braces around anything without a brace, with an optional backslash before them. One
 * pass with this pattern is the whole renderer, so a value it writes is never read again.
 */
const VARIABLE = /(\\?)\{\{([^{}]+)\}\}/g

/** The format tokens, longest first so `YYYY` is never read as two `YY`s. Case-sensitive. */
const FORMAT_TOKEN = /YYYY|YY|MM|DD|HH|mm|ss/g

const FORMAT_PREFIX = /^(date|time):(.+)$/i

/** The context for copying a Template into the document named `concept`, at `now`. */
export function templateContextFor(concept: string, now: Date = new Date()): TemplateContext {
    return { day: isJournalConcept(concept) ? concept.trim() : todayISO(now), now, title: concept }
}

/** Fill in `body`'s variables for `context`. */
export function renderTemplate(body: string, context: TemplateContext): RenderedTemplate {
    const day = parseISODate(context.day) ?? context.now
    let cursor: number | null = null
    let text = ''
    let last = 0
    for (const match of body.matchAll(VARIABLE)) {
        const [whole, backslash, inner] = match
        text += body.slice(last, match.index)
        last = match.index + whole.length
        if (backslash) {
            text += whole.slice(1)
            continue
        }
        const name = inner.trim().toLowerCase()
        if (name === 'cursor') {
            // Only the first cursor places the caret. A second one would leave the author's
            // marker in the copy, which is never what they meant, so it goes too.
            cursor ??= text.length
            continue
        }
        text += valueOf(inner.trim(), day, context) ?? whole
    }
    return { text: text + body.slice(last), cursor }
}

/** Every variable in `text`, for marking them in a Template as it is written. */
export function templateVariableSpans(text: string): TemplateVariableSpan[] {
    const spans: TemplateVariableSpan[] = []
    for (const match of text.matchAll(VARIABLE)) {
        const [whole, backslash, inner] = match
        if (backslash) continue
        const name = inner.trim().toLowerCase()
        spans.push({ from: match.index, to: match.index + whole.length, known: name === 'cursor' || isKnown(inner.trim()) })
    }
    return spans
}

function isKnown(inner: string): boolean {
    // Any day and time will do: the question is only whether a value comes back.
    return valueOf(inner, new Date(2000, 0, 1), { day: '2000-01-01', now: new Date(2000, 0, 1), title: '' }) !== null
}

/** The text a variable stands for, or null for a name this module does not know. */
function valueOf(inner: string, day: Date, context: TemplateContext): string | null {
    switch (inner.toLowerCase()) {
        case 'date':
            return formatISODate(day)
        case 'yesterday':
            return formatISODate(shiftDate(day, -1))
        case 'tomorrow':
            return formatISODate(shiftDate(day, 1))
        case 'time':
            return format('HH:mm', day, context.now)
        case 'datetime':
            return `${formatISODate(day)} ${format('HH:mm', day, context.now)}`
        case 'title':
            return context.title
    }
    const custom = FORMAT_PREFIX.exec(inner)
    // `date:` and `time:` share one formatter: the prefix says what the author meant, and the
    // tokens decide what is printed, the date fields from the day and the time fields from now.
    return custom ? format(custom[2], day, context.now) : null
}

function format(pattern: string, day: Date, now: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    return pattern.replace(FORMAT_TOKEN, (token) => {
        switch (token) {
            case 'YYYY':
                return String(day.getFullYear())
            case 'YY':
                return pad(day.getFullYear() % 100)
            case 'MM':
                return pad(day.getMonth() + 1)
            case 'DD':
                return pad(day.getDate())
            case 'HH':
                return pad(now.getHours())
            case 'mm':
                return pad(now.getMinutes())
            default:
                return pad(now.getSeconds())
        }
    })
}
