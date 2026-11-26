/**
 * What released builds say on the sync socket, for tests of a build against the ones already in
 * people's hands. Add a release here when its wire contract differs from the last one listed.
 */
import { parseClientMessage, parseServerMessage } from './sync-protocol-0-51-0'
import recorded from './sync-messages-0-51-0.json'

export const release0510 = {
    /** How the 0.51.0 Sync Server reads what a Client sends. Strict: it refuses what it does not know. */
    serverReads: parseClientMessage,
    /** How the 0.51.0 Client reads what a Sync Server sends. Strict: it drops what it does not know. */
    clientReads: parseServerMessage,
    /** Raw frames, recorded from 0.51.0 Clients and the 0.51.0 relay talking to each other. */
    clientFrames: recorded.client as readonly string[],
    serverFrames: recorded.server as readonly string[],
} as const
