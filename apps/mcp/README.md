# @appsoftwareltd/etherpk-mcp

An [MCP](https://modelcontextprotocol.io) server that gives your AI agent (Claude Code, Codex,
Cursor and the like) one of your [EtherPK](https://etherpk.com) knowledge graphs, run on the same
computer as the agent. The agent can search your notes by words or by meaning, follow links,
list tasks, and read and edit documents without breaking EtherPK's format.

This is EtherPK's **Headless Client**: EtherPK with no editor. Set up depends on where the graph
lives:

- **A local graph folder.** Point it at the folder. It reads and writes the markdown there and
  keeps a search index of it. No sign-in, no server.
- **A synced graph.** EtherPK's Sync Server never sees your notes unencrypted. The Headless
  Client signs in as one of your devices, holds your keys, keeps the graph in sync and serves it
  from your own computer.

The agent gets the same tools either way. Protected documents are listed by name only and never
served.

Needs Node.js 22 or later.

## Set up: a synced graph

Open the graph in EtherPK, pick **Settings → Agents**, and copy the two commands it shows with your
server and graph filled in:

```sh
# Once per computer. Asks for an account-wide Personal Access Token (from
# https://sync.etherpk.com/account/tokens, or "Access tokens" in EtherPK's account menu),
# then shows a short code: confirm it in any browser tab where EtherPK is signed in and
# unlocked. The same step as adding a phone.
npx @appsoftwareltd/etherpk-mcp login --sync-server https://sync.etherpk.com

# Tell the agent about the graph (Claude Code shown; the Agents tab has the others).
claude mcp add etherpk -- npx @appsoftwareltd/etherpk-mcp serve --sync-server https://sync.etherpk.com --graph <graph id>
```

Self-hosting? Give your own server's address to `login`. By default `login` gets your keys by
Device Approval: confirm the code it shows in EtherPK on any device where your account is
unlocked. If there's no EtherPK to hand, press `r` while `login` is waiting, or add
`--recovery-code`, and type your Recovery Code instead. For a scripted setup, `ETHERPK_PAT` and
`ETHERPK_RECOVERY_CODE` stand in for the prompts.

`npx @appsoftwareltd/etherpk-mcp graphs` lists the graphs each signed-in account can reach, by
name and id. A graph nobody has opened since names started being stored on the server is opened
once to read its name; `(unnamed)` means it has none.

One computer can be signed in to several Sync Servers - your own beside the managed service, say.
Run `login` once per server. `--sync-server` then says which one a command means; it can be left
off while only one is signed in, and the commands the Agents tab shows always include it.

## Set up: a local graph folder

No sign-in and no Sync Server required. The agent gets the same tools over the folder's
markdown, beside the files themselves, which it can still read and write directly. **Settings → Agents** shows the
command with your folder's path filled in once you've recorded the path on the General tab:

```sh
claude mcp add etherpk -- npx @appsoftwareltd/etherpk-mcp serve --folder /path/to/your/notes
```

The folder must already be an EtherPK graph (open it in EtherPK once). Edits made in an editor,
or by the agent writing files directly, are picked up before the next tool call, and the index
follows within a second or so. A tool's write is in the file when the tool returns; if a write
fails, the agent is told why and the edit is retried on the next write. The index lives under
the cache directory, never in the folder.

## Commands and flags

Every command is `npx @appsoftwareltd/etherpk-mcp <command>`. `npx` never puts `etherpk-mcp` on
your PATH; for the short form, `npm install -g @appsoftwareltd/etherpk-mcp` once. `--help` (`-h`)
prints this reference, `--version` (`-v`) the version.

| Command | What it does |
| --- | --- |
| `login --sync-server <url> [--pat <token>] [--recovery-code]` | Sign this computer in as a device of your account on that Sync Server. Asks for a Personal Access Token unless given one, then unlocks your keys by Device Approval or, with `--recovery-code`, your Recovery Code. Lists the graphs it can reach when done. |
| `graphs [--sync-server <url>]` | List the synced graphs each signed-in account can reach, by name, id and your role. Without `--sync-server`, every signed-in server in turn. |
| `serve --graph <id or name> [--sync-server <url>] [--no-semantic]` | Serve one synced graph to the agent over stdio. |
| `serve --folder <path> [--no-semantic]` | Serve a local graph folder the same way. The folder must already be an EtherPK graph. |
| `logout [--sync-server <url> \| --all]` | Forget that server's token and keys and delete its cached graphs. `--all` forgets every server and clears the whole cache, semantic runtime and model included. Revoke the token at the portal too if the computer isn't yours to keep. |
| `semantic setup` | Install the embedding runtime (about 300 MB, through your npm) and the 23 MB model into the cache directory. Once per computer. |
| `semantic status` | Whether semantic search is set up here, and each cached graph's embedding progress. |
| `semantic remove` | Delete the runtime and model. Each graph's stored vectors stay in its cache and are reused if you set up again. |
| `publish (--graph <id or name> \| --folder <path>) --publication <id> [--out <dir>]` | Publish one publication of a graph to a folder on this computer and print the report. `--out` sets the folder for that graph and publication and is remembered: the command without `--out`, and the agent's `publish` tool, write there from then on (the agent can't choose a folder). The folder's owned files (top-level `.html`, `assets/`, `theme/`, the search, feed and report files) are rewritten and their strays removed; everything else is left alone. Writes files; deploying them is yours. |
| `diagrams setup` | Install a Chromium (about 170 MB) into the cache directory so a publish can draw Mermaid diagrams. Once per computer; a publish with diagrams refuses until then. |
| `diagrams status` | Which browser a publish would use, if any. |

