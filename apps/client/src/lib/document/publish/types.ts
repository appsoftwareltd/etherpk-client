/**
 * The publisher's vocabulary (CONTEXT.md → [[Publish]], [[Publication]], [[Published Site]],
 * [[Theme]], [[Include]]; ADR 0082). Pure types shared by every module under `publish/`, so
 * the core stays framework-free and the Client, the Headless Client and the tests hand it the
 * same shapes.
 */

export type PublishDocumentKind = 'page' | 'journal'

/** One document as the publisher receives it: materialised text, cipher fence and all. */
export interface PublishDocument {
    /** The concept the document answers to (a page's title, a journal entry's day). */
    concept: string
    kind: PublishDocumentKind
    /** The whole text, frontmatter included. Never decrypted: a cipher fence stays opaque. */
    text: string
    /** Alternate names from frontmatter, already normalised by the store. */
    aliases: readonly string[]
}

/** An asset's bytes, as the store hands them over for a `../assets/<name>` reference. */
export interface PublishAssetBytes {
    bytes: Uint8Array
    name: string
    type: string
}

/** Everything the publisher reads: the documents and a way to fetch an asset by reference. */
export interface PublishSource {
    documents: readonly PublishDocument[]
    /** Resolve a document-relative asset reference (`../assets/<name>`) to bytes, or null when absent. */
    readAsset(ref: string): Promise<PublishAssetBytes | null>
}

export type PublicationKind = 'docs' | 'blog'
export type PublicationSelection = 'named' | 'all-public'

/** A [[Publication]] as its page declares it, validated. */
export interface Publication {
    /** Kebab-case identifier; what documents name in `publications:`. */
    id: string
    /** The page's title: the display name. */
    name: string
    /** The concept of the page that defines it; never emitted as a page. */
    concept: string
    kind: PublicationKind
    selection: PublicationSelection
    /** Concept whose content becomes the front page; absent ⇒ a generated index. */
    home?: string
    /** Where the site is deployed; used for the feed and the sitemap. */
    url?: string
    /** A bundled theme name, a URL to a manifest, or a graph theme id. */
    theme: string
    /** How many posts the front page lists (`site.recentPosts`); every post is on the posts archive. */
    recent: number
    /** Include slot → concept of the page that fills it. */
    includes: Readonly<Record<string, string>>
    /** The page's body: the navigation outline. */
    outline: string
}

export type IssueLevel = 'error' | 'warning' | 'info'

/** Something the report has to say. `concept` names the document it is about, when there is one. */
export interface PublishIssue {
    level: IssueLevel
    code: string
    message: string
    concept?: string
}

/** A file of the [[Published Site]]: text or bytes at a site-relative path. */
export type SiteFile = string | Uint8Array

/** The site as a map of relative path → content. Written by a host, never here. */
export type SiteBundle = Map<string, SiteFile>
