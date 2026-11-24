import { describe, expect, it } from 'vitest'

import { copyPassages, findCopyViolations, findCopyWarnings, findUnclearReferences, RETIRED_TERMS } from './copy-wording'

const rules = (source: string, file = 'Page.svelte') => findCopyViolations(source, file).map(({ rule, line }) => `${rule}:${line}`)

describe('findCopyViolations', () => {
    it('refuses computer where EtherPK runs, in markup and in a string', () => {
        expect(rules('<p>Open a folder on this computer instead.</p>')).toEqual(['computer:1'])
        expect(rules("const hint = 'for a server on this computer'", 'hint.ts')).toEqual(['computer:1'])
        expect(rules('<p>Computers running the Headless Client drop their copy.</p>')).toEqual(['computer:1'])
    })

    it('refuses making a resource, and reads past a determiner and one describing word', () => {
        expect(rules('<p>Make a token on the Access tokens page.</p>')).toEqual(['make:1'])
        expect(rules('<p>An import makes a new graph.</p>')).toEqual(['make:1'])
        expect(rules('<p>Making a synced graph afterwards gives you a new code.</p>')).toEqual(['make:1'])
        expect(rules('<p>You made another access token.</p>')).toEqual(['make:1'])
        expect(rules('busyReason="Making the copy…"')).toEqual(['make:1'])
    })

    it('lets make stand where nothing is created', () => {
        expect(rules('<p>Make sure the page has loaded.</p>')).toEqual([])
        expect(rules('<p>Make sure pages load first.</p>')).toEqual([])
        expect(rules('<p>Make the file smaller or link to it.</p>')).toEqual([])
        expect(rules('<p>That makes sense for a task.</p>')).toEqual([])
    })

    it('tells creating a thing from changing one, by what follows it', () => {
        const changing = ['Ticking makes a task Done.', 'It makes the page public.', '`true` makes the page a Template.', 'Restart it to make the graphs you own writable again.', 'One changed byte makes the whole document unreadable.', 'Make the folder a git repository.', 'AGENTS.md says what makes a task about a concept.']
        for (const text of changing) expect(rules(text, 'Page.md'), text).toEqual([])
        const creating = ['To make a new page, open its name.', 'How to make a token</summary>', 'You make a GitHub token on GitHub.', 'It makes the copy and points the publication at it.', '## Make a task']
        for (const text of creating) expect(rules(text, 'Page.md'), text).toEqual(['make:1'])
        expect(rules('## Make a task\n\nType a dash.', 'Page.md')).toEqual(['make:1'])
        // A sentence wrapped over two lines is still one sentence.
        expect(rules('a single changed byte makes the whole document\n  unreadable for good.', 'Page.md')).toEqual([])
        expect(rules('Only the owner can make the new key\n  on the Sync Server.', 'Page.md')).toEqual(['make:1'])
    })

    it('refuses a retired name and says the one to write', () => {
        const found = findCopyViolations('<h2>Page Marks</h2>\n<p>Open the Graph Sidebar.</p>', 'Page.svelte')
        expect(found.map(({ rule, line, fix }) => [rule, line, fix])).toEqual([
            ['retired-term', 1, 'say "PDF Bookmarks"'],
            ['retired-term', 2, 'say "Explorer"'],
        ])
    })

    it('finds Page Marks as a name, and not where a page marks something', () => {
        expect(rules('<h2>Page Marks</h2>')).toEqual(['retired-term:1'])
        expect(rules('<p>Add a Page mark here.</p>')).toEqual(['retired-term:1'])
        expect(rules('<p>The Graphs page marks Plain Folders (not synced).</p>')).toEqual([])
    })

    it('leaves EBook Bookmarks alone, which holds a retired name inside it', () => {
        expect(rules('<h2>EBook Bookmarks</h2>')).toEqual([])
        expect(rules('<h2>Book Bookmarks</h2>')).toEqual(['retired-term:1'])
    })

    it('reads no comment', () => {
        expect(rules('// runs on this computer\nconst a = 1 // make a token\n/* a computer\n   too */', 'a.ts')).toEqual([])
        expect(rules('<!-- make a key on this computer -->\n<p>Fine.</p>')).toEqual([])
    })

    it('keeps the address pages outside the repository link to', () => {
        expect(rules("const href = `${docs}/running-etherpk-on-your-own-computer`", 'links.ts')).toEqual([])
    })

    it('excuses a line with a reason on it or above it', () => {
        expect(rules("// copy-exempt: a model's name\nconst skip = /computer-use/", 'models.ts')).toEqual([])
        expect(rules("const skip = /computer-use/ // copy-exempt: a model's name", 'models.ts')).toEqual([])
        expect(rules('const skip = /computer use/', 'models.ts')).toEqual(['computer:1'])
    })

    it('skips what the caller says is not copy, and holds only the rules asked for', () => {
        const source = 'Run it on your own computer. Make a token first.'
        expect(findCopyViolations(source, 'Page.md', { ignore: [/your own computer/g] }).map(({ rule }) => rule)).toEqual(['make'])
        expect(findCopyViolations(source, 'Page.md', { rules: ['retired-term'] })).toEqual([])
    })

    it('reads the prose of Markdown: not its code, link targets, addresses or aliases', () => {
        const page = [
            '---',
            'title: Running On A Device',
            'slug: on-your-computer',
            'aliases:',
            '  - Running On A Computer',
            '---',
            'See [the guide](../computer/make-a-token.md) or https://example.test/computer.',
            '',
            '```bash',
            'make a token # on this computer',
            '```',
            '',
            'Run `computer --make a key` on a computer.',
        ].join('\n')
        expect(rules(page, 'Page.md')).toEqual(['computer:13'])
    })

    it('reads a title, which a reader sees', () => {
        expect(rules('---\ntitle: On Your Own Computer\n---\nText.', 'Page.md')).toEqual(['computer:2'])
    })

    // Every retired name is found in a sentence built around it, in either case, and the sentence
    // without it is clean: the patterns neither miss their own name nor match plain words.
    it('finds each retired name in any sentence, and nothing in the sentence without it', () => {
        const frames = ['Open %s to see them.', 'The %s is on the left', '%s', 'under "%s", choose one', 'see (%s).']
        const names = ['Copy Task Reference', 'copy task reference', 'Graph Sidebar', 'Book Bookmarks']
        expect(names.length).toBeGreaterThanOrEqual(RETIRED_TERMS.length - 1)
        for (const frame of frames) {
            expect(rules(frame.replace('%s', 'the page'), 'Page.md'), frame).toEqual([])
            for (const name of [...names, ...names.map((name) => name.toUpperCase())]) {
                expect(rules(frame.replace('%s', name), 'Page.md'), `${frame} with ${name}`).toEqual(['retired-term:1'])
            }
        }
    })
})

