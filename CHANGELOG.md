# Changelog

What changed in each release of the EtherPK Client and the Headless Client
([`@appsoftwareltd/etherpk-mcp`](https://www.npmjs.com/package/@appsoftwareltd/etherpk-mcp) on npm).
They are released together, under the version number they share with the Sync Server. This log
starts at 0.9.3.

## 0.48.0 - 2026-11-24

### Client

- **Fixes.**
  - On an Android phone, a tap on a picture no longer brings up the keyboard or scrolls the page
    back to the cursor.
  - On a phone or a tablet, closing **View larger** leaves the keyboard closed and the picture where
    it was.
  - The notice shown where an Agent Chat cannot open is shorter.

## 0.47.0 - 2026-11-24

### Client

- **Delete table.** The row and column menus of a table, and the command menu, have **Delete table**,
  which removes the whole table from the document. Undo brings it back.
- **Task tags count anywhere in a task's line.** A task tag such as `#P1`, `#W` or `#D-2026-07-01`
  written after a task's words is read as the task's tag by the Tasks view, Kanban boards and
  Search, where it counted only once the cursor had passed through the task. EtherPK still moves it
  to after the checkbox: when the cursor leaves the task, when the task's status, priority or dates
  change, and when a quick note is moved into the journal. Put a `#P1` that is part of a task's
  words in backticks. The search index is rebuilt once after the update.
- **Close Primary Sidebar.** The header above a view of the Primary Sidebar has a cross at its
  right end that collapses the sidebar, on a desktop and in the phone's drawer. The view stays
  open, and its icon in the Activity Bar brings the sidebar back.
- **An icon for where a graph is kept.** On the Graphs page, a stack of servers follows the name of
  a synced graph and a folder follows the name of a folder graph, in place of the **Folder** tag.
- **Fixes.**
  - Text says "device" where it said "computer", and "desktop" where a phone is ruled out. A
    token, key, graph or copy is created. The user doc Running EtherPK On Your Own Computer is now
    Running EtherPK On Your Own Device, at the same address.
  - A file attached to a quick note is a bullet nested under the note when the list is moved into
    the journal, so a task keeps its picture under it.
  - A tag typed in a task's title in the Task Editor is written once, and shows as a tag, a
    priority, a lane or a date in the editor.
  - The outline's guide line runs to the bottom of an audio or video player that ends a branch.
  - A click on a cell of a table no longer scrolls the page, and Tab, Enter and the arrows scroll
    only as far as the next cell. The row you type in stays where it is while other cells wrap. On a
    phone, a cell you tap stays above the keyboard.
  - A table wider than the pane scrolls sideways by itself, where the whole document scrolled with
    it, and **Add column** stays in reach.
  - On a phone, the keyboard resizes the page in Chrome and Firefox on Android, and in other
    browsers the workspace stays on the screen when the browser moves the page to show the cursor.
  - The header of the Primary Sidebar no longer shows a cross that did nothing.

### Headless Client

- **Task tags count anywhere in a task's line.** `tasks` and `read_task` read a task tag written
  after a task's words, and `set_task` moves it to after the checkbox when it changes the task.
- **Fixes.** The theme tools say a customised theme "creates a copy in the graph".

## 0.46.0 - 2026-11-23

### Client

- **Tables you edit in the grid.** Click a cell of a table and type, and the table stays drawn.
  **Tab**, **Enter** and the arrow keys move between cells, and `/` in a cell opens the command menu.
  Handles on the grid's borders add, remove and align rows and columns. You can select a block of
  cells, copy it, and paste rows from a spreadsheet. **Table: Edit as text** shows a table's
  Markdown, which putting the cursor in a table did before. A table is now as wide as its cells
  need, where before it filled the width of the text.
- **Larger videos you can resize.** A video in a document is as wide as the text, with no space around
  its picture. Drag the handle in the picture's bottom right corner to make it smaller, which writes
  the width into its line as it does for a picture (`![clip|480](../assets/clip.webm)`). A drag to the
  edge of the text, or a double click on the handle, makes it full width again. A video in a tab of
  its own, and on a published site, is as wide as it fits.
- **Pictures on a touch screen.** A tap on a picture in a document now shows its actions and its
  resize handle, and a second tap hides them. Before, they were always over the picture and a tap
  opened its line of Markdown. **Edit as text**, the first of the actions, opens that line. With a
  mouse nothing changes.
- **The Graphs page.** Its sections are always in one order: synced graphs, Folder graphs, Plain
  Folders. The buttons beside the title are filled and have icons, and so do the tabs. Sync has one
  icon everywhere. On a narrow screen a card keeps **Open** beside the graph's name, with its other
  buttons on the line below. A graph you own says **Owner** once, in its member list.
- **Text Editor in Plain Folders.** A Markdown file in a Plain Folder opens in the Markdown Editor or
  the Text Editor, which shows its source with line numbers. Change it from the editor's name above
  the file or with **Alt+M**. **Default file editor** is under **General** in **Folder settings**.
- **A breadcrumb above each text file of a Plain Folder,** with its folders, its name and the
  headings the cursor is under. Select one to go there.
- **Code and text files in Plain Folders.** Every line has a number. A line can be bookmarked, from
  the space beside its number or with **Ctrl+Alt+K**. Hold **Alt** and drag to edit several lines at
  once.
- **Fixes.**
  - On a synced graph, adding a row or a column to a table leaves another person's cursor in the
    cell they are typing in.
  - A table command keeps the cells of a row that has more cells than the table's header. Every
    row is given that many columns.
  - Importing an Obsidian vault keeps the width of an embedded video.
  - The player of a folded bullet stays when the last bullet inside it is folded too.
  - In a picture's line of Markdown, a drag selects text, a double click selects a word and
    Shift+click extends the selection. On a touch screen, a double tap and a long press select as
    on any other line.
  - In a code file, a selection covers the indent of each line.
  - On a phone, the Command Bar's buttons that do nothing in a code file are off there, and **Move
    up**, **Move down** and **Outdent** act on its lines.
  - On a synced graph, an edit made at the moment another tab's or device's edit arrives is sent at
    once. Before, it could wait until your next edit or until you reloaded the page.

## 0.45.0 - 2026-11-23

### Client

- **Quick notes in the sidebar.** Quick notes is a view of the Primary Sidebar, chosen from its icon
  in the Activity Bar, in place of the window and its button in the sidebar. **Alt+N** shows it
  with the cursor in the box. What you have typed and attached is kept while another view shows.
- **A graph opens on today's journal.** A graph opened in a new browser tab, from the installed app
  or from the list of graphs shows today's entry, with the tabs you left beside it. Tabs of earlier
  days you never wrote in are closed. Reloading the page, and a link to a document, open that
  document as before.
- **Explorer.** The Graph Sidebar is called Explorer, and its header gives the graph's name after it.
- **Protected documents in the sidebar.** Protected documents is a view of the Primary Sidebar with a
  padlock icon, in place of the section in the Explorer. The padlock is open while the graph is
  unlocked. **Alt+K** shows it.
- **Shortcuts in the Activity Bar.** Search, Today and the buttons extensions add to the Explorer are
  also icons under the sidebar views, below a line. The Explorer now scrolls as one, its buttons with
  the rest. Graph Kanban comes before Graph Map, and the buttons of extensions you install come last.
- **Tooltips name shortcuts.** On a device with a keyboard, a control that has a shortcut shows it
  after its name, such as **Search (Ctrl + K)**.
- **Closing a sidebar view asks first,** and names the shortcut that brings it back. **Alt+C** shows
  Agent Chats, and in a Plain Folder **Alt+G** shows Files and **Alt+O** Outline. An extension's
  manifest can name the Command that shows its view, as `"command"` of `resident`.
- **One Reset workspace.** **Reset workspace** also puts the sidebars' arrangement back to the
  defaults, in every graph and folder, and replaces **Reset Sidebars**. It is under **Primary
  Sidebar** in a graph's settings and in a Plain Folder's.
- **Plain Folders on the Graphs page.** The **Plain Folders** section is there before you have opened
  one, with **Open a Plain Folder**. The dialog then has **Open as a Plain Folder** selected.
- **Fixes.**
  - The sidebar toggles show no tooltip.
  - The home page lists Quick share as planned for the Android, Linux and Windows apps.
  - The hints under **Primary Sidebar** and **Where pasted files go** are shorter.
  - Text that could not be added as a quick note goes back into the box after anything you typed
    meanwhile.
  - A quick note that could not be saved no longer takes others added at the same moment off the
    list, and a folder graph does not save it later.
  - After a dialog closes, the tooltip of the button it was opened from shows beside that button.

## 0.44.0 - 2026-11-23

### Client

- **Primary and Secondary Sidebar.** The left sidebar's views are chosen from the Activity Bar, a
  column of icons, and Tasks and the Graph View are there with the Graph Sidebar. The right sidebar
  keeps its tabs. You can hide, reorder and move views and swap the sidebars' sides. The arrangement
  is the same in every graph, and on your other devices when your account syncs a graph. On a phone,
  the icons are inside the drawer. An extension's manifest can say
  `"resident": { "sidebar": "primary" }` or `"secondary"`.

## 0.42.0 - 2026-11-22

### Client

- **Plain Folders.** EtherPK now opens an ordinary folder of markdown files and edits them where
  they are. **Open folder** on the Graphs page looks inside the folder first. A graph's folder opens
  as before. Any other folder is asked about: open it as a Plain Folder, create a graph in it, or
  import it into a new graph. A folder dropped onto the Graphs page is opened the same way. A Plain
  Folder is not a graph, so it has no wikilinks, backlinks or journal. It is listed in a section
  of its own on the Graphs page and in a **Plain Folders** group of the Graphs menu. EtherPK does
  not sync a Plain Folder or a Folder graph, and the Graphs page now says **(not synced)** beside
  both headings.
  - A file tree with new, rename, move and delete, **Go to file** (Ctrl+P), **Search** across the
    folder's files (Ctrl+Shift+F), an outline of the file's headings, and Favourites.
  - Standard markdown links between files, with the folder's files suggested after `](`. A link to
    a heading opens the file there. After a rename or a move, EtherPK offers to update the links
    it changed.
  - A save changes only the lines you edited and keeps the file's line endings. The outliner's
    keys work on `*`, `+` and numbered lists as well as `-`, and Tab leaves a paragraph alone.
  - PDFs, EPUB books, pictures and recordings open in the readers a graph has. Text files that are
    not markdown open in a plain editor, with their language's colours, in the font and size of a
    code block in a document.
  - EtherPK adds nothing to the folder until you keep a highlight, a bookmark, a favourite, a
    dictionary word or a folder setting. Those go in a hidden `.etherpk` folder, one small file
    each, and a notice says so the first time.
  - Pictures from other websites are not loaded until you allow them for the folder.
  - A folder inside it that holds an EtherPK graph is marked, shown read-only, and opens as the
    graph.
- **Open a markdown file from your file manager.** With EtherPK installed as an app, the file
  manager offers it for `.md` files. The file opens on its own and saves in place, and **Open the
  folder** adds its folder as a Plain Folder.
- **A save no longer replaces another program's edit.** In a folder graph, when another program
  changes a file you have open and you keep typing, the next save stops and shows the
  **External change** dialog. Before, the file was checked only when the window gained focus and
  every few seconds, so a save in between wrote over the other program's text. **Keep mine** checks
  again, and shows the newer text if the file changed while the dialog was open.
- **Icon buttons name themselves on a phone.** Tap a button that shows only an icon, on the
  command bar, the top bar or a PDF's or an EBook's tools, and its name shows above it for 1.5
  seconds. With a mouse the name shows on hover, and with the keyboard on focus, in the app's own
  colours in place of the browser's tooltip.
- **Outdent and Indent come earlier on the command bar.** They now follow the `[[` and `]]`
  buttons, ahead of Toggle task, Undo and Redo.
- **Ways to run EtherPK, as two tables.** The home page now lists where to get EtherPK (the
  hosted app, the Docker image, the Node.js bundle, and the planned Android, Linux and Windows
  apps) with what each runs, then which browsers run synced graphs and folder graphs and which
  can install the app. The Docker row links the image and the new user docs page
  "Running EtherPK With Docker", which has an example Docker Compose file.
- **Fixes.**
  - The Graphs menu opens with its rows in place. It drew **All Graphs** alone first, then the
    rows pushed it down from under the pointer.
  - The question asked when a link names a folder that several of your folders share now says how
    many there are. It said "Two folders" over a list of three.
  - Importing a folder of markdown reads a link such as `[soil](soil.md)` as a path from the note
    that holds it, so it reaches the note beside it when another note has the same name. A link
    with a heading, `[soil](soil.md#clay)`, now becomes a wikilink to the page too.

## 0.41.0 - 2026-11-22

### Client

- **The account is in the menu on a phone.** Below 640px wide, the signed-in account (or Sign in)
  is the first row of the navigation menu instead of a button in the header, where a long email
  address pushed into the menu button. Press the row to show Account, Billing, Access tokens and
  Sign out. Tablets and wider screens keep it in the header.
- **Fixes.**
  - The sync status dot no longer pulses while it is amber. The colour shows the state.

## 0.40.0 - 2026-11-21

### Client

- **One status dot for sync and the mirror.** A synced graph's toolbar dot now covers sync and the
  local mirror together. It is green only when both are working, or when sync is working and the
  graph has no mirror. Select it to open **Sync status**, with a section for **Sync** and one for
  **Mirroring**, each with its explanation and actions. On a phone the dot is in the header, to the
  right of the logo. The sync status row at the foot of the Graph Sidebar is gone. When sync stops,
  a notice under the dot says why, that your changes are kept, and when they sync.
- **Filter the Graph Kanban by concept.** A box before the words filter on the Graph Kanban
  suggests the graph's pages, journal days and aliases as you type. Choosing one shows that
  concept's tasks, the same cards as its own board, and works with the words, priority and due
  date filters.
- **Text fields and drop-downs look alike.** Every text field and drop-down in the Client now has
  the same fill, border and height. In the dark theme a drop-down is the same grey as the field
  beside it. Fields in a toolbar, such as the PDF and EBook viewers' page and find boxes, share one
  smaller size. Extensions can use that size with `gk-input--small` and `gk-select--small`.
- **Buttons, links and menus look alike.** Every button, link, label, checkbox and menu in the
  Client now draws from one set of styles. A button that removes something is outlined in red, and
  a toggle that is on is filled. The PDF and EBook viewers' tools, menus and notices follow the
  same styles.
- **Toolbar and Quick notes.** The workspace toolbar's buttons are 32px with a border and a small
  shadow, as other icon buttons over a colour are. In Quick notes the note box looks like a text
  field, and **Clear** and **Add** are full-size buttons. A plain text button is as tall as the
  button beside it.
- **Search rows keep their height.** In Search, the **New page** label is the size of the
  **Enter** key hint, and a name row is one height with either or neither. The rows below no
  longer move as the hint comes and goes or as a name is typed.
- **Buttons line up with fields.** A button is now as tall as a text field (38px, and 30px for the
  small size), and never narrower than 80px (60px small), so a short label no longer draws a
  square. Extensions get the new sizes from `gk-button`, and a new `gk-button--emphasis` for the
  one action a page most wants taken.
- **Filter boxes look alike.** The Tasks View's and the Kanban boards' filter boxes now share one
  style, with a filter icon inside each and a close button that clears it. The concept boxes read
  **Concept (Page / Journal)** and the text boxes **Task text / #tag**.
- **Document width.** In a wide pane, a document's text now stays 1000 pixels wide and sits in the
  middle of the pane, with the backlinks and journal panels beneath it lined up. Change the width
  with **Document width** in Graph Settings, or enter `0` to let the text fill the pane as before.
  The width grows and shrinks with the text zoom.
- **Copy wikilink.** A document tab's menu has **Copy wikilink to clipboard** below **Copy name to
  clipboard**. It copies the page's name inside `[[` `]]`, ready to paste into another page as a
  link.
- **Fixes.**
  - The outline's guide lines, the caret and a selection stay on the text while a pane divider is
    dragged or the window is resized. In a pane wider than the **Document width** they were left
    behind as the text moved. They also stay in place after a new **Document width** is saved, and
    when a narrow pane scrolls sideways to the caret.
  - A pane divider can be dragged its whole way with text selected in a document. It used to stop
    after a few pixels. The caret also stays in the document through the drag.
  - On a phone, the header menu's theme switch has a gap above it under **Install app**.
  - The list of boards that `/kanban` offers when a line answers to more than one page no longer
    closes by itself a moment after it opens.
  - Resizing a pane no longer scrolls the tab in front out of view. The tabs beside the edge you
    drag stay against it: widen the right Sidebar and the right-hand tabs move with the edge.
  - Enter with text selected in a block deletes the text and splits the block there, as Enter does
    with nothing selected. It used to put the rest of the line outside the block. Shift+Enter
    likewise opens a new line inside the block.
  - **Copy agent instruction** puts a blank line between the parts of the text it copies, so an
    agent's chat that shows a paste as one block keeps them apart.
  - A synced graph opens in a tab when the Sync Server has no connection left for it, which
    happens when the account has the graph open in many tabs and devices at once. The tab used to
    stay on **Opening your graph…**. It now opens from the copy on the device, its status dot
    turns red and says why, and it connects once one of the other tabs is closed. Changes made
    meanwhile are kept on the device, and sync from a newly opened tab if you close this one.
  - A click on the blank space beside the journal roll's bar, the backlinks or the journal panels
    no longer takes the keys from the text: typing carries on where the caret was.
  - Two folder graphs kept in folders with the same name: the **Graphs** menu ticks only the one
    that is open, and choosing either there or on the Graphs page opens it without asking which
    you mean. A link from outside EtherPK still asks. The Graphs page says which folders share a
    name.

## 0.39.0 - 2026-11-19

### Client

- **Import to Sync+.** While a folder graph is open, the header offers **Import to Sync+**, which
  copies the graph into a new synced graph in two presses: the button, then **Import**. The folder
  is only read. Without an account that has Sync+, the dialog leads to the sign-in or to Billing
  and opens again on the way back. Once a folder graph has been copied from a browser, that
  browser no longer offers it. Only a Client that offers Managed Sync shows the button.

## 0.38.0 - 2026-11-19

### Client

- **Tags on Kanban cards keep their `#`.** A card shows a tag such as `maintenance` as
  `#maintenance`, as the task line writes it, so it no longer looks like the scheduled date's pill.
- **Firefox explains before it asks to keep data.** Firefox asks whether EtherPK may use
  persistent storage, in a prompt by the address bar. EtherPK now says why first, once, as a graph
  opens, and its **Continue** button brings up Firefox's prompt. **Ask Firefox to keep it** on the
  Graphs page's **This Device** tab asks again.
- **Import is easier to find.** A browser with no graph of its own shows an **Already have notes?**
  panel with an **Import** button, and names EtherPK exports and folder graphs as sources too.
- **Fixes.**
  - The task editor's description and comments no longer show a stray fold arrow when the mouse
    is above or below their lines.
  - The Import dialog says what a local folder needs in the same words as the Graphs page.

### Headless Client

- **Fixes.**
  - `login` says "Logged in." once it has worked and ends with the address of the Agents tab in
    EtherPK. `semantic setup` says that `serve` embeds each graph next, in the background, and how
    to see progress.
  - Messages, errors and the tools' descriptions say "device" where they said "computer".

## 0.37.0 - 2026-11-19

### Client

- **Remove Access on the Agents tab.** A graph's **MCP Server** tab now says how to take access
  back: the command that removes this graph from Claude Code or Codex, or which entry to delete
  for Cursor, VS Code and other agents, and, on a synced graph, `logout --all`, which removes every
  synced graph from the agent's device.
- **Clearer notes when the task editor keeps a key to its part.** When a key in the description,
  the comments or the additional context would reach past them, the note now names the part and
  says what the key would have done, such as joining the line onto the task. It has an **Open in
  tab** button to make the change in the task's document.
- **Scheduled dates on Kanban cards.** A card with a scheduled date shows it as a pill, such as
  `Scheduled 2026-12-01`, before its due date and in the same style as its tags.
- **Kanban Board filters by priority and due date.** Beside the filter box, the P1, P2, P3 and None
  chips show only the priorities you turn on, and **Due** shows only overdue tasks, tasks due today,
  tasks due in the next 7 days, or tasks with no due date. The Tasks View's **Due** menu offers
  **No due date** too.
- **Add a comment in the task editor.** A task with no comments has an **Add a comment** button, as
  the description has, which opens the comments' editor with the cursor in a new comment. A comment
  left empty is taken out when the task editor closes.
- **Search completes a property key as grey text after the cursor.** Press **Tab** or **Right**, or
  tap the grey text on a phone, to complete it. The list of keys no longer covers the first result.
- **Picture actions on phones and tablets.** Copy, download, view larger, open and delete are always
  shown over a picture on a touch screen, and are big enough to tap.
- **Fixes.**
  - **Esc** closes the task editor from its description and comments too. It only left the editor.
  - **Tab** and **Shift+Tab** stay inside Search. They moved on to the page behind it.
  - After **Create task**, the keyboard goes to the new task's title. It was left on the page behind
    the task editor.
  - On a phone or tablet, the Priority, Status, Due date and Task menu buttons in the bar along the
    bottom open their menu just above the button, not next to the cursor, and a menu stays clear of
    the on-screen keyboard.
  - On a browser that cannot open a folder, the Graphs page says which browsers open Folder Graphs
    in a plain grey box, in place of an amber warning.

## 0.36.0 - 2026-11-19

### Client

- **Fixes.**
  - In the Graphs menu, a graph with no toolbar colour sits in the same block as the coloured
    graphs of its group. It looked like a separate item under them.

### Headless Client

- **`read_document` reads a long document to its end.** A document over 200,000 characters comes
  in parts: an answer cut short gives `nextOffset`, and `read_document` with `offset` set to it
  gives the next part, until `truncated` is false. `startLine` says which line each part starts on,
  so line numbers from `search` and `tasks` still apply. `read_version` takes `offset` too, and
  `read_documents` gives `nextOffset` for a document it cut.
- **Fixes.**
  - `list_assets` lists every name a document uses for a file. A file uploaded twice under two
    names was listed under one of them only.
  - `read_task` and `set_task` give a task's text with its task tags, as `tasks` does, so the text
    matches the task's line.

## 0.35.0 - 2026-11-18

### Client

- **Bullets indented under a heading are put at column 0.** Bullets under a heading that were
  indented with no bullet above them, as another editor can leave a page, are now found by the
  formatting scan's indentation check, and its fix moves the section under the heading to column 0
  as a whole. Import and paste put such bullets at column 0 too.
- **Approve all and Dismiss in the formatting scan.** Under the count of issues, **Approve all**
  fixes every issue the scan can fix, after one confirmation, and **Dismiss** clears the results
  ready for a new scan. The scan also finds empty bullets written as a lone `-`, as Logseq writes
  them, which showed as a dash, and gives them the space that makes them bullets. A Logseq import
  now writes them that way too.
- **A graph's address says where the graph is kept.** A folder graph is at
  `/graph/folder/<folder name>`, a synced graph at `/graph/sync/<id>`, and the demo at
  `/graph/browser/demo-graph`. A link to a page in a folder graph now opens in a browser that has
  never opened the folder: EtherPK asks you to choose the folder once, then opens the page. If you
  have opened two folders with the same name, it asks which one the link is for, and shows each
  graph's name, colour and when you added it. An installed app that is already open goes to the linked page. Old `/g/…` addresses are sent on to
  the new ones in this release and stop working in the next.
- **Task and lane references carry the same address.** Copy agent instruction writes
  `etherpk:/graph/sync/<id>/…` or `etherpk:/graph/folder/<folder name>/…`, and the Headless Client
  now checks a folder's reference against the folder it serves. References copied earlier are
  still read in this release. Update the Headless Client with the Client: an older one cannot read
  the new references.
- **The `AGENTS.md` in a graph folder tells an agent how to link to a page**, so an agent can end
  its message with a link you can open.
- **Audio and video play in your notes.** A video (`.webm`, `.mp4`) or audio file (`.mp3`, `.m4a`,
  `.wav`, `.ogg`, `.opus`, `.flac`) written as `![name](../assets/file.webm)` on a line of its own
  has a player under it, with play, seek, volume, speed and full screen, and the same player opens
  the file in a tab. A file you drop or paste is written that way. The file is read when you
  press play. A published site shows the browser's own player, and the Headless Client publishes
  the same. An Obsidian import turns `![[clip.mp4]]` into a player line.
- **A graph kept in a folder is a folder graph.** The Graphs page, the Graphs menu and the docs
  no longer call it "local". The badge on such a graph reads **Folder**, and the user docs page is
  now **Folder Graphs**, at `folder-graphs.html`.
- **Fixes.**
  - A folder chosen in two tabs at the same moment becomes one graph, where it could become two.
  - Each group's **Approve all** in the formatting scan has the same fill as **Approve**, and asks
    for its confirmation straight away, without waiting for you to open a page's changes.
  - The formatting scan no longer reports a page as changed since the scan when nobody edited it,
    as when the page had been opened in the editor or one of the scan's own fixes brought an issue
    back. Approve all goes round again for such issues, and the count left after fixing says which
    issues have to be fixed by hand.
  - Keyboard focus stays on a formatting scan button while it waits for a scan or fixes to finish.
  - In Firefox, selected text in the PDF reader is marked in grey, as in other browsers, instead of
    the system's highlight colour.

## 0.34.0 - 2026-11-17

### Client

- **Several files added at once go on lines of their own.** Pasting, dropping or uploading more
  than one file puts each link or picture after the first on a new line in text, or in a new
  bullet in an outline, instead of running them together on one line. With one file to a line, a
  click to the right of a file's buttons puts the cursor on that line and shows the link's Markdown.
- **Fixes.**
  - Adding files that a folder graph already holds says they were reused, for every one of them. It
    used to count most of them as uploaded again when several were added at once.
  - The same file added twice in one go is stored once.
  - A file dropped to the left of a bullet lands at the start of the bullet's text, instead of
    before the bullet, where it turned the bullet into plain text.
  - A file added with the cursor in a page's frontmatter, or at the end of a code block's first or
    last line, goes on the next line instead of breaking the frontmatter or the code block.
  - On a phone, closing the last open tab no longer raises an error.

## 0.33.0 - 2026-11-17

### Client

- **Task buttons on a phone.** With the cursor on a task, the command bar shows **Priority**,
  **Status**, **Due date** and **Task menu**, which hold what a right-click on the task offers on a
  desktop, including **Open in task editor** and **Copy agent instruction**.
- **The task editor saves a new task when you close it.** Closing a new task with **Esc**, the
  close button or a click outside creates it when it has a title, instead of asking to discard it.
  **Cancel** still asks first.
- **Tag suggestions in the task editor.** The **Tags** field offers the tags already used in the
  graph as you type, and writes tags in lower case. On a phone, the keyboard no longer capitalises
  them, and the command bar shows while you type in the description, comments or additional context.
- **The Tasks view keeps up with other devices.** On a synced graph, a task ticked or moved on
  another device, in another window or by an agent changes in an open Tasks view without a reload.
- **Fixes.**
  - On a phone, a PDF bookmark in the sidebar opens the PDF at its page when another document was
    in front. It used to open the PDF where you last left it.

## 0.32.0 - 2026-11-17

### Client

- **Add a line above a code block.** With the caret before the opening backticks of a code block
  on a bullet's own line, Enter adds a bullet above the block and moves there. Above a code block
  that is not under a bullet, it adds an empty line. Enter there used to add a line of code inside
  the block.
- **One filter for the whole Kanban board.** The box above the lanes narrows every lane at once, by
  title words and `#tags`, and each lane counts its matches out of all its tasks. It replaces the
  search button on each lane. The line that says where a card went now goes away after five
  seconds, unless the pointer or the keyboard is on it.
- **A Kanban board keeps up with other devices.** On a synced graph, a board left open shows a card
  moved on another device, in another window or by an agent as soon as the change arrives, without a
  reload. It used to show such a change only for a document open in a tab.
- **Fixes.**
  - On a synced graph, a Kanban card moved to another lane no longer goes back to its old lane, and
    Move all to lane moves the tasks when another window, device or agent changed them first. A
    move, a tick in the Tasks view and an agent's change now start from the task as the Sync Server
    has it.
  - Renaming a page to the same name in different capitals (`Garden` to `garden`) shows the new
    spelling on its tab, and its editor no longer says the name differs.
  - Renaming a page that is alone in a pane beside another keeps it in its own pane. It used to
    move into the other pane, and its pane closed.
  - On a phone, notices appear below the top bar, so the document control and the sidebar buttons
    can still be tapped while one shows.
  - Deleting an empty bullet whose children hold a code block keeps the tabs the code is indented
    with.
  - The Command Bar's buttons work after selected text is replaced by a change from outside the
    editor, such as a file changed on disk or another person's edit. They used to do nothing.
  - Opening or reloading a mirrored graph shows one "Mirrored to" notice, not two.
  - On a folder graph, a file deleted or renamed outside EtherPK while the folder is being checked no
    longer stops the other changes from being picked up.

## 0.31.0 - 2026-11-16

### Client

- **Fold a bullet from its dot.** Click a bullet's dot, or the arrow that appears beside it under
  the pointer, to fold or unfold its children; on a phone, tap the dot. A folded bullet keeps a
  shaded circle in place of the `…` box, and stays folded when the document is opened again on
  the same device. Folds are not shared with other people in the document.

- **A block menu on the dot.** Right-click a bullet's dot, press and hold it on a phone, or press
  Ctrl+Shift+. to fold, copy, cut, duplicate, move, indent or delete the block with everything
  under it, paste above or below it, or put the cursor at its start or end. Pressing and holding a
  task's checkbox on a phone opens the task's menu.

- **More room between outline levels.** Each level of an outline steps in further on a desktop,
  and the text starts a little further from the left edge to make room for the fold arrow.

- **A protected documents passkey can be replaced or removed.** Settings > Protected Documents
  offers **Bind a new passkey** and **Remove this device's passkey** on a device that already has
  one, for a passkey that was deleted from the password manager. When a passkey cannot be used, the
  unlock prompt says to enter the passphrase and where to bind a new passkey.

- **The theme follows you between the Client and the Sync Server.** A link from one to the other
  carries the light, dark or system theme chosen there, so both show the same one.

- **Quick notes opens in a window over the graph.** A **Quick notes** button, third at the top
  of the Graph Sidebar, and Alt+N open it with the cursor in the box. The Quick notes tab in the
  left sidebar is gone. Text and files in the box are still there when you close the window and
  open it again, and moving the notes to today's journal closes it. **Add as task** sits beside
  **Attach**, the box's text is the size of a document's, and a note added as a task shows a
  checkbox in the list.

- **The Graph Sidebar's buttons stay in place.** Search, Today, Quick notes and the extensions'
  buttons no longer scroll away with the calendar and the lists under them.

- **The Documentation button is gone from the workspace toolbar.** **Docs** in the header
  opens the same pages.

- **Fixes.**
  - **Scan for orphaned assets** on a synced graph reads the documents a hundred at a time and
    closes each batch after reading it, so the memory it uses does not grow with the graph.
    It also waits for the graph's list of documents to arrive before it reads them, and says so
    when the list has not finished syncing.
  - The help text under **Rebuild search index** says when to use it: when backlinks, tasks or
    search results do not match your documents.
  - A code block under a bullet stays where it is while you type elsewhere on the page. It moved
    further right with each key when a diagram, video or other rendered block sat above it at the
    same indent.
  - The shaded background of a code block is one clean rectangle. A code sample holding a code
    block of its own (a four-backtick block around a three-backtick one) drew a second, offset
    background inside the first, with a scroll bar it did not need and the start of its lines cut
    off. A bullet-shaped line of code could also sit to the right of the lines around it while a
    fence above it was being typed.
  - Alt+Up and Alt+Down in a shared graph keep a word someone else types into the moving bullet at
    the same moment. It used to land at the start of the next line.
  - A task's checkbox shows exactly where the Tasks view lists the task. Typing a code fence above
    a task no longer hides its checkbox before the fence has its closing line, and a task beside an
    unclosed fence shows its checkbox where the Tasks view lists it.
  - Enter or Shift+Enter between the backticks of a code fence that has no closing line acts as at
    the end of the line, so it no longer splits the fence. Enter there completes the fence.
  - Tab over code lines and one fence of a code sample inside a code block does nothing, as Shift+Tab
    already did. It moved the code lines and left the fence where it was.
  - Enter at the end of the opening line of a four-backtick code block that holds a three-backtick
    sample adds a line of code. It added a second closing line.
  - A code block completed with Enter is drawn as a block straight away on a page that has an
    unclosed fence elsewhere. It stayed drawn as text.
  - Typing or pasting between two unclosed fences leaves both where they are. The lower one moved
    to the margin, and the lines between them became code.
  - Ctrl+Enter does nothing where the code block it carries out of a bullet would land under a
    longer unclosed fence at the margin. The block was carried out and stopped being a block.
  - Moving the caret off an indented, unclosed fence line leaves the line where it is. It moved to
    the margin and broke the code block below it.
  - A space typed in front of a code block's closing line, or Ctrl+Delete at its end, leaves the
    caret in place. It jumped to the start of the line.
  - Shift+Tab on a code line indented with a tab removes the spaces Tab added, or one tab. It
    removed the tab and a space together. Ctrl+Enter keeps a code line's tab when it carries a
    code block out of a bullet.
  - Several lines pasted into a code block that is not under a bullet line up with the code, as
    they do in a block under a bullet.
  - Deleting a selection inside a code block keeps the block. A selection that started on an empty
    line could move the code to the margin.
  - A click on a link opens it straight after a link's right-click menu has closed. The first
    click did nothing.
  - `\|` in a table cell is a pipe in that cell. It split the cell in two, and formatting the
    table added a column.
  - A search filter typed with a stray `"` keeps the same value when another filter's chip is
    removed.
  - An export of a graph with no name is called `Graph <date>.zip`, not `_ <date>.zip`. Before an
    export, **Mirror and Export** gives the size of the attachments and says so, and no longer
    shows "about 0 B" for a graph with none.
  - After **Replace all** in Find and Replace, the first replaced word is no longer left selected,
    which looked like a match beside "No matches".

## 0.30.0 - 2026-11-13

### Client

- **The usage statistics switch is at the bottom of Settings > General.** It links to the
  deployment's privacy page (`PUBLIC_PRIVACY_URL` on a self-hosted Client) for what is sent. The
  separate **Privacy** tab, with its list of events and of what was sent, is gone: it made the
  Settings tabs wrap onto a second line on a desktop.

## 0.29.0 - 2026-11-13

No changes to the Client or the Headless Client themselves.

## 0.28.0 - 2026-11-13

### Client

- **Usage statistics are off unless the deployment turns them on.** A Client sends them only when
  `PUBLIC_TELEMETRY_URL` is set: to `https://analytics.appsoftware.com` to send them to EtherPK,
  or to your own Umami server together with `PUBLIC_TELEMETRY_WEBSITE_ID`. In 0.27.0 a Client that
  left the setting unset sent them to EtherPK.

## 0.27.0 - 2026-11-13

### Client

- **Usage statistics.** The Client sends EtherPK usage statistics about once a minute: that it
  was opened, the kind of graph, and the names of the commands, tabs and Settings tabs used, such
  as `command.tasks.open`. It sends no notes, page names, file names, searches or accounts, and
  keeps no identifier. A notice says so before anything is sent, and **Settings** > **Privacy**
  lists every event, shows what was sent, and turns them off. A browser that sends Global Privacy
  Control reports nothing. To turn them off for a whole deployment, set `PUBLIC_TELEMETRY_URL` to
  an empty value.

## 0.26.0 - 2026-11-13

### Client

- **Quick notes take links, files and a place to go.** The box in Quick notes has a `[[ ]]` button
  that wraps the selected text in a wikilink or inserts an empty one, and typing inside `[[`
  lists your pages. A paperclip button attaches a photo, a PDF or any other file, and you can
  paste or drop one. **Link to Favourite** lists your favourite pages: pick one and the note moves to the
  journal nested under that page's link. Deleting a quick note deletes its file when nothing else
  uses it. **Add as task** puts a checkbox on the note, and once the notes have moved
  **Open today's journal** takes you to the entry and back to the graph's sidebar tab.
- **Share a photo or a file to EtherPK.** The installed app on Android and ChromeOS takes files
  from the share sheet as well as text and links. The share page shows the picture or the file
  name, and has the same link button and **Link to Favourite** row. On a synced graph that is unlocked
  on the device the file is saved on the device at once and uploaded after. If you leave before
  the upload ends, it is sent the next time EtherPK starts on that device. An app installed
  before this release takes files once the browser has refreshed it.
- **Fixes.**
  - The installed app's icon is full size again in desktop launchers, with slightly rounded
    corners and no shadow, and shows no square edge when Android crops it to a circle. An app
    installed before this keeps its old icon until it is installed again.
  - An installed app takes a changed icon or share target with the update that changes it.
  - A file in a quick note that has not arrived from another device yet shows when it does, with
    no reload.
  - An empty journal day or new page says "Type to create…" on a phone as on a desktop.

## 0.25.0 - 2026-11-12

No changes to the Client or the Headless Client themselves.

## 0.24.0 - 2026-11-12

- **The home page is shorter.** The line under the headline reads "Fast, Private, Secure Knowledge
  Management". The screenshots add Agent Integration (Claude Code working on a task from a Kanban
  board), Reading (the PDF reader) and Drawing (an Excalidraw drawing), and the list of what EtherPK
  offers adds the PDF and EBook reader and document versioning. The long feature list and the two
  panels comparing local and synced use are gone. On a self-hosted Client, the note under the
  buttons links the team's Sync Server.

## 0.23.0 - 2026-11-11

No changes to the Client or the Headless Client themselves.

## 0.22.0 - 2026-11-11

### Client

- **Version history on synced graphs.** A synced graph keeps earlier versions of each page and journal entry: one
  when you pause after editing (at most every ten minutes), when you close the document or leave EtherPK, and
  before a delete, a rename, **Replace all**, removing protection or a restore. Right-click a document's tab and
  choose **Version history** to see what each version changed, read it in full, and **Restore this version**.
  Restoring keeps a version of what it replaces, so it can be undone the same way.
- **Deleted documents and files can be restored.** Deleting a page, a journal entry or a file on a synced graph keeps
  it for the time the Sync Server keeps versions, 30 days unless it says otherwise. **All Documents** has a
  **Deleted documents and files** section to restore one or remove it for good. A restored PDF keeps its
  annotations. Undoing the delete of a picture brings the file back too. The delete confirmations say how long
  it is kept, and **Graph Settings** > **Maintenance** shows how much the history holds. The graph's owner can
  remove all of it there.
- The Graphs page quotes the managed service's lowest Sync+ price by the month ("from US$4.00 a
  month, billed yearly"), and the account card names the tier of Sync+ the account is on.
- The home page no longer has the line "Personal Knowledge Management System (PKMS)" under the
  EtherPK name.

### Headless Client

- **Document versions for agents.** On a synced graph, an agent's first edit to a document in a session keeps a
  version of it first. The new tools `list_versions` and `read_version` show a document's earlier versions. An agent
  cannot restore one: a person does that in EtherPK.

## 0.21.0 - 2026-11-11

### Client

- **A plainer home page.** The heading reads "One Markdown Notes App For", **Try The Demo** is the first
  button and the screenshots open on the editor.
- **A Welcome page in a new graph.** A graph you create empty, synced or in a folder with no notes, starts with
  one page, **Welcome to EtherPK**, with a few things to try. It is the tab in front when the graph first opens, with the
  journal entry for today as the tab beside it, and it is in **Favourites**. Delete it when you are done with it and it does not come back. An import, a folder that already
  holds notes and a graph you join do not get one.
- **Choosing a first graph.** With no graphs yet, the **Graphs** page shows two panels, **Create a Folder Graph** and
  **Create a Synced Graph**, each saying what it gives you, and a short list under them, **All graphs get**, of what
  the two share. On the managed service the synced panel states the price and the trial, as the account site
  publishes them. **New synced graph** is never greyed out: without a plan that includes synced graphs it leads to
  where you start one, and coming back to the app afterwards opens the naming dialog.
- **Import says where a graph can go before asking for a file.** When this browser has nowhere to put an imported
  graph, the dialog says why and what to do. With one place available it is chosen for you.
- **The `/` menu is in three groups.** **Insert** comes first, then **Go to**, then **Settings**, each under its
  heading. Typing still searches all three. An extension chooses the group its rows appear in.
- **New line and New block have names.** The two buttons at the end of a document are a row at the foot of its tab,
  with their names, and no longer sit over the text.
- **Signing in comes first on the Sync tab.** With no account on this device, the **Sync** tab shows **Sign in**, and
  **Use your own Sync Server** opens the form for a server you run. A deployment with no managed service shows its
  server form as before.
- **A locked device shows one step.** Until your Encryption Keys are unlocked on a device, each server shows
  **Unlock Encryption Keys** and lists its graphs as locked. A locked graph's menu still has **Delete graph…** or
  **Leave graph…**, and the question it asks says which graph it is.
- **The same agent setup on the Graphs page.** The **Agents** tab there has a graph picker and shows the steps and
  commands a graph's own **Agents** settings show.
- **Empty Bookmarks sections stay closed.** **Bookmarks** and **PDF Bookmarks** in the sidebar show only their
  headings until they hold something. Open one to read what it is for.
- **Share from inside a graph.** The Owner of a synced graph has **Share** in its Settings, **Share this graph…** on a
  tab's menu and in the `/` menu. Each opens the invite dialog.

- **Read EBooks.** An EPUB in a graph opens in its own tab, with contents, page turns, find and your place kept between
  devices. Your text size, line spacing, alignment and hyphenation apply over the EBook's own layout. Highlights, notes and bookmarks are kept beside the EBook, private to you, and a
  highlight can be copied to your journal with a link back to the passage. An EBook reads in a document of its own, with
  no network and no way into the rest of the app, so an EBook's scripts do not run. An EBook protected by DRM does not open.
- **More for EBooks.** Read an EBook aloud with a voice on your device, look up a word in a StarDict dictionary you add, set the
  text in Literata or Atkinson Hyperlegible, and export your highlights to a page. The time left learns how fast you read. The
  demo graph has an EBook to try.
- **Favourite a PDF or an EBook from its tab.** Right-click its tab, or long-press it on a phone, and choose
  **Add to favourites**.
- **Every unlocked device shows a new device's request.** When a new device or the Headless Client asks for your
  Encryption Keys, **Approve a new device?** appears on each device with your keys unlocked, not only on the first one
  to see it. Select **Show the code** on the device you approve from, and the prompt closes on the others. **Not now**
  closes it on one device only.
- **Clearer agent setup.** On a synced graph's **Agents** tab, the first step is **Log in the agent**. It says what
  the agent's token can and cannot do, and that logging in once on a device covers every graph. What an agent can do
  without is under **Optional Steps**.
- **Colours at the side of the page.** A PDF tool's colours and thicknesses, and an EBook's highlight colours, wait
  behind a button at the right edge of the page on every screen, so they no longer cover the top of the page on a
  tablet or a desktop.
- **Fixes.**
  - **Ctrl+/** opens the Keyboard Shortcuts card and leaves the line the caret is on as it was.
  - The Recovery Code dialog opens on the warning and the code. It mentions other Sync Servers only when this device holds one.
  - The **This Device** tab is marked only when this browser holds something a Device Passcode would protect.
  - Closing the folder picker without choosing a folder shows no message. A folder that fails to open while importing or publishing now says so.
  - Messages about one person with access to a graph call them a Player.
  - On a phone the demo opens on its page with the sidebar closed, and its text says where things are on a phone.
  - **Reset workspace** is no longer a toolbar icon. It is still at the foot of the sidebar, by name, and in the `/` menu.

### Headless Client

- **`login` is easier to read.** Its messages have blank lines between them, and the line that says
  to press `r` for your Recovery Code is marked with `**` so that it stands out.


## 0.20.0 - 2026-11-06

### Client

- **Images in Excalidraw drawings.** Paste an image over a drawing, drop it there or use Excalidraw's
  image tool, then draw over it. The image is kept as one of the graph's assets, and it shows in the
  drawing's picture, in backlinks and on published sites. An agent can place one too: `upload_asset`
  and `read_asset` report an image's size in pixels, and `AGENTS.md` describes the line to add.
- **Copy or save a drawing as an image.** The menu over a drawing's picture has **Copy as image** and
  **Save as image**: a light PNG at twice the drawing's size, named after the document. While you edit a
  drawing, **Export image...** in Excalidraw's menu offers PNG, SVG and the clipboard, with its own options.
- **Open in tab in the task editor.** A link under the task editor's buttons closes it and opens the
  task's document in its own tab at the task line.
- **Task tags in any case.** `#p1` means the same as `#P1`, and so do `#w`, `#c`, `#d-2026-11-05` and the
  other task tags, in the editor, the Tasks View, Kanban boards and published pages. Lower-case tags already
  at the start of a task count the next time you open the graph. A word like `#c` or `#w` later in a task is
  now a tag too: it moves to the start when the cursor leaves the line, and `#c` or `#a` ticks the task. Put
  backticks around one you mean as text.
- **Free tags in the `#` menu.** Type `#` and a letter on a task line and the menu lists the free tags your
  graph already uses, after the task tags. If what you typed is already one of them, **Enter** starts a new
  line and leaves the tag as you typed it.
- **Neutral greys.** The interface's greys are neutral in both themes, without the blue or purple tint they
  had. Text selection in the editor and in a PDF, an unfilled PDF form field, Excalidraw's controls and a
  Mermaid diagram that sets no theme of its own are grey too. A Find match in a PDF uses the editor's Find
  colours. Links and everything else in the link blue stay as they were.
- **Put your graphs in order.** On the Graphs page, drag a graph by the grip on its card, or press the up
  and down arrow keys on the grip. Each Sync Server's group and your folder graphs keep their own order,
  and the Graphs menu and the share sheet follow it. A synced group's order follows your account to your
  other devices. Local order stays in the browser.
- **The Graphs page and the Graphs menu are laid out differently.** Synced graphs come above folder graphs
  on both. Each graph on the Graphs page is a separate card, and a coloured graph's card takes its toolbar
  colour. The Graphs menu lists synced and folder graphs under separate labels.
- **Error messages about syncing are in plain words.** They say what failed and what to try next. The
  underlying error goes to the browser console.
- **Kanban cards show their priority.** A card in a P1, P2 or P3 section carries that label, so you can
  still tell which priority you are in after a long lane has scrolled its section heading away. Priority
  labels on cards and in the Tasks view have the Task Editor's colours.
- **Resize a map.** Drag the handle on a map's corner, as you would on an image, and double-click it for the
  default size. The size is saved in the map's text as a line such as `size 640x380`, so your other devices
  and the other members of a shared graph see the same size, and a published picture of the map follows it.
  An older Client draws the map at its default size and reports the line as one it can't read.
- **Copy or save a map as an image.** In a map's **More map actions** menu, **Save as image** downloads a PNG
  of the map as it is on screen, at twice its size, named after the document, and **Copy as image** puts it on
  the clipboard. It shows your places and routes with their names, without the map's buttons. With your own
  Mapbox token it keeps the Mapbox background, including satellite, and the map reminds you that Mapbox's terms
  don't allow you to distribute the picture.
- **Two new extension calls, in beta.** A framed block with `asImage` gets **Copy as image** and **Save as image**
  in its menu. `context.assets.storeImage` keeps an image and answers its reference as well as its markdown, or
  why it was not kept.
- **Fixes.**
  - A map's search box no longer pushes the map's buttons off the edge of a narrow map.
  - A folder graph opened from its address or a restored tab shows **Grant access** when the browser needs a
    click before it will ask for the folder. It used to fail with a message about the sync server. If you
    refuse, the screen says so and offers **Back to graphs**.
  - Any other failure to open a folder graph describes the folder, not the sync server.
  - The `#` menu no longer opens with the cursor inside a task tag, where choosing a row split the tag
    (`#P1 2`), or after you set a status or priority from a task's right-click menu.
  - The `/` menu opens only when you type `/` or press the slash button. It no longer opens when the cursor
    lands behind a `/` already in the text, where **Enter** would run a row. After **Escape** it stays closed
    until you type another `/`.
  - Saving a synced graph's settings from the Graphs page no longer reports an error after saving them.
  - Search results on a published site with the EtherPK Docs theme nearly fill a phone's width. They used to be
    as narrow as the search box.

### Headless Client

- `tasks`, `read_task` and `set_task` read a task tag in any case, so `#p1` means the same as `#P1`.
- **Agents say when their copy of a synced graph is offline.** While the Headless Client cannot reach the
  Sync Server, every tool answer ends with a note saying since when, and `graph_info` reports `connection`.
  `task_not_found` says a task may be newer than the copy, and the same instruction works once the
  connection returns. The background process's log records the connection going and coming back.
- **Fixes.**
  - `graph_info` answers within about 15 seconds when the publications cannot be read, with `publications`
    set to null and a note.
  - `read_asset` takes `reference`, the word the task tools use, in place of `ref`. `upload_asset`,
    `read_asset` and `list_assets` answer with `reference` too.

## 0.19.4 - 2026-11-05

### Client

- **New synced graph works again.** From 0.17.0 it failed against any deployed Sync Server, with "The sync
  server could not be reached (Failed to fetch)". So did the other actions that send no data: **Create an
  Agent Setup Code**, accepting or declining an invite, removing a member, leaving or deleting a graph,
  **Rotate key** and removing unused files.

### Headless Client

- **Fixes.**
  - `logout` revokes the token it holds again. From 0.17.0 the server refused the request, so `logout`
    reported that it could not.

## 0.19.3 - 2026-11-05

### Client

- **More room to read a PDF on a phone.** The top bar and the page buttons go 5 seconds after they show, and
  the page stays where it is. Tap the middle of the page, or anywhere on it without **Page by page**, to bring
  them back, and tap again to hide them. The command bar stays. A tool, or anything opened from the command
  bar, keeps them up until it is done. **Hide top bar and page buttons** in **More** turns this off. It replaces
  **Full screen**, which is no longer in **More**.

## 0.19.2 - 2026-11-05

### Client

- **Copy agent instruction.** **Copy task reference** and **Copy lane reference** are now **Copy agent
  instruction**, on tasks and on Kanban lanes, and what they copy depends on where the graph is. On a
  folder graph it names the task's file, so an agent can work from it with or without the Headless
  Client. The first copy asks where the graph's folder is, and you can skip that. On a synced graph it
  tells an agent with no Headless Client to stop and send you to the graph's **Agents** settings. On a
  graph kept in the browser, it says an agent cannot reach it, and that tab says what to do instead.
- **Agents settings.** The **Agents** tab has a sub-tab for each way of working with an agent: **MCP Server**,
  for an AI agent on your device, and **Agent Chat**, for asking a language model from inside EtherPK. The Claude
  Code command now reaches a graph from any folder, each graph registers under a name of its own, and VS Code has
  the `mcp.json` block it reads. The EtherPK skill is marked optional, since only creating a new graph folder needs it.
- **Chat instruction.** The **Agent instruction** setting in Agent Chat is now called **Chat instruction**.
  What you wrote there stays as it was.
- **Protect a page before you type in it.** **Protect…** on a page you have opened but not typed
  into asks whether to create it. **Create and protect** creates the page empty and encrypts it, so
  what you type into it next is protected from the first keystroke.
- **Turning a PDF's pages, reading page by page.** A tap at either side of the screen turns the page however far
  it is zoomed or moved, and the side flashes so you can see how far it reaches. A new page starts at its top,
  centred across the view, where a zoomed page used to start at its left edge.
- **Hand tool for PDFs.** With a mouse, **Hand** in the toolbar lets you drag a zoomed page around. A click still
  opens a link.
- **A placed signature stays on the page.** It stays when a tablet turns and the layout changes, and on a phone
  while another document is on screen, until you save a copy and close the tab or discard it.
- **Fixes.**
  - On a touch screen, a link or a form field in a PDF answers the first tap after a tap elsewhere on the page.
  - **Draw with finger** is remembered on the device once you change it, and is on by default on a phone held
    sideways.

## 0.19.1 - 2026-11-05

### Client

- **Ask an agent about a PDF.** Select text in a PDF and press the Agent button, on the Command Bar on a
  phone or at the bottom right of the tab on a larger screen, or press Alt+A. A chat opens with the text
  as its message, ready for a question. The model receives only what is in the chat, and the chat is not
  kept: **Copy** takes the latest answer as bullets to paste anywhere.
- **Select text in a PDF with a finger or a stylus.** A new **Select text** tool sits before Highlight
  text. Neither can be turned on on a page with no text. Selected text brings up a bar with **Highlight**
  and a new **Copy**.
- **Reading a PDF on a phone.** The toolbar's buttons move to the Command Bar, in place of the editing
  buttons, and the app's header hides while a PDF is in front, coming back when you open anything else. The
  page box is in the **More** menu, and the page number shows over the page for 5 seconds when it changes
  or when you tap the page. In **Page by page**, a tap at any height on either side turns the page at once,
  with a finger or a stylus. **Full screen** in the **More** menu gives the PDF the whole window, and a
  button at the bottom right brings the controls back.
- **Saving a copy of a PDF.** **Save a copy** is on the phone's Command Bar, with a new icon. Its dialog is
  headed **Save an additional copy** and says your annotations are already saved. The new link goes
  after an existing link to the PDF unless you choose otherwise.
- **A PDF to try in the demo.** The demo graph has a Houseplant Handbook, with a form to fill in and sign,
  so you can try the PDF reader without a PDF of your own. Today's journal links to it near the top.
- **Extension API.** `layout.activeFile()` says which file's tab is in front and what is selected in it,
  and `layout.openWindow` takes a `size` and `closesOnOutsideClick`. A Command Bar button's `files`
  names the types of file it works on, and replaces `documentOnly`. With a PDF in front, a button that does
  not name `pdf` is not shown. A window over the whole screen ends above a phone's keyboard.
- **Kanban boards on a phone.** Boards now open in the phone layout, from the same menus as on a desktop
  and from the **Graph Kanban** button. A board shows one lane at a time, chosen from a selector that
  counts the tasks in each, and remembers your lane on each device. To move a card, long-press it or
  press its three dots, or use **Lane** in the task editor. The board says where the card went, with
  **Undo**.
- **Fixes.** A signature placed on a PDF's form field stays above it, where you can see and drag it, and
  its remove button shows a cross in the dark theme. A form's check boxes no longer show over the tab in
  front of a PDF. A right-click menu too tall for the screen now scrolls. What you are reading in a journal
  tab's older days stays still when several lines arrive above it in quick succession. The **More** menu in a
  PDF closes with its close button or a press outside it. Undo and redo in a PDF go to the page they change. Search has a close button at the top right. The message shown while a
  file loads is at the top of the view, and a phone's list of open documents shows a synced PDF's name.
  On a phone, the icons on the sidebar's favourites and bookmarks sit level with their names, Agent Chat's input
  stays above the keyboard, and the Command Bar's buttons are off while a drawer is open.

## 0.19.0 - 2026-11-04

### Client

- **A PDF reader.** A PDF opens in its tab with pages drawn as you reach them, selectable text, links,
  zoom and find, and it asks for a PDF's password each time. It reopens where you stopped, on any of
  your devices on a synced graph. **Page by page** has buttons floating at the bottom of the view,
  **Crop margins** hides blank margins and **Dark pages** gives the pages dark colours. Ctrl or Cmd
  with the mouse wheel zooms the PDF, not the app.
- **Annotate a PDF.** Highlight text, draw with a pen or freehand highlighter and type notes, in any
  colour and four line thicknesses. The line is steadied as you draw, and a stylus's pressure changes
  its width. Annotations save as you work and belong to you: EtherPK does not show them to the other
  members of a graph. **Copy to journal** writes a passage into today's journal with a link to its
  page, and `../assets/name.pdf#page=12` opens a PDF at that page.
- **Sign and save a copy of a PDF.** Fill in its form, place a signature, then save a new PDF to your
  device or add it to the graph, with a link in today's journal or straight after the link you opened
  it from. A copy can be flattened, and its password kept, removed or changed. Printing includes your
  annotations by default. The PDF in your graph never changes.
- **PDFs on a phone or tablet.** Pinch to zoom, read full-screen as the controls hide, keep the screen
  on, and keep a large file on the device for reading offline. At phone width a finger draws and
  highlights, two fingers move the page, and the pen's options tuck behind a tab at the page's edge.
  **Draw with finger** in the **More** menu changes what a finger does.
- **PDF Bookmarks.** Bookmark a page from the PDF's toolbar. It shows a ribbon, and is listed in the
  Sidebar under the name of its PDF, on all your devices on a synced graph.
- **Links to files read as their label.** A link to a PDF or other file shows its label and a pill
  with the file's extension, and its full source when the caret is on its line, as other links do. A
  click on the link or the pill opens a PDF in its tab. Other files download as before, and so does
  the download icon beside the link.
- **PDFs in Favourites and Recents**, with a PDF icon. A PDF's tab can also list the documents that
  link to it, delete it when nothing does, and rename it, which updates the links to it.
- **Extension API.** A Command Bar button can set `documentOnly`, which greys it while a tab that shows
  a file, such as a PDF, is in front. Agent Chat's button does this.

### Headless Client

- **`diagrams status` starts the browser.** It reported a browser whenever the file existed. It now
  starts the browser too, and prints the browser's error and exits with 1 when it does not start.

## 0.18.5 - 2026-11-04

### Client

- **Fixes.**
  - Enter completes a code fence when a space was typed before the backticks, or sits after the
    caret. It opened a new bullet instead.

## 0.18.4 - 2026-11-04

### Client

- **Filter tasks by tag as well as by text.** A Kanban lane's filter now reads a `#tag` as well as
  words, so `gate #bug` shows the tasks with `gate` in the title that carry `#bug`. Case is ignored
  and a tag must match whole. The Tasks View has the same filter, in a new **Task text / tag** box
  under its other controls, and lists a subtask by its own text and tags. Both wait for a pause in
  typing before they update. Each graph rebuilds its search index the first time it opens after
  updating.
- **Kanban lane headers show the count beside the name**, such as `Open 7`, instead of beside the
  buttons.
- **The Kanban board's moved and deleted notices follow the theme.** They use the theme's own surface
  rather than a blue tint, and sit further up from the bottom of the board.
- **Fixes.**
  - A copied task reference keeps a tag written in the task's sentence, so `e.g. #bug.` no longer reads
    `e.g..` in the copied text.

### Headless Client

- **A publish draws Excalidraw drawings.** A site published from the Headless Client now shows each
  drawing as a picture, as one published from the browser does, instead of leaving it out. A publish
  that includes drawings needs a browser, so it is refused until `diagrams setup` has run or
  `ETHERPK_CHROMIUM` names one. The npm package is about 15 MB larger, for Excalidraw and its fonts.

## 0.18.3 - 2026-11-04

### Client

- **Open in pane below from the keyboard.** With the cursor in a link, press
  **Ctrl+Alt+Shift+Enter** (**Cmd+Option+Shift+Enter** on a Mac) to open its page in the pane
  below, as **Ctrl+Alt+Enter** opens it in the pane to the right.
- **Kanban boards show a task with subtasks as one card.** A task nested under a task on the same
  board has no card of its own: the parent's card counts its subtasks, such as `1/3`, and the task
  editor shows them in the description. The Tasks View still lists every task. A card also says
  `in:` and the concept it sits under, on a board for a concept further out. To keep tasks as
  separate cards, nest them under a plain bullet (`- [[Garden]]`) rather than a task.
- **Filter a Kanban lane by title.** The search button in a lane's header opens a box at the top of
  the lane, and the lane shows only the cards whose titles contain what you type, ignoring case. The
  lane's count shows the matches out of its tasks. The close button or **Esc** clears the filter.
- **The graph opening screen holds still.** The "Indexing N of M documents" line uses a fixed-width
  font with the count padded to the total's digits (`0900 of 2932`), so neither it nor its progress
  bar changes width as the count runs. The bar is now rounded and takes the theme's colours.

### Headless Client

- **`read_task` lists a task's `subtasks`**, each with its text, status, line, depth and a reference
  for `set_task`, so an agent can tick them off as it works through them.
- **`tasks` says how tasks nest.** Each one has `parentTask` and a `subtasks` count, and `board: true`
  lists what a Kanban board shows, as a lane reference does.

## 0.18.2 - 2026-11-03

### Client

- **Ink drawings are removed.** Excalidraw is the one kind of drawing, and draws freehand lines
  with pen pressure too. An Ink drawing already in a document stays in it as text: the document
  shows a note in its place, and **Show text** shows its lines.
- **Drawings on a tablet open over the window.** On a touch screen, in the desktop layout too,
  pressing a drawing or inserting one opens it over the whole window, so a finger still scrolls the
  document. A mouse or a trackpad still edits a drawing in its place.
- **Open in pane below.** Right-click a link and choose **Open in pane below**, under **Open in
  pane to the right**, to read the page under the note. Both rows are now on backlinks too:
  right-click a reference or a document's name in the Backlinks panel, or under a document, to
  open that document beside the one you are reading, at the line with the link. On a Kanban card,
  **Open below** is now **Open in pane below**.
- **Fixes.**
  - The installed app's icon is a rounded tile with a soft shadow in desktop app launchers such as
    GNOME's, instead of a square with sharp corners. An app installed before this keeps its old
    icon until it is installed again.

## 0.18.1 - 2026-11-03

### Client

- **Excalidraw drawings on a phone.** Tap a drawing to draw on it over the whole window, in
  Excalidraw's phone layout, and `/drawing` is offered on a phone too. A pen turns on Excalidraw's
  pen mode, where a finger no longer draws.
- **Fixes.**
  - Ink strokes drawn fast with an Apple Pencil in Safari on an iPad no longer break into dashes.

## 0.18.0 - 2026-11-03

### Client

- **Excalidraw drawings come with EtherPK.** There is nothing to install. The slash command is now
  **Excalidraw (drawing)**, and `/draw` still finds it. Existing drawings keep working, and a
  device that installed Excalidraw from the Extension Directory switches to the built-in one by
  itself. Drawings are light in both themes, drawn in the colours they store. The font for Chinese
  and Japanese handwriting downloads the first time a drawing needs it.
- **Ink drawings.** `/ink` adds a drawing for a pen or stylus, on every device. Press it to draw on
  an endless sheet of white paper: a pen that follows the pen's pressure, a highlighter, an eraser
  that takes out whole strokes (a pen's eraser end works too), a lasso to select and drag strokes,
  and a Hand to move the sheet, on plain, dotted or lined paper. Once a pen has touched the
  drawing, a finger only scrolls and zooms, so a resting hand leaves no marks. Each stroke is a line
  of text in the document, and **Undo** in the palette or **Ctrl+Z** takes it back, in a tab or the
  full window too.
- **Drawings share one toolbar.** While a drawing is edited in the document, **Done**,
  **Full window**, **Open in tab**, **Edit as text** and **Delete** sit above it, and the **…**
  menu over its picture offers **Edit as text** and **Delete**. One drawing is edited at a time, and
  a press outside it puts its picture back.
- **View a picture larger.** Point at a picture in a document and select **View larger**, the first
  of its icons, or choose it from the menu a right-click or a long press opens. The picture opens
  as large as the window allows, over the page or the task editor, and **Esc** closes it.
- **Set a task's status and priority from its menu.** Right-click a task in the editor, or its row
  in the Tasks view, and choose **Mark as Doing**, **Mark as Done**, **Archive**, **Priority P1**,
  **No priority** and so on, as on a Kanban card. In the editor **Ctrl+Z** undoes the change; in
  the Tasks view a notice offers **Undo**.
- **Task tags typed later in a task move to the front.** Type `#P1`, `#W` or a dated tag such as
  `#D-2026-07-01` anywhere in a task line, and when the cursor leaves the task the tag moves to
  after the checkbox. A priority or a date counts as if chosen in the tag menu. A state tag sets the
  task's status and ticks or unticks it to match, so `#C` cancels the task and `#W` makes it
  Waiting. Tags in backticks, links and web addresses stay where they are, and so do free tags.
  **Ctrl+Z** puts the tag back.
- **The task editor.** **Open in task editor**, the first row of the right-click menu on a Kanban
  card, a task in the editor or a row of the Tasks view, opens a task in a dialog, and so does a
  click on a card. Change its title, lane, priority, due and scheduled dates (from the editor's
  **Date Picker** calendar) and tags, edit its description and its comments (bullets under a
  `- Comments` bullet nested under the task), add assets, archive it or delete it with **Undo**.
  Each change is saved into the task's text as you make it, and a task changed elsewhere while it
  is open is never overwritten: the editor offers to reload. Lines nested under the task below its
  comments show as **Additional context**. The assets list shows every picture and file in the
  task, with a preview of each picture that opens larger. Drag the handle under a part to make it
  taller, and the editor remembers that height on this device. In these parts, `/` offers only the
  commands that add or format text. To edit a card's document as text below the board, as a click
  did before, right-click the card and choose **Open below**.
- **Add a task from a Kanban lane.** The **+** in a lane's header opens the task editor on a new
  task in that lane. **Create task** (or **Ctrl+Enter**) writes it into today's journal, under a
  bullet linking the board's page, or on its own on the Graph Kanban.
- **Copy a reference to a Kanban lane.** Right-click a lane's header or folded strip and choose
  **Copy lane reference** to hand an agent every task in the lane, to work through or triage. In
  the Headless Client, `tasks` takes the copied text as `reference` and lists the lane's tasks.
- **Extension API.**
  - A Command Menu row that only adds or formats text at the cursor can set `actsOnText: true`.
    Only such rows are offered in the task editor's description, comments and additional context.
  - `context.assets.viewImages({ refs, start })` shows a list of the graph's pictures in the
    Lightbox that **View larger** opens, and `view-larger` is one of the Client's icons.
  - `context.dialogs.pickDate({ anchor, value, label })` opens the editor's Date Picker calendar
    beside an element and resolves to the day picked, as `YYYY-MM-DD`.
  - `context.notify(text, { action })` puts a button such as **Undo** on the notice.
    `context.contextMenu.taskOf(target)` names the task a menu was raised on, a task's line in the
    editor or a Tasks view row. `context.assets.describe(ref)` and `context.assets.imageUrl(ref)`
    name an asset a document refers to and show its image.
- **Fixes.**
  - Deleting a page removes it from Favourites, by its title or an alias, and removes its
    bookmarks, for every member of a shared graph. A favourite board or map of the page stays.
  - A Kanban card moved with the mouse, by dragging it or from its menu, no longer scrolls the
    board to the card's new lane. When that lane is out of sight, a line at the foot of the board
    says where the card went and offers **Undo**. Keyboard moves still follow the card.
  - A clicked image is drawn again as soon as the cursor leaves its line, also after **Enter** or a
    click below the document, instead of showing its markdown over an empty grey box.
  - **Delete** on a drawing that sits on a bullet's line removes it again, from the drawing's
    **…** menu and from its toolbar. The bullet stays, empty.

### Headless Client

- **Protected documents are no longer shown to an agent, not even by name.** `list_documents`,
  `search`, `backlinks`, `tasks`, `graph_insights` and `graph_path` leave them out, and reading one
  answers `not_found`, as for a name nothing has. `graph_info` still counts them. A write onto a
  protected document's name, such as `create_page` or a rename to it, is still refused with
  `protected_document`. A document with an encrypted block beside plain text is left out the same
  way, as Agent Chat already did.
- **`add_task_note` writes a task comment.** The note goes under a `- Comments` bullet nested
  directly under the task, which is started as the task's last child when there is none, and
  `read_task` lists the task's comments. Notes added before this change stay where they are.

## 0.17.1 - 2026-11-03

No changes to the Client or the Headless Client. 0.17.0's images, GitHub Release and npm
package were not published, and 0.17.1 publishes the same code under a new number.

## 0.17.0 - 2026-11-03

### Client

- **Bookmarks.** Mark a line to come back to it: right-click the line and choose **Bookmark
  line**, press **Ctrl+Alt+K** (**Control+Option+K** on a Mac), or click in the padding to the left
  of the line. Bookmarks are listed in a **Bookmarks** section of the graph sidebar, below
  Favourites, and a click opens the document at the line. A bookmark stays with its line as the
  text around it changes and follows its document through a rename. You can give one a label, and
  **Remove all** has **Undo**. On a folder graph bookmarks are kept in `etherpk/bookmarks.json`.
  Protected pages have no bookmarks.
- **Favourites, quick notes and bookmarks are your own on a synced graph.** Each member of a shared
  graph has their own, and EtherPK does not show them to the other members. The first time you open the graph,
  its favourites are copied to your list. Quick notes added before this change move to the graph's
  owner. When a member leaves, their favourites, quick notes and bookmarks are deleted the next time
  the owner opens the graph.
- **A menu on right-click in the editor.** Right-click a line for the bookmark rows and **Paste**,
  or a link for **Add to favourites** and **Remove from favourites**. **Shift+F10** or the **Menu**
  key opens it at the cursor. Right-click inside a selection, on a picture, or with **Shift** held,
  for the browser's own menu.
- **Boards and maps can be favourites.** Right-click the tab of a Kanban board, the Graph Kanban, a
  map view, the Graph Map or the whole-graph Graph View and choose **Add to favourites**. The view
  joins your favourites in the graph sidebar with its tab's title and icon, and selecting it opens
  the view again. A board or map of a page follows the page when it is renamed. Older versions of
  EtherPK do not show these favourites, and remove them from your list if they change it.
- **Extension API:** a view declaration can set `"favourite": true` to let a person add the view to
  their favourites from its tab.
- **New line buttons float at the bottom left.** The two buttons that start a new line of text or
  a new bullet float at the bottom left of a document, as the lock button does at the right, so
  they are always in reach. With the cursor in the document, the line goes after the cursor's
  block: the text button breaks out of a list to a line of text, splitting the list, and the
  bullet button adds a bullet beside the cursor's. With no cursor, the line goes at the end.
- **Test and Archived task states.** `#T` marks a task under test, and Kanban boards show it in a
  new **Test** lane between Waiting and Done. `#A` on a ticked task archives it: it leaves every
  Kanban board and stays in its document, and the Tasks view lists it under **Archived**. A card's
  menu has **Archive**, and archiving a task archives the tasks nested under it.
- **Move all to lane.** Right-click a Kanban lane's header, or its folded strip, and choose **Move
  all to lane…** to move every task in the lane to another state, Archived included. One **Undo**
  puts the whole move back. Extensions can ask the same kind of question with
  `context.dialogs.choose`.
- **Free tags on tasks.** Write your own labels, such as `#bug` or `#needs-review`, anywhere in a
  task's text. The Tasks view and Kanban cards show them as labels, and a Kanban board groups the
  cards in each section by their first free tag. A task tag written after a free tag, as in
  `#bug #P1 Fix the gate`, is now read.
- **Task references for AI agents.** **Copy task reference** copies the graph's name, the task's
  words, a reference that starts `etherpk:`, and which Headless Client tools read it, so an agent
  with several EtherPK graphs connected can tell which one the task is in. Copy it from a Kanban
  card's copy button, or right-click a task's checkbox or words in the editor, or a row of the
  Tasks view (**Shift+F10** from the keyboard). A line above a Kanban board's lanes links to how to
  set up an agent, and can be dismissed. References copied before still work.
- **Ticking a task ticks the tasks nested under it,** at any depth, and unticking it unticks them,
  except cancelled tasks (`#C`). This applies in the editor, the Tasks view and on a Kanban board,
  and one **Undo** reverses it.
- **Resize an image by dragging** the handle at its bottom right corner. The width is written into
  the image's size hint, such as `|320`. **Esc** cancels, and a double-click on the handle removes
  the hint.
- **A copied line pastes above the cursor's line.** With nothing selected, **Ctrl+C** or **Ctrl+X**
  takes the whole line, and **Ctrl+V** puts it on its own line above the cursor's line, as in VS
  Code. In a list it becomes a block at the same depth.
- **Templates and days.** **Yesterday** and **Tomorrow** in the `/` menu insert a link to that
  day. The `{{date}}`, `{{today}}`, `{{yesterday}}` and `{{tomorrow}}` Template variables give a
  link to the day's journal entry, such as `[[2026-11-01]]`, except inside a link, so
  `[[{{date}}]]` copies as before. `{{date:YYYY-MM-DD}}` gives the plain day.
- **Self-hosting: the Client does not start when `ORIGIN` is not an HTTP or HTTPS origin with no
  path,** such as `https://app.example.com`.
- **Fixes.**
  - A click just past the end of a link puts the cursor after it, and a click on an image puts the
    cursor at the end of its markdown, on whichever line was clicked.
  - Text pasted after a code block's closing ` ``` ` or the frontmatter's `---` starts on a new
    line, and pasted text loses the spaces at the end of its lines, outside code.
  - Cutting or deleting blocks that end at an empty line leaves the text after it where it was.
  - **Ctrl+Enter** keeps its new line when spaces follow the cursor, and the outline's guide lines
    continue beside a soft line made with **Shift+Enter**.
  - A page no longer scrolls back while you type straight after opening it, and Search keeps the
    keyboard when opened in that moment.
  - A synced graph reconnects after a sign-in request that gets no answer, and the sync status no
    longer says Offline after the network comes back.
  - A page deleted and created again on another device shows its first edits without a reload.
  - The address bar keeps the page you went to after connecting a server.
  - A protected page you keep typing in is saved at least once a minute.
  - In Firefox, the first character typed into a new page of an unlocked protected graph is kept,
    and a Command Bar button no longer closes the phone's keyboard.
  - Graph View says when the browser cannot draw it, instead of reading for ever.
  - Notifications stay in front of an open dialog, and an extension's question opens in front of
    its full window.
  - The External change prompt takes the keyboard and stays open with a reason when your choice
    cannot be saved.
  - The write allowance notice goes once no refused change is waiting.
  - A Template that ends with an empty bullet keeps the bullet.
  - **Code block** on a line of spaces leaves no spaces behind, and the table removal rows of the
    Command Menu show their icons.
- Updated dependencies.

### Headless Client

- **`read_task` lists the task's images and files** in `assets`, and the instructions tell the
  agent to look at them with `read_asset`, and to leave a task's status alone unless you ask.
- **Free tags.** `tasks` and `read_task` list a task's free tags in `freeTags`.
- **Task references start `etherpk:`.** The tools return references in the form **Copy task
  reference** writes, and still read the web addresses copied before.
- **`set_task` changes the tasks nested under a task,** as the Client does. The result lists each
  changed line in `nested`.
- **Test and Archived task states.** `tasks` and `set_task` take the `test` and `archived`
  statuses.
- **Templates:** the day variables give a link and `{{today}}` works, in `create_page` and
  `append_document`, and a Template's last empty bullet is kept.
- **Renaming a page moves everyone's favourites and bookmarks** to the new name on a synced graph.
- **Fixes.**
  - `edit_document` and `append_document` keep the nesting of text that starts on an indented
    line. Before, its first bullet moved to the top level and the lines under it moved with it.
    Lines written inside a code block are left as they are.
- Updated dependencies.

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
  (GitHub Pages, Cloudflare, Netlify) deploys it. You create a GitHub token on GitHub with the
  Contents permission and paste it once, in a GitHub section at the top of the tab, and it follows
  you to your other devices through your account. **Save and check** tests the token against the
  repository, and offers **Create branch** when the branch isn't there yet. The first publish to a
  branch that already holds other files lists them and asks first. Alt+Shift+P publishes to the
  repository too.
- **Install app.** EtherPK offers to install itself as an app from a button in the header (on a
  desktop, while Chrome or Edge offers its install dialog), a row in the phone's header menu, the
  account menu, **Install EtherPK** in the Command Menu and **Settings > Install**. Where the
  browser has no install dialog of its own, the **Install EtherPK** dialog gives the steps for that
  browser: the Share sheet on an iPhone or iPad, Add to Dock in Safari on a Mac, and Add tab to
  taskbar in Firefox on Windows.
- **Install offers.** EtherPK offers the install once at a few moments where it helps: on an
  iPhone or iPad before you sign in, when the browser has cleared some of EtherPK's data, on the
  folder access screen on a desktop, and in Quick notes on Android and ChromeOS. Each offer is
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
  Google Gemini, OpenRouter, a model on your device (Ollama, LM Studio) or another
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
  with the cursor on it, on a desktop and a phone. A new line you leave without typing on is taken
  out again, and a journal entry or page that has not been created yet is created only once you
  type on it.
- **Typing a slash command in a new journal entry or page** no longer creates it on its own. It is
  created once the command or your typing adds text, so `/Agent` leaves a new day as it was.
- **Agent Setup Code.** The one-time code that signs in an agent's device is called an Agent Setup
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
- **EtherPK can reach a model server on your own device** over plain HTTP at `localhost` or
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

- **A site needs a folder of its own.** **Choose folder…** on the Publish tab refuses a folder
  graph's folder, a Local Mirror's folder, a folder inside one and a folder that holds one, and
  says why: a publish removes the files it did not write from its folder. A folder chosen earlier
  is checked again before each publish.
- **Settings → Agents shows the agent skill**, with its install command and a copy button, for
  local and synced graphs alike.
- **The `AGENTS.md` in a folder graph's folder** now says that a journal entry can carry
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
  `/graph/<where>/<name>/kanban`. Open it from the sidebar's Graph Kanban button or **Graph Kanban** in the
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
- **The notice that the write allowance was reached goes once no refused change is waiting.** When
  a refused change was dropped because the page had been deleted and started again elsewhere, the
  notice stayed while another page's change was still being sent.
- **Code block on a line of only spaces leaves no spaces behind.** The spaces used to stay after the
  closing fence.
- **The table removal rows of the Command Menu show their icons.** Remove rows above, Remove rows
  below, Remove columns right and Remove columns left drew a dot.
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
  **Access tokens** page, which creates the code.
- **Reset Encryption Keys** on a custom server finishes on the server's own **Reset Encryption
  Keys** page, after a recent sign-in there. The dialog finishes the reset on the device by itself
  once it is done. It also says that the reset signs out every agent.
- Settings opens when its button is clicked while a graph is still opening. Before, a click in
  that moment could be lost.

### Headless Client

- `login --code <setup code>` signs a device in with a one-time setup code. The device gets an
  agent token of its own, which can do only what the Headless Client needs and stops working after
  30 days without use.
- A token given to `login --pat` is swapped for an agent token and revoked. A login made by an
  earlier version is swapped the same way on its next run.
- The token and the Encryption Keys are kept in the macOS Keychain, or in a Linux desktop's keyring
  through `secret-tool`, where `login` can use one, and in the config file otherwise. The config
  file is replaced whole when it changes, so a crash or a full disk part way through leaves the
  previous file.
- `logout` revokes the device's token on the Sync Server.
- Several agents can use one graph at once. The first agent's `serve` starts a background process
  that holds the graph, and every other `serve` passes its requests to that process. `running`
  lists these processes and `stop` ends them. `ETHERPK_MCP_HOST_IDLE_SECONDS` sets how long one
  stays after its last agent has gone, five minutes by default.
- An agent's session starts before a large graph has finished opening, and each tool waits for the
  graph.
- When a graph cannot be served, for example on a device that is not logged in, `serve` stays
  connected and every tool answers with the reason. A later call tries again.
- `publish` runs in the graph's background process when one is running.
