# Changelog

What changed in each release of the EtherPK Client and the Headless Client
([`@appsoftwareltd/etherpk-mcp`](https://www.npmjs.com/package/@appsoftwareltd/etherpk-mcp) on npm).
They are released together, under the version number they share with the Sync Server. This log
starts at 0.9.3.

## Unreleased

### Client

- **A copied line pastes above the cursor's line.** With nothing selected, **Ctrl+C** (**Cmd+C**
  on a Mac) or **Ctrl+X** takes the whole line, and **Ctrl+V** now puts it on a line of its own
  above the line the cursor is on, as in VS Code. In a list it becomes a block above the cursor's
  block, at the same depth. Before, in a list, the copied text went in at the start of the line,
  ahead of the bullet.
- **Text pasted after a code block's closing ` ``` ` starts on a new line,** so the code block stays
  closed. Text of more than one line pasted after the opening ` ``` ` becomes the first lines of
  code, and one line there is still the code's language. Text pasted after either `---` line around
  the frontmatter also starts on a new line.
- **Pasted text loses the spaces at the end of its lines.** Text copied from a terminal or another
  editor often has spaces after the end of each line. A paste now removes them, except in code
  blocks and the frontmatter.
- **The outline's guide lines run beside a new soft line.** After **Shift+Enter** at the end of a
  block, the guide lines now continue down beside the new line, as it is still part of the block.
  Before, the gap looked the same as the break that **Ctrl+Enter** makes between two lists.
- **Ctrl+Enter keeps its new line when spaces follow the cursor.** The new line under the list
  stayed only until the cursor moved off it if the line had spaces after the cursor. Now those
  spaces are removed, and text after the cursor starts the new line at the margin.

## 0.16.0 - 2026-10-29

### Client

- **Today opens at the top of the day.** The Graph sidebar's **Today** button, **Alt+J**, the
  phone's Today button and a day picked on the calendar show the journal entry from its top, with
  the cursor at the start of its first line. This is the same when the entry is already open and
  scrolled down. On a phone the keyboard stays down unless the entry is empty.
- **Find and replace in a document.** **Ctrl+F** (**Cmd+F** on a Mac) opens a find box at the top
  right of the document in front, and **Ctrl+H** (**Cmd+Option+F** on a Mac) opens it with a
  replace field. It finds text anywhere in the document, including lines not yet scrolled into
  view, with options for case, whole words and regular expressions. Every match is marked, and a
  list at the bottom of the document shows each matching line and what a replace would change.
  **Replace all** is one undo step. A replace never changes the page's title or aliases. If a
  replace would change the name in a wikilink that other documents also use, EtherPK asks first,
  and offers to rename it everywhere, to change only this document's links, or to replace outside
  wikilinks only. On a phone, choose **Find and replace** from the `/` menu.
- **Open a link in the pane to the right.** On a desktop, right-click a wikilink and choose **Open
  in pane to the right**, or put the cursor in the link and press **Ctrl+Alt+Enter** (**Cmd+Option+Enter** on a Mac). The page
  opens beside the note, at the end of the tabs of the pane to the right, or in a new pane split off
  to the right when there is none. The cursor stays in the note you are reading, and Backlinks keeps
  showing that note's backlinks. A page already open in another pane moves there with its scroll
  position, cursor and undo history. A page already in front in the pane to the right scrolls to
  its top.
- **A sidebar keeps its width on a desktop.** Opening, closing and moving panes, hiding the other
  sidebar and resizing the window change only the main area, and its panes keep their proportions.
  Only a drag of the sidebar's edge or **Reset workspace** changes its width. In a window too
  narrow for both sidebars, they get narrower, and they go back to their width when the window gets
  wider. The width also comes back after the phone layout. A sidebar is one pane: a tab dragged onto
  it joins its tabs.
- **Extension API:** `layout.openView` and `layout.openDocument` with `beside` open in the pane to
  the right of the given panel's pane, splitting one off when there is none, and move a View that is
  open in another pane there. The View goes in front of that pane without taking the keyboard.
- **One journal entry for a day started on two devices.** Two devices that start the same day's
  journal while offline now write into one entry, which holds the text from both. When both
  started the day with the same Journal Template, the entry holds it once.
- **Duplicate names.** Settings → Maintenance lists names that open more than one document, which
  happens when two devices create a page with the same name before they sync. It shows each
  document and a preview of the merged text, and **Merge** joins them into one document. The graph
  says so when it opens.
- Updated dependencies.

## 0.15.0 - 2026-10-21

### Client

- **Publish to a GitHub repository.** In Settings → Publish, a publication can publish to a branch
  of a GitHub repository in place of a folder, from any browser, phones included. Each publish is
  one commit, a publish that changes nothing makes no commit, and the host that watches the branch
  (GitHub Pages, Cloudflare, Netlify) deploys it. You make a GitHub token on GitHub with the
  Contents permission and paste it once, in a GitHub section at the top of the tab, and it follows
  you to your other devices through your account. **Save and check** tests the token against the
  repository, and offers **Create branch** when the branch isn't there yet. The first publish to a
  branch that already holds other files lists them and asks first. Alt+Shift+P publishes to the
  repository too.
- **Install app.** EtherPK offers to install itself as an app from a button in the header (on a
  computer, while Chrome or Edge offers its install dialog), a row in the phone's header menu, the
  account menu, **Install EtherPK** in the Command Menu and **Settings > Install**. Where the
  browser has no install dialog of its own, the **Install EtherPK** dialog gives the steps for that
  browser: the Share sheet on an iPhone or iPad, Add to Dock in Safari on a Mac, and Add tab to
  taskbar in Firefox on Windows.
- **Install offers.** EtherPK offers the install once at a few moments where it helps: on an
  iPhone or iPad before you sign in, when the browser has cleared some of EtherPK's data, on the
  folder access screen on a computer, and in Quick notes on Android and ChromeOS. Each offer is
  shown at most once on a device, and **Not now** closes it.
- **Install in Settings.** Installing on this device has its own area, **Install**, after
  **Settings** and **Extensions** at the top of the Settings dialog, in place of the section at
  the foot of **General**.
- **App icon shortcuts.** The installed app's icon menu on Chrome and Edge has **Today's journal**,
  **Search** and **New quick note**, which open in the graph you used last. A new launch, shortcut
  or share reuses the window that is already open.
- **Installed app start.** An installed app with no graphs opens the Graphs page rather than the
  public home page, and says once that it is installed on its first launch.
- **Richer install dialog.** The web app manifest has screenshots, a padded icon for round masks
  and a category, so Chrome can show a fuller install dialog. The app no longer locks phones and
  tablets to portrait.
- **Ways to run EtherPK.** The home page lists the ways to run EtherPK after its opening section:
  in a browser, from the Node bundle and from the Docker image, with which browsers run synced
  graphs and folder graphs.

### Headless Client

- **`publish --github owner/name[#branch]`** commits the site to a GitHub repository's branch,
  with the token in `ETHERPK_GITHUB_TOKEN`, and is remembered in place of `--out`. `--replace`
  lets a first publish replace files on a branch that holds something else, and
  `ETHERPK_GITHUB_API_URL` points it at GitHub Enterprise Server. The agent's `publish` tool never
  commits to a repository: it checks such a publication with a dry run and names the command for
  you to run. `list_publications` and `graph_info` show a publication's repository as
  `publishRepository`.

## 0.14.1 - 2026-10-20

### Client

- **Agent Chat.** `/Agent` on a line with text opens the chat with that text in its message box,
  ready to send or change. The up and down arrow keys move through the list of chats to start or
  resume. The model you choose in a chat is the one each new chat starts on until you reload.
  Escape closes a chat without saving, and the chat keeps what you had typed for when you open it
  again.
- **Agent Chat.** A model that reasons before it answers shows its reasoning while it works, folded
  away once the answer starts. An answer is kept on the device as it arrives, so closing the tab
  keeps what had come. You can select text in a chat and copy it.
- **Agent Chat.** Your question and the agent's answer are separate turns, each with its own box
  when you save, and **Mine** and **Agent's** tick only yours or only the answers. A saved chat's
  first line is bold.
- **Agent Chat.** **New chat** in the Agent Chats view starts a chat without a document, which
  saves at the end of today's journal entry. A chat whose document was deleted saves there too.
- **Agent Chat.** Saved answers keep to the outline wherever the chat is: lists, headings and code
  become bullets of their own, and the blocks after a nested bullet keep their place. Beneath a
  bullet with more lines of text, the turns go after them.
- **Extension API:** a block put in through a panel or `editor.insertBlock` that would rearrange
  the outline around it is refused. `InlinePanel.lineText()` (Proposed) gives the text of the line
  a panel opened on.

## 0.14.0 - 2026-10-17

### Client

- **Extensions draw EtherPK's own buttons, fields and menus.** The Client gives every extension
  its control classes (`gk-button`, `gk-input`, `gk-select`, `gk-menu` and others), so an
  extension's controls look like the Client's in the light and dark themes. Agent Chat, Kanban,
  Maps and the Graph View now use them.
- **Extension API (Stable):** the control classes, in `controls.css` in
  `@appsoftwareltd/etherpk-extension-api`, and listed in its README under Controls. A select with
  `gk-select` draws its option list in EtherPK's colours in Chrome and Edge.
- **Settings and Extensions** draws its buttons, fields and links with the same classes, so a few
  buttons there are a little lighter.
- **Delete in a document's or an image's menu** is drawn in red.
- **Extension API (Stable):** every part that was Proposed is Stable, apart from `contributions`:
  running Commands, Context Menu rows, Command Bar buttons, key chords, the graph's index, concept
  names, icons, Sidebar Views, reading documents, records for one graph, images as assets, panels
  in a document, windows and settings sections. `CLIENT_COMMANDS` lists the Client's Commands an
  extension may run.
- **An extension's own settings section** can now sit under its entry in Settings and Extensions,
  for settings that need more than a text field or a switch.
- **A key chord an extension binds** that the Client or another extension already uses is skipped,
  and the extension still starts.
- **An extension tried from a folder** (`ETHERPK_DEV_EXTENSIONS`) gets what a release from the
  Extension Directory gets, so a part it may not use fails while it is being tested.
- After you cancel an invite or remove a member, the graph's row on the Graphs page keeps saying so.
  The note that the graph has a new key now follows it, where before it replaced it.
- The Tasks view's name box offers a page you created a moment ago. Before, it was missing until you
  typed in the box again.

## 0.13.0 - 2026-10-16

### Client

- **Agent Chat.** Type `/Agent` on a line, or press Alt+A, to ask a language model about your notes
  in a chat at that line, beside the bullet's dot on an empty bullet. You connect Anthropic, OpenAI,
  Google Gemini, OpenRouter, a model on your computer (Ollama, LM Studio) or another
  OpenAI-compatible server with your own key, and EtherPK calls the provider from your browser. Each
  chat reads nothing else, the bullet's siblings and ancestors, the document, the document and the
  documents it links to, or the whole graph through search and read tools that the chat lists as the
  model uses them. A chat opened on a bullet starts on that bullet's siblings and ancestors, and
  where your notes already hold the question you can send without typing anything. You choose the
  model from a list you can narrow by typing, and an agent instruction in the Agents settings goes
  to every model in every chat. A protected document is never read or named, even while it is
  unlocked. You can paste images for a model that takes
  them, and a chat can search the web through Anthropic, OpenAI or OpenRouter, starting as your
  setting says. A chat is kept on the device you had it on, and only the turns you tick to save go
  into the document. On a phone the chat opens over the whole screen. Agent Chat is an extension
  that comes with EtherPK, so you can switch it off.
- **The Agent Chats view** in the right sidebar lists every chat of the graph kept on the device,
  saved or not, to read, continue, rename or delete.
- **An Agent Chat button on the phone's command bar**, pinned at its right end, opens a chat at the
  cursor while you are typing and at the end of the document otherwise. A chat opened in a journal
  entry or page that has not been created yet leaves it uncreated until you save turns into it.
- **The phone's font size buttons** are now the last of the command bar's scrolling buttons.
- **The window an extension's block opens over the editor**, a drawing or a map, closes with a close
  icon in place of a Return button.
- **Closing a tab goes back to the tab you had open before it** in that pane, rather than to the
  first or last tab, whether you close it with its ×, a tab menu row or by deleting the document,
  and on a phone. The order is kept when you reload. Closing a tab in another pane leaves the
  keyboard where you were typing.
- **Two buttons under the last line of a document** start a new line or a new bullet at its end,
  with the cursor on it, on a computer and a phone. A new line you leave without typing on is taken
  out again, and a journal entry or page that has not been created yet is created only once you
  type on it.
- **Typing a slash command in a new journal entry or page** no longer creates it on its own. It is
  created once the command or your typing adds text, so `/Agent` leaves a new day as it was.
- **Agent Setup Code.** The one-time code that signs in an agent's computer is called an Agent Setup
  Code, created with **Create an Agent Setup Code** in the Agents settings, and the sign-in steps
  there are shorter. The settings no longer offer a login command without a code.
- **A Settings Vault for your settings.** The settings that follow you between devices, such as
  your extensions, their settings and your Agent Chat keys, are kept in a Settings Vault in your
  account, apart from your Encryption Keys. An agent you sign in with the Headless Client cannot
  read it. EtherPK moves your settings there the first time it syncs them, and it needs a Sync
  Server of this version.
- **An Agents tab on the Graphs page** sets up your model connections, which follow you to every
  graph and to your other devices like your other settings, and shows how to sign in an agent with
  the Headless Client without opening a graph.
- **The slash menu puts a command named what you typed first**, ahead of a command that matches
  as well only through one of its other search words. `/agent` now offers Agent Chat before Copy
  task reference.
- **EtherPK can reach a model server on your own computer** over plain HTTP at `localhost` or
  `127.0.0.1`, and nowhere else over plain HTTP.
- **Extension API (Proposed):** `context.documents` reads the open graph's documents with every
  protected document left out, `context.records` keeps an extension's records for a graph on the
  device, `context.assets` adds images to the graph, `context.layout.openWindow` draws over the
  whole window, and `context.editor.openPanel` draws a panel at a line of the document, which can be
  resized and can read the outline around its line. `context.commandBar` adds a button to the
  phone's command bar. An extension's main module can export
  `settingsSections`, drawn in the Agents tab of the Graphs page and of a graph's settings.

### Headless Client

- **`login` always ends with an Agent Token.** An access token given with `--pat` is swapped for one
  as before, and if the swap fails, `login` now fails and keeps nothing, where it used to keep the
  access token. Messages name the Agent Setup Code and where to create one.

## 0.12.0 - 2026-10-15

### Client

- **Synced graphs open when the Sync Server can't be reached.** If the app is already loaded, a
  synced graph now opens from the copy on your device when you are offline or the server is down.
  You can read, search and edit it, and unlock protected documents with their passphrase. Your
  edits are sent when the server can be reached again. This works once the device has connected
  to the server since updating.
- **EtherPK starts with no network.** Once you have opened EtherPK online, it keeps its files on
  your device, so a reload, a new tab or the installed app opens without a connection. Graph View
  and extensions you have used work offline too.
- **Images in synced graphs show offline.** An image or file you have viewed or uploaded on a
  device is kept there, encrypted as the server stores it, so it shows with no connection and
  opens at once afterwards.
- **You can add images to a synced graph offline.** A file you paste or drop with no connection
  is saved on your device and shows at once. It uploads when the sync server can be reached.
- **Sync starts again as soon as you are back online.** After a long time offline, a synced graph
  used to wait up to 30 seconds before it tried the server again. It now tries at once when the
  connection returns or when you come back to the tab. A graph that could not open because the
  server was out of reach opens by itself when the connection returns.
- **A publish removes old map and extension pictures.** A picture under `maps/` or `pictures/`
  that no published page uses any more is deleted from the site folder, as old pages and assets
  already were.
- **A page named Search publishes at `search.html`**, where it was given `search-2.html`. In a
  blog, a page named Posts now gets `posts-2.html` instead of being replaced by the list of posts.
- **Reset workspace keeps Highlight reference** and whether the backlinks under documents are
  folded. It still forgets the arrangement, the Backlinks pin and the Tasks filter.
- **Clearer wording** on the Graphs page, in Settings and on the home page about which browsers can
  open a folder: Chrome or Edge on a desktop, or Chrome on Android. Also clearer: what a passkey
  does for protected documents, the two choices when you rename a page, the Graph View's
  **Pageless** filter (**In two or more documents**), and **no page yet** in the Tasks view's name
  suggestions.
- **Templates.** A page whose frontmatter says `template: true` is a Template. Type `/Template` in
  any document to copy one in, with `{{date}}`, `{{title}}`, `{{time}}` and the other variables
  filled in for that document, and the cursor placed at `{{cursor}}`. A Template's tasks and links
  stay out of the Tasks view, Kanban boards, backlinks, maps and the Graph View, and Search still
  finds it.
- **Journal Template.** Choose a Template in Settings and Extensions → General, and today and every
  later day open holding it, with that day's date filled in. Nothing is saved until you type.
- **Add frontmatter** offers the `template` key on pages.
- **Importing from Logseq, Obsidian or AS Notes brings templates across** as Templates, with their
  variables rewritten, and sets the Journal Template from the app's own setting.
- **Paste several lines into one block.** Ctrl+Shift+V (Cmd+Shift+V on a Mac, Cmd+Option+Shift+V
  in Safari) pastes as plain text and keeps every line in the block you paste into, where Ctrl+V
  makes a block of each line. Bullets in the pasted text become children of the block, each heading
  becomes a block with its section nested under it, and a link stays a link.
- **A copied bullet that starts with a code block, pasted after a block's text,** keeps its code
  block. Its backticks used to join the text.
- **Drawings and videos in backlinks.** The Backlinks panel and the backlinks under a document show
  an Excalidraw drawing as a picture in your theme, and a video as a link to its page. This needs a
  version of the extension that supports it. Until then, and where the extension isn't running, a
  drawing shows as a note naming the extension instead of its data.
- **Extension API:** a fence registration can give `quote(fence)`, which says how the backlinks
  show the fence: a picture drawn in the theme it is asked for, or a link, in the same shapes as
  `publish`. The new `QuoteFenceRequest` type describes what it is given.

### Headless Client

- **`publish` removes old map pictures** from the site folder, as the Client does.
- **A page named Search publishes at `search.html`**, and a blog's page named Posts at
  `posts-2.html`, as in the Client.
- **`create_page` and `append_document` take a `template`**, the name of a Template, whose text
  starts the page or is added to the document with its variables filled in.
- **`backlinks` leaves out the text of Templates.** A Template that links to a page is listed only
  when its own name is scoped by that page.

### Agent skill

- The skill and the `AGENTS.md` section EtherPK writes into a graph folder describe Templates and
  their variables.

## 0.11.1 - 2026-10-14

### Client

- **Refresh in the Extension Directory** (Settings and Extensions → Extensions) reads the directory
  again at once and brings installed extensions up to their newest release, instead of waiting up
  to ten minutes for the list and an hour for updates.
- **The Extensions tab says more plainly** how the directory's extensions are reviewed, installed on
  your devices and updated.
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