describe('findUnclearReferences', () => {
    const reasons = (text: string) => findUnclearReferences(text).map(({ reason }) => reason.split(':')[0])

    // The owner's corrections of November 2026: each text as it stood, then the owner's rewrite, or
    // the text written to the owner's comment where the owner only asked.
    const corrections: [before: string, after: string][] = [
        [
            'On each device where your Encryption Keys are already unlocked, an approval prompt will appear. Select Show the code on one of them, and this device then shows a code to compare with it.',
            'Use an unlocked device to approve this one. Select Show the code on any of them, and this device will show a code which should match the one shown here.',
        ],
        ['It connects by itself once the graph is closed in one of them.', 'It connects by itself once one of the other tabs is closed.'],
        [
            'A picture is saved as assets/photo.png. This is kept in the folder’s hidden .etherpk folder, so everyone who opens the folder gets the same.',
            'A picture is saved as assets/photo.png. This setting is kept in the folder’s hidden .etherpk folder.',
        ],
        ['Every member has a copy, but the Sync Server never has one.', 'Every member gets a copy of the key, which is never seen by the Sync Server.'],
        ['The owner decides who is in it.', 'The owner decides who has access.'],
        ['Removing the copies also locks them, and you do that on the row of the server.', 'Removing the copies also locks them. Removing graphs can be actioned on the row of the server.'],
        ['Sign out of EtherPK keeps the connection. After it, the graph list is empty.', 'Sign out of EtherPK keeps the connection. After this step, the graph list is empty.'],
        ['Another tab has it open.', 'Another browser tab has this graph open.'],
        // Two the warning raised and an agent let stand, because "it" could mean only one thing.
        // The owner named the thing all the same.
        [
            'If another of your devices still has its Encryption Keys unlocked, approve this one from it, then create a new code there.',
            'If another of your devices still has its Encryption Keys unlocked, approve this one from that device, then create a new code there.',
        ],
        ['Where diagrams setup installs Chromium and a publish looks for it.', 'Where diagrams setup installs Chromium and a publish looks for the installed instance.'],
        // Three from the sample of 20 the owner marked: a warning, a table cell and a step.
        ['Mirroring into “X” would write into that mirror’s folder and delete files in it.', 'Mirroring into “X” would write into that mirror’s folder and delete files inside.'],
        ['A browser, or installed from it', 'A browser, or installed via the browser'],
        [
            'To open a card in the task editor, select it, press Enter on it, or choose Open in task editor in the card menu.',
            'To open a card in the task editor, select it, press Enter on the task card, or choose Open in task editor in the card menu.',
        ],
        ['That edit would move text out of what this editor shows. Open the document to edit around it.', 'Kept in the description. That would join this line onto the task. To join them, open the page in a tab.'],
    ]

    it.each(corrections)('warns about the text as it stood: %s', (before) => {
        expect(reasons(before)).not.toEqual([])
    })

    it.each(corrections)('passes the text that replaced it (was: %s)', (_before, after) => {
        expect(reasons(after)).toEqual([])
    })

    it('passes the owner’s longer rewrites', () => {
        const kept = [
            'Not syncing: this graph is open in too many tabs or devices. Your changes are kept on this device and sync once one of the other tabs is closed. If you close this tab your edits will sync when a newly opened tab next syncs.',
            'A synced graph is a graph that EtherPK stores on a Sync Server. Devices connect to the Sync Server and open the graph using access tokens for authentication. They obtain Encryption Keys using either a Recovery Code or verification via another of your devices with access to the graph.',
            'This link opens a page in a graph folder on this device. This browser has not opened that folder yet.',
        ]
        for (const text of kept) expect(reasons(text), text).toEqual([])
    })

    it('says why, once for each cause', () => {
        expect(reasons('Open the page. This is where the list goes, and you add to it.')).toEqual(['"it" ending a clause', '"This" with no noun'])
        expect(reasons('Does the server keep a copy? It does not.')).toEqual(['a sentence that is only "it" and a verb'])
    })

    it('lets "This" open a passage, where it names what is on the screen', () => {
        expect(reasons('This is a draft document. Create it as an empty document and protect?')).toEqual([])
    })
})

