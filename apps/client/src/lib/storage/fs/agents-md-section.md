## EtherPK knowledge graph

This folder is a **Local knowledge graph** kept by [EtherPK](https://etherpk.com), a personal
knowledge management app: daily journal entries, titled pages and the files they embed, all as
plain GitHub-flavoured markdown. The files here *are* the notes. EtherPK has no copy of them
anywhere else, so an edit made here is the edit, and a corrupted file is corrupted for good.
The user documentation is at <https://docs.etherpk.com>; the pages that matter for editing
these files are linked at the end of this section.

EtherPK may have this folder open in a browser while you work. It notices files that change
on disk (on window focus and on a light poll) and reloads them; if the user also had unsaved
edits to the same file, EtherPK stops and asks them which version to keep rather than merging.
Write each file once, whole, rather than in several passes, so what it sees is finished.

This section is rewritten by EtherPK every time the graph is opened. Put your own
instructions **outside this section**, above or below it; they are kept as written. The
`CLAUDE.md` beside this file is EtherPK's too: Claude Code reads that name rather than this
one, so it only imports this file. If this folder sits inside a larger project, add a line to
that project's own `AGENTS.md` / `CLAUDE.md` pointing here, since an agent started above this
folder will not find this file on its own.

### Folder layout

```text
journals/   2026-06-02.md                     one entry per calendar day, ISO-dated
pages/      Quantum Mechanics.md              a page, named by its concept
            [[Physics]] Quantum Mechanics.md  a scoped concept keeps its inner brackets
assets/     diagram.a1b2c3d4.png              embedded images and files
etherpk/    settings.json, quick-notes.json,  app-managed graph settings, quick notes,
            dictionary.txt, protection.json,  the graph dictionary, key material
            theme-<id>.jsonc                  and website themes
AGENTS.md                                     this file
```

- Only `journals/` and `pages/` are read for documents, and only `.md` files in them. Nothing
  is nested below these four directories; a subfolder inside one is ignored.
- `etherpk/` is app-internal. `settings.json` holds graph settings (default image size, code
  language, favourites). `quick-notes.json` holds quick notes the user has not yet moved into a
  journal; EtherPK rewrites it whole, so do not edit it. `dictionary.txt` is the graph dictionary:
  words spell check accepts in this graph, one per line, sorted. You may add a word to it (one
  per line, keeping the order); EtherPK merges the file before it next writes it. `theme-<id>.jsonc` holds a website theme
  the user copied into the graph (templates, stylesheet and script as JSON strings, under a
  comment header saying as much); edit it through EtherPK's Theme editor rather than here. `protection.json` holds the user's **wrapped
  protection key**: never edit, move or delete it, or every protected document in the graph
  becomes unreadable with no way back.
- Do not add files elsewhere in the folder. EtherPK ignores them, but a stray `.md` at the root
  or in `assets/` will be imported as a page if the folder is ever imported into another graph.

### Documents and identity

- A **journal entry** is `journals/YYYY-MM-DD.md`. The date is its whole identity: the file name
  must be a real calendar day, there is at most one file per day, and it has no frontmatter
  (a `title:` in one is kept but ignored). Journal entries cannot be renamed.
- **A page is never named after a day.** Write a day's content to `journals/YYYY-MM-DD.md`,
  never to `pages/YYYY-MM-DD.md` or a page whose `title:` is a date: EtherPK refuses to create
  or rename a page to a day, and a page file that has one answers to the day in place of its
  journal entry.
- A **page** is `pages/<name>.md` and its identity is the `title:` in its frontmatter, **not**
  the file name. The file name is a convenience derived from the title with characters
  illegal on some filesystems replaced (`/?<>\:*|"` become `_`); when two titles derive the
  same file name the second gets a ` (2)` suffix. Read the title from the frontmatter; when
  a page has none, the file name without `.md` is the title.
- **Concept names are case-insensitive.** `[[Physics]]` and `[[physics]]` are one concept.
  Two pages whose titles differ only in case are a collision: one silently shadows the other.
  Check for an existing page (or alias) before creating one.
- To **create a page**, write `pages/<title>.md` with a frontmatter block:

  ```markdown
  ---
  title: Quantum Mechanics
  aliases:
    - QM
  ---
  - first block
  ```

- To **rename a page**, change `title:` (renaming the file alone does nothing). EtherPK does not
  rewrite links to the old name when the change is made on disk, so update `[[Old Name]]`
  links across the folder yourself, or leave the old name as an alias.
- A page whose title contains a wikilink is a **scoped concept**: `[[Physics]] Quantum Mechanics`
  is "Quantum Mechanics within Physics". It is linked as `[[[[Physics]] Quantum Mechanics]]` and
  its file is `pages/[[Physics]] Quantum Mechanics.md`. Nesting can go as deep as needed. The
  page counts as a reference to its scope: it appears under the backlinks of `Physics`, and
  `Physics` exists as a concept (linkable, searchable) from the file alone, before it has a page.

### Frontmatter

- Only at the very start of the file, opened and closed by a line that is exactly `---`. A
  `---` anywhere else is ordinary markdown: a horizontal rule, or, directly under a line of
  text, that text's heading underline. Leave a blank line above a `---` meant as a rule.
- Keys EtherPK reads: `title` (identity, pages only), `aliases` (a YAML list of other names
  a page answers to; a wikilink to an alias resolves to the page), and the publishing keys
  below. Any other key is kept verbatim and ignored, so you may add your own.
- **Publishing.** EtherPK can render a set of documents into a website. A document is published
  only when its frontmatter says `public: true` **and** it belongs to a publication:
  `publications: [docs, blog]` names the publications by id, unless a publication takes every
  public document; `publications: []` on a public document is EtherPK's prompt that it is in
  none yet. A protected document is never published whatever its frontmatter says, and EtherPK
  removes both keys before protecting a public document. A
  **publication** is defined by a page whose frontmatter carries a `publication:` mapping
  (`id`, and optionally `kind` of `docs` or `blog`, `selection` of `named` or `all-public`,
  `home`, `url`, `theme`, `includes`) and whose outline of wikilinks is the site's
  navigation; that page is itself never published. A page named under `includes` (a footer, a
  head snippet) needs the same two keys as any published document and is then a snippet: it
  fills its slot and is never published as a page of its own. A `slug: privacy-policy` key
  chooses the document's address on the site instead of one derived from its name. To publish a document,
  add the two keys to its block; to make a publication, write such a page. The user runs the
  publish from EtherPK.
- Keep the block intact: never join body text onto the closing `---` and never delete the
  block from a protected document (see below).

### Document syntax

Everything is valid GFM. EtherPK adds nothing proprietary; it derives structure from the text.

**Wikilinks.** `[[Concept Name]]` links to the page (or journal day, `[[2026-06-02]]`) of that
concept and creates the concept if no page exists yet. Whitespace inside the brackets is part
of the name. There is **no** `[[target|label]]` and **no** `[[target#anchor]]`; the link text is
the concept. Nested links make scoped concepts (above). Wikilinks inside code are plain text.

**Outliner blocks.** Bullets are `- ` (hyphen, space). Nesting is indentation, **two spaces per
level**, and a child sits exactly one level under its parent: a bullet indented more than one
level deeper than the bullet above it is an orphan and is healed or misread. A group of bullets
runs until a heading, a paragraph or a flush-left blank line; a blank line that is indented to
a bullet's content column is a paragraph break *inside* that bullet and must keep its indent.
Lines that continue a bullet (a second paragraph, a code fence) are indented to the bullet's
content column, two characters right of the bullet's own indent:

```markdown
- a parent block
  - a child, two spaces in
    - a grandchild
  a second line of the parent block, at its content column

  a second paragraph of the parent block (the blank line above is indented too)
- a sibling of the parent

A flush-left blank line ends the group; this is prose.
```

Headings (`#`, `##`, ...) and plain paragraphs are ordinary markdown and also nest blocks by
heading level. Numbered lists, `*` bullets and `+` bullets are not outliner blocks.

**Inline marks.** Standard Markdown: `**bold**`, `*italic*` or `_italic_`, `~~strikethrough~~`,
`\`inline code\``, plus `==highlight==` (the Obsidian and Logseq spelling; Logseq's `^^text^^` is not
recognised). A mark stays on one line in practice and is never recognised inside a code block.

**Hyperlinks.** Standard Markdown, `[text](https://…)` or a bare url, opened in the browser. A
`file:///path` url (spaces as `%20`) is rendered as a file link that copies its path when clicked,
since a browser page cannot open a local file; nothing checks that the file exists.

**Tasks.** A bullet with a checkbox: `- [ ] open` or `- [x] done`. Task metadata is carried by
**task tags**, recognised only in the run of tokens immediately after the checkbox:
priority `#P1` `#P2` `#P3`; state `#W` (waiting), `#D` (doing), `#C` (cancelled); dates
`#D-YYYY-MM-DD` (due), `#S-YYYY-MM-DD` (scheduled), `#C-YYYY-MM-DD` (completed). A bare
letter is a state, a dated letter is a date. `#` text anywhere else in the line is plain text.
Example: `- [ ] #P1 #D-2026-07-01 Ship the release [[Acme]]`. A task is *about* every
concept linked on its own line, on any ancestor block or heading, and the document it is in.

**Fenced code.** Three or more backticks (tildes are not recognised), closed by a bare fence of
**the same length at the same column**. Inside a bullet the fence and every line of it sit at
the bullet's content column. The info-string picks the rendering: any language name is
highlighted; ` ```mermaid ` is drawn as a diagram; ` ```math ` is typeset as LaTeX (`latex`
and `tex` are not); ` ```etherpk-cipher ` is a protected document (below). To put backticks
inside a block, open it with four. Inline maths is `$...$` on one line; there is no `$$`
block form.

**Tables.** GFM pipe tables. Leave a blank line between two tables or they read as one; a
table cannot sit inside a code block or the frontmatter.

**Assets.** Files live flat in `assets/` and are referenced by relative path from the document:

```markdown
![Quarterly chart|300](../assets/quarterly-chart.a1b2c3d4.png)
[Q3 report](../assets/q3-report.5e6f7a8b.pdf)
```

- An image is `![alt](...)`; anything else is `[label](...)`. An optional display-size hint
  after a `|` in the alt caps the rendered size: `|300` is a maximum width, `|640x480` a
  maximum width and height. It never enlarges.
- EtherPK names the files it stores `<kebab-name>.<8 hex chars of content hash>.<ext>` and
  de-duplicates by content. To add an asset yourself, copy the file into `assets/` under any
  name and reference it; the hash is optional. If this folder is served to you over MCP
  (`etherpk-mcp serve --folder`), prefer its `upload_asset` tool: it names, de-duplicates and
  returns the markdown to paste. Never rename or delete a file in `assets/`
  without updating or removing every reference to it across `journals/` and `pages/`.
- A web image (`![alt](https://...)`) is fetched from that site each time it is shown.

### Protected documents: do not touch the ciphertext

A page whose entire body is a single fence with the info-string `etherpk-cipher` is a
**protected document**. Its body is encrypted under a key EtherPK never writes to disk in
usable form, and the fence content is base64url ciphertext, one envelope per line:

````markdown
---
title: Passwords
---
```etherpk-cipher
AQQAAAGY...
```
````

- **Never edit, reformat, re-wrap, re-indent, trim, sort or re-encode the fence or anything
  inside it.** The envelope is authenticated; a single changed byte makes the whole document
  unreadable and there is no recovery. Treat the fence and its lines as opaque bytes.
- Do not add text before or after the fence inside the body: a document whose body is not one
  whole fence stops being protected, and the ciphertext is then stranded as ordinary text.
- The frontmatter above the fence is cleartext and may be edited (`title`, `aliases`), but the
  block must stay: without it the title would be sealed into the ciphertext at the next save.
- You cannot read the content and should not try. If a task needs it, tell the user; they can
  unlock the document in EtherPK.
- `etherpk/protection.json` is the wrapped key. Leave it alone.

### Keeping files editable by EtherPK

- **UTF-8, `LF` line endings, no byte-order mark.** End every file with a single newline.
- **Spaces, not tabs**, for indentation. A tab reads as one character to the editor and four
  columns to the importer, so a tab-indented outline is misread as soon as it is touched.
- **Do not strip trailing whitespace or blank lines by formatter.** A whitespace-only line
  indented to a bullet's content column is part of that bullet; flattening it to an empty line
  splits the block and its children lose their parent. Only tidy a line you are editing.
- **Do not run a markdown formatter** over these files (Prettier, `mdformat`, an editor's
  format-on-save). They re-indent nested bullets to four spaces, renumber, re-wrap paragraphs
  and rewrite fences, every one of which changes the meaning above.
- Keep fences balanced: the closer must match the opener's length and column. An
  unterminated fence turns everything below it into plain text.
- Never leave two pages with the same title or alias (case-insensitively), a page titled with
  a calendar day, or a journal file not named after a real day.
- Write files atomically and one at a time where you can. Do not hold a file open in another
  editor with unsaved changes while EtherPK is autosaving it.
- Do not create, rename or delete anything under `etherpk/` (adding a word to
  `dictionary.txt` is the one edit you may make there), and do not edit inside the
  EtherPK section of this file.

### Further reading

- Agents and these files: <https://docs.etherpk.com/using-ai-agents-with-your-notes>
- Local graphs and this folder: <https://docs.etherpk.com/local-graphs>
- This layout, as a reference: <https://docs.etherpk.com/graph-folder-layout>
- Titles, aliases and frontmatter: <https://docs.etherpk.com/titles-aliases-and-frontmatter>
- Images and files: <https://docs.etherpk.com/images-and-files>
- Code, maths and diagram blocks: <https://docs.etherpk.com/code-maths-and-diagrams>
- Tables: <https://docs.etherpk.com/tables>
- Protected documents: <https://docs.etherpk.com/protected-documents>
- Every construct on one page: <https://docs.etherpk.com/document-syntax>
- Everything else: <https://docs.etherpk.com>
