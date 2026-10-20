/**
 * What an extension may do in the document editor: draw a widget over its own kind of fenced block,
 * and put a block at the caret.
 *
 * A widget never sees the editor. It is told the fence's body as lines of text and asks for changes
 * to those lines, which the Client writes as ordinary editor changes: undone with the editor's undo,
 * synced and merged like typing, and refused where the document cannot be written.
 */

/**
 * One change to a fence's body, by line number from 0. A replacement or a removal names the text the
 * widget last read on that line, and applies only while the line still says it, so a widget acting on
 * an old reading never lands on someone else's edit.
 *
 * @public
 */
export type FenceEdit =
    | { kind: 'insert'; line: number; text: string }
    | { kind: 'replace'; line: number; expect: string; text: string }
    | { kind: 'remove'; line: number; expect: string }

/**
 * What a widget is told about its fence.
 *
 * @public
 */
export interface FenceInfo {
    /** The fence's info word, the one the widget was registered for. */
    readonly info: string
    /** The fence's body: its lines between the fences, less their indentation. */
    readonly body: readonly string[]
    /** The document the fence is in, by its concept, or null outside a workspace. */
    readonly document: string | null
    /**
     * How many fences with this info word come before this one in the document. It changes when one
     * is added or removed above, so it keys only what lasts a moment.
     */
    readonly ordinal: number
}

/**
 * Where a widget is drawn: in the document, in a tab of its own, or filling the EtherPK window.
 *
 * @public
 */
export type FencePresentation = 'inline' | 'tab' | 'window'

/**
 * What a mounted widget can see and ask for.
 *
 * @public
 */
export interface FenceContext extends FenceInfo {
    /** Whether the document accepts the widget's changes now: not read-only, not locked. */
    readonly writable: boolean
    /** Whether the dark theme shows. */
    readonly dark: boolean
    /**
     * Whether anyone can see the widget: false while its tab is behind another, its Pane is collapsed
     * or the browser tab is hidden. A widget holding something costly lets it go while this is false.
     */
    readonly onScreen: boolean
    /** Where the widget is drawn. */
    readonly presentation: FencePresentation
    /**
     * Change the body, as one undoable change: one edit, or several applied together. False when it
     * was refused (the document cannot be written, the fence is gone, or a line no longer says what an
     * edit expects), and then nothing changed. The widget hears the current body in an `update`.
     */
    edit(change: FenceEdit | readonly FenceEdit[]): boolean
    /** Show the fence's text in the editor, with the caret on its first body line. */
    editAsText(): void
    /** Delete the fence, as one undoable change. False when it was refused. */
    remove(): boolean
    /** The widget's height changed: the editor asks `height` again. */
    resized(): void
    /**
     * True once, when the widget is to take the keyboard: for the widget of a fence `insertBlock` put
     * in with `focus`, and for a widget drawn in a tab or over the window as it opens. False otherwise.
     */
    takeFocus(): boolean
    /**
     * Open the fence in a tab of its own, which draws the same widget with `presentation` `tab`. Only
     * for a fence the registration can `identify`.
     */
    openInTab(): void
    /**
     * Draw the widget again over the whole EtherPK window, with `presentation` `window`, and a Return
     * button the Client draws. Only for a fence the registration can `identify`.
     */
    openWindow(): void
    /** Close the window this widget fills. Does nothing for a widget drawn elsewhere. */
    closeWindow(): void
}

/**
 * A widget the extension has drawn, as the Client drives it.
 *
 * @public
 */
export interface MountedFence {
    /** The body, the theme, whether it can be written or whether it is on screen changed. */
    update(context: FenceContext): void
    /** The widget leaves: scrolled far away, its fence deleted, its tab or the editor closed. */
    destroy(): void
}

/**
 * What an extension registers for one info word.
 *
 * @public
 */
export interface FenceWidget {
    /**
     * The widget's height in CSS pixels, before and after it mounts. The editor reserves it so the
     * lines below never move while the widget loads. It is asked again after `resized`. Not asked for
     * a widget in a tab or a window, which fills what it is given.
     */
    height(info: FenceInfo): number
    /** Draw the widget into `host`, which the Client owns and places. */
    mount(host: HTMLElement, context: FenceContext): MountedFence
}

/**
 * A fence as the publisher hands it to the extension: already public content.
 *
 * @public
 */
export interface PublishFenceRequest {
    /** The fence's info word. */
    readonly info: string
    /** The fence's body lines. */
    readonly body: readonly string[]
    /** The document being published, by its concept. */
    readonly document: string
}