| Flag | Applies to | Meaning |
| --- | --- | --- |
| `--sync-server <url>` | `login`, `graphs`, `serve --graph`, `logout` | Which Sync Server the command means. Required for `login`; elsewhere optional while only one server is signed in. `serve` and `logout` refuse to guess when several are. |
| `--pat <token>` | `login` | The Personal Access Token, instead of the prompt. |
| `--recovery-code` | `login` | Unlock with your Recovery Code instead of waiting for Device Approval. Pressing `r` while `login` waits does the same. |
| `--graph <id or name>` | `serve` | The synced graph to serve. Exclusive with `--folder`. |
| `--folder <path>` | `serve` | The local graph folder to serve. Exclusive with `--graph` and `--sync-server`. |
| `--no-semantic` | `serve` | Keep this agent text-only even when semantic search is set up. |
| `--all` | `logout` | Every server at once. |
| `--publication <id>` | `publish` | Which publication of the graph. `list_publications` and Settings → Publish show the ids. |
| `--out <dir>` | `publish` | Where the site goes on this computer. Remembered for the graph and publication. |

| Environment variable | Meaning |
| --- | --- |
| `ETHERPK_PAT` | Stands in for the token prompt, for a scripted `login`. |
| `ETHERPK_RECOVERY_CODE` | Stands in for the Recovery Code prompt, for a scripted `login --recovery-code`. |
| `ETHERPK_MCP_CONFIG` | The config file holding the logins. Default `~/.config/etherpk/mcp.json` (`XDG_CONFIG_HOME` respected). |
| `ETHERPK_MCP_CACHE_DIR` | The cache root for graphs, the semantic runtime and the model. Default `~/.cache/etherpk/mcp` (`XDG_CACHE_HOME` respected). Set it in the agent registration's `env` as well as your shell: the agent starts `serve` with its own environment. |
| `ETHERPK_MCP_SEMANTIC_THREADS` | Threads for the embedding model. Default a quarter of the cores, at most four. |
| `ETHERPK_MCP_DEBUG_MEMORY` | `1` logs the process's memory use every 10 seconds and on every progress line. |
| `ETHERPK_MCP_PUBLISH_CONFIG` | The file remembering each publication's publish folder. Default `publish.json` beside the config file. |
| `ETHERPK_CHROMIUM` | A Chromium on this computer for drawing diagrams, instead of the one `diagrams setup` installs. NixOS needs this. |

## What the agent gets

