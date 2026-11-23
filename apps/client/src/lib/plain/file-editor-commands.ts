/**
 * The Commands that choose which editor a file of a [[Plain Folder]] opens in (ADR 0204), and the
 * rows of the menu on the button that names it above the file (`ui/FileBar.svelte`).
 *
 * The menu lists the file's editors with the one in force ticked, then one row that changes the
 * default for every markdown file and names the change. A file with one editor has no rows.
 */
import { showNotice } from '#lib/activity/notices.js'

import { type CommandRegistry, type ContextMenuTarget, type ContributionRegistry, registerContextMenuItem } from '../surface'
import { FILE_EDITOR_NAMES, type FileEditor, type FileEditors } from './file-editors'
import { baseName } from './plain-path'

/** Put the file in front in its other editor. */
export const SWITCH_EDITOR = 'plain.switchEditor'
const MAKE_DEFAULT = 'plain.editor.makeDefault'
const commandFor = (editor: FileEditor) => `plain.editor.${editor}`

export interface FileEditorCommandDeps {
    editors: FileEditors
    /** The path of the file in front, or null. */
    activePath(): string | null
}

const other = (editor: FileEditor): FileEditor => (editor === 'markdown' ? 'text' : 'markdown')

/** The path a menu's target names, or null for any other argument. */
function pathOf(arg: unknown): string | null {
    const target = arg && typeof arg === 'object' ? (arg as ContextMenuTarget) : null
    return target?.kind === 'plain-editor' ? target.path : null
}

export function registerFileEditorCommands(commands: CommandRegistry, contributions: ContributionRegistry, { editors, activePath }: FileEditorCommandDeps): () => void {
    const offs: (() => void)[] = []
    const offersChoice = (target: ContextMenuTarget) => target.kind === 'plain-editor' && editors.choices(target.path).length > 1

    for (const [index, editor] of (['markdown', 'text'] as const).entries()) {
        offs.push(
            commands.register(commandFor(editor), (arg) => {
                const path = pathOf(arg) ?? activePath()
                if (path !== null) editors.choose(path, editor)
            }),
            registerContextMenuItem(contributions, {
                id: commandFor(editor),
                label: FILE_EDITOR_NAMES[editor],
                command: commandFor(editor),
                order: 10 + index,
                checked: (target) => editors.editorOf(pathOf(target) ?? '') === editor,
                when: offersChoice,
            }),
        )
    }
    offs.push(
        commands.register(MAKE_DEFAULT, () => editors.setDefault(other(editors.defaultEditor()))),
        registerContextMenuItem(contributions, {
            id: MAKE_DEFAULT,
            label: () => `Make ${FILE_EDITOR_NAMES[other(editors.defaultEditor())]} the default for markdown files`,
            command: MAKE_DEFAULT,
            order: 20,
            separatorBefore: true,
            when: offersChoice,
        }),
        commands.register(SWITCH_EDITOR, () => {
            const path = activePath()
            if (path === null) return
            if (editors.choices(path).length > 1) editors.choose(path, other(editors.editorOf(path)))
            else showNotice({ id: 'plain-editor', tone: 'info', text: `${baseName(path)} opens in the Text Editor only. A markdown file has a choice of editors.` })
        }),
    )
    return () => offs.forEach((off) => off())
}