/**
 * How a published site shows a fence: a picture the site keeps, or a link with an optional picture
 * from the web. The publisher writes the HTML, so an extension never writes markup into a site.
 *
 * @public
 */
export type PublishedFence =
    | {
          kind: 'picture'
          /** The picture's type. */
          type: 'image/svg+xml' | 'image/png' | 'image/webp'
          /** The picture's bytes, written into the site as a file of its own. */
          bytes: Uint8Array
          width: number
          height: number
          /** What the picture shows, for anyone who cannot see it. */
          alt: string
      }
    | {
          kind: 'link'
          /** Where the link goes: an `https` address. */
          href: string
          /** The link's text. */
          text: string
          /** A picture from the web shown in the link: an `https` address. */
          image?: { src: string; alt: string; width?: number; height?: number }
      }

/**
 * A fence as the Client hands it to the extension to quote it read-only: in the Backlinks panel and in
 * the backlinks under a document, where a reference's block holds the fence.
 *
 * @public
 */
export interface QuoteFenceRequest {
    /** The fence's info word. */
    readonly info: string
    /** The fence's body lines. */
    readonly body: readonly string[]
    /** The document the fence is in, by its concept. */
    readonly document: string
    /** Whether the dark theme shows: a picture is drawn for it. */
    readonly dark: boolean
}

/**
 * Options for a fence registration.
 *
 * @public
 */
export interface FenceOptions {
    /**
     * A short name for what the fence holds, such as "Drawing": a tab's title and the full window's
     * heading start with it.
     */
    title?: string
    /**
     * What text pasted as plain text on an empty line or bullet becomes: the body lines of a fence of
     * this kind, or null to leave the paste as it is. A link to a video, say, gives the link as the
     * one line. The text is the clipboard's own, untrimmed. The Client asks each registration in
     * turn, and the first that answers takes the paste. Mod+Z straight after it gives back the
     * text that was pasted.
     *
     * The lines are written inside the fence as they are, except that a line which would end the
     * fence, or start another, is changed so it cannot. A line break inside a line splits it in two.
     */
    fromPaste?(text: string): readonly string[] | null
    /**
     * How a published site shows the fence, or null to leave it out. Called only for public content,
     * in a publish run in the browser. Where it is not called (the Headless Client, or the extension
     * off), an Extension Fence is left out and an ordinary fence is published as code.
     */
    publish?(fence: PublishFenceRequest): PublishedFence | null | Promise<PublishedFence | null>
    /**
     * How a read-only quote of the fence shows it, such as a reference in the Backlinks panel: a
     * picture, drawn in the theme asked for, or a link. Null, or no `quote`, shows what the quote
     * shows without the extension: an ordinary fence's text as code, and for an Extension Fence a note
     * naming the extension. The Client never mounts the widget in a quote.
     *
     * Called as a quote shows the fence, and again when its text, the theme or one of the extension's
     * own settings changes. The Client keeps the last answers it was given, so a reference shown
     * again does not ask again, and it treats an answer that takes more than 30 seconds as a failure.
     * A link's picture is loaded from the web as the quote shows it, so give one only where the
     * person has agreed to that, as a setting for thumbnails does. An SVG picture is cleaned first, as
     * one for a published site is.
     */
    quote?(fence: QuoteFenceRequest): PublishedFence | null | Promise<PublishedFence | null>
    /**
     * The fence's own id, read from its body, or null. A fence with an id can be opened in a tab or a
     * window, where the Client finds it again by the id after every change.
     */
    identify?(body: readonly string[]): string | null
    /**
     * True when the widget keeps its own undo: Mod+Z and Mod+Y pressed inside it are its own, rather
     * than the editor's.
     */
    keepsHistory?: boolean
}

/**
 * A panel an extension draws in a document, beneath one of its lines, which is not part of the
 * document's text: nothing of it is saved, synced or seen on another device (ADR 0147).
 *
 * The panel follows its line as the document changes, here or on another device, and moves with
 * the editor when the editor is rebuilt (a Draft becoming a document, say). It closes when the
 * person closes it, or when the document's editor closes for good: the panel lasts for the visit.
 *
 * @public
 */
