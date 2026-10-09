/**
 * Rows an extension adds to the Client's menus. A row runs a Command, so every row is reachable
 * from code, keybindings and other menus as well.
 */

/**
 * A document, reached from its tab, a Favourite, Recents or an All Documents row.
 *
 * @beta
 */
export interface DocumentMenuTarget {
    /** Where the menu was raised: the document's tab, or a row naming it. */
    kind: 'document-tab' | 'favourite' | 'recent' | 'document-row'
    /** The concept the document is about. */
    concept: string
    /** The panel it is open in, when the target is a tab. */
    panelId?: string
    /** The tab is a row in a vertical list, as a phone draws its open documents. */
    vertical?: boolean
}

/**
 * A tab that is not a document's.
 *
 * @beta
 */
export interface TabMenuTarget {
    /** Any tab that is not a document's. */
    kind: 'tab'
    /** The panel the tab belongs to. */
    panelId: string
    /** The tab is a row in a vertical list, as a phone draws its open documents. */
    vertical?: boolean
}

/**
 * A wikilink in an editor.
 *
 * @beta
 */
export interface WikilinkMenuTarget {
    /** A wikilink in an editor. */
    kind: 'wikilink'
    /** The concept the link names. */
    concept: string
    /** The editor's panel. */
    panelId?: string
}

/**
 * A thing an extension raises a menu on, of a kind the extension names under its own id
 * (`kanban.card`). Only rows that check for that kind apply to it.
 *
 * @beta
 */
export interface ExtensionMenuTarget {
    /** `<extension id>.<name>`. */
    kind: `${string}.${string}`
    /** Whatever the extension's own rows need to know about the thing. */
    [field: string]: unknown
}

/**
 * What a Context Menu can be raised on that an extension may add rows to. The Client also raises
 * menus on things this list does not name, an Asset or a misspelt word, so a row's `when` answers
 * false for any kind it does not check for.
 *
 * @beta
 */
export type MenuTarget = DocumentMenuTarget | TabMenuTarget | WikilinkMenuTarget | ExtensionMenuTarget

/**
 * One Context Menu row.
 *
 * @beta
 */
export interface ContextMenuItem {
    /** Under the extension's id: `graph-view.showConcept`. */
    id: string
    /** The row's text, which may read the target. */
    label: string | ((target: MenuTarget) => string)
    /** Lower sorts earlier. Rows with equal values keep the order they were added in. */
    order?: number
    /** The Command the row runs, given the target. */
    command: string
    /** An icon drawn left of the label: the extension's own or one of the Client's. */
    icon?: string
    /** A separator above the row. */
    separatorBefore?: boolean | ((target: MenuTarget) => boolean)
    /** Whether the row applies to a target. Absent means every target. */
    when?: (target: MenuTarget) => boolean
}

/**
 * What a Command Menu row's `when` may read about the editor it was opened in.
 *
 * @beta
 */
export interface CommandMenuContext {
    /** The caret is in a table. */
    inTable: boolean
    /** A table may be inserted at the caret. */
    tableInsertable: boolean
    /** The document's body may be written: false in a locked Protected Document. */
    bodyWritable: boolean
    /**
     * The document is a Protected Document, locked or not: where a row whose widget draws no
     * protected content, such as `/map`, is not offered. Absent reads as false.
     */
    protectedDocument?: boolean
    /**
     * The concepts a View about one concept can be opened for from the caret, nearest first: the
     * caret line's links, the links above it in the outline, the document's own concept, then the
     * scopes in its name. Names are as written, an alias as the alias. Worked out only when a row
     * reads it. Absent reads as none.
     */
    readonly conceptsAtCaret?: readonly string[]
}

/**
 * One row of the Command Menu, the menu `/` opens in the editor.
 *
 * @beta
 */
export interface CommandMenuItem {
    /** Under the extension's id. */
    id: string
    /** The row's text. */
    title: string
    /**
     * A line under the title, or a function that works it out from the editor the menu opened in,
     * each time the menu opens. A function that throws shows no line.
     */
    detail?: string | ((context: CommandMenuContext) => string | undefined)
    /** An icon drawn before the title: the extension's own or one of the Client's. */
    icon?: string
    /** Rows are grouped under this heading. */
    group?: string
    /** Lower sorts earlier within the group. */
    order?: number
    /** More words the menu's filter matches. */
    keywords?: string[]
    /** Whether the row is offered here. Absent means everywhere. */
    when?: (context: CommandMenuContext) => boolean
    /** The Command the row runs. */
    command: string
    /** What the Command is given. */
    args?: unknown
}

/**
 * A button in the Graph Sidebar, under Today's journal: a way in to what the extension shows for
 * the whole graph, such as the Graph Map View. Pressing it runs `command`.
 *
 * @beta
 */
export interface GraphSidebarButton {
    /** Under the extension's id. */
    id: string
    /** The button's text. */
    title: string
    /** An icon drawn before the title: the extension's own or one of the Client's. */
    icon?: string
    /** Lower lists earlier. A button without one lists after every button that has one. */
    order?: number
    /** The Command the button runs. */
    command: string
    /** What the Command is given. */
    args?: unknown
}