describe('copyPassages', () => {
    it('joins markup text across lines and inline tags, and splits it at a block', () => {
        const source = ['<p>', '    Use an unlocked device. Select <strong>Show the code</strong> on any of them,', '    and compare the two.', '</p>', '<p>A second paragraph of text.</p>'].join('\n')
        expect(copyPassages(source, 'Dialog.svelte')).toEqual([
            { line: 2, text: 'Use an unlocked device. Select Show the code on any of them, and compare the two.' },
            { line: 5, text: 'A second paragraph of text.' },
        ])
    })

    it('reads a tooltip and a placeholder, and the strings of the script', () => {
        const source = ['<script lang="ts">', "    const note = 'Your changes are kept on ' +", "        'this device until then.'", '</script>', '<button data-tooltip="Create a new key for this graph">Go</button>'].join('\n')
        expect(copyPassages(source, 'Row.svelte').map(({ text }) => text)).toEqual(['Create a new key for this graph', 'Your changes are kept on this device until then.'])
    })

    it('reads each line of Markdown prose, without its list marker or code', () => {
        const source = ['# A heading of four words', '', '- Press `Ctrl+K` to open the search box.', '', '```', 'not prose at all here', '```'].join('\n')
        expect(copyPassages(source, 'Page.md')).toEqual([
            { line: 1, text: 'A heading of four words' },
            { line: 3, text: 'Press to open the search box.' },
        ])
    })
})

describe('findCopyWarnings', () => {
    it('gives the file, the line and the sentence', () => {
        const source = '<p>\n    Two tabs are open. Close one of them to carry on.\n</p>'
        expect(findCopyWarnings(source, 'Notice.svelte')).toEqual([{ file: 'Notice.svelte', line: 2, excerpt: 'Close one of them to carry on.', reason: '"one of them": say which things' }])
    })

    it('excuses a line with a reason above it', () => {
        const source = '<!-- copy-exempt: the two buttons are beside the text -->\n<p>Two buttons follow. Press one of them to carry on.</p>'
        expect(findCopyWarnings(source, 'Notice.svelte')).toEqual([])
    })
})
