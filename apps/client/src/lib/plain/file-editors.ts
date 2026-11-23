/**
 * Which editor a file of a [[Plain Folder]] opens in (ADR 0204).
 *
 * A markdown file opens in the **Markdown Editor**, the one a graph uses, or in the **Text
 * Editor**, which shows its source as a code editor does. The person chooses: a default for every
 * markdown file, which is theirs and not the folder's (it goes where their settings go, ADR 0134),
 * and another for one file, remembered on this device. A file put back on the default follows the
 * default again. Any other text has only the Text Editor: the Markdown Editor would read a
 * script's dashes as bullets.
 *
 * Nothing here is written to the folder (ADR 0197): which editor a person reads a file in is no
 * business of the next person to open it.
 */
import type { PersonSettings } from '../person-settings/person-settings'

import { fileKindOf } from './file-kind'
import { type TrustStorage } from './remote-images'

export type FileEditor = 'markdown' | 'text'

/** What each editor is called, wherever it is named. */
export const FILE_EDITOR_NAMES: Readonly<Record<FileEditor, string>> = { markdown: 'Markdown Editor', text: 'Text Editor' }

/** The person's setting the default is kept under: absent for the Markdown Editor. */
export const MARKDOWN_EDITOR_SETTING = 'files.markdown-editor'

/** How many files' choices are kept for one folder; the oldest go first. */
const MAX_CHOICES = 500

const BOTH: readonly FileEditor[] = ['markdown', 'text']
const TEXT_ONLY: readonly FileEditor[] = ['text']

const storageKey = (folderId: string) => `etherpk-plain-editors:${folderId}`
const isFileEditor = (value: unknown): value is FileEditor => value === 'markdown' || value === 'text'
const isMarkdown = (path: string) => fileKindOf(path) === 'markdown'
const isUnder = (path: string, at: string) => path === at || path.startsWith(`${at}/`)

export interface FileEditors {
    /** The editor the file at `path` opens in. */
    editorOf(path: string): FileEditor
    /** The editors the file at `path` can open in. One, unless it is markdown. */
    choices(path: string): readonly FileEditor[]
    /** The editor a markdown file opens in when none was chosen for it. */
    defaultEditor(): FileEditor
    /** Open the file at `path` in `editor` from now on, on this device. */
    choose(path: string, editor: FileEditor): void
    /** Open every markdown file without an editor of its own in `editor`. */
    setDefault(editor: FileEditor): void
    /** A file or a directory moved: the choices for what is there follow. */
    moved(from: string, to: string): void
    /** A file or a directory was removed, and its choices go with it. */
    removed(path: string): void
    /** Called when an answer may have changed. */
    subscribe(listener: () => void): () => void
    dispose(): void
}

export interface FileEditorsOptions {
    folderId: string
    settings: Pick<PersonSettings, 'get' | 'set' | 'subscribe'>
    storage: TrustStorage
}

/** The default, as the person's settings hold it. A value this version does not know is the default. */
export function defaultFileEditor(settings: Pick<PersonSettings, 'get'>): FileEditor {
    const kept = settings.get(MARKDOWN_EDITOR_SETTING)
    return isFileEditor(kept) ? kept : 'markdown'
}

/** Keep the default. The Markdown Editor is kept by clearing the setting. */
export function setDefaultFileEditor(settings: Pick<PersonSettings, 'set'>, editor: FileEditor): void {
    settings.set(MARKDOWN_EDITOR_SETTING, editor === 'markdown' ? null : editor)
}

export function createFileEditors({ folderId, settings, storage }: FileEditorsOptions): FileEditors {
    const listeners = new Set<() => void>()
    const tell = () => {
        for (const listener of [...listeners]) listener()
    }

    /** The choices storage holds, or null where it cannot be read. */
    function read(): Map<string, FileEditor> | null {
        try {
            const parsed: unknown = JSON.parse(storage.getItem(storageKey(folderId)) ?? '{}')
            const entries = typeof parsed === 'object' && parsed !== null ? Object.entries(parsed) : []
            return new Map(entries.filter((entry): entry is [string, FileEditor] => isFileEditor(entry[1])))
        } catch {
            return null
        }
    }

    // Held here too, so a choice stands for the visit where storage refuses it (private mode).
    let chosen = read() ?? new Map<string, FileEditor>()
    let refused = false

    /**
     * Change the choices and keep them. Read again first, so a choice made meanwhile in another tab
     * on the folder is kept beside this one, unless storage does not hold this tab's own.
     */
    function change(edit: (choices: Map<string, FileEditor>) => void): void {
        const before = JSON.stringify([...chosen])
        const next = (refused ? null : read()) ?? new Map(chosen)
        edit(next)
        for (const path of [...next.keys()].slice(0, Math.max(0, next.size - MAX_CHOICES))) next.delete(path)
        if (JSON.stringify([...next]) === before) return
        chosen = next
        try {
            if (next.size === 0) storage.removeItem(storageKey(folderId))
            else storage.setItem(storageKey(folderId), JSON.stringify(Object.fromEntries(next)))
            refused = false
        } catch {
            refused = true
        }
        tell()
    }

    const defaultEditor = () => defaultFileEditor(settings)
    let heardDefault = defaultEditor()
    const stop = settings.subscribe(() => {
        const now = defaultEditor()
        if (now === heardDefault) return
        heardDefault = now
        tell()
    })

    return {
        editorOf: (path) => (isMarkdown(path) ? (chosen.get(path) ?? defaultEditor()) : 'text'),
        choices: (path) => (isMarkdown(path) ? BOTH : TEXT_ONLY),
        defaultEditor,
        choose(path, editor) {
            if (!isMarkdown(path)) return
            change((choices) => {
                choices.delete(path)
                if (editor !== defaultEditor()) choices.set(path, editor)
            })
        },
        setDefault: (editor) => setDefaultFileEditor(settings, editor),
        moved(from, to) {
            change((choices) => {
                const followed = [...choices].filter(([path]) => isUnder(path, from))
                // What was at the destination is what the move replaced.
                for (const path of [...choices.keys()]) if (isUnder(path, from) || isUnder(path, to)) choices.delete(path)
                for (const [path, editor] of followed) choices.set(to + path.slice(from.length), editor)
            })
        },
        removed(path) {
            change((choices) => {
                for (const each of [...choices.keys()]) if (isUnder(each, path)) choices.delete(each)
            })
        },
        subscribe(listener) {
            listeners.add(listener)
            return () => void listeners.delete(listener)
        },
        dispose() {
            stop()
            listeners.clear()
        },
    }
}

/** Forget a folder's choices: when the folder itself is forgotten on this device. */
export function forgetFileEditors(folderId: string, storage: TrustStorage): void {
    try {
        storage.removeItem(storageKey(folderId))
    } catch {
        // Nothing to forget.
    }
}
