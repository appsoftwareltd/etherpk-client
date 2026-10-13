# EtherPK Extension API

This package holds the types an [EtherPK](https://etherpk.com) extension is written against, and
`readExtensionPackage`, which checks an extension's manifest the way the EtherPK Client does. It
holds no code that the Client runs. MIT licensed.

```bash
npm install --save-dev @appsoftwareltd/etherpk-extension-api
```

It is a development dependency, because the Client supplies everything at run time.

## What an extension is

An extension is an npm package. Its `package.json` has an `etherpk` manifest, which says what the
extension is and what it adds, and its main module exports `activate(context)`. The Client calls
`activate` each time a graph opens, with a context for that graph. When the graph closes, the Client
removes everything the extension registered through the context, and calls the function `activate`
returned, if it returned one, for anything else the extension holds.

```json
{
    "name": "etherpk-extension-hello",
    "version": "1.0.0",
    "type": "module",
    "files": ["dist"],
    "etherpk": {
        "id": "hello",
        "displayName": "Hello",
        "publisher": "you",
        "minClientVersion": "0.10.0",
        "main": "./dist/main.js"
    }
}
```

```ts
import type { ExtensionContext } from '@appsoftwareltd/etherpk-extension-api'

export function activate(context: ExtensionContext): void {
    context.commands.register('hello.greet', () => context.notify('Hello from an extension.'))
    context.commandMenu.register({ id: 'hello.greet', title: 'Say hello', command: 'hello.greet' })
}
```

## Stable and Proposed parts

Each declaration in this package, and each member of one, is either Stable or Proposed. Its
documentation says which, with `@public` for Stable and `@beta` for Proposed.

- **A Stable part never breaks.** A change can add to it. Anything a change replaces is marked
  deprecated and kept working.
- **A Proposed part may change in any release.** Only the extensions that come with EtherPK may use
  it. In an extension installed from the Extension Directory, a call to a Proposed member throws an
  error that names it.

An extension listed in the Extension Directory uses only the Stable part.
[`etc/etherpk-extension-api.public.api.md`](etc/etherpk-extension-api.public.api.md) lists the
Stable part, and [`etc/etherpk-extension-api.beta.api.md`](etc/etherpk-extension-api.beta.api.md)
lists everything. A Proposed part becomes Stable when an extension from another publisher needs it.
To ask for one, open an issue on
[the EtherPK Client repository](https://github.com/appsoftwareltd/etherpk-client/issues).

## The manifest

| Field | What it is |
| --- | --- |
| `id` | The extension's id: lowercase letters, digits and hyphens, starting with a letter. The ids of everything it registers start with it. An extension in the Extension Directory can't use `map`, `math`, `mermaid` or `etherpk-cipher`, the words of blocks the Client draws itself. |
| `displayName` | The name Settings shows, and the name a dialog it opens gives. |
| `publisher` | Who publishes the extension. |
| `minClientVersion` | The oldest Client version the extension runs on, as `x.y.z`. An extension in the Extension Directory must give one. |
| `main` | The main module, an ES module. |
| `styles` | The extension's stylesheets (see *Styles* below). |
| `isolation` | `"shadow"`, the default, or `"page"` (see *Styles* below). |
| `icons` | Icons by name, each the SVG elements of a 16 by 16 picture. A Command Menu row or a View refers to an icon by its name. |
| `views` | The View kinds the extension supplies (see *Views* below). |
| `settings` | What the person can set (see *Settings* below). |

`readExtensionPackage(packageJson)` checks a manifest as the Client does, and lists every problem
it finds.

## What an extension can do

These are the Stable parts of the context.

### Commands and the `/` menu

`context.commands.register(id, handler)` adds a Command, whose id starts with the extension's id
(`hello.greet`). `context.commandMenu.register(item)` adds a row to the `/` menu that runs a Command.
A row can have a `detail` line, an `icon`, `keywords` that find it, a `group` and an `order`. Its
`when(menu)` says whether it is offered at the caret, from what `menu` reports: `bodyWritable`,
`inTable` and `protectedDocument`.

### Notices

`context.notify(text)` shows a short notice, as the Client's own notices do.

### Settings

A value the person sets, such as a key for a service, is declared in the manifest. The Client draws
it under the extension's entry in Settings, in the Extensions area.

```json
"settings": [
    {
        "id": "api-key",
        "type": "secret",
        "title": "Weather service key",
        "description": "Forecasts come from your own account with the weather service.",
        "placeholder": "wk_…",
        "link": { "title": "Getting a key", "url": "https://weather.example.com/keys" }
    }
]
```

`type` is `text`, `secret` or `boolean`. A secret stays hidden until the person shows it. A
`boolean` is a switch, and `"default": true` starts it on. The person can change settings while the
extension is switched off.

The extension reads a setting with `context.settings.get('api-key')`, which is undefined until the
person sets it, and hears every change with `context.settings.subscribe`. A switch always reads
`'true'` or `'false'`. Settings belong to the person, not to a graph. Once their account syncs a
graph, the settings follow them to their other devices, encrypted so that only those devices can read
them.

`context.settings.set('api-key', value)` sets one of the manifest's settings, as the person would in
Settings, or clears it with `null`. It is for a screen of the extension's own where the person types
the value, such as a setup guide. It throws for a setting the manifest does not declare, and a switch
takes only `'true'` or `'false'`.

### Storage

`context.storage` keeps the extension's own values on the device, as JSON, with `get`, `set` and
`remove`. It is for what the extension works out or caches, not for what the person sets.

### Records kept with the person

`context.personStorage` keeps the extension's own records with the person rather than on one
device, such as what signing in to another service gave it. It has `get`, `set`, `remove` and
`subscribe`, and keeps each record as JSON, at most 64 KB of it, under a key of letters, digits,
`.`, `_` and `-`. Where the person's account syncs a graph, the records follow them to their other
devices in the account's vault, encrypted so that only those devices can read them, and the later
change to a record wins. The person never sees them, and uninstalling the extension clears them on
every device.

A record is no more private than a setting. Any code in EtherPK's page can read it on the device,
and so can an agent the person gave an agent token for their account, so say in the extension what
it keeps.

### Signing in to another service

`context.auth` runs an OAuth 2.0 sign-in in a popup. The service sends the popup back to the
Client's one return page, `context.auth.redirectUri` (the Client's address followed by
`/extension-sign-in`), which the person registers with the service once, for every extension.

```ts
const answer = await context.auth.authorize(`https://accounts.example.com/authorize?client_id=…&redirect_uri=${encodeURIComponent(context.auth.redirectUri)}&state=${state}&…`, { signal })
if (answer.error) throw new Error(answer.error)
// answer.code: exchange it at the service's token endpoint.
```

- The address must carry a `state`: only a return with the same `state` answers the call.
- Call `authorize` inside the click that asked for it, with nothing awaited before it, because a
  browser blocks a popup opened later. Work that takes time, such as a PKCE challenge, is done
  before the click.
- `authorize` resolves with the parameters the service sent back, `error` among them when the
  person refused. It rejects when the browser blocks the popup, when `signal` aborts, or after ten
  minutes. It does not reject when the person closes the popup, which the Client cannot always tell,
  so offer a Cancel that aborts `signal`.
- The extension builds the request and exchanges the code itself: the Client knows no service.

### Journal Panels

A Journal Panel draws beneath a journal entry's text, above its backlinks, about that day, such as
the day's events from a calendar. It is outside the document, so nothing in it is synced with the
graph, searched or published.

```ts
context.journalPanels.register({
    id: 'weather.day',
    mount(element, { day, visibility }) {
        // `day` is YYYY-MM-DD. Load once `visibility.onScreen` is true.
        element.textContent = `Forecast for ${day}`
        return { destroy: () => element.replaceChildren() }
    },
})
```

The Client mounts a panel for each journal tab's own entry, a day with nothing written included, and
never for the older days shown beneath it. A panel is as tall as what it draws, so one that draws
nothing takes no space, and it draws its own heading and spacing. It mounts in a shadow root with the
extension's stylesheets, as a View does.

### Graph Sidebar buttons

A button in the Graph Sidebar, below Search and today's date, runs a Command:
`context.graphSidebar.register({ id, title, description, icon, order, when, command })`. These rules
keep the buttons readable together:

- **`title`** is short. Two buttons sit side by side in the sidebar at its default width of 304
  pixels, and "Graph Kanban", with its icon, is about the widest that fits.
- **`description`** says what the button does, such as "Open a map of every place and route in this
  graph". The Client shows it as the button's help text. Don't write a keyboard shortcut in it: the
  Client adds the key chords bound to the button's Command itself.
- **`icon`** is clear on its own. On a phone the buttons show their icons only.
- **`when`** hides the button where it does not apply. A button for the desktop alone passes
  `when: () => context.layout.isDesktop()`. A `when` that throws hides the button too.
- **`order`** places the button among the others. The Graph Map's is 20 and the Graph Kanban's is
  30.

### Opening documents, the theme and Events

- `context.layout.openDocument(concept)` opens a document as following a wikilink does. A day's
  name, `YYYY-MM-DD`, opens its journal entry.
- `context.theme.isDark()` says whether the dark theme shows, and the `theme:changed` Event reports a
  switch. EtherPK's `--gk-*` colour tokens reach into a shadow root and change with the theme by
  themselves.
- `context.events.on(name, listener)` hears the Client's Events: `document:active-changed`,
  `concept:renamed`, `document:deleted`, `documents:changed` and `theme:changed`.

### Fence widgets

A fence widget draws over a fenced block in a document, in place of its text. The extension
registers one for an info word, which is either its id or `<id>.<name>`:

- **Its id** (```` ```hello ````) makes an ordinary fence. Without the extension it shows as a code
  block, so the document reads well anywhere.
