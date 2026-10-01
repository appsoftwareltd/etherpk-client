import { describe, expect, it } from 'vitest'

import { parseFrontmatter } from '$lib/storage/fs/frontmatter'
import { aliasesOf } from '$lib/storage/fs/identity'

import { convertAsNotes } from './asnotes'
import type { ConvertedGraph, SourceFile } from './types'

function src(path: string, content: string | Uint8Array<ArrayBuffer>): SourceFile {
    return { path, data: new Blob([content]) }
}

/** An initialised AS Notes workspace: `.asnotes/` beside the given files. */
function workspace(...files: SourceFile[]): SourceFile[] {
    return [src('.asnotes/index.db', new Uint8Array([1])), src('.asnotes/.gitignore', 'index.db\n'), ...files]
}

function doc(graph: ConvertedGraph, concept: string) {
    const found = graph.documents.find((d) => d.concept === concept)
    if (!found) throw new Error(`no document with concept "${concept}" in ${graph.documents.map((d) => d.concept).join(', ')}`)
    return found
}

function details(graph: ConvertedGraph, category: string): string[] {
    return graph.report.filter((r) => r.category === category).map((r) => r.detail)
}

describe('convertAsNotes', () => {
    describe('journals', () => {
        it('keeps ISO journals, renames older underscore ones and rewrites the links to them', async () => {
            const graph = await convertAsNotes(
                workspace(
                    src('journals/2026-09-30.md', '# 2026-09-30\n- met [[2026_09_29]] about [[2026-09-30]]'),
                    src('journals/2026_09_29.md', '# 2026-09-29\nolder'),
                ),
            )
            expect(doc(graph, '2026-09-30')).toMatchObject({ kind: 'journal', fileName: '2026-09-30.md' })
            expect(doc(graph, '2026-09-30').text).toBe('# 2026-09-30\n- met [[2026-09-29]] about [[2026-09-30]]')
            expect(doc(graph, '2026-09-29')).toMatchObject({ kind: 'journal', fileName: '2026-09-29.md', text: '# 2026-09-29\nolder' })
            expect(details(graph, 'rename')).toContain('Journal "journals/2026_09_29.md" renamed to "2026-09-29.md"')
        })

        it('reads the journal folder from the workspace settings', async () => {
            const graph = await convertAsNotes(
                workspace(
                    src('.vscode/settings.json', '{\n  // where journals go\n  "as-notes.journalFolder": "daily/",\n}\n'),
                    src('daily/2026-09-30.md', 'today'),
                    src('journals/2026-09-28.md', 'not in the journal folder, but named for a free day'),
                    src('notes/2026-09-30.md', 'named for a day the journal folder has'),
                ),
            )
            expect(doc(graph, '2026-09-30').text).toBe('today')
            expect(doc(graph, '2026-09-28').kind).toBe('journal')
            expect(doc(graph, '2026-09-30 (2)').kind).toBe('page')
        })
    })

    describe('pages and links', () => {
        it('flattens folders, scopes clashing names, and re-points links to the closest folder', async () => {
            const graph = await convertAsNotes(
                workspace(
                    src('work/Notes.md', 'work notes'),
                    src('home/Notes.md', 'home notes'),
                    src('work/deep/Linker.md', 'see [[Notes]] and [[Unique]]'),
                    src('home/Other.md', 'see [[notes]]'),
                    src('elsewhere/Unique.md', 'unique'),
                ),
            )
            expect(doc(graph, '[[work]] Notes').text).toBe('---\ntitle: "[[work]] Notes"\n---\nwork notes')
            expect(doc(graph, '[[home]] Notes').kind).toBe('page')
            expect(doc(graph, 'Unique').text).toBe('---\ntitle: Unique\n---\nunique')
            expect(doc(graph, 'Linker').text).toContain('see [[[[work]] Notes]] and [[Unique]]')
            // Same directory wins outright.
            expect(doc(graph, 'Other').text).toContain('see [[[[home]] Notes]]')
        })

        it('rewrites a link whose characters AS Notes turns into underscores', async () => {
            const graph = await convertAsNotes(
                workspace(
                    src('A_B.md', 'slash'),
                    src('x_y.md', 'pipe'),
                    src('My Page.md', 'cased'),
                    src('user.md', '[[A/B]] [[x|y]] [[my page]] [[Nowhere/Yet]]'),
                ),
            )
            expect(doc(graph, 'user').text).toContain('[[A_B]] [[x_y]] [[my page]] [[Nowhere/Yet]]')
        })

        it('passes nested wikilinks through, as EtherPK reads them as scoped concepts', async () => {
            const graph = await convertAsNotes(
                workspace(
                    src('Outer [[Inner]] text.md', 'nested page'),
                    src('Inner.md', 'inner'),
                    src('user.md', 'see [[Outer [[Inner]] text]]'),
                ),
            )
            expect(doc(graph, 'Outer [[Inner]] text').text).toContain('title: Outer [[Inner]] text')
            expect(doc(graph, 'user').text).toContain('see [[Outer [[Inner]] text]]')
        })

        it('turns a markdown link to a note into a wikilink, and leaves code alone', async () => {
            const graph = await convertAsNotes(
                workspace(
                    src('notes/Other.md', 'x'),
                    src('notes/user.md', '[Other](Other.md) and [the other one](./Other.md)\n`[[A/B]]`\n```\n[[A/B]]\n```'),
                    src('A_B.md', 'y'),
                ),
            )
            const text = doc(graph, 'user').text
            expect(text).toContain('[[Other]] and the other one ([[Other]])')
            expect(text).toContain('`[[A/B]]`\n```\n[[A/B]]\n```')
        })

        it('imports .markdown files as pages', async () => {
            const graph = await convertAsNotes(workspace(src('Old Note.markdown', 'legacy')))
            expect(doc(graph, 'Old Note')).toMatchObject({ kind: 'page', fileName: 'Old Note.md' })
        })
    })

    describe('frontmatter', () => {
        it('gives a page its file name as its title and reports a title that differed', async () => {
            const graph = await convertAsNotes(
                workspace(src('Page.md', '---\ntitle: A Nicer Title\npublic: true\norder: 2\n---\n# Heading\nbody')),
            )
            expect(doc(graph, 'Page').text).toBe('---\ntitle: Page\npublic: true\norder: 2\n---\n# Heading\nbody')
            expect(details(graph, 'degradation')).toContain(
                'Frontmatter title "A Nicer Title" replaced by the page\'s name "Page" (AS Notes links name the file, and the title was only used when publishing)',
            )
        })

        it('writes a single alias as the list EtherPK reads', async () => {
            const graph = await convertAsNotes(
                workspace(
                    src('Long Page Name.md', '---\naliases: Short, Name\n---\nx'),
                    src('Listed.md', '---\naliases: [One, "Two"]\n---\nx'),
                    src('user.md', '[[Short, Name]] [[One]]'),
                ),
            )
            expect(aliasesOf(parseFrontmatter(doc(graph, 'Long Page Name').text))).toEqual(['Short, Name'])
            expect(aliasesOf(parseFrontmatter(doc(graph, 'Listed').text))).toEqual(['One', 'Two'])
            expect(doc(graph, 'user').text).toContain('[[Short, Name]] [[One]]')
        })

        it('reads a block YAML rejects the way AS Notes does, and keeps one it cannot read', async () => {
            const graph = await convertAsNotes(
                workspace(
                    src('Loose.md', '---\ntitle: Plans: 2026\ndescription: Notes: the lot\npublic: yes\naliases:\n  - Plans\n---\nbody'),
                    src('Nested.md', '---\ntitle: A: B\nsettings:\n  width: 3\n---\nbody'),
                ),
            )
            const loose = parseFrontmatter(doc(graph, 'Loose').text)
            expect(loose.data).toEqual({ title: 'Loose', description: 'Notes: the lot', public: true, aliases: ['Plans'] })
            expect(loose.body).toBe('body')
            expect(doc(graph, 'Nested').text).toBe('---\ntitle: A: B\nsettings:\n  width: 3\n---\nbody')
            expect(graph.report).toContainEqual(expect.objectContaining({ category: 'degradation', concept: 'Loose' }))
            expect(graph.report).toContainEqual(
                expect.objectContaining({ category: 'unsupported', concept: 'Nested', detail: expect.stringContaining('not valid YAML') }),
            )
        })
    })

    describe('tasks', () => {
        it('passes AS Notes tasks through, and gives a * task the - EtherPK reads', async () => {
            const graph = await convertAsNotes(
                workspace(src('todo.md', '- [ ] #P1 #W #D-2026-10-01 ship it\n* [x] #C-2026-09-01 done\n  * [ ] child\n* plain bullet')),
            )
            expect(doc(graph, 'todo').text).toBe(
                '---\ntitle: todo\n---\n- [ ] #P1 #W #D-2026-10-01 ship it\n- [x] #C-2026-09-01 done\n  - [ ] child\n* plain bullet',
            )
            expect(details(graph, 'degradation')).toContain('2 tasks written with a * bullet now use -, which EtherPK needs to read them as tasks')
        })

        it('reports text that AS Notes read as prose and EtherPK reads as a task tag', async () => {
            const graph = await convertAsNotes(workspace(src('todo.md', '- [ ] #P2 #D fix the build\n- [ ] #S-2026-10-01 later')))
            expect(doc(graph, 'todo').text).toBe('---\ntitle: todo\n---\n- [ ] #P2 #D fix the build\n- [ ] #S-2026-10-01 later')
            expect(details(graph, 'degradation')).toEqual([
                'Task "#P2 #D fix the build" - EtherPK reads #D as a task tag, where AS Notes read it as text',
                'Task "#S-2026-10-01 later" - EtherPK reads #S-2026-10-01 as a task tag, where AS Notes read it as text',
            ])
        })
    })

    describe('files', () => {
        it('re-points relative image paths and removes the retina marker', async () => {
            const bytes = new Uint8Array([5, 6, 7])
            const graph = await convertAsNotes(
                workspace(
                    src('assets/images/Shot.png', bytes),
                    src('notes/deep/Page.md', '![a shot {.retina}](../../assets/images/Shot.png)\n![sized|300](../../assets/images/Shot.png)\n[site](https://example.com/x.png)'),
                    src('notes/Near.md', '![near](images/Local.png)'),
                    src('notes/images/Local.png', new Uint8Array([9])),
                ),
            )
            const shot = graph.assets.find((a) => a.fileName.startsWith('shot.'))
            const local = graph.assets.find((a) => a.fileName.startsWith('local.'))
            expect(doc(graph, 'Page').text).toContain(
                `![a shot](../assets/${shot?.fileName})\n![sized|300](../assets/${shot?.fileName})\n[site](https://example.com/x.png)`,
            )
            expect(doc(graph, 'Near').text).toContain(`![near](../assets/${local?.fileName})`)
            expect(details(graph, 'degradation')).toContain(
                'Retina image marker `{.retina}` removed. EtherPK sizes an image by a width in its alt text, such as `![alt|300](...)`',
            )
        })

        it('imports templates as pages scoped under Templates', async () => {
            const graph = await convertAsNotes(workspace(src('templates/Journal.md', '# {{date}}\n'), src('Journal.md', 'a page')))
            expect(doc(graph, '[[Templates]] Journal').text).toBe('---\ntitle: "[[Templates]] Journal"\n---\n# {{date}}\n')
            expect(doc(graph, 'Journal').kind).toBe('page')
            expect(graph.report).toContainEqual(expect.objectContaining({ category: 'rename', concept: '[[Templates]] Journal' }))
        })
    })

    describe('what is left out', () => {
        it('leaves encrypted notes out and names each one', async () => {
            const graph = await convertAsNotes(
                workspace(src('Secret.enc.md', 'ASNOTES_ENC_V1:abc'), src('journals/2026-09-30.enc.md', 'plain after decrypting'), src('Open.md', 'x')),
            )
            expect(graph.documents.map((d) => d.concept)).toEqual(['Open'])
            expect(graph.assets).toEqual([])
            expect(details(graph, 'drop')).toEqual([
                '"Secret.enc.md" is an AS Notes encrypted note, so it was not imported. It is still in the source folder.',
                '"journals/2026-09-30.enc.md" is an AS Notes encrypted note, so it was not imported. It is still in the source folder.',
            ])
        })

        it('leaves the publish setup and the sites it generated out', async () => {
            const graph = await convertAsNotes(
                workspace(
                    src('asnotes-publish.docs.json', '{ "inputDir": "./docs", "outputDir": "./docs-publish", "layouts": "./my-layouts" }'),
                    src('asnotes-publish.themes.docs/default.css', 'body{}'),
                    src('my-layouts/docs.html', '<html/>'),
                    src('docs-publish/index.html', '<html/>'),
                    src('docs/index.md', 'home'),
                    src('docs/nav.md', '- [[index]]'),
                ),
            )
            expect(graph.documents.map((d) => d.concept).sort()).toEqual(['index', 'nav'])
            expect(graph.assets).toEqual([])
            expect(details(graph, 'unsupported')).toContain(
                'The AS Notes publish setup (asnotes-publish.docs.json, asnotes-publish.themes.docs/, my-layouts/) and the site it generates (docs-publish/) were not imported. To publish from EtherPK, set up a Publication.',
            )
        })

        it('honours the simple .asnotesignore patterns and reports the rest', async () => {
            const graph = await convertAsNotes(
                workspace(
                    src('.asnotesignore', '# comment\nlogseq/\nprivate/\n/scratch.md\n*.tmp\n!keep.md\n'),
                    src('private/Diary.md', 'secret'),
                    src('notes/private/Deep.md', 'also ignored: no leading slash matches at any depth'),
                    src('scratch.md', 'scratch'),
                    src('notes/scratch.md', 'anchored pattern, so kept'),
                    src('work.tmp', 'tmp'),
                ),
            )
            expect(graph.documents.map((d) => d.concept)).toEqual(['scratch'])
            expect(doc(graph, 'scratch').text).toContain('anchored pattern, so kept')
            expect(graph.assets.map((a) => a.fileName)).toEqual([expect.stringMatching(/^work\..+\.tmp$/)])
            expect(details(graph, 'drop')).toContain('3 files that .asnotesignore excludes were not imported')
            expect(details(graph, 'unsupported')).toContain(
                '.asnotesignore patterns that are not a plain folder or file name were not applied, so the files they match were imported: *.tmp, !keep.md',
            )
        })

        it('imports only the notes folder when AS Notes was set up in a subfolder', async () => {
            const graph = await convertAsNotes([
                src('.vscode/settings.json', '{ "as-notes.rootDirectory": "docs-src", "as-notes.journalFolder": "days" }'),
                src('docs-src/.asnotes/index.db', new Uint8Array([1])),
                src('docs-src/Page.md', 'inside'),
                src('docs-src/days/2026-09-30.md', 'a day'),
                src('README.md', 'outside'),
                src('src/app.ts', 'code'),
            ])
            expect(graph.documents.map((d) => d.concept).sort()).toEqual(['2026-09-30', 'Page'])
            expect(graph.assets).toEqual([])
            expect(details(graph, 'drop')).toContain('2 files outside the notes folder "docs-src" were not imported')
        })
    })

    describe('kanban boards', () => {
        const card = (frontmatter: string, body = '') => `---\n${frontmatter}\n---\n${body}`

        it('makes a page per board with a task per card', async () => {
            const graph = await convertAsNotes(
                workspace(
                    src('kanban/website/board.yaml', 'name: Website\nlanes:\n  - todo\n  - doing\n  - review\n  - done\nusers:\n  - Gareth\n'),
                    src(
                        'kanban/website/todo/card_fix_login_abc123.md',
                        card(
                            'title: Fix the login redirect\ncreated: "2026-09-01T10:00:00.000Z"\nupdated: "2026-09-02T10:00:00.000Z"\ndescription: The redirect loses the return URL.\npriority: p1\nassignee: Gareth\nlabels:\n  - bug\ndueDate: "2026-10-03"\nsortOrder: 2\nassets:\n  - filename: trace.png\n    added: "2026-09-01T10:00:00.000Z"',
                            'See [[Auth]].\n\n## entry 2026-09-28 Found the cause\nThe cookie path is wrong.\n',
                        ),
                    ),
                    src('kanban/website/todo/card_write_copy_def456.md', card('title: Write the copy\npriority: p4\nsortOrder: 1')),
                    src('kanban/website/doing/card_pricing_ghi789.md', card('title: Draft the pricing page\nwaiting: true')),
                    src('kanban/website/review/card_footer_jkl012.md', card('title: Check the footer')),
                    src('kanban/website/done/card_logo_mno345.md', card('title: Ship the logo')),
                    src('kanban/website/archive/card_old_pqr678.md', card('title: Old thing')),
                    src('kanban/website/assets/card_fix_login_abc123/trace.png', new Uint8Array([1, 2])),
                    src('Auth.md', 'auth notes, see [[card_fix_login_abc123]]'),
                ),
            )
            const trace = graph.assets.find((a) => a.fileName.startsWith('trace.'))
            expect(doc(graph, '[[Website]] Kanban').text).toBe(
                [
                    '---',
                    'title: "[[Website]] Kanban"',
                    '---',
                    '- [ ] Write the copy',
                    '- [ ] #P1 #D-2026-10-03 Fix the login redirect',
                    '  Assignee: Gareth. Labels: bug.',
                    '  The redirect loses the return URL.',
                    '  See [[Auth]].',
                    '  - 2026-09-28 Found the cause',
                    '    The cookie path is wrong.',
                    `  - ![trace](../assets/${trace?.fileName})`,
                    '- [ ] #W #D Draft the pricing page',
                    '- [ ] Check the footer',
                    '- [x] Ship the logo',
                    '- [x] Old thing',
                    '',
                ].join('\n'),
            )
            expect(doc(graph, 'Auth').text).toContain('see [[[[Website]] Kanban]]')
            expect(trace?.unreferenced).toBe(false)
            const website = graph.report.filter((r) => r.concept === '[[Website]] Kanban').map((r) => r.detail)
            expect(website).toEqual(
                expect.arrayContaining([
                    'AS Notes kanban board "Website" became this page, one task per card',
                    'Lane "review" has no EtherPK task status, so its 1 card was imported as an open task',
                    '1 archived card was imported as a done task',
                    'Priority p4 on "Write the copy" dropped (EtherPK has three priority levels)',
                    'Assignees and labels kept as text under each task: EtherPK tasks have neither',
                    'Dropped: card creation and update times, the card order within each lane, the board\'s list of users',
                ]),
            )
        })

        it('imports a card AS Notes cannot read as an ordinary page', async () => {
            const graph = await convertAsNotes(workspace(src('kanban/b/todo/card_x_aaaaaa.md', 'no frontmatter at all')))
            expect(doc(graph, 'card_x_aaaaaa').kind).toBe('page')
        })
    })
})
