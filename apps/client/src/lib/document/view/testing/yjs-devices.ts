/**
 * Two headless editors joined through Yjs the way y-codemirror.next joins a synced editor to its
 * `Y.Text` (`y-sync.js`), for property tests of what a peer's edits do on this device. A local
 * transaction's changes are written into the Y.Text; the update waits in the device's outbox until
 * the test delivers it, so holding updates back makes edits concurrent; and the other side's
 * observer turns the Y.Text delta back into one CodeMirror transaction, as the live editor's does.
 * Used by `augmentations/outline-folds.property.test.ts`.
 */

import { type ChangeSpec, Transaction } from '@codemirror/state'
import * as Y from 'yjs'

import { editorFixture, type HeadlessEditor } from './editor-state-fixture'

/** Marks a transaction that came from the other side, so it is not written back. */
const fromPeer = Transaction.remote

/**
 * One device: a headless editor bound to a Y.Text as y-codemirror.next binds a synced editor, and the
 * updates its document has made that the other device has not had yet.
 */
export class Device {
    readonly ydoc = new Y.Doc()
    readonly ytext = this.ydoc.getText('doc')
    readonly outbox: Uint8Array[] = []
    readonly editor: HeadlessEditor

    constructor(text: string) {
        this.editor = editorFixture('|' + text)
        this.ytext.insert(0, text)
        this.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
            if (origin !== 'remote') this.outbox.push(update)
        })
        // A local transaction's changes go into the Y.Text (y-sync.js `update`).
        const dispatch = this.editor.dispatch
        this.editor.dispatch = (tr) => {
            dispatch(tr)
            if (!tr.docChanged || tr.annotation(fromPeer)) return
            this.ydoc.transact(() => {
                let adj = 0
                tr.changes.iterChanges((fromA, toA, _fromB, _toB, insert) => {
                    const text = insert.sliceString(0, insert.length, '\n')
                    if (fromA !== toA) this.ytext.delete(fromA + adj, toA - fromA)
                    if (text.length > 0) this.ytext.insert(fromA + adj, text)
                    adj += text.length - (toA - fromA)
                })
            }, 'local')
        }
        // The other side's changes come back as one transaction (y-sync.js `_observer`).
        this.ytext.observe((event, ytr) => {
            if (ytr.origin !== 'remote') return
            const changes: ChangeSpec[] = []
            let pos = 0
            for (const d of event.delta) {
                if (d.insert != null) changes.push({ from: pos, to: pos, insert: d.insert as string })
                else if (d.delete != null) {
                    changes.push({ from: pos, to: pos + d.delete, insert: '' })
                    pos += d.delete
                } else pos += d.retain ?? 0
            }
            this.editor.dispatch(this.editor.state.update({ changes, annotations: fromPeer.of(true) }))
        })
    }

    /** Send this device's pending updates to `other`. */
    deliverTo(other: Device): void {
        for (const update of this.outbox.splice(0)) Y.applyUpdate(other.ydoc, update, 'remote')
    }
}

/** Two devices on one document, both starting from the same Y.Doc state. */
export function pair(text: string): [Device, Device] {
    const a = new Device(text)
    const b = new Device('')
    // b starts empty and takes a's history, so both share the one insert of the starting text.
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc), 'remote')
    a.outbox.length = 0
    return [a, b]
}

