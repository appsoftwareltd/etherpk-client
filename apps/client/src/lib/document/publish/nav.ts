/**
 * The navigation of a [[Published Site]], from the publication page's outline (ADR 0082):
 * a top-level bullet is an entry, a nested bullet a sub-entry, a plain-text bullet with
 * children a group, a heading a group too (as-notes `nav.md` parity), and a markdown link an
 * external entry. An entry naming a document outside the publication is dropped and reported,
 * never pointed at the 404 page: a menu entry to "not published" helps nobody.
 */

import { type Block, parseBlocks } from '../block-model'
import { MARKDOWN_LINK, linkGroups } from '../markdown-link-target'
import { parseWikilinks } from '../wikilink/parser'
import type { PublicationResolver } from './resolve'
import { titleText } from './resolve'
import type { PublishIssue } from './types'

export interface NavNode {
    /** Plain text, for `<title>`-like places and the fragments' text. */
    label: string
    /** The label as HTML: chained anchors for a concept, escaped text otherwise. */
    labelHtml: string
    /** Where the entry goes; absent for a group. */
    href?: string
    external?: boolean
    /** The concept an entry names, for marking the current page. */
    concept?: string
    children: NavNode[]
}

export interface NavResult {
    nav: NavNode[]
    issues: PublishIssue[]
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The bullet's or heading's own text: the marker and any `#` run removed. */
function contentOf(block: Block): string {
    const first = block.text.split('\n')[0]
    if (block.type === 'heading') return first.replace(/^#{1,6}\s+/, '').trim()
    return first.replace(/^-\s+/, '').trim()
}

const WHOLE_LINK = new RegExp(`^${MARKDOWN_LINK}$`)

/** The schemes an outline link may carry onto a published page; a target with no scheme is a path on the site. */
const NAV_LINK_SCHEMES = new Set(['http', 'https', 'mailto'])

/**
 * An outline link's target, or null when a published page must not carry it. Links in page bodies
 * go through markdown-it's validateLink; the outline is parsed here, so it gets its own rule. The
 * scheme is read after removing the control characters and spaces a browser would ignore, so
 * '\u0001javascript:' is read as javascript.
 */
function navLinkTarget(target: string): string | null {
    const visible = [...target].filter((c) => c.charCodeAt(0) > 0x20 && c.charCodeAt(0) !== 0x7f).join('')
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(visible)
    if (!scheme) return target
    return NAV_LINK_SCHEMES.has(scheme[1].toLowerCase()) ? target : null
}

export function buildNav(outline: string, resolver: PublicationResolver): NavResult {
    const issues: PublishIssue[] = []

    function convert(blocks: readonly Block[]): NavNode[] {
        const out: NavNode[] = []
        for (const block of blocks) {
            if (block.type === 'paragraph') continue
            const content = contentOf(block)
            if (content === '') continue
            const children = convert(block.children)

            if (block.type === 'bullet' || block.type === 'task') {
                const links = parseWikilinks(content)
                const whole = links.find((l) => l.start === 0 && l.end === content.length - 1)
                if (whole) {
                    const target = resolver.resolve(whole.concept)
                    if (target.missing) {
                        issues.push({
                            level: 'warning',
                            code: 'nav-entry-not-published',
                            message: `The navigation names "${whole.concept}", which is not in this publication; the entry is left out.`,
                        })
                        continue
                    }
                    out.push({
                        label: titleText(target.canonical),
                        labelHtml: resolver.titleHtml(target.canonical),
                        href: target.href,
                        concept: target.canonical,
                        children,
                    })
                    continue
                }
                const link = WHOLE_LINK.exec(content)
                if (link && !linkGroups(link).bang) {
                    const { label, target } = linkGroups(link)
                    const href = navLinkTarget(target)
                    if (href === null) {
                        issues.push({
                            level: 'warning',
                            code: 'nav-link-unsafe',
                            message: `The navigation links "${label}" to a target a published page does not carry (only http, https, mailto and site paths); the entry is shown without its link.`,
                        })
                        out.push({ label, labelHtml: escapeHtml(label), children })
                        continue
                    }
                    out.push({ label, labelHtml: escapeHtml(label), href, external: true, children })
                    continue
                }
            }
            const label = titleText(content)
            out.push({ label, labelHtml: escapeHtml(label), children })
        }
        return out
    }

    return { nav: convert(parseBlocks(outline)), issues }
}
