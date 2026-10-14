---
name: etherpk
description: "EtherPK graph folders: plain markdown with [[wikilinks]] that the EtherPK app opens as a local graph and publishes as a static website. Use to create a blog, docs site or wiki folder in EtherPK format; to write or edit pages, journal entries, tasks or frontmatter in a folder that holds journals/ and pages/ or an AGENTS.md written by EtherPK; to set up, check or publish a publication (public and publications frontmatter, a page with a publication mapping, etherpk-mcp publish); or when the user names an EtherPK synced graph or the etherpk MCP tools are connected."
license: Elastic-2.0
---

# EtherPK graph folders

EtherPK is a notes app over plain markdown. A **graph folder** holds one knowledge graph:
`pages/` (one page per file), `journals/` (one entry per day), `assets/` (images and files) and
`etherpk/` (the app's own settings). A person opens the folder in EtherPK, in a Chromium-based
desktop browser, and works in it while you work on the files: EtherPK reloads a file when it
changes on disk. Public pages become a static website through a **publication**, published from
the app or with `etherpk-mcp`, EtherPK's Headless Client on npm.

Work through the steps in order. Each one ends on a check.

## 1. Choose the route

| What you find | Route |
| --- | --- |
| The user names a synced EtherPK graph, or the `etherpk` MCP tools serve one (`graph_info` says it is synced) | **MCP.** A synced graph has no folder on this computer. Read and write it through the `etherpk` tools only, as their own instructions describe, and use step 5 for its publications. |
| A folder with `etherpk/graph.json` | A **Local Mirror** of a synced graph. EtherPK rewrites every file in it from the server, so work on that graph through the MCP route. |
| A folder with `journals/` and `pages/` | An existing **local graph**. Go to step 3. When the `etherpk` MCP tools serve this folder (`graph_info` shows its path), edit and search through them, since they keep the format intact. |
| No folder yet, and the user wants a blog, docs site or wiki | Make one in step 2. |

When the MCP route applies and the `etherpk` tools are not connected, tell the user to open
**Settings → Agents** in EtherPK for that graph. It shows the commands that sign this computer in
and connect their agent, for example:

```sh
claude mcp add etherpk -- npx @appsoftwareltd/etherpk-mcp serve --sync-server <url> --graph <graph id>
```

Then stop until they have restarted the agent with the tools connected.

**Check:** you know the route, and on the MCP route the `etherpk` tools answer `graph_info`.

## 2. Make a new graph folder

1. Choose the folder: the one the user named, otherwise `docs/`, `blog/` or `wiki/` at the
   project root. It is new or empty, and outside any other graph folder.
2. Copy a starter from this skill's `assets/` folder, all of it, dot-files included:
   `assets/docs/` for a docs site or a wiki, `assets/blog/` for a blog. This skill's folder is
   the one holding this `SKILL.md`, usually `.claude/skills/etherpk/` or `.agents/skills/etherpk/`
   in the project, or under the home folder when it was installed for every project.

   ```sh
   mkdir -p <folder> && cp -R <this skill's folder>/assets/docs/. <folder>/
   ```

3. Name the site. The publication page is `pages/Docs.md` (or `pages/Blog.md`), and its
   `title:` is the site's name, for example `Tally Docs`. Change the `title:` and rename the file
   to the same name (`pages/Tally Docs.md`). Set `publication.id` to a short id of lower-case
   letters, digits and hyphens (`tally-docs`), and put that id in place of `docs` (or `blog`) in
   every page's `publications:` list.
4. Rewrite, rename or delete the sample pages, and add as many pages as the content needs, in
   step 4. Keep `AGENTS.md`, `CLAUDE.md` and the two `.gitkeep` files as they are: EtherPK owns the
   first two, and the `.gitkeep` files keep the empty folders in git.
5. Add a line to the project's own `AGENTS.md` (or `CLAUDE.md`), so an agent started in the
   project finds the format:

   ```markdown
   `<folder>/` is an EtherPK graph folder. Read `<folder>/AGENTS.md` before editing files in it.
   ```

**Check:** the folder holds `AGENTS.md`, `CLAUDE.md`, `journals/.gitkeep`, `pages/.gitkeep` and
the renamed publication page, and every `publications:` list names the new id.

## 3. Read the format

Read the folder's `AGENTS.md` in full before you write a file in it. Its EtherPK section is the
format reference: page names and identity, frontmatter, outliner bullets, tasks, links, assets,
protected documents, and the rules that keep a file readable by EtherPK. EtherPK rewrites that
section to match the version the user runs, so where it and this skill differ, follow
`AGENTS.md`.

**Check:** you have read the whole EtherPK section.

## 4. Write the content

- One page per file, `pages/<Title>.md`, with `title: <Title>` in its frontmatter.
- A graph with no publication yet gets one from a starter: copy `assets/docs/pages/Docs.md` (or
  `assets/blog/pages/Blog.md`) into its `pages/` and name it as in step 2.
- A page on the site carries both publishing keys:

  ```yaml
  public: true
  publications:
    - <id>
  ```

- The site's menu is the outline on the publication page: `- [[Page]]` for an entry, nested
  bullets for sub-entries, a plain bullet with children for a group, and `- [Text](https://...)`
  for an outside link. A public page left out of the menu is still on the site, reached through
  links and search.
- Link pages with `[[Page Title]]`. A link to a page that is not on the site goes to its 404 page.
- The theme shows the page title as the heading, so start a page's own headings at `##`.
- On a blog, a page with `date: YYYY-MM-DD` is a post, listed newest first, and a new post takes
  today's date. A page with no date, such as About, is a fixed page. A public journal entry
  (`journals/YYYY-MM-DD.md`) is a post too. The archive of every post is `posts.html`, which the
  menu can link as `- [All posts](posts.html)`.
- A page with `template: true` in its frontmatter is a Template: a pattern the user copies with
  `/Template`, its `{{date}}`, `{{title}}` and other variables filled in on the copy. Keep it off
  the site by leaving out `public: true`. To write a page from one, copy its body and fill the
  variables in yourself, or pass `template` to the MCP `create_page` tool.
- Put images in `assets/` and embed them as `![Alt text](../assets/<file>)`.
- The publication's `theme:` sets the look. Left out, a docs site uses `etherpk-docs` and a blog
  `etherpk-blog`. The other bundled themes suit either kind: `etherpk-papermod`, `etherpk-stack`,
  `etherpk-terminal` and `etherpk-al-folio`. A custom theme is made in EtherPK's Theme editor or
  with the MCP theme tools.
- When the user knows the site's address, set `url: https://...` in the `publication:` mapping.
  The site then gets a sitemap, and a feed of its dated pages when it has any.

**Check:** every page meant for the site has `public: true` and the id in `publications:`, and
each one is in the menu or linked from a page that is.

## 5. Check with a dry run

```sh
npx -y @appsoftwareltd/etherpk-mcp@latest publish --folder <folder> --publication <id> --dry-run
```

It needs Node.js 24 or later, and `@latest` keeps `npx` from running an older copy it has cached. It renders the whole site, writes nothing, and prints a JSON report.
Read `errors`, `warnings`, `missingLinks`, `excluded` (the documents left out, counted by reason)
and `publicInNoPublication`, fix what they point to, then run it again. Over MCP, the `publish`
tool with `dryRun: true` returns the same report.

`chromium_unavailable` means a page holds a Mermaid diagram or a map, which a publish draws with a
browser. Ask the user to run `npx @appsoftwareltd/etherpk-mcp diagrams setup` once (it downloads
about 170 MB), or to set `ETHERPK_CHROMIUM` to the path of a Chromium already installed.

**Check:** the dry run reports `"ok": true`, no warnings, and only the missing links the user
wants.

## 6. Hand over

Tell the user how to open and publish the folder:

- **Open it in EtherPK.** In Chrome, Edge, Brave or Arc on a desktop, go to
  <https://app.etherpk.com> (or their own EtherPK), select **Open folder (Local Graph)** on the
  Graphs page and pick the folder. Their edits and yours show up in each other.
  <https://docs.etherpk.com/local-graphs>
- **Publish it.** In EtherPK: **Settings → Publish**, **Choose folder…**, then **Publish to
  folder**. Or from a terminal:

  ```sh
  npx @appsoftwareltd/etherpk-mcp@latest publish --folder <folder> --publication <id> --out <site folder>
  ```

  The site folder is a folder of its own, outside the graph folder, and `--out` is remembered
  after the first run. The published folder comes with a GitHub Pages workflow and a Cloudflare
  `wrangler.jsonc`. <https://docs.etherpk.com/hosting-a-published-site>

Publish yourself when the user asks for it. Until then the dry run is your check.

**Check:** the user has the folder's path, the publication id, and both ways to publish.
