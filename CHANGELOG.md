# Changelog

What changed in each release of the EtherPK Client and the Headless Client
([`@appsoftwareltd/etherpk-mcp`](https://www.npmjs.com/package/@appsoftwareltd/etherpk-mcp) on npm).
They are released together, under the version number they share with the Sync Server. This log
starts at 0.9.3.

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