Thirty-two tools, the same over a synced graph and a folder. Reading: `graph_info`,
`list_documents` (with a range of journal days), `read_document` (the body as text, the
frontmatter as data), `read_documents`, `search`, `backlinks`, `tasks`, `list_assets`,
`read_asset`, `list_publications`. Writing: `edit_document` (an exact, unique old→new
replacement; on a synced graph it merges with anyone typing elsewhere on the page),
`append_document` (a page, or a day's journal entry, created if needed), `create_page`,
`set_frontmatter` (`public`, `publications`, `date`, any key; never the title or aliases),
`set_task`, `set_aliases`, `plan_rename` and `rename` (scoped concepts carried along, links
rewritten by default, a merge only when confirmed), `upload_asset` (returns the markdown to
paste), `create_publication`, `update_publication` and `publish` (into the folder you set with
the `publish` command; it can't choose one). Themes: `list_themes`, `read_theme` and
`read_theme_file` (a theme's files out to disk to edit), `create_theme` and
`customise_publication_theme` (a copy in the graph, since a bundled theme is never edited in
place), `write_theme_file`, `delete_theme_file`, `import_theme_folder`, `delete_theme`, and
`preview_theme` (a rendered site to inspect, with screenshots when a browser is set up). A
protected document is refused by every one of them. One running instance serves one graph.

No skill or extra setup is needed: the server describes its tools and the graph, and Claude Code
reaches for them when you ask about your notes. To make that a rule rather than a good guess, add
one line to your `CLAUDE.md`: *"My notes live in EtherPK; use the etherpk MCP tools for anything
I've written down, and `search` in semantic mode for questions."*

## Searching by meaning

`search` matches words. With one more step it also matches **meaning** - "when do I pay my taxes"
finds the note that says "due 31 January" - by running a small embedding model on this computer.
Nothing is sent anywhere, and protected documents are never embedded.

```sh
npx @appsoftwareltd/etherpk-mcp semantic setup
```

- **Any order, no restart.** Run it before or after registering the agent, even while one is
  connected: a running `serve` notices within 30 seconds and starts building. Until then a
  search by meaning is refused with this command in the message, so the agent can tell you what
  to run.
- **What changes.** `search` accepts `mode: "semantic"` (and `"hybrid"`, both groups side by
  side). Each result carries the document, the breadcrumb of headings and parent bullets, the
  passage's line range and its text with a similarity score. Passage text has bullet markers and
  `[[ ]]` stripped, so it's right for quoting and wrong as the `old` text of `edit_document`,
  which should come from `read_document`.
- **Progress.** The first pass over a large graph takes minutes, in the background; after that
  only edits are processed. Every semantic result says `embedded` / `total` and `complete`, and
  `semantic status` shows each cached graph's progress.
- **Only while it runs.** The store is built and kept current by `serve`, which exists only while
  an agent session has it open. To keep a graph current without an agent, run it by hand:
  `npx @appsoftwareltd/etherpk-mcp serve --graph <id> </dev/null &` (or `--folder <path>`).
- **Load.** The first pass uses a quarter of the cores, at most four, and pauses between model
  calls. `ETHERPK_MCP_SEMANTIC_THREADS=8` in the registration's `env` makes it faster and hotter.

## What this client keeps on your computer

- **Keys** in `~/.config/etherpk/mcp.json`, one entry per Sync Server, readable only by your
  user - the same trust as a browser you've signed in on.
- **A cache of each synced graph you serve** under `~/.cache/etherpk/mcp/`, so a restart fetches
  what changed rather than everything. It holds your notes readably, as a signed-in browser's
  storage does. It's never the source of truth: on every start the Sync Server is asked what
  moved, edits made elsewhere arrive as they happen, and a newer version of this program
  discards a cache it no longer understands and rebuilds it.
- **For a folder**, only its index and (once set up) its vectors, under
  `local/<folder name>-<hash of its path>/` in the same cache directory. Nothing is written into
  the folder. Moving or renaming the folder starts the index over.

On Windows both paths sit under your user folder: `C:\Users\<you>\.config\etherpk\` and
`C:\Users\<you>\.cache\etherpk\`. Revoke the token at the portal to cut an agent off; `logout`
forgets the keys and deletes the cache on this computer.

## Building and publishing

From the repository root. The bundle compiles the Client's own sync, crypto and index code in
through a `$lib` alias, so it builds from the repository, not from this folder alone:

```sh
pnpm install                                      # once, at the repo root
pnpm --filter @appsoftwareltd/etherpk-mcp check   # type-check
pnpm --filter @appsoftwareltd/etherpk-mcp test    # unit tests, no server needed
pnpm --filter @appsoftwareltd/etherpk-mcp build   # dist/main.js; run it with node dist/main.js
```

Releases are published to npm by the repository's CI, at the version the Client and the Sync
Server share (the CLI reads it from `package.json`). Check that a release is on the registry:

```sh
npx -y @appsoftwareltd/etherpk-mcp@<version> --version
```

Full guide: <https://docs.etherpk.com/using-ai-agents-with-your-notes>.
