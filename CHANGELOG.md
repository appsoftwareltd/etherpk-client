# Changelog

What changed in each release of the EtherPK Client and the Headless Client
([`@appsoftwareltd/etherpk-mcp`](https://www.npmjs.com/package/@appsoftwareltd/etherpk-mcp) on npm).
They are released together, under the version number they share with the Sync Server. This log
starts at 0.9.3.

## Unreleased

### Client

- **Long links in the Tasks panel wrap onto the next line.** A task with a long link or a long
  page name no longer makes the whole list scroll sideways.
- **Selecting a block in an outline selects its children too.** A selection from a parent into its
  first child now takes all of the parent's children, so what is highlighted is what Tab moves and
  what Backspace, Delete, cut and copy take. **Shift+Up** and **Shift+Down** shrink such a selection
  by a whole branch or block at a time.
- **Typing over selected blocks keeps the outline whole.** The blocks are replaced by one block in
  the place of the first, holding what you type, where the text used to land at the left margin and
  leave the next block without a parent. **Enter** and **Shift+Enter** leave one empty block, and
  words typed with a phone keyboard or an input method land in the block too. **Ctrl+Shift+Enter**
  over selected blocks cycles the task state of each of them.
- **Sharing to EtherPK from another app waits for you to press Add.** You can edit the shared text
  first, and tick **Add as task** to have it land as a task when you move it to your journal. With
  several graphs, the one you opened last is already selected, and the page no longer jumps about
  while it loads.
- **Move all to today's journal** in Quick notes is drawn like the **Add** button, so it no longer
  looks like a text box.

## 0.11.0 - 2026-10-13

### Client

- **The Today button's calendar is drawn with the same line weight** as the other buttons in the
  graph sidebar.
- **Extensions can show something about a day beneath its journal entry**, such as that day's
  calendar events, above the entry's backlinks. It is not part of the entry, so it is never synced
  with the graph, searched or published.
- **Extensions can sign you in to other services.** The sign-in opens in a small window and comes
  back to the Client's `/extension-sign-in` page, the one address to register with the service.
- **Extensions from the Extension Directory can do more**: add a button to the graph sidebar, open a
  document or a day's journal entry, follow the light and dark theme, save their own settings, and
  keep records that follow you to your other devices with your settings, encrypted. Uninstalling an
  extension clears its records.

## 0.10.2 - 2026-10-12

### Client

- **The journal button in the graph sidebar reads Today.** It showed today's date. It still opens
  today's journal, and a tab left open past midnight opens the new day.

## 0.10.1 - 2026-10-12

### Client

- **A site needs a folder of its own.** **Choose folder…** on the Publish tab refuses a local
  graph's folder, a Local Mirror's folder, a folder inside one and a folder that holds one, and
  says why: a publish removes the files it did not write from its folder. A folder chosen earlier
  is checked again before each publish.
- **Settings → Agents shows the agent skill**, with its install command and a copy button, for
  local and synced graphs alike.
- **The `AGENTS.md` in a local graph's folder** now says that a journal entry can carry
  `aliases`, `public`, `publications` and `slug`, names a blog's `recent` setting, and asks agents
  to keep an empty `journals/` or `pages/` folder with a `.gitkeep` file in it.

### Headless Client

- **`publish --dry-run`** renders and checks a publication and prints the whole report, without
  writing anything and without a publish folder. The `publish` tool takes `dryRun: true` for the
  same check.
- **`publish --out` refuses a folder that overlaps the graph's**: the served folder itself, a
  folder inside it, or one that holds it. Nothing is remembered, and a folder set earlier is
  checked again before each publish.

### Agent skill

- **New: the `etherpk` agent skill.** `npx skills add appsoftwareltd/etherpk-client` teaches
  Claude Code, Codex, Cursor and other agents to make a blog, docs site or wiki folder in EtherPK's
  format inside any project, to check it with a dry run and publish it, and to use the Headless
  Client's tools for a synced graph.

## 0.10.0 - 2026-10-12

### Client

- **Buttons at the top of the graph sidebar.** The sidebar now opens with **Search**, today's date
  (it opens today's journal), **Graph Map** and **Graph Kanban**. They sit in one row when the
  sidebar is wide, two by two at its usual width, and one above the other when it is narrow, with
  Search and today's date always first. Hover a button to see what it does and its keyboard
  shortcut.
- **Quick Find is gone.** The sidebar's "Quick find" box and its "Search everything" line are
  replaced by the Search button. Search finds documents by name in the same way, and offers a
  **New page** row for a name that has no page yet. Open it with Ctrl+K (⌘K on a Mac), Alt+F or
  the Search button.
- **Graph Kanban.** A Kanban board of every task in the graph, not only one page's tasks, at
  `/g/<graph>/kanban`. Open it from the sidebar's Graph Kanban button or **Graph Kanban** in the
  `/` menu. It works as any board does, and each card names the document its task is in.
  Desktop only, as every board is.
- **Graph Map View is now Graph Map**, on its button, its tab and its `/` menu row.
- **A search button on a phone's top bar**, to the left of the document name. The drawer buttons
  on the top bar now show which drawer is open. In a phone's drawer the sidebar's buttons are
  icons side by side, across the drawer's width.
- **Wider sidebars.** Both sidebars open at 304px wide, so the sidebar's buttons fit two by two.
  A sidebar you have already resized keeps its width.
- **Extension API.** A Graph Sidebar button can carry a `description`, shown as its help text
  with the key chords bound to its command, and a `when`, so it shows only where it applies.
- **Kanban boards look as designed again.** Cards have their padding back, long tasks are cut
  after three lines, a folded lane shows its name down the strip, and a card carried over a
  section outlines where it will land.
- **Search keeps the focus** when you open it straight after typing the first letter of a new
  page. The page used to take the focus back once it was saved.
- **A Stable Extension API.** The parts an extension from the Extension Directory may use are
  Stable from this release, and a Stable part never breaks: it is deprecated and kept. They are the
  parts below, and Views with their addresses, layout, settings, storage, commands and the Command
  Menu. The rest stays Proposed, for the extensions that come with EtherPK, and in an extension
  installed from the directory a call to a Proposed member throws an error that names it.
  `etc/etherpk-extension-api.public.api.md` in the package lists the Stable part.
- **More for extensions to build on.** The Extension API adds:
  - `context.editor.registerFence`, a widget drawn over every fenced block with a given info word,
    which edits the block's lines, can open it in a tab of its own or over the whole window, and
    says how a published site shows it, as a picture or a link card.
  - Extension Fences: a block named `<extension id>.<name>` holds an extension's data. It is never
    searched, never published as code, and the caret passes over it. Where its extension isn't
    running, a note says so and offers to show its text.
  - Text pasted on a line of its own, such as a video's link, can become an extension's block, and
    Mod+Z straight after gives back the text.
  - `context.editor.insertBlock`, which puts nothing in a Protected Document,
    `context.dialogs.prompt`, whose dialog names the extension that asks, and
    `context.embeds.frame`, which shows a YouTube or Vimeo player. Besides its own pages, the Client now allows frames from
    `www.youtube-nocookie.com` and `player.vimeo.com`, and from no other site.
  - `"isolation": "page"` in an extension's manifest, for a library that can't run in a shadow
    root, when every rule in its stylesheets styles only elements under its own classes.
- **The Extension Directory.** Settings and Extensions → Extensions lists extensions from other
  publishers, each release reviewed before it is listed. Install one and it starts at once, after a
  question that says what every extension can reach: the documents in the graphs you open, every
  extension's settings, and other websites. An extension from the directory can't take `map`,
  `math`, `mermaid` or `etherpk-cipher` as its id. The Client's server fetches each release from npm, checks
  it is the exact release the directory lists, and serves it from the Client's own address. It
  stops serving a release within minutes of it leaving the directory.
- **Your extensions follow you.** Once your account syncs a graph, the extensions you install from
  the directory install on your other devices as they start, which say so once, and Remove takes
  one off all of them. They leave a device with your other settings when you sign out there. While
  the directory can't be read, one your account has that this device hasn't installed yet says
  that it waits for the directory.
- **Extensions update by themselves.** A newer release is fetched while EtherPK runs and takes over
  the next time it starts, and the extension's row says when it was updated. A release taken out of
  the directory stops at once and the newest listed one takes its place. A release that needs a
  newer EtherPK waits, and the row says which version.
- **Pages of extensions from the directory have addresses**, under `/x/<extension>/`. A link to one
  whose extension is not installed opens a tab that says which extension it belongs to, with
  Install.
- **Settings for self-hosting the directory.** `EXTENSION_DIRECTORY_URL` chooses the list (EtherPK's
  when unset, none when empty), `EXTENSION_REGISTRY_URL` the npm registry, and `EXTENSION_CACHE_DIR`
  where the server keeps the releases it fetched, a folder no other user may write. Unset, the
  server uses a folder of its own in the system's temporary folder. A directory of your own
  can be plain files, with each release's package given by address (`tarball`) rather than
  fetched from a registry, on a web server or in a folder (a `file:` address). EtherPK's own
  directory takes every release from npm.
- **Extension manifests.** `readExtensionPackage` refuses an icon longer than 4096 characters, and
  a `main` or stylesheet path that is an address or a drive (`https:`, `C:`).

### Headless Client

- **Extension blocks on published pages.** `publish` leaves out a block that holds an extension's
  data (an Extension Fence, such as an Excalidraw drawing), since the Headless Client runs no
  extensions, and its report warns which documents had one. Publish from EtherPK in a browser,
  with the extension on, to include it.

## 0.9.6 - 2026-10-11

### Client

- **Journal roll.** Under a journal entry's text and backlinks, a bar names the previous day you
  wrote on. Scroll down, or select the bar, and that day opens below, editable and with its own
  backlinks, then the day before, up to ten days in one tab. **Hide** closes a day and the ones
  below it, and **Open** opens it in its own tab. **Show older entry** in the `/` menu does the
  same from the keyboard.
- **The Extension API on npm.** [`@appsoftwareltd/etherpk-extension-api`](https://www.npmjs.com/package/@appsoftwareltd/etherpk-extension-api),
  the package an EtherPK extension is written against, is on npm from 0.9.5 and is published with
  every release, at the Client's version.
- **Screenshots on the home page.** The home page shows four screenshots of the demo graph in turn:
  the Graph View, the editor, a Kanban board and a Map View. Choose one from the row of tabs under
  them, swipe on a phone, or pause them. A browser set to reduce motion shows the first one, still.
- **Maps in the Backlinks panel.** A reference that holds a map shows a picture of the map instead
  of its lines of text, as wide as the panel, with every place and route in view. Select it to open
  the note at the reference. The picture is always drawn over the deployment's own map, even with
  your own Mapbox token.
- **Today's journal on a phone's top bar.** A calendar button between the document name and the
  right drawer's button opens today's journal, without opening the left drawer first.
- **Long place names on a published map** are shortened with an ellipsis instead of running off
  the edge of the picture.
- **Backlinks beneath every document.** Every journal entry and page lists what links to it under
  its text, the same list as the Backlinks panel. A linked name that has no page yet opens with
  its backlinks under the empty first line. Select the **Backlinks** heading to fold the list for
  every document, or use **Backlinks below documents: hide** and **show** in the `/` menu.
  **Go to backlinks** in the `/` menu scrolls to the list from the keyboard.
- **A document is no longer its own backlink.** Its links to its own name are left out of the
  Backlinks panel.
- **Highlight reference** now emphasises a link written with one of the page's aliases, as it does
  a link written with the page's name.
- **No more jumps while moving through code.** With the cursor in a code block, the page could jump
  away from the cursor as you moved, because the editor guessed the height of the lines off screen
  from the code's own lines. It now guesses from ordinary text only.
- **Pictures keep their size after a reload.** The editor remembers the size each picture was last
  drawn at, per graph on this device, so the text around a picture no longer moves as it loads.
- **The cursor stays in view when a phone's keyboard opens**, or when a pane is made shorter, instead
  of sitting under the keyboard until the first key is pressed.
- **A swipe up or down on a code block's scroll bar scrolls the page** on a phone. A sideways drag
  still scrolls the code.

## 0.9.5 - 2026-10-10

### Client

- **A link's menu.** Right-click a link (long-press on a phone) for the same rows a document's tab
  has for looking at a concept: **Show Backlinks**, **Open Kanban Board**, **Show in Graph View**,
  **Open Map View** and **Show Tasks**, each for the concept the link names, without following the
  link. The Kanban board and the Graph View open on a desktop only, as from a tab.
- **Show Tasks.** A new row on a document's tab and on a link brings the Tasks view to the front,
  filtered to that concept. Its state, priority and date filters stay as you left them.
- **Map links.** A map's search box opens Google Maps short links (`maps.app.goo.gl`) through the
  graph's Sync Server, reads OpenStreetMap's short links on the device, and accepts everything a
  phone's Share gives, with the place's name before the link. A link that names a place but doesn't
  say where it is is searched for by its name, where your plan includes search.
- **Names for new places.** Where your plan includes search, a place you click on a map or type as
  coordinates is offered the name of the place nearest it, with its address underneath. A name you
  type first is kept.
- The map's search box says when searching by place name needs Sync+, and offers postcodes,
  coordinates and map links instead once a search is refused.
- **Use search and link services**, a new switch in the Maps extension's settings, on by default.
  Turned off, maps ask no search service and open no short links. Coordinates, Plus Codes, map
  links, postcodes and your own Mapbox token still work.
- A map's search box has a search button, and looks up a name or a postcode when you stop typing
  for a moment. Coordinates and links still wait for Enter or the button.
- A map's credit no longer shows over other panes when its tab is behind another.
- A map in a tab behind another stops drawing after a few seconds and draws again when you come
  back to it, so maps in many open tabs no longer stop each other from drawing.
- **Extension API:** a setting can be a `boolean`, drawn as a checkbox, with an optional
  `default`. `context.settings.get` reads it as `'true'` or `'false'`.
- **Maps in the demo graph.** Every plant in the demo graph has a map of where it grows wild, and
  the Where to Learn About Plants page gathers gardens noted across the graph into one Map View.
  Today's journal has a map to try. **Reset demo** brings a demo you opened before up to date.

## 0.9.4 - 2026-10-09

### Client

- **Maps.** Type `/map` in a document to add a map. Its places and routes are kept in the document
  as lines of text, so they sync, export and back up with the rest of it. Add a place by pasting
  coordinates, a Plus Code or a link from Google Maps, Apple Maps or OpenStreetMap, or by clicking
  the map. Draw a route, or import a GPX recording. A map under a bullet sits beside its dot.
- **Finding a place.** A map's search finds UK postcodes and US ZIP codes for everyone, a whole UK
  postcode district included. A search by name or address goes through the graph's Sync Server,
  where its account's plan includes it, and the search service's credits show under the results.
- **The Map View.** A concept's map shows every place and route that belongs to it, and the Graph
  Map View, a button under Today's journal, shows the whole graph's, with a list beside the map.
  Places at one spot are offered together. **Show in document** opens the document in the map's
  own pane, with the place chosen on its map.
- **Maps on published sites.** A published page shows a map as a picture, with the places' names,
  and the site never holds the map's coordinates.
- **Your own Mapbox.** With your own Mapbox access token in the maps' settings, maps are drawn over
  Mapbox's street map, with a **Satellite** switch that each device remembers.
- **Settings and Extensions.** The graph's settings dialog has two areas, **Settings** and
  **Extensions**. The Extensions area lists the extensions that come with EtherPK, the Graph View,
  Kanban boards and maps, each with a switch for this device. An extension's settings are set under
  its name, even while it is off, and follow you to your other devices through your account once it
  syncs a graph.
- **Zoom.** The document's text zooms with Alt+= and Alt+-. Ctrl+wheel (Cmd+wheel on a Mac) over a
  map zooms the map.
- **Published sites.** Every bundled theme gives a site EtherPK's favicon, the blog and docs themes
  have a wider text column, and a published image stays inside its column.
- Updated dependencies.

### Headless Client

- **Maps on published pages.** `publish` draws each map as a picture in the browser it manages for
  diagrams, so publishing a page with a map needs that browser. `ETHERPK_MAP_STYLE_URL` names the
  map style it draws with, and a publish the shared graph host runs uses it too.
- Updated dependencies.

## 0.9.3 - 2026-10-08

### Client

- The **Agents** tab in a synced graph's settings makes the one-time setup code that the Headless
  Client's `login` command needs, on Managed Sync. For a custom server it links to the server's
  **Access tokens** page, which makes the code.
- **Reset Encryption Keys** on a custom server finishes on the server's own **Reset Encryption
  Keys** page, after a recent sign-in there. The dialog finishes the reset on the device by itself
  once it is done. It also says that the reset signs out every agent.
- Settings opens when its button is clicked while a graph is still opening. Before, a click in
  that moment could be lost.

### Headless Client

- `login --code <setup code>` signs a computer in with a one-time setup code. The computer gets an
  agent token of its own, which can do only what the Headless Client needs and stops working after
  30 days without use.
- A token given to `login --pat` is swapped for an agent token and revoked. A login made by an
  earlier version is swapped the same way on its next run.
- The token and the Encryption Keys are kept in the macOS Keychain, or in a Linux desktop's keyring
  through `secret-tool`, where `login` can use one, and in the config file otherwise. The config
  file is replaced whole when it changes, so a crash or a full disk part way through leaves the
  previous file.
- `logout` revokes the computer's token on the Sync Server.
- Several agents can use one graph at once. The first agent's `serve` starts a background process
  that holds the graph, and every other `serve` passes its requests to that process. `running`
  lists these processes and `stop` ends them. `ETHERPK_MCP_HOST_IDLE_SECONDS` sets how long one
  stays after its last agent has gone, five minutes by default.
- An agent's session starts before a large graph has finished opening, and each tool waits for the
  graph.
- When a graph cannot be served, for example on a computer that is not logged in, `serve` stays
  connected and every tool answers with the reason. A later call tries again.
- `publish` runs in the graph's background process when one is running.
