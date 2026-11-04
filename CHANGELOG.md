# Changelog

What changed in each release of the EtherPK Client and the Headless Client
([`@appsoftwareltd/etherpk-mcp`](https://www.npmjs.com/package/@appsoftwareltd/etherpk-mcp) on npm).
They are released together, under the version number they share with the Sync Server. This log
starts at 0.9.3.

## Unreleased

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
  **Remove all** has **Undo**. On a local graph bookmarks are kept in `etherpk/bookmarks.json`.
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
