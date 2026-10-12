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
 * Dialogs.
 *
 * @public
 */
export interface ExtensionDialogs {
    /** Ask for one line of text. Resolves to the text, trimmed, or undefined when it was cancelled. */
    prompt(options: PromptOptions): Promise<string | undefined>
}
