/**
 * The addresses Built-in Extensions declare (ADR 0121), as the document URLs see them.
 *
 * The workspace hands over its extension host's address book as it starts, and `viewUrl` asks it
 * about every kind the Client does not address itself. Held here, rather than imported, so URL code
 * never loads an extension: an address book is built from manifests the workspace already read.
 */
import type { AddressBook } from '$lib/extensions/addresses'

let current: AddressBook | null = null

export function setExtensionAddresses(book: AddressBook | null): void {
    current = book
}

/** The address book, or null before a workspace has started. */
export function extensionAddresses(): AddressBook | null {
    return current
}
