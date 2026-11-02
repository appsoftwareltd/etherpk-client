/**
 * Dialogs the Client draws for an extension, so every extension's questions look and behave like the
 * Client's own: the keyboard stays inside while one is open, Enter answers, Esc cancels, and the
 * keyboard returns where it was when one closes. Each dialog names the extension that asks, and
 * shows every string it is given as plain text, never as markup.
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
 * Dialogs.
 *
 * @public
 */
export interface ExtensionDialogs {
    /** Ask for one line of text. Resolves to the text, trimmed, or undefined when it was cancelled. */
    prompt(options: PromptOptions): Promise<string | undefined>
    /** Ask for one of a list of answers. Resolves to the value picked, or undefined when it was cancelled. */
    choose(options: ChooseOptions): Promise<string | undefined>
}
