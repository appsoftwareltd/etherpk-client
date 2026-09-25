# @appsoftwareltd/etherpk-mcp

An [MCP](https://modelcontextprotocol.io) server that gives an AI agent (Claude Code, Codex, Cursor
and others) one of your [EtherPK](https://etherpk.com) knowledge graphs. It runs on the same
computer as the agent, which can then search your notes by words or by meaning, follow links, list
tasks, and read and edit documents without breaking EtherPK's format.

This package is EtherPK's **Headless Client**: EtherPK without an editor. It serves either a graph
folder on your computer or a graph synced through a Sync Server, and the agent gets the same tools
for both. Protected documents are listed by name only and never served.

Needs Node.js 22 or later.

## Get started

### A synced graph

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

### A local graph folder

No sign-in and no Sync Server. **Settings → Agents** shows the command with your folder's path
filled in once you've recorded the path on the General tab:

```sh
claude mcp add etherpk -- npx @appsoftwareltd/etherpk-mcp serve --folder /path/to/your/notes
```

The folder must already be an EtherPK graph: open it in EtherPK once.

### Ask about your notes

The server describes its tools and the graph to the agent, so no skill or extra setup is needed. Ask
about something you've written down and the agent uses the tools. To make that a rule rather than
the agent's judgement, add a line to your `CLAUDE.md`, or your agent's equivalent:

> My notes live in EtherPK; use the etherpk MCP tools for anything I've written down, and `search`
> in semantic mode for questions.

## What the agent can do

Thirty-two tools, the same over a synced graph and a folder. One running server serves one graph,
and every tool refuses a protected document.

| Group | Tools | Notes |
| --- | --- | --- |
| Find and read | `graph_info`, `list_documents`, `read_document`, `read_documents`, `search`, `backlinks`, `tasks` | `list_documents` can narrow to a range of journal days. `read_document` returns the body as text and the frontmatter as data. |
| Edit | `edit_document`, `append_document`, `create_page`, `set_task`, `set_frontmatter`, `set_aliases` | `edit_document` replaces one exact, unique piece of text; on a synced graph it merges with edits made elsewhere at the same time. `append_document` creates a day's journal entry when there is none. `set_frontmatter` sets any key except `title`, `aliases` and `publication`, which have tools of their own. |
| Rename | `plan_rename`, `rename` | Links to the old name are rewritten by default and scoped concepts move with it. Renaming onto a name that is taken merges two documents and needs confirming. |
| Images and files | `upload_asset`, `read_asset`, `list_assets` | `upload_asset` returns the markdown to paste into a document; `read_asset` writes an asset to a local file. |
| Publishing | `list_publications`, `create_publication`, `update_publication`, `publish` | `publish` writes into the folder you set with the `publish` command; the agent can't choose one. |
| Themes | `list_themes`, `read_theme`, `read_theme_file`, `create_theme`, `customise_publication_theme`, `write_theme_file`, `delete_theme_file`, `import_theme_folder`, `delete_theme`, `preview_theme` | Bundled themes are read-only; customising one copies it into the graph. `preview_theme` renders a site to inspect, with screenshots when a browser is set up. |

## Search by meaning

`search` matches words. After one setup step it also matches **meaning**: "when do I pay my taxes"
finds the note that says "due 31 January". A small embedding model runs on this computer; nothing is
sent anywhere, and protected documents are never embedded.

```sh
npx @appsoftwareltd/etherpk-mcp semantic setup
```

Setup installs a native runtime of about 300 MB through your npm, and a 23 MB model, into the cache
directory, once per computer.

- **No restart needed.** A running `serve` checks every 30 seconds and starts building once setup
  has run. Until then a search by meaning is refused, and the message names the setup command so
  the agent can tell you what to run.
- **Modes.** `search` accepts `mode: "semantic"`, and `"hybrid"` for words and meaning side by side.
  Each result carries the document, its breadcrumb of headings and parent bullets, the passage's
  lines and text, and a similarity score. Passage text has bullet markers and `[[ ]]` removed, so
  quote it, but take the `old` text for `edit_document` from `read_document`.
- **Progress.** The first pass over a large graph takes minutes and runs in the background; after
  that only changed documents are embedded. Every semantic result reports `embedded`, `total` and
  `complete`, and `semantic status` shows each cached graph.
- **Only while `serve` runs.** `serve` builds and updates the store, and runs only while an agent
  session has it open. To keep a graph current without an agent, run
  `npx @appsoftwareltd/etherpk-mcp serve --graph <id> </dev/null &` (or `--folder <path>`).
- **Load.** The model uses a quarter of the cores, at most four, and pauses for a tenth of a second
  between batches. `ETHERPK_MCP_SEMANTIC_THREADS` changes the thread count; set it in the agent
  registration's `env`.
- **Per agent.** `serve --no-semantic` keeps one registration text-only.

## Synced graphs in detail

### Signing in

`login` makes this computer a device of your account:

- It asks for an account-wide Personal Access Token, from `<Sync Server>/account/tokens` or
  **Access tokens** in EtherPK's account menu. `--pat` or `ETHERPK_PAT` supplies it instead.
- It unlocks your keys by Device Approval: it shows a short code, which you confirm in EtherPK in
  any browser signed in to the account with its graphs unlocked.
- With no EtherPK to hand, press `r` while it waits, or pass `--recovery-code`, and type your
  Recovery Code instead. `ETHERPK_RECOVERY_CODE` supplies the code for a scripted setup.

When it is done it lists the graphs the account can reach. A self-hosted Sync Server works the same
way: give its address to `login`.

### Choosing a graph

`graphs` lists the synced graphs each signed-in account can reach, with the name, the id and your
role. `serve --graph` takes the id or the name. A graph nobody has opened since names were first
stored on the server is opened once to read its name; `(unnamed)` means it has none.

### Several Sync Servers

One computer can be signed in to several Sync Servers, your own beside EtherPK's, say. Run `login`
once for each. `--sync-server` then says which server a command means. It can be left out while only
one server is signed in, and the commands the Agents tab shows always include it.

## Local folders in detail

- The folder must hold `pages/` and `journals/`. `serve` never creates them, so a mistyped path is
  refused rather than turned into an empty graph.
- Edits made in an editor, or by the agent writing files directly, are picked up before the next
  tool call, and the index follows within a second or so.
- A tool's write is in the file when the tool returns. If a write fails, the agent is told why and
  the edit is retried on the next write.
- The index lives under the cache directory, never in the folder. Moving or renaming the folder
  starts the index again.

## Publishing a site

`publish` renders one publication of a graph into a folder on this computer and prints the report:

```sh
npx @appsoftwareltd/etherpk-mcp publish --graph <id or name> --publication <id> --out <dir>
```

- `--out` is remembered for that graph and publication. Later runs without it, and the agent's
  `publish` tool, write to the same folder. The agent can't choose a folder.
- In that folder, the top-level `.html` files, `assets/`, `theme/` and the search, feed and report
  files are rewritten, and files that no longer belong are removed. Everything else is left alone.
- Deploying the folder, with a git push say, is up to you. Run the command from cron for a site that
  republishes itself.
- Mermaid diagrams need a browser. `diagrams setup` installs a Chromium of about 170 MB into the
  cache directory, once per computer, and a publish whose pages hold diagrams refuses until then.
  `ETHERPK_CHROMIUM` names a Chromium already on the computer instead; NixOS needs this.
- `list_publications`, or **Settings → Publish** in EtherPK, shows the publication ids.

## Reference

Every command is `npx @appsoftwareltd/etherpk-mcp <command>`. `npx` never puts `etherpk-mcp` on
your PATH; for the short form, install the package globally once:

```sh
npm install -g @appsoftwareltd/etherpk-mcp
```

`--help` (`-h`) prints the command reference and `--version` (`-v`) the version.

### Commands

| Command | What it does |
| --- | --- |
| `login --sync-server <url> [--pat <token>] [--recovery-code]` | Sign this computer in as a device of your account on that Sync Server, unlock your keys, and list the graphs the account can reach. |
| `graphs [--sync-server <url>]` | List the synced graphs each signed-in account can reach, by name, id and your role. Without `--sync-server`, every signed-in server in turn. |
| `serve --graph <id or name> [--sync-server <url>] [--no-semantic]` | Serve one synced graph to the agent over stdio. |
| `serve --folder <path> [--no-semantic]` | Serve a local graph folder the same way. |
| `logout [--sync-server <url> \| --all]` | Forget that server's token and keys and delete its cached graphs. `--all` forgets every server and clears the whole cache, the semantic runtime and model included. |
| `semantic setup` | Install the embedding runtime and model into the cache directory. |
| `semantic status` | Whether semantic search is set up here, and each cached graph's embedding progress. |
| `semantic remove` | Delete the runtime and model. Each graph's stored embeddings stay in its cache and are reused if you set up again. |
| `publish (--graph <id or name> \| --folder <path>) --publication <id> [--out <dir>]` | Publish one publication of a graph to a folder on this computer and print the report. |
| `diagrams setup` | Install a Chromium into the cache directory so a publish can draw Mermaid diagrams. |
| `diagrams status` | Which browser a publish would use, if any. |

### Flags

| Flag | Applies to | Meaning |
| --- | --- | --- |
| `--sync-server <url>` | `login`, `graphs`, `serve --graph`, `publish --graph`, `logout` | Which Sync Server the command means. Required for `login`; elsewhere optional while only one server is signed in. `serve` and `logout` refuse to guess when several are. |
| `--pat <token>` | `login` | The Personal Access Token, instead of the prompt. |
| `--recovery-code` | `login` | Unlock with your Recovery Code instead of waiting for Device Approval. Pressing `r` while `login` waits does the same. |
| `--graph <id or name>` | `serve`, `publish` | The synced graph. Not with `--folder`. |
| `--folder <path>` | `serve`, `publish` | The local graph folder. Not with `--graph` or `--sync-server`. |
| `--no-semantic` | `serve` | Keep this agent text-only even when semantic search is set up. |
| `--all` | `logout` | Every server at once. |
| `--publication <id>` | `publish` | Which publication of the graph. |
| `--out <dir>` | `publish` | Where the site goes on this computer. Remembered for the graph and publication. |

### Environment variables

| Variable | Meaning |
| --- | --- |
| `ETHERPK_PAT` | The Personal Access Token, for a scripted `login`. |
| `ETHERPK_RECOVERY_CODE` | The Recovery Code, for a scripted `login --recovery-code`. |
| `ETHERPK_MCP_CONFIG` | The file holding the logins. Default `~/.config/etherpk/mcp.json`, under `XDG_CONFIG_HOME` when that is set. |
| `ETHERPK_MCP_CACHE_DIR` | The cache directory for graphs, the semantic runtime and the model. Default `~/.cache/etherpk/mcp`, under `XDG_CACHE_HOME` when that is set. Set it in the agent registration's `env` as well as your shell: the agent starts `serve` with its own environment. |
| `ETHERPK_MCP_PUBLISH_CONFIG` | The file remembering each publication's publish folder. Default `publish.json` beside the login file. |
| `ETHERPK_MCP_SEMANTIC_THREADS` | Threads for the embedding model. Default a quarter of the cores, at most four. |
| `ETHERPK_CHROMIUM` | A Chromium on this computer for drawing diagrams, instead of the one `diagrams setup` installs. |
| `PLAYWRIGHT_BROWSERS_PATH` | Where `diagrams setup` installs Chromium and a publish looks for it. Default `browsers/` in the cache directory. |
| `ETHERPK_MCP_DEBUG_MEMORY` | `1` logs the process's memory use every 10 seconds and with every progress line. |

## What stays on your computer

- **Keys** in the login file, `~/.config/etherpk/mcp.json`, one entry per Sync Server, readable only
  by your user: the same trust as a browser you've signed in on.
- **A cache of each synced graph you serve** under `~/.cache/etherpk/mcp/`, so a restart fetches what
  changed rather than everything. It holds your notes readably, as a signed-in browser's storage
  does. The Sync Server stays the source of truth: each start asks it what changed, edits made
  elsewhere arrive as they happen, and a newer version of this package discards a cache it can't
  read and rebuilds it.
- **For a folder**, only its index and, once semantic search is set up, its embeddings, under
  `local/<folder name>-<hash of its path>/` in the cache directory. Nothing is written into the
  folder.

On Windows both directories are under your user folder: `C:\Users\<you>\.config\etherpk\` and
`C:\Users\<you>\.cache\etherpk\`.

To cut an agent off, revoke its Personal Access Token on the Sync Server. `logout` forgets the token
and keys on this computer and deletes that server's cached graphs.

## Build from source

The package lives at `apps/mcp` in the etherpk-client repository. It compiles the Client's sync,
crypto and index code in through a `$lib` alias, so it builds from the repository root, not from
this folder alone:

```sh
pnpm install --frozen-lockfile
pnpm --filter @appsoftwareltd/etherpk-mcp check   # type check
pnpm --filter @appsoftwareltd/etherpk-mcp test    # unit tests, no server needed
pnpm --filter @appsoftwareltd/etherpk-mcp build   # dist/main.js; run it with node dist/main.js
```

Releases are published to npm by the repository's CI, at the version the Client and the Sync Server
share. To check that a version is on the registry:

```sh
npx -y @appsoftwareltd/etherpk-mcp@<version> --version
```

## Documentation and licence

The full guide is [Using AI agents with your notes](https://docs.etherpk.com/using-ai-agents-with-your-notes).

The package is available under the Elastic License 2.0 ([LICENSE](LICENSE)): you may use, copy,
modify and self-host it, but not offer it to others as a hosted or managed service. It is
source-available, not open source.