export interface InlinePanel {
    /** The document the panel is in, by its concept. */
    readonly document: string | null
    /** False once the panel has closed. */
    readonly isOpen: boolean
    /**
     * Put a block at the panel's line, by the rule {@link ExtensionEditor.insertBlock} follows at the
     * caret: an empty line is replaced, an empty bullet takes an outline's place at its own
     * indentation (or any other block as its content), and after any other line the block goes on new
     * lines beneath at the line's content column. Beneath a bullet with text it goes in as the
     * bullet's first child, after the bullet's own lines and at its children's indentation. The panel
     * then sits beneath the block, and the next block goes after it at the indentation of its first
     * line. One undoable change. False where nothing was put in: the panel is closed, its editor has
     * closed, its line is now in the frontmatter, a fenced block or a table, or the block would
     * rearrange the outline around it (an indented heading, say, or a blank line that ends a branch).
     */
    insertBlock(text: string): boolean
    /** Bring the panel into view. */
    focus(): void
    /**
     * Give the panel a new height in CSS pixels, which its content scrolls inside: the lines below
     * it move once. Grow it when there is more to show, rather than on every change.
     */
    resize(height: number): void
    /**
     * The outline around the panel's line, as the document writes it: the line's ancestors, each its
     * own lines without its other children, and its siblings with their branches, the line's own
     * branch among them while the line has text. A block the panel put in is left out. Null when
     * the line is not a bullet, or the panel is closed or under the document's last line.
     */
    outline(): string | null
    /**
     * The text of the bullet the panel opened on, as it was when the panel opened: without its
     * bullet marker or a task's box, its continuation lines joined with line breaks. Null when the
     * panel opened on an empty bullet, on a line that is not a bullet, or under the document's last
     * line. An Agent Chat opened with `/Agent` on a line with text starts with this as its prompt.
     *
     * @beta
     */
    lineText(): string | null
    /** Close the panel. Its `onClose` is told. */
    close(): void
}

/**
 * What an inline panel is drawn with.
 *
 * @public
 */
export interface InlinePanelOptions {
    /**
     * The panel's height in CSS pixels, which its content scrolls inside, so the lines below never
     * move as its content grows. {@link InlinePanel.resize} changes it.
     */
    height?: number
    /**
     * Draw the panel into `host`, which the Client owns and places. Called once, when the panel is
     * first drawn: the host keeps its content while the panel is scrolled out of view and when the
     * editor is rebuilt, and `destroy` is called when the panel closes. Events inside the host are
     * the panel's own: the editor neither types nor moves its caret for them, but Mod+Z and Mod+Y
     * outside a text field undo and redo in the document.
     */
    mount(host: HTMLElement, panel: InlinePanel): { destroy(): void }
    /** Told once, when the panel closes for any reason. */
    onClose?(): void
}

/**
 * The document editor, as far as an extension may reach it.
 *
 * @public
 */
export interface ExtensionEditor {
    /**
     * Draw `widget` over every complete fence whose info word is `info`. The word is the extension's
     * id (an ordinary fence, whose text stays text) or `<id>.<name>` (an Extension Fence, whose body
     * is the extension's data and never searched or shown as text). Throws for any other word, or one
     * that is taken.
     *
     * An extension listed in the Extension Directory may not have an id that is one of the words the
     * Client draws blocks for itself: `map`, `math`, `mermaid` and `etherpk-cipher`.
     */
    registerFence(info: string, widget: FenceWidget, options?: FenceOptions): () => void
    /**
     * Put a block at the caret of the editor the person is working in, as a code block or a table
     * goes in: an empty bullet takes it as its content, an empty line is replaced, and after any other
     * line it goes on new lines beneath at the line's content column. `text` is the block's lines
     * without indentation. A blank line inside the block takes the indentation of the line after it,
     * so the block stays one branch. A block that is a fence leaves the caret outside it, and with
     * `focus` its widget is told to `takeFocus`. False where nothing was put in: no editor, a body
     * that cannot be written, a caret in the frontmatter, a fence or a table, or a block that would
     * rearrange the outline around it.
     */
    insertBlock(text: string, options?: { focus?: boolean }): boolean
    /**
     * Draw a panel beneath the caret's line in the editor the person is working in, from where the
     * line's text starts, or beside the dot of an empty bullet, as a code block opened there is. With
     * `at` `end`, it is drawn beneath the document's last line, at the editor's left edge, a line's
     * height clear of it. With `caret-or-end`, at the caret while the person is typing in the
     * document (the editor has the keyboard, as a Command Bar button leaves it), else at the end: for
     * a button pressed from outside the text. Null where no panel can go: no editor, a Protected
     * Document, or a caret in the frontmatter, a fenced block or a table.
     */
    openPanel(options: InlinePanelOptions & { at?: 'caret' | 'end' | 'caret-or-end' }): InlinePanel | null
}
