/**
 * Dialogs the Client draws for an extension, so every extension's questions look and behave like the
 * Client's own: the keyboard stays inside while one is open, Enter answers, Esc cancels, and the
 * keyboard returns where it was when one closes. Each dialog names the extension that asks, and
 * shows every string it is given as plain text, never as markup. The calendar `pickDate` opens is
 * drawn beside the extension's own element rather than over the page, so it names nobody.
 */

/**
 * A question with one line of text for an answer.
 *
 * @public
 */
export interface PromptOptions {
    /** The dialog's heading. */
    title: string
    /** The text field's label. */
    label: string
    /** Example text shown in the empty field. */
    placeholder?: string
    /** The field's text when the dialog opens. */
    value?: string
    /** The button that answers. "OK" when left out. */
    submitLabel?: string
    /**
     * Checks the answer when it is given: a message saying what is wrong, shown at the field, or
     * undefined when it is fine. The dialog stays open, with the text kept, until it is fine.
     */
    validate?(value: string): string | undefined
}

/**
 * One of the answers a {@link ChooseOptions} question offers.
 *
 * @public
 */
export interface ChooseChoice {
    /** What `choose` resolves to when this answer is picked. */
    value: string
    /** What the dropdown shows for it. */
    label: string
}

/**
 * A question answered by picking one of a list of answers from a dropdown and confirming it.
 *
 * @public
 */
export interface ChooseOptions {
    /** The dialog's heading. */
    title: string
    /** A sentence above the dropdown saying what confirming will do. */
    message?: string
    /** The dropdown's label. */
    label: string
    /** The answers, in the order the dropdown lists them. At least one. */
    choices: ChooseChoice[]
    /** The value of the answer picked when the dialog opens. The first answer when left out. */
    value?: string
    /**
     * The button that confirms: its words, or a function giving its words for the answer picked,
     * so it can say what it will do ("Move 3 tasks to Done"). "OK" when left out.
     */
    submitLabel?: string | ((value: string) => string)
}

/**
 * A day to pick from the Client's calendar, the one the document editor's Date Picker shows.
 *
 * @public
 */
export interface PickDateOptions {
    /**
     * The element the calendar opens beside: below it, or above it where there is no room below.
     * The keyboard returns to it when a day is picked or the calendar is closed with Esc. The
     * calendar closes when the element leaves the page. Asking again with the same element while
     * its calendar is open closes the calendar, so a button that opens it also closes it.
     */
    anchor: HTMLElement
    /** The day the calendar opens on, `YYYY-MM-DD`. Today when left out, or when it names no day. */
    value?: string
    /** What a screen reader announces for the calendar ("Due date"). "Choose a date" when left out. */
    label?: string
}

/**
 * Dialogs.
 *
 * @public
 */
export interface ExtensionDialogs {
    /** Ask for one line of text. Resolves to the text, trimmed, or undefined when it was cancelled. */
    prompt(options: PromptOptions): Promise<string | undefined>
    /** Ask for one of a list of answers. Resolves to the value picked, or undefined when it was cancelled. */
    choose(options: ChooseOptions): Promise<string | undefined>
    /**
     * Ask for a day from the Client's calendar, opened beside `options.anchor`. Arrow keys move a
     * day or a week, Page Up and Page Down a month, Enter or a click picks, and Esc, Tab or a click
     * elsewhere closes it. Resolves to the day as `YYYY-MM-DD`, or undefined when it was closed
     * without one. One calendar is open at a time: asking for another closes the first.
     */
    pickDate(options: PickDateOptions): Promise<string | undefined>
}
