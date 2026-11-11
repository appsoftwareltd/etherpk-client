/**
 * Version History for the Headless Client (ADR 0184). An agent's edits are the changes a person is
 * least likely to have watched, so the first write an agent makes to a document in a session is
 * preceded by a version of it, which the tool waits for: the process keeps no outbox across a
 * restart. An agent can list and read versions; restoring one is a person's decision, made in
 * EtherPK.
 */
import type { VersionList } from '@appsoftwareltd/etherpk-shared'
import type { GraphVersions } from '#lib/sync/version-history/graph-versions.js'
import type { DocumentVersionPayload } from '#lib/sync/version-history/version-payload.js'

export interface HeadlessVersions {
    /** Make a version of `concept` before this session's first write to it; resolves once it has been sent. */
    beforeAgentWrite(concept: string): Promise<void>
    /** A document's verified versions, newest first; null when no document has that name. */
    list(concept: string): Promise<VersionList | null>
    /** One version's text and identity; null when no document has that name. */
    read(concept: string, versionId: string): Promise<DocumentVersionPayload | null>
    /** Send every version still waiting. */
    flush(): Promise<void>
    /** The same history with this session's own record of which documents it has versioned. */
    forSession(): HeadlessVersions
}

export function headlessVersions(versions: GraphVersions, documentIdOf: (concept: string) => string | undefined): HeadlessVersions {
    const make = (versioned: Set<string>): HeadlessVersions => ({
        async beforeAgentWrite(concept) {
            const docId = documentIdOf(concept)
            if (!docId || versioned.has(docId)) return
            versioned.add(docId)
            await versions.recorder.record(docId, 'before_agent_write', { wait: true })
        },
        async list(concept) {
            const docId = documentIdOf(concept)
            return docId ? versions.history.list(docId) : null
        },
        async read(concept, versionId) {
            const docId = documentIdOf(concept)
            return docId ? versions.history.read(docId, versionId) : null
        },
        flush: () => versions.recorder.flush(),
        forSession: () => make(new Set()),
    })
    return make(new Set())
}
