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

Since 0.14.0 every part is Stable but `contributions` and an inline panel's `lineText` (see
*Proposed parts* below). An extension
listed in the Extension Directory uses only the Stable part.
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

`context.commands.execute(id, arg)` runs a Command, and `context.commands.has(id)` says whether there
is one. An extension may run three kinds of Command, by `execute` or as the Command of a row or a
button it adds:

- Its own.
- Another running extension's, by its id (`kanban.open`).
- One of the Client's that `CLIENT_COMMANDS` names. Each keeps its id and argument in every release.

The Client's other Commands may change, so `execute` rejects for them, and a row or button naming one
is refused. `CLIENT_COMMANDS` holds `agents.settings` (open Settings at the Agents tab), and more are
added as extensions need them.

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
- `context.layout.activeDocument()` names the document the person is working in, as its tab names
  it, or null.
- `context.layout.openWindow({ title, mount })` draws something over the whole window, with a heading
  and a close button the Client draws. One is open at a time: opening another closes it, even
  another extension's.
- `context.layout.reveal(kind)` brings one of the extension's own Sidebar Views to the front (see
  *Views* below). It does nothing for any other kind.
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
- `quote`, which says how the Backlinks panel shows the fence where a reference's block holds it,
  in the same shapes as `publish`, with the theme to draw a picture in. The widget is never mounted
  there. Without `quote`, an ordinary fence shows as code and an Extension Fence as a note. A link's
  picture is loaded from the web as the panel shows it, so give one only where the person agreed.
- `identify`, which finds a fence again by an id in its body, so it can open in a tab.
- `keepsHistory`, which leaves Mod+Z to the widget while it has the keyboard.

### A block at the caret

`context.editor.insertBlock(text, { focus })` puts lines at the caret, as a code block or a table
goes in. It returns false where nothing went in, such as a document that cannot be written, a
Protected Document, or a caret in the frontmatter, in a fence or in a table.

`context.editor.openPanel({ mount, at })` draws a panel of the extension's own in the document,
beneath the caret's line, or beneath the document's last line with `at: 'end'`, without changing
the text. It returns null where no panel can go, by the same rules as `insertBlock`. A panel closes
when the extension stops. The panel's `insertBlock` puts a block at its line: beneath a bullet with
text as the bullet's first child, after its own lines. A block that would rearrange the outline
around it, from `insertBlock` here or at the caret, is refused, and the call returns false.

### Context Menu rows and Command Bar buttons

`context.contextMenu.register({ id, label, command, when })` adds a row to the menu raised on a
document's tab, a Favourite, a Recent, an All Documents row, any other tab, or a wikilink. The row's
Command is given the target, and its `when(target)` says whether it applies. More kinds of target may
be added, and when the Client stops raising a menu on one, the rows for it are no longer shown, so a
`when` answers false for any kind it does not check. A row that deletes or removes something for good
sets `danger: true`, and is drawn in the danger colour.

`context.commandBar.register({ id, title, icon, command, pinned })` adds a button to the row of
buttons across the bottom of a phone's screen: after the editing buttons that scroll, or with
`pinned`, at the bar's right end, where it never scrolls away.

### Key chords

`context.keybindings.register({ key, command, label })` binds a chord such as `Alt+M` to one of the
extension's own Commands. `Mod` is Cmd on Apple devices and Ctrl elsewhere. When the Client or another
extension binds the chord already, the chord stays theirs: the call still succeeds, the binding is
left out, and the browser's console says so. So a shortcut the Client adds in a later release never
stops an extension from starting.

### The graph's index and the names of concepts

- `context.index.allConcepts()` lists the graph's concepts, `context.index.linkGraph()` gives every
  concept and the links between them, and `context.index.onUpdated(listener)` hears each change to
  the index.
- `context.concepts.canonicalName(name)` gives the name a concept resolves to: an alias's page, a
  page's own title, or the name itself. `context.concepts.key(name)` gives the key the Client tells
  two names apart by. The way the key is made may change, so compare keys from `key`, and never make
  one another way.

### Reading documents

`context.documents` reads the graph's documents for the person, for example for a language model they
use: `list`, `read`, `links`, `search`, `backlinks` and `tasks`. Every answer leaves out each Protected
Document, its name included, and a document holding an encrypted fence. Answers are bounded. A page
of a listing holds at most 200 documents or tasks, and a page of a search 50 results, and a
document's text is cut after 200,000 characters, saying so. `formatGuide()` describes how the
graph's documents are written, in the words the Client gives agents. Its wording changes as the
format does, so pass it on rather than read meaning into it.

### Records for one graph

`context.records` keeps the extension's records for the open graph on this device alone, such as a
chat the person has not saved: `get`, `set`, `remove` and `keys`. They are never synced, and they go
when the graph's data leaves the device. A record may hold a `Blob`, an `ArrayBuffer`, a `Date` or
plain data, at most 4 MB of it, and a larger one is refused. A write the browser refuses, such as on
a full disk, rejects.

### Images as assets

`context.assets.prepareImage(blob)` makes an image smaller, as a pasted image is.
`context.assets.saveImage(blob, name)` keeps it as one of the graph's assets and answers the markdown
that shows it, such as `![photo](assets/photo.3f9a1c2e.webp)`. The file's name ends in a hash of its
bytes, so two images never take the same name, and the same image kept twice is one file. An asset
is part of the graph: it syncs, and every member of a shared graph can see it.

### Icons

