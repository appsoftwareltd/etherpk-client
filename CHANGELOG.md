# Changelog

What changed in each release of the EtherPK Client and the Headless Client
([`@appsoftwareltd/etherpk-mcp`](https://www.npmjs.com/package/@appsoftwareltd/etherpk-mcp) on npm).
They are released together, under the version number they share with the Sync Server. This log
starts at 0.9.3.

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
