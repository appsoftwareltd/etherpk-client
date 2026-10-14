import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { shownBacklinkGroups } from './backlinks/shown-backlinks'
import { backlinksFor, conceptCandidates, createSchema, indexDocHash, indexDocumentFactKeys, ingest, type IndexDoc, type SqlDb, templatePages } from './index-db'
import { wrapOo1Db } from './index-db-sqlite'
import { linkGraph } from './index-link-graph'
import { mapItems } from './index-map-items'

// A [[Template]]'s content is a pattern, not knowledge (ADR 0144): its tasks and places belong to
// no relation, and the views that show links leave its links out. Its link rows are still kept,
// marked, because a rename on a Server Backend rewrites only the documents the index says link to
// the old name, and a Template's `[[Garden]]` must follow Garden's rename like any other link.

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>

beforeAll(async () => {
    sqlite3 = await sqlite3InitModule()
})

let db: SqlDb

beforeEach(() => {
    db = wrapOo1Db(new sqlite3.oo1.DB(':memory:'))
    createSchema(db)
})

const page = (concept: string, text = ''): IndexDoc => ({ concept, kind: 'page', aliases: [], text })
const template = (concept: string, text = ''): IndexDoc => ({ ...page(concept, text), template: true })

const templateText = ['- Review of [[{{date}}]] for [[Garden]]', '  - [ ] water the beans', '```map', 'Pebble Cove @ 50.74860, -4.07890', '```'].join('\n')

function taskCount(): number {
    return db.all<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')[0].n
}

describe('a Template in the Derived Index', () => {
    it('contributes no tasks and no places', () => {
        ingest(db, [template('Daily Review', templateText)])
        expect(taskCount()).toBe(0)
        expect(mapItems(db, null).items).toEqual([])
    })

    it('still holds its blocks, so Search finds it', () => {
        ingest(db, [template('Daily Review', templateText)])
        const rows = db.all<{ n: number }>("SELECT COUNT(*) AS n FROM block_fts WHERE block_fts MATCH 'beans'")
        expect(rows[0].n).toBe(1)
    })

    it('keeps its links, marked as a Template’s, for a rename to find', () => {
        ingest(db, [template('Daily Review', templateText), page('Garden'), page('Kitchen', '- see [[Garden]]')])
        expect(backlinksFor(db, 'Garden').map((g) => [g.sourceConcept, g.sourceIsTemplate])).toEqual([
            ['Daily Review', true],
            ['Kitchen', false],
        ])
    })

    it('makes no link for a target that holds a variable, so no page called {{date}} is offered', () => {
        ingest(db, [template('Daily Review', templateText)])
        expect(conceptCandidates(db).map((c) => c.display)).not.toContain('{{date}}')
        expect(backlinksFor(db, '{{date}}')).toEqual([])
    })

    it('treats a variable in a link on an ordinary page as text like any other', () => {
        ingest(db, [page('Kitchen', '- [[{{date}}]]')])
        expect(conceptCandidates(db).map((c) => c.display)).toContain('{{date}}')
    })

    it('counts a protected page as no Template', () => {
        const cipher = '```etherpk-cipher\nAAAA\n```'
        ingest(db, [{ ...template('Locked', cipher) }, page('Garden')])
        expect(db.all<{ template: number }>("SELECT template FROM pages WHERE concept = 'Locked'")[0].template).toBe(0)
    })

    it('re-indexes a document whose template mark changes and nothing else', () => {
        expect(indexDocHash(page('Daily Review', '- x'))).not.toBe(indexDocHash(template('Daily Review', '- x')))
    })

    it('reports the same link targets to update bookkeeping as it writes', () => {
        expect(indexDocumentFactKeys(template('Daily Review', templateText)).linkTargets).toEqual(['garden'])
    })
})

describe('shownBacklinkGroups', () => {
    it('leaves a Template’s body links out of the backlinks a person sees', () => {
        ingest(db, [template('Daily Review', templateText), page('Garden'), page('Kitchen', '- see [[Garden]]')])
        expect(shownBacklinkGroups(backlinksFor(db, 'Garden')).map((g) => g.sourceConcept)).toEqual(['Kitchen'])
    })

    it('keeps a Template’s name, so a Templates page lists the Templates scoped by it', () => {
        ingest(db, [template('[[Templates]] Daily', '- [[Garden]]'), page('Templates'), page('Garden')])
        const shown = shownBacklinkGroups(backlinksFor(db, 'Templates'))
        expect(shown.map((g) => [g.sourceConcept, g.refs.map((r) => r.kind)])).toEqual([['[[Templates]] Daily', ['title']]])
    })

    it('leaves out a document’s links to itself, as before', () => {
        ingest(db, [page('Garden', '- [[Garden]] again'), page('Kitchen', '- [[Garden]]')])
        expect(shownBacklinkGroups(backlinksFor(db, 'Garden')).map((g) => g.sourceConcept)).toEqual(['Kitchen'])
    })
})

describe('the Graph View leaves Templates out', () => {
    it('draws no dot for a Template and no line from or to it', () => {
        ingest(db, [template('Daily Review', templateText), page('Garden', '- uses [[Daily Review]]'), page('Kitchen', '- [[Garden]]')])
        const graph = linkGraph(db)
        expect(graph.concepts.map((c) => c.name).sort()).toEqual(['Garden', 'Kitchen'])
        expect(graph.links.map((l) => `${graph.concepts[l.source].name} -> ${graph.concepts[l.target].name}`)).toEqual(['Kitchen -> Garden'])
    })
})

describe('templatePages', () => {
    it('lists the graph’s Templates by name, each with its first line for the picker', () => {
        ingest(db, [
            template('Weekly Review', '\n- [[{{date}}]] review\n  - [ ] water the beans'),
            page('Garden', '- beds'),
            template('[[Templates]] Daily', '# Morning\n- plan'),
            template('Empty Pattern', ''),
        ])
        expect(templatePages(db)).toEqual([
            { concept: 'Empty Pattern', firstLine: '' },
            { concept: '[[Templates]] Daily', firstLine: 'Morning' },
            { concept: 'Weekly Review', firstLine: '[[{{date}}]] review' },
        ])
    })

    it('leaves out a protected page and a journal entry', () => {
        ingest(db, [template('Locked', '```etherpk-cipher\nAAAA\n```'), { concept: '2026-10-14', kind: 'journal', aliases: [], text: '- x', template: true }])
        expect(templatePages(db)).toEqual([])
    })
})