- **`<id>.<name>`** (```` ```hello.board ````) makes an Extension Fence, which holds the extension's
  data. EtherPK never searches its lines and never publishes them as code. The caret passes over it,
  and where the extension is not running, a note says so.

```ts
context.editor.registerFence('hello', {
    height: () => 40,
    mount(host, initial) {
        const line = document.createElement('p')
        const show = (fence: { body: readonly string[] }) => {
            line.textContent = `${fence.body.length} lines`
        }
        show(initial)
        host.append(line)
        return { update: show, destroy: () => line.remove() }
    },
})
```

`height` must answer before the widget is drawn, so the lines below never move as it loads. The
context a widget is given has the fence's lines (`body`), whether the document can be written
(`writable`), and the theme. It can also:

- Change the lines (`edit`), as one change that Mod+Z undoes.
- Show the fence as text (`editAsText`), or delete it (`remove`).
- Open the fence in a tab of its own, or over the whole window.

The third argument to `registerFence` adds options:

- `title`, what the fence is called in its tab.
- `fromPaste`, which turns text pasted on a line of its own into the fence. A line it answers with
  that would end the fence is changed so it can't.
- `publish`, which says how a published site shows the fence, as a picture or a link card. An SVG
  picture is cleaned of scripts, event handlers and links that run code before the site gets it.
- `identify`, which finds a fence again by an id in its body, so it can open in a tab.
- `keepsHistory`, which leaves Mod+Z to the widget while it has the keyboard.

### A block at the caret

`context.editor.insertBlock(text, { focus })` puts lines at the caret, as a code block or a table
goes in. It returns false where nothing went in, such as a document that cannot be written, a
Protected Document, or a caret in the frontmatter, in a fence or in a table.

### Dialogs

`context.dialogs.prompt(options)` asks for one line of text in a dialog the Client draws. Its
`validate` function can refuse an answer by returning a message, and the dialog stays open with the
text kept. It resolves to the text, trimmed, or undefined when the person cancels. The dialog names
the extension, and shows every string it is given as text.

### Frames

`context.embeds.frame({ src, title })` builds a frame showing a page from a host the Client allows,
and throws for any other host. `context.embeds.frameHosts` lists the hosts: the video players of
YouTube (`www.youtube-nocookie.com`) and Vimeo (`player.vimeo.com`).

### Views

A View is the content of a tab. The manifest declares each View kind, and the extension supplies it
with `context.views.register(kind, view)` as the graph opens.

```json
"views": [
    {
        "kind": "hello.board",
        "title": "Board: {target}",
        "region": "main",
        "address": { "segment": "board", "target": "concept" }
    }
]
```

`kind` starts with the extension's id. `{target}` in the title stands for the View's target, here a
concept. `region` is where the kind opens: `main`, `left-sidebar` or `right-sidebar`. A kind with
one View per graph gives a fixed `target` instead.

An `address` gives the View a URL. For an extension from the Extension Directory, the URL is
`/g/<graph>/x/<extension id>/<segment>`, followed by the concept when `target` is `concept`. A link
to it opens the View. On a device without the extension, it opens a page that names the extension
and offers to install it, if the directory lists it.

`context.layout.openView({ kind, target })` opens a View. `context.layout.isDesktop()` says whether
the desktop layout is showing, which it is at 1024 pixels wide and more.

## Styles

The manifest's `styles` are the extension's stylesheets. By default, each widget and View the
extension draws is mounted in a shadow root with them, so the extension's styles and the Client's
stay apart.

Some libraries can't run in a shadow root. An extension that uses one can set
`"isolation": "page"` to mount in the page instead. Then every rule in its stylesheets must style
only elements with a class that starts with the extension's id, or elements inside one. The Client
refuses any other stylesheet. The colours of the Client's theme are CSS variables (`--gk-*`) that
reach into a shadow root as well, so an extension can follow the light and dark themes either way.
An extension's stylesheet can't register one of them with `@property`.

Either way, the shadow root and the check keep styles apart, and nothing more. They don't limit
what the extension's code can do in the page.

## Writing to the page

The Client enforces
[Trusted Types](https://developer.mozilla.org/en-US/docs/Web/API/Trusted_Types_API), and extension
code runs under them.

- **Write no HTML.** Build elements with the DOM (`createElement`, `createElementNS`,
  `textContent`). A string written to an HTML sink such as `innerHTML` is sanitized by the Client's
  default policy, which may remove what you wrote.
- **An extension can't create a Trusted Types policy.** The Client's Content Security Policy names
  the policies it allows, and each one belongs to the Client or to a library it ships.
- **Icons come from the manifest.** The Client sanitizes the icons a manifest declares as SVG, so
  they can hold only SVG.

## Proposed parts

The Proposed parts are for the extensions that come with EtherPK, and may change in any release.
They include:

- Context Menu rows (`contextMenu`) and key chords (`keybindings`).
- Questions to the graph's index (`index`) and the rules for naming a concept (`concepts`).
- The Client's icons (`icons`) and a View that lives in a Sidebar (`resident`).
- Running another extension's Commands (`commands.execute`), and the document the person is working
  in (`layout.activeDocument`).

`contributions`, which reaches the Client's own registries, stays Proposed for good, since its
shape is the Client's internals.

## Trying an extension

To try an extension, build it, and start a development copy of the EtherPK Client with the
extension's folder named in `ETHERPK_DEV_EXTENSIONS`. Separate several folders with commas. The
Client loads each one as it loads the extensions it comes with, and one with the same id replaces
it.

```bash
ETHERPK_DEV_EXTENSIONS=/path/to/my-extension pnpm dev
```

[The EtherPK Client repository](https://github.com/appsoftwareltd/etherpk-client) says how to run
the Client.

## Listing an extension

The [Extension Directory](https://github.com/appsoftwareltd/etherpk-extension-directory) lists the
extensions people can install from inside EtherPK. Each release is a pull request there. It is
rebuilt from its tagged source and compared with its npm package, and a person reviews it before it
is listed. Installed extensions update by themselves to the newest listed release the person's
EtherPK can run. The directory's contributing guide says what a release needs, including the size
limits. Publish the tarball `npm pack` makes: `pnpm publish` rewrites `package.json` as it packs,
and then the published package no longer matches the rebuild.

## Licence

MIT.
