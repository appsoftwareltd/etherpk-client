/**
 * The [[Graph View]]'s query over the [[Derived Index]]: every [[Concept]] and every pair of
 * concepts a [[Wikilink]] joins, in one answer.
 *
 * Everything comes from rows the index already holds: the `pages` and `aliases` tables, and the
 * `links` table grouped by source document. No document is opened or parsed, which is what lets
 * a whole graph be drawn from one round trip.
 *
 * A [[Protected Document]] contributes no body links (the parser suppresses links inside the
 * cipher fence, and the index never sees plaintext), so it appears here as a name with lines in
 * from plaintext documents and none out. Its title scopes still draw a line, because a page's
 * name is visible wherever the page is.
 */
import { activeIndexGeneration, type SqlDb } from './index-db'

/** One dot: a page, a journal entry, or a concept no page resolves to yet. */
export interface LinkGraphConcept {
    /** Case-insensitive identity (ADR 0011), the same key every other index answer uses. */
    key: string
    /** The page's title, or for a Pageless Concept the casing most of its mentions use. */
    name: string
    kind: 'page' | 'journal' | 'pageless'
    /** Present, and true, only for a [[Protected Document]]. */
    protected?: true
}

/**
 * One line, from the document whose text holds the wikilinks to the concept they name. Both
 * ends are positions in {@link LinkGraph.concepts}: a whole graph's names would otherwise be
 * repeated once per line in a message that crosses the worker boundary.
 */
export interface LinkGraphLink {
    source: number
    target: number
    /** How many wikilinks in the source name the target, under its name or any alias. */
    mentions: number
    /** Present, and true, when the source's own name scopes it by the target (ADR 0083). */
    inTitle?: true
}

export interface LinkGraph {
    /** Sorted by key, so two answers over the same index are identical. */
    concepts: LinkGraphConcept[]
    /** Sorted by source, then target. A pair linked both ways is two links. */
    links: LinkGraphLink[]
}

/** One wikilink as the JSON rows carry it: target key, target as written, in the source's own name. */
type WrittenLink = [key: string, written: string, inTitle: number]

export function linkGraph(db: SqlDb): LinkGraph {
    const generation = activeIndexGeneration(db)
    const pages = db.all<{ concept: string; key: string; kind: 'page' | 'journal'; protected: number }>(
        'SELECT concept, concept_key AS key, kind, protected FROM pages WHERE generation = ? ORDER BY id',
        [generation],
    )
    const aliases = db.all<{ key: string; page: string }>(
        'SELECT a.alias_key AS key, p.concept_key AS page FROM aliases a JOIN pages p ON p.id = a.page_id WHERE p.generation = ? ORDER BY a.page_id',
        [generation],
    )
    // One row per source DOCUMENT, its links as a JSON array. Reading a row costs far more than
    // parsing JSON in sqlite-wasm: a row per (document, target) pair took about 195 ms on a 2,838
    // document graph, and this takes about 30 ms.
    const rows = db.all<{ source: string; links: string }>(
        `SELECT p.concept_key AS source, json_group_array(json_array(l.concept_key, l.concept, l.in_title)) AS links
         FROM links l JOIN pages p ON p.id = l.page_id
         WHERE p.generation = ?
         GROUP BY p.id`,
        [generation],
    )

    const concepts = new Map<string, LinkGraphConcept>()
    for (const page of pages) {
        if (concepts.has(page.key)) continue
        const concept: LinkGraphConcept = { key: page.key, name: page.concept, kind: page.kind }
        concepts.set(page.key, page.protected ? { ...concept, protected: true } : concept)
    }
    // An alias names its page, so a link written through one is a line to that page. A page's
    // own name wins over an alias that spells the same name, as it does when a wikilink is opened.
    const pageOfAlias = new Map<string, string>()
    for (const alias of aliases) {
        if (!concepts.has(alias.key) && !pageOfAlias.has(alias.key)) pageOfAlias.set(alias.key, alias.page)
    }
    const resolve = (key: string) => (concepts.has(key) ? key : (pageOfAlias.get(key) ?? key))

    // Every other target is a Pageless Concept, named by the casing most of its mentions use;
    // ties go to the one that sorts first, which puts a Title-Cased spelling ahead (as
    // conceptCandidates does, so a Draft opened from the Graph View is named the same way).
    const parsed = rows.map((row) => ({ source: row.source, links: JSON.parse(row.links) as WrittenLink[] }))
    const spellings = new Map<string, Map<string, number>>()
    for (const row of parsed) {
        for (const [key, written] of row.links) {
            if (concepts.has(resolve(key))) continue
            const counts = spellings.get(key) ?? new Map<string, number>()
            counts.set(written, (counts.get(written) ?? 0) + 1)
            spellings.set(key, counts)
        }
    }
    for (const [key, counts] of spellings) {
        let name = ''
        let best = 0
        for (const [written, count] of counts) {
            if (count > best || (count === best && written < name)) {
                name = written
                best = count
            }
        }
        concepts.set(key, { key, name, kind: 'pageless' })
    }

    const ordered = [...concepts.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const position = new Map(ordered.map((concept, index) => [concept.key, index]))
    const lines = new Map<string, LinkGraphLink>()
    for (const row of parsed) {
        const source = position.get(row.source)
        if (source === undefined) continue
        for (const [key, , inTitle] of row.links) {
            const target = position.get(resolve(key))
            if (target === undefined || source === target) continue
            const id = `${source}:${target}`
            const line = lines.get(id) ?? { source, target, mentions: 0 }
            line.mentions += 1
            if (inTitle) line.inTitle = true
            lines.set(id, line)
        }
    }
    const links = [...lines.values()].sort((a, b) => a.source - b.source || a.target - b.target)
    return { concepts: ordered, links }
}