`context.icons.svg(name)` draws one of the extension's own icons or one of the Client's, as markup the
Client trusts. The Client's icons, which every `icon` field may name too, are `alias`, `backlinks`, `bold`, `bullet`, `calendar`, `check`, `clock`, `close`, `code`, `copy`, `download`, `fit`, `flag`, `fold`, `frontmatter`, `globe`, `graph`, `grip`, `headless-client`, `highlight`, `image`, `import`, `indent`, `italic`, `list`, `lock`, `lock-open`, `more`, `move`, `move-down`, `move-up`, `new-page`, `open-external`, `outdent`, `page`, `pageless`, `pin`, `redo`, `rename`, `reset`, `search`, `slash`, `spell-check`, `table`, `table-add-column`, `table-add-row`, `table-format`, `table-remove-column`, `table-remove-row`, `task`, `template`, `text-lines`, `today`, `todays-journal`, `trash`, `undo`, `wikilink-close`, `wikilink-open`, `zoom-in`, `zoom-out`. An
icon may be added in a later release, never taken away. An unknown name draws a small dot.

### Settings sections

The main module can export `settingsSections`, for settings that need more than the fields a
manifest declares, such as a list of accounts with a button that connects one. Each section has an
`id`, a `tab` and a `mount(element, context)` that draws it. The context holds the extension's
settings, its records kept with the person, signing in, the theme and `notify`, and nothing from a
graph.

```ts
export const settingsSections: SettingsSection[] = [{ id: 'hello.accounts', tab: 'extension', mount: drawAccounts }]
```

`tab: 'extension'` draws the section under the extension's own entry in Settings and Extensions,
beside its declared settings, and `tab: 'agents'` in the Agents tab. The Client draws an extension's
sections in a graph's settings while the extension runs there. An extension's code is loaded only
once a graph opens, so its sections are not drawn on the Graphs page.

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

A View kind can live in a Sidebar from the moment a graph opens, beside the Client's own Sidebar
Views, with `"resident": { "side": "left" }` (or `"right"`, and `"desktopOnly": true` for the desktop
alone). `context.layout.reveal(kind)` brings it to the front of its Sidebar.

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

## Controls

The Client draws its own buttons, fields, links and menus with a set of classes, and gives the same
stylesheet to every shadow root an extension draws in, ahead of the extension's own stylesheets. An
extension mounted in the page has it from the Client's own stylesheet. So an element with one of
these classes looks like the Client's control, in the light and dark themes alike, and keeps
looking like it as the Client changes. The classes are Stable, and the Client has them from
EtherPK 0.14.0. The stylesheet is in this package as `controls.css`, for reference and for an
extension's own tests.

| Class | Use it on |
| --- | --- |
| `gk-button` | A `<button>` or `<a>`, as the Client's everyday button: a thin border, filled faintly on hover. |
| `gk-button--primary` | With `gk-button`, the one main action of a form or dialog. |
| `gk-button--danger` | With `gk-button`, an action that removes or ends something. |
| `gk-button--quiet` | With `gk-button`, a button with no border, in a toolbar or beside other text. |
| `gk-button--small` | With `gk-button`, a button on the line of a heading or a row, 24px tall. |
| `gk-button--raised` | With `gk-button` or `gk-icon-button`, a button over content such as a map, a picture or code: a solid surface and a small shadow. |
| `gk-icon-button` | A square button holding only an icon. Give it an `aria-label`. |
| `gk-link` | A `<button>` or `<a>` that reads as a link: the accent colour, underlined. |
| `gk-field` | An element holding a field's label, its control and any hint or error, stacked. |
| `gk-label` | A field's `<label>`. |
| `gk-hint` | Help text under a field. |
| `gk-error` | An error under a field. Set `aria-invalid="true"` on the control too. |
| `gk-input` | An `<input>` or `<textarea>`, the full width of its column. |
| `gk-select` | A `<select>`. Where the browser can, it draws the option list in the menu's colours, with `<optgroup>` labels and a tick on the chosen option. Elsewhere it shows the browser's own list. |
| `gk-checkbox` | An `<input type="checkbox">`. |
| `gk-menu` | A list of actions, such as a menu a button opens. |
| `gk-menu-item` | A row of a `gk-menu`. |
| `gk-menu-item--danger` | With `gk-menu-item`, a row that removes something. |
| `gk-menu-separator` | A rule between groups of rows in a `gk-menu`. |

A disabled control (`disabled`, or `aria-disabled="true"`) recedes by colour. A toggle button with
`aria-pressed="true"` is drawn as the primary button while it is on. On a touch screen buttons,
fields and menu rows are at least 44px tall.

```ts
const save = document.createElement('button')
save.className = 'gk-button gk-button--primary'
save.textContent = 'Save'
```

The rules are in the `components` cascade layer, after the layer order Tailwind v4 uses
(`properties`, `theme`, `base`, `components`, `utilities`). So Tailwind's utilities can adjust a control
(`gk-button w-full`), and Tailwind's preflight doesn't undo one. A rule of yours outside any layer
wins over every layered rule, so keep element resets such as `button { color: inherit }` in
`@layer base`, or they will override the controls.

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

`contributions` reaches the Client's own registries by kind. Only the extensions that come with
EtherPK may use it, and it stays Proposed for good: its kinds and their values are the Client's
internals, which change between releases, and through it one extension could take another's
entries. Where an extension from another Publisher needs what a registry gives, the Client adds a
checked part for it, as it did for fences and Journal Panels.

An inline panel's `lineText()`, the text of the bullet the panel opened on, is Proposed while
Agent Chat is its only user, and becomes Stable when an extension from another Publisher needs it.

## Trying an extension

To try an extension, build it, and start a development copy of the EtherPK Client with the
extension's folder named in `ETHERPK_DEV_EXTENSIONS`. Separate several folders with commas. The
Client loads each one as it loads the extensions it comes with, and one with the same id replaces
it. An extension loaded this way gets what a Directory release gets, the Stable part alone, unless it
stands in for one that comes with EtherPK, so a Proposed part it calls fails while you test.

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
