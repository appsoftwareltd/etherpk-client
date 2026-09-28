/**
 * The release-stage badge beside the EtherPK mark in the shared application header, so one
 * value covers the Client, the Sync Server and Corporate.
 *
 * Hidden until beta testing opens; set `visible` to true to show it. The e2e suites read this
 * same value, so switching it needs no test edits.
 */
export interface ReleaseStageBadge {
    /** The stage word. The header draws it upper case; screen readers get it as written. */
    readonly label: string
    readonly visible: boolean
}

export const releaseStageBadge: ReleaseStageBadge = {
    label: 'Beta',
    visible: false,
}
