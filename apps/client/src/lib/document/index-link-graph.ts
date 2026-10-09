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
import type { LinkGraph, LinkGraphConcept, LinkGraphLink } from '@appsoftwareltd/etherpk-extension-api'

import { activeIndexGeneration, type SqlDb } from './index-db'
import { isJournalConcept } from './journal-concept'

/**
 * The answer's shape is the Extension API's (ADR 0120), since extensions ask this question: one
 * dot per concept, one line per pair, both ends of a line positions in the concept list so a whole
 * graph's names are not repeated once per line in a message that crosses the worker boundary.
 */
export type { LinkGraph, LinkGraphConcept, LinkGraphLink }

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
        // Only a journal entry named for a day that exists is dated (CONTEXT.md, Journal Concept),
        // said here so no reader of the answer needs the calendar rule.
        if (page.kind === 'journal' && isJournalConcept(page.concept)) concept.day = page.concept
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
