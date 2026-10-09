# @appsoftwareltd/etherpk-mcp

[![Discord](https://img.shields.io/badge/Discord-join%20the%20community-5865F2?logo=discord&logoColor=white)](https://discord.gg/m9vScxQzvp)

An [MCP](https://modelcontextprotocol.io) server that gives an AI agent (Claude Code, Codex, Cursor
and others) one of your [EtherPK](https://etherpk.com) knowledge graphs. It runs on the agent's
computer. The agent can search your notes by words or by meaning, follow links, list tasks, and
read and edit documents without breaking EtherPK's format.

This package is EtherPK's **Headless Client**, EtherPK without an editor. It serves a graph folder
on your computer or a graph synced through a Sync Server, with the same tools for both. Protected
documents are listed by name only and never served.

Needs Node.js 24 or later.

## Get started

### A synced graph

In EtherPK, open the graph's **Settings → Agents** and select **Make a setup code**. The tab shows
two commands with your server, the code and the graph filled in. On your own Sync Server, the tab
links to the server's **Access tokens** page, which makes the code.

```sh
# Once per computer. When this terminal and an unlocked EtherPK tab show the same code,
# approve in the tab, then press y here.
npx @appsoftwareltd/etherpk-mcp login --sync-server https://sync.etherpk.com --code <setup code>

# Register the graph with your agent (Claude Code shown, the Agents tab has the others).
claude mcp add etherpk -- npx @appsoftwareltd/etherpk-mcp serve --sync-server https://sync.etherpk.com --graph <graph id>
```

### A local graph folder

No sign-in and no Sync Server:

```sh
claude mcp add etherpk -- npx @appsoftwareltd/etherpk-mcp serve --folder /path/to/your/notes
```

The folder must already be an EtherPK graph, so open it in EtherPK once. **Settings → Agents**
shows this command with the path filled in once the folder's path is set on the General tab.

### Ask about your notes

The server describes its tools and the graph to the agent, so nothing else needs setting up. To
make the agent always use them, add a line like this to your `CLAUDE.md`, or your agent's
equivalent:

> My notes are stored in EtherPK. Use the etherpk MCP tools for anything I've written down, and
> `search` in semantic mode for questions.

## What the agent can do

Thirty-six tools, the same for a synced graph and a folder. Each `serve` serves one graph, and
every tool refuses a protected document.

| Group | Tools | Notes |
| --- | --- | --- |
| Find and read | `graph_info`, `list_documents`, `read_document`, `read_documents`, `search`, `backlinks`, `tasks`, `graph_insights`, `graph_path` | `list_documents` can narrow to a range of journal days. `graph_insights` lists the most-linked concepts, clusters and bridges, and `graph_path` finds how two concepts connect. |
| Edit | `edit_document`, `append_document`, `create_page`, `set_task`, `set_frontmatter`, `set_aliases` | `edit_document` replaces one exact, unique piece of text, and on a synced graph it merges with edits made elsewhere. `append_document` creates the day's journal entry when there is none. |
| Tasks handed over | `read_task`, `add_task_note`, `set_task` | Paste the agent a task reference copied in EtherPK. The reference still finds the task after lines are added above it, and refuses once the task's words change. |
| Rename | `plan_rename`, `rename` | Links to the old name are rewritten. Renaming onto a name in use merges two documents and needs confirming. |
| Images and files | `upload_asset`, `read_asset`, `list_assets` | `upload_asset` returns the markdown to paste into a document. It refuses hidden files and folders (`.ssh`, `.env`), the Headless Client's own config and cache, and files over 100 MiB. |
| Publishing | `list_publications`, `create_publication`, `update_publication`, `publish` | `publish` writes to the folder set with the `publish` command. The agent can't choose one. |
| Themes | `list_themes`, `read_theme`, `read_theme_file`, `create_theme`, `customise_publication_theme`, `write_theme_file`, `delete_theme_file`, `import_theme_folder`, `delete_theme`, `preview_theme` | Bundled themes are read-only, and customising one copies it into the graph. `preview_theme` renders a site, with screenshots when a browser is set up. |

`read_asset`, `read_theme` and `preview_theme` write only in the graph's `downloads` folder in the
cache directory, and `import_theme_folder` reads only from there. A folder outside it is refused,
so a prompt hidden in a note cannot steer the agent into writing or reading elsewhere.

## Several agents on one graph

Any number of agents can use one graph at once. The first `serve` for a graph starts a background
process that holds the graph, and every `serve` passes its agent's requests to it, so there is one
copy of the graph in memory and one index on disk.

- The agent's session starts at once. A tool called before the graph has opened waits for it.
- The process saves the graph and stops five minutes after its last agent has gone
  (`ETHERPK_MCP_HOST_IDLE_SECONDS`). An agent still connected starts a new one on its next request.
- `running` lists the processes with their agents and logs, and `stop` ends them.
- If the process stops during a request, the agent is told the request may or may not have been
  applied. A request that never reached it goes to the next process.
- With no graph to serve (not logged in, or a folder that is not a graph yet), the agent stays
  connected and each tool answers `graph_unavailable` with the reason. A request 10 seconds or
  more later tries again, so fixing the cause needs no restart.
- The process logs to `host.log` in the graph's cache directory. `publish` runs in the same
  process.

## Search by meaning

`search` matches words. After one setup step it also matches meaning, so "when do I pay my taxes"
finds the note that says "due 31 January". A small embedding model runs on this computer. Nothing
is sent anywhere, and protected documents are never embedded.

```sh
npx @appsoftwareltd/etherpk-mcp semantic setup
```

Setup installs a native runtime of about 300 MB (through your npm) and a 23 MB model into the cache
directory, once per computer.

- **No restart.** A graph's background process checks every 30 seconds and starts embedding once
  setup has run. Until then a search by meaning is refused, and the message names the setup command.
- **Modes.** `search` takes `mode: "semantic"`, or `"hybrid"` for words and meaning together. Each
  result has the document, its breadcrumb of headings and parent bullets, the passage and a
  similarity score.
- **Progress.** The first pass over a large graph takes minutes and runs in the background. After
  that only changed documents are embedded. Results report `embedded`, `total` and `complete`, and
  `semantic status` shows each cached graph.
- **When it runs.** Only while the graph's background process runs, which is while an agent has
  the graph open and for five minutes after. To keep a graph current without an agent, run
  `npx @appsoftwareltd/etherpk-mcp serve --graph <id> </dev/null &` (or `--folder <path>`).
- **Load.** The model uses a quarter of the cores, at most four, and pauses a tenth of a second
  between batches. `ETHERPK_MCP_SEMANTIC_THREADS` changes the thread count. Set it in the agent
  registration's `env`.
- **Per agent.** `serve --no-semantic` keeps one registration text-only.

## Synced graphs

### Signing in

`login` makes this computer a device of your account.

- **The token.** `--code` trades a setup code for an agent token. Make the code in a synced graph's
  **Settings → Agents** in EtherPK, or on the Sync Server's **Access tokens** page, where the token
  is then listed as "Agent on <computer name>". An agent token can read and write your graphs. It
  cannot reset or replace your Encryption Keys, make tokens, invite people or delete graphs. It
  stops working after 30 days unused, when you revoke it, and when you reset your Encryption Keys.
- **For a script**, or a Sync Server too old for setup codes, `--pat` or `ETHERPK_PAT` gives an
  account-wide access token instead. `login` unlocks with it, then swaps it for an agent token and
  revokes it.
- **The keys** are unlocked by Device Approval. Open EtherPK in a browser where the account's
  Encryption Keys are unlocked. When the browser and the terminal show the same short code, select
  **Approve** in the browser and press `y` in the terminal. Press `n` if the codes differ.
- **Without EtherPK to hand**, press `r` while `login` waits, or pass `--recovery-code`, and type
  your Recovery Code. `ETHERPK_RECOVERY_CODE` supplies it for a scripted setup.

`login` then lists the graphs the account can reach.

### Choosing a graph

`graphs` lists the synced graphs each signed-in account can reach, with the name, the id and your
role. `serve --graph` takes the id or the name. `(unnamed)` means a graph has no name yet.

### Several Sync Servers

Run `login` once for each Sync Server. `--sync-server` then says which server a command means. It
can be left out while only one server is signed in.

## Local folders

- The folder must hold `pages/` and `journals/`. `serve` never creates them, so a mistyped path is
  refused rather than turned into an empty graph.
- Edits made in an editor, or by the agent writing files directly, are picked up before the next
  tool call, and the index follows within a second or so.
- A tool's write is in the file when the tool returns. A failed write is reported to the agent and
  retried on the next write.
- The index is kept in the cache directory, never in the folder. Moving or renaming the folder
  starts a new index.

## Publishing a site

`publish` renders one publication of a graph into a folder on this computer and prints the report:

```sh
npx @appsoftwareltd/etherpk-mcp publish --graph <id or name> --publication <id> --out <dir>
```

- `--out` is remembered for that graph and publication. Later runs without it, and the agent's
  `publish` tool, write to the same folder.
- The top-level `.html` files, `assets/`, `theme/` and the search, feed and report files are
  rewritten, and files that no longer belong are removed. Everything else in the folder is left
  alone.
- Deploying the folder is up to you. Run the command from cron for a site that republishes itself.
- Mermaid diagrams and maps need a browser. A map is published as a picture of the map, drawn over
  EtherPK's map host unless `ETHERPK_MAP_STYLE_URL` names another style. `diagrams setup` installs a
  Chromium of about 170 MB into the cache directory, once per computer, and a publish whose pages
  hold diagrams or maps refuses until then. `ETHERPK_CHROMIUM` names a Chromium already on the
  computer instead, which NixOS needs.
- `list_publications`, or **Settings → Publish** in EtherPK, shows the publication ids.

## Reference

Every command is `npx @appsoftwareltd/etherpk-mcp <command>`. For the short form, `etherpk-mcp`,
install the package globally once with `npm install -g @appsoftwareltd/etherpk-mcp`. `--help`
(`-h`) prints the command reference and `--version` (`-v`) the version.

### Commands

| Command | What it does |
| --- | --- |
| `login --sync-server <url> [--code <setup code>] [--recovery-code]` | Sign this computer in as a device of your account, unlock your Encryption Keys, and list the graphs the account can reach. |
| `graphs [--sync-server <url>]` | List the synced graphs each signed-in account can reach, with name, id and your role. |
| `serve --graph <id or name> [--sync-server <url>] [--no-semantic]` | Serve one synced graph to the agent over stdio. |
| `serve --folder <path> [--no-semantic]` | Serve a local graph folder the same way. |
| `running` | List the graphs served on this computer, with each one's background process, agents and log. |
| `stop [--graph <id or name> [--sync-server <url>] \| --folder <path> \| --all]` | Save a graph and end its background process, or every graph's when none is named. |
| `logout [--sync-server <url> \| --all]` | Revoke that server's token, forget it and the Encryption Keys, stop its graphs' background processes and delete its cached graphs. `--all` does this for every server and clears the whole cache, the semantic runtime and model included. |
| `semantic setup` | Install the embedding runtime and model into the cache directory. |
| `semantic status` | Whether semantic search is set up, and each cached graph's embedding progress. |
| `semantic remove` | Delete the runtime and model. Stored embeddings stay, and are reused if you set up again. |
| `publish (--graph <id or name> \| --folder <path>) --publication <id> [--out <dir>]` | Publish one publication of a graph to a folder and print the report. |
| `diagrams setup` | Install a Chromium into the cache directory, so a publish can draw Mermaid diagrams and maps. |
| `diagrams status` | Which browser a publish would use, if any. |

### Flags

| Flag | Applies to | Meaning |
| --- | --- | --- |
| `--sync-server <url>` | `login`, `graphs`, `serve --graph`, `publish --graph`, `stop --graph`, `logout` | Which Sync Server the command means. Required for `login`, and elsewhere optional while only one server is signed in. `serve` and `logout` refuse to guess between several. |
| `--code <setup code>` | `login` | The one-time setup code. It works once, within 10 minutes. |
| `--pat <token>` | `login` | An account-wide access token instead of a setup code. `login` swaps it for an agent token and revokes it. |
| `--recovery-code` | `login` | Unlock with your Recovery Code instead of Device Approval. Pressing `r` while `login` waits does the same. |
| `--graph <id or name>` | `serve`, `publish`, `stop` | The synced graph. Not with `--folder`. |
| `--folder <path>` | `serve`, `publish`, `stop` | The local graph folder. Not with `--graph` or `--sync-server`. |
| `--no-semantic` | `serve` | Keep this agent text-only even when semantic search is set up. |
| `--all` | `logout`, `stop` | Every server, or every graph. |
| `--publication <id>` | `publish` | Which publication of the graph. |
| `--out <dir>` | `publish` | Where the site goes. Remembered for the graph and publication. |

### Environment variables

Set a variable that `serve` should see in the agent registration's `env` as well as your shell,
because the agent starts `serve` with its own environment.

| Variable | Meaning |
| --- | --- |
| `ETHERPK_PAT` | An account-wide access token for a scripted `login`, swapped for an agent token and revoked. |
| `ETHERPK_RECOVERY_CODE` | The Recovery Code for a scripted `login --recovery-code`. |
| `ETHERPK_MCP_SECRETS` | `file` keeps the agent token and Encryption Keys in the login file even where there is a keychain. |
| `ETHERPK_MCP_CONFIG` | The login file. Default `~/.config/etherpk/mcp.json`, or under `XDG_CONFIG_HOME` when that is set. |
| `ETHERPK_MCP_CACHE_DIR` | The cache directory for graphs, the semantic runtime and the model. Default `~/.cache/etherpk/mcp`, or under `XDG_CACHE_HOME` when that is set. |
| `ETHERPK_MCP_PUBLISH_CONFIG` | The file that remembers each publication's folder. Default `publish.json` beside the login file. |
| `ETHERPK_MCP_SEMANTIC_THREADS` | Threads for the embedding model. Default a quarter of the cores, at most four. |
| `ETHERPK_MCP_HOST_IDLE_SECONDS` | How long a graph's background process stays after its last agent has gone. Default 300. |
| `ETHERPK_CHROMIUM` | A Chromium on this computer for drawing diagrams and maps, instead of the one `diagrams setup` installs. |
| `ETHERPK_MAP_STYLE_URL` | The MapLibre style a published map's picture is drawn over. Default EtherPK's map host; empty draws maps on a plain background. |
| `PLAYWRIGHT_BROWSERS_PATH` | Where `diagrams setup` installs Chromium and a publish looks for it. Default `browsers/` in the cache directory. |
| `ETHERPK_MCP_DEBUG_MEMORY` | `1` logs the process's memory use every 10 seconds and with every progress line. |

## What stays on your computer

- **The agent token and your Encryption Keys.** They go in the system keychain where `login` can
  use one: the macOS Keychain, or a Linux desktop's keyring through `secret-tool` (the
  `libsecret-tools` package on Debian and Ubuntu). The login file, `~/.config/etherpk/mcp.json`,
  then names only the server. Otherwise they are in the login file, readable only by your user,
  like a signed-in browser's storage. `login` says which. Any program running as you can ask the
  keychain for them, so run only agents you trust with your account, and never let one read, print
  or search `~/.config/etherpk`.
- **A cache of each synced graph you serve**, under `~/.cache/etherpk/mcp/`, so a restart fetches
  only what changed. It holds your notes readably. The Sync Server stays the source of truth, and a
  newer version of this package rebuilds a cache it can't read.
- **For a folder**, its index and, with semantic search, its embeddings, under
  `local/<folder name>-<hash of its path>/` in the cache directory. Nothing is written into the
  folder.
- **Beside each graph's cache**, `host.json` while its background process runs, and `host.log`,
  which names the graph's documents and is deleted with the cache. The process listens on a socket
  in a directory only your user can open (`$XDG_RUNTIME_DIR/etherpk-mcp`, or `etherpk-mcp-<uid>` in
  the temporary directory), or on Windows on a named pipe with a random name.

On Windows the login file and the cache are under `C:\Users\<you>\.config\etherpk\` and
`C:\Users\<you>\.cache\etherpk\`.

To cut an agent off, revoke its agent token on the Sync Server's **Access tokens** page. `logout`
revokes the token itself and deletes the keys and cached graphs on this computer. If the computer
or its login file may have been copied, also select **Replace Encryption Keys and lock out other
devices** in EtherPK, so the keys saved there no longer open your account.

## Build from source

The package's source is `apps/mcp` in the etherpk-client repository. It compiles the Client's sync,
crypto and index code in through a `$lib` alias, so it builds from the repository root, not from
this folder alone:

```sh
pnpm install --frozen-lockfile
pnpm --filter @appsoftwareltd/etherpk-mcp check   # type check
pnpm --filter @appsoftwareltd/etherpk-mcp test    # unit tests, no server needed
pnpm --filter @appsoftwareltd/etherpk-mcp build   # dist/main.js, run with node dist/main.js
```

The repository's CI publishes each release to npm, at the same version as the Client. To check that
a version is on the registry:

```sh
npx -y @appsoftwareltd/etherpk-mcp@<version> --version
```

## Documentation and licence

The full guide is [Using AI agents with your notes](https://docs.etherpk.com/using-ai-agents-with-your-notes).
What changed in each release is in the
[changelog](https://github.com/appsoftwareltd/etherpk-client/blob/main/CHANGELOG.md), which covers
this package and the EtherPK Client, released together under one version.

The package is available under the Elastic License 2.0 ([LICENSE](LICENSE)): you may use, copy,
modify and self-host it, but not offer it to others as a hosted or managed service. It is
source-available, not open source.
