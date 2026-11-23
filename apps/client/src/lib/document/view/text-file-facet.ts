/**
 * Whether an editor is the **Text Editor** (text-file.ts): set over a text file that is not
 * markdown, and over a markdown file opened as text. In a file of its own so that the code that
 * asks (the shared analysis among it) does not load the editor's languages to ask.
 */
import { Facet } from '@codemirror/state'

/**
 * A Command that would write markdown (a bullet, a task box) reads it and acts on the lines as text
 * or does nothing instead.
 */
export const isTextFile = Facet.define<boolean, boolean>({ combine: (values) => values.some(Boolean) })
