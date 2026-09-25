/**
 * Logseq journal date grammars. File names follow `:journal/file-name-format` (default
 * `yyyy_MM_dd`); date-page links follow `:journal/page-title-format` (default
 * `MMM do, yyyy`). Both convert to the ISO date that IS a journal's concept in EtherPK.
 * Unknown format tokens make the parser return null - the caller leaves the value
 * untouched and reports it once.
 */

const MONTHS = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
]

function monthNumber(name: string): number {
    const lower = name.toLowerCase()
    const index = MONTHS.findIndex((m) => m === lower || m.slice(0, 3) === lower)
    return index + 1
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Order matters: longer tokens first so `MMMM` is not read as two `MM`s. */
const TOKENS: Array<[token: string, pattern: string, kind: 'year' | 'monthName' | 'month' | 'day' | 'skip']> = [
    ['yyyy', '(\\d{4})', 'year'],
    ['MMMM', '([A-Za-z]+)', 'monthName'],
    ['MMM', '([A-Za-z]{3})', 'monthName'],
    ['MM', '(\\d{2})', 'month'],
    ['M', '(\\d{1,2})', 'month'],
    ['EEEE', '[A-Za-z]+', 'skip'],
    ['EEE', '[A-Za-z]{3}', 'skip'],
    ['do', '(\\d{1,2})(?:st|nd|rd|th)', 'day'],
    ['dd', '(\\d{2})', 'day'],
    ['d', '(\\d{1,2})', 'day'],
]

interface DateGrammar {
    regex: RegExp
    order: Array<'year' | 'monthName' | 'month' | 'day'>
}

/** Compile a Logseq date format into a regex, or null when it uses tokens we don't know. */
function compile(format: string): DateGrammar | null {
    let pattern = '^'
    const order: DateGrammar['order'] = []
    let i = 0
    outer: while (i < format.length) {
        for (const [token, tokenPattern, kind] of TOKENS) {
            if (format.startsWith(token, i)) {
                pattern += tokenPattern
                if (kind !== 'skip') order.push(kind)
                i += token.length
                continue outer
            }
        }
        const ch = format[i]
        if (/[A-Za-z]/.test(ch)) return null // an unrecognised format token
        pattern += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        i += 1
    }
    if (!order.includes('year') || !order.includes('day')) return null
    if (!order.includes('month') && !order.includes('monthName')) return null
    return { regex: new RegExp(pattern + '$', 'i'), order }
}

const grammarCache = new Map<string, DateGrammar | null>()

function grammarFor(format: string): DateGrammar | null {
    if (!grammarCache.has(format)) grammarCache.set(format, compile(format))
    return grammarCache.get(format) ?? null
}

/** Parse a date string against a Logseq format; ISO `YYYY-MM-DD` or null. */
export function logseqDateToIso(value: string, format: string): string | null {
    const grammar = grammarFor(format)
    if (!grammar) return null
    const match = grammar.regex.exec(value.trim())
    if (!match) return null
    let year = 0
    let month = 0
    let day = 0
    grammar.order.forEach((kind, i) => {
        const captured = match[i + 1]
        if (kind === 'year') year = Number(captured)
        else if (kind === 'month') month = Number(captured)
        else if (kind === 'monthName') month = monthNumber(captured)
        else day = Number(captured)
    })
    if (month < 1 || month > 12 || day < 1 || day > 31) return null
    return `${year}-${pad(month)}-${pad(day)}`
}

export interface LogseqConfig {
    /** `:journal/file-name-format`, default `yyyy_MM_dd`. */
    journalFileFormat: string
    /** `:journal/page-title-format`, default `MMM do, yyyy`. */
    journalTitleFormat: string
}

/** Read the two journal formats out of `logseq/config.edn` (regex - we don't parse EDN). */
export function parseLogseqConfig(edn: string | null): LogseqConfig {
    const read = (key: string) =>
        edn ? new RegExp(`:journal/${key}\\s+"([^"]+)"`).exec(edn)?.[1] : undefined
    return {
        journalFileFormat: read('file-name-format') ?? 'yyyy_MM_dd',
        journalTitleFormat: read('page-title-format') ?? 'MMM do, yyyy',
    }
}
