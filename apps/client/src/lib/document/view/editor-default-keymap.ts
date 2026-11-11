/**
 * CodeMirror's default keymap as the document editor binds it, under the outliner's keys
 * (cm-document.ts): every binding except the two that toggle a comment.
 *
 * `defaultKeymap` binds `Mod-/` to `toggleComment` and `Alt-A` (Shift+Alt+A) to
 * `toggleBlockComment`, and the markdown language gives both `<!--` and `-->` to write. An HTML
 * comment is no part of the document format, and `Mod+/` is the workspace's key for the Keyboard
 * Shortcuts card (keyboard-shortcuts.ts), bound on the window: with CodeMirror's binding in place
 * the one press opened the card and wrapped the caret's line in a comment as well. Left unbound
 * here, the editor does not handle either chord, so `Mod+/` reaches the window alone.
 *
 * The bindings are dropped by the command they run, not by key name, so a chord CodeMirror renames
 * or adds for the same commands goes with them (Editor Content Rules.md → Standard prose).
 */

import { defaultKeymap, toggleBlockComment, toggleComment } from '@codemirror/commands'
import type { KeyBinding } from '@codemirror/view'

/** The commands that write comment markers into the document. */
const COMMENT_COMMANDS: ReadonlySet<KeyBinding['run']> = new Set([toggleComment, toggleBlockComment])

export const editorDefaultKeymap: readonly KeyBinding[] = defaultKeymap.filter((binding) => !COMMENT_COMMANDS.has(binding.run))
