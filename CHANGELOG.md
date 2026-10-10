# Changelog

What changed in each release of the EtherPK Client and the Headless Client
([`@appsoftwareltd/etherpk-mcp`](https://www.npmjs.com/package/@appsoftwareltd/etherpk-mcp) on npm).
They are released together, under the version number they share with the Sync Server. This log
starts at 0.9.3.

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
