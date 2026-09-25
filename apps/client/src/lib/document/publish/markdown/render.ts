/**
 * The markdown → HTML renderer of a [[Published Site]] (ADR 0082): markdown-it over the
 * document's body with the rules the format needs on top of GFM, the as-notes precedent
 * ported onto the editor's own parsers wherever one exists. Every construct the editor
 * knows is listed in the plan's syntax table; this file is that table's implementation.
 *
 * Diagrams and code highlighting are asynchronous (a browser for Mermaid, lazily loaded
 * grammars for code), so they are pre-rendered by the orchestrator and handed in as lookups;
 * the renderer itself is synchronous and pure over its inputs.
 */

import MarkdownIt, { type Token } from 'markdown-it'

import { isSafeAssetName } from '../../../storage/fs/asset-names'
import { parseImageDisplaySizeHint } from '../../view/augmentations/image-display-size'
import { publishSlug } from '../../wikilink/derive'
import { markRule } from './mark-rule'
import { mathRule, renderMath } from './math-rule'
import { taskRule } from './task-rule'
import { type WikilinkResolve, wikilinkRule } from './wikilink-rule'

export interface RendererOptions {
    resolve: WikilinkResolve
    /** The site-relative href for an asset the document references by name, or null to leave the reference alone. */
    assetHref(name: string): string | null
    /** Pre-rendered SVG for a Mermaid fence's source, when the host could render it. */
    mermaidSvg?(source: string): string | undefined
    /** Pre-highlighted HTML (the `<code>` element's inner HTML) for a fence, when the host could highlight it. */
    highlighted?(lang: string, code: string): string | undefined
}

export interface TocItem {
    level: number
    id: string
    text: string
}

export interface RenderedDocument {
    html: string
    toc: TocItem[]
    hasMath: boolean
    hasMermaid: boolean
    /** A Mermaid fence the host could not pre-render was left as `<pre class="mermaid">`. */
    mermaidFallback: boolean
    /** The body as plain text, for the search index and the feed. */
    text: string
    /** The first two hundred characters of that text, on a word boundary. */
    excerpt: string
    /** Asset names the rendered document references. */
    assets: string[]
}

export interface FenceRef {
    lang: string
    code: string
}

export interface DocumentRenderer {
    render(body: string): RenderedDocument
    /** One line of markdown as inline HTML (a backlink's context, a heading's text). */
    renderInline(text: string): string
    /** Every fenced block in the body with its language, for the orchestrator's pre-render pass. */
    fences(body: string): FenceRef[]
}

/** A document-relative asset reference: any number of `../`, `assets/`, the name. */
const ASSET_REF = /^(?:\.\.\/)*assets\/(.+)$/

/**
 * The asset a reference names, decoded, or null when it names none. A name that decodes to
 * anything but one file inside `assets/` is not an asset: it would become a bundle path, and a site
 * folder, outside `assets/` (see `isSafeAssetName`). The link is then left as the author wrote it.
 */
function assetNameOf(ref: string): string | null {
    const match = ASSET_REF.exec(ref)
    if (!match) return null
    const raw = match[1].split(/[?#]/)[0]
    let name: string
    try {
        name = decodeURIComponent(raw)
    } catch {
        name = raw
    }
    return isSafeAssetName(name) ? name : null
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const EXCERPT_LENGTH = 200

export function excerptOf(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim()
    if (flat.length <= EXCERPT_LENGTH) return flat
    const cut = flat.slice(0, EXCERPT_LENGTH)
    const space = cut.lastIndexOf(' ')
    return `${space > EXCERPT_LENGTH / 2 ? cut.slice(0, space) : cut}…`
}

/** The plain text of a token stream: what a reader would select, one line per block. */
function plainText(tokens: readonly Token[]): string {
    const lines: string[] = []
    for (const token of tokens) {
        if (token.type === 'inline' && token.children) {
            let line = ''
            for (const child of token.children) {
                if (child.type === 'text' || child.type === 'code_inline') line += child.content
                else if (child.type === 'softbreak' || child.type === 'hardbreak') line += ' '
            }
            if (line.trim() !== '') lines.push(line.trim())
        } else if (token.type === 'fence' || token.type === 'code_block') {
            if (token.info.trim() !== 'mermaid' && token.info.trim() !== 'math') lines.push(token.content.trim())
        }
    }
    return lines.join('\n')
}

export function createDocumentRenderer(options: RendererOptions): DocumentRenderer {
    const md = new MarkdownIt({ html: true, linkify: true, typographer: false })
    // markdown-it refuses `file:` links as unsafe; the editor renders them (they copy their path,
    // ADR 0079's neighbour `file-link.ts`), and on a static site the link is merely inert.
    const validateLink = md.validateLink
    md.validateLink = (url) => validateLink(url) || /^file:\/\//i.test(url)
    wikilinkRule(md, options.resolve)
    markRule(md)
    mathRule(md)
    taskRule(md)

    // Per-render state the rules below write into; reset by `render`.
    let state = { toc: [] as TocItem[], ids: new Set<string>(), hasMath: false, hasMermaid: false, mermaidFallback: false, assets: [] as string[] }

    const defaultImage = md.renderer.rules.image
    md.renderer.rules.image = (tokens, idx, opts, env, self) => {
        const token = tokens[idx]
        const src = String(token.attrGet('src') ?? '')
        const name = assetNameOf(src)
        if (name !== null) {
            const href = options.assetHref(name)
            if (href !== null) {
                token.attrSet('src', href)
                if (!state.assets.includes(name)) state.assets.push(name)
            }
        }
        // The alt as the editor shows it: the display-size hint stripped, and applied as a cap.
        const alt = self.renderInlineAsText(token.children ?? [], opts, env)
        const parsed = parseImageDisplaySizeHint(alt)
        token.attrSet('alt', parsed.cleanAlt)
        if (parsed.maxWidth !== undefined) {
            const style = [`max-width:${parsed.maxWidth}px`]
            if (parsed.maxHeight !== undefined) style.push(`max-height:${parsed.maxHeight}px`)
            token.attrSet('style', style.join(';'))
        }
        // Not `defaultImage`: it re-derives alt from the children, which still carry the hint.
        const attrs = (token.attrs ?? []).map(([k, v]) => `${k}="${escapeHtml(String(v))}"`).join(' ')
        void defaultImage
        return `<img ${attrs}>`
    }

    const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts))
    md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
        const token = tokens[idx]
        const href = String(token.attrGet('href') ?? '')
        const name = assetNameOf(href)
        if (name !== null) {
            const rewritten = options.assetHref(name)
            if (rewritten !== null) {
                token.attrSet('href', rewritten)
                if (!state.assets.includes(name)) state.assets.push(name)
            }
        }
        return defaultLinkOpen(tokens, idx, opts, env, self)
    }

    md.renderer.rules.fence = (tokens, idx) => {
        const token = tokens[idx]
        const lang = token.info.trim().split(/\s+/)[0] ?? ''
        const code = token.content
        if (lang === 'mermaid') {
            state.hasMermaid = true
            const svg = options.mermaidSvg?.(code)
            if (svg !== undefined) return `<figure class="diagram diagram-mermaid">${svg}</figure>\n`
            state.mermaidFallback = true
            return `<pre class="mermaid">${escapeHtml(code)}</pre>\n`
        }
        if (lang === 'math') {
            state.hasMath = true
            return `<div class="math math-block">${renderMath(code.replace(/\n$/, ''), true)}</div>\n`
        }
        if (lang === 'etherpk-cipher') return '' // never reached: such a document is excluded before rendering
        const highlighted = options.highlighted?.(lang, code)
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`
        const inner = highlighted ?? escapeHtml(code)
        return `<pre><code${cls}>${inner}</code></pre>\n`
    }

    md.renderer.rules.heading_open = (tokens, idx, opts, _env, self) => {
        const token = tokens[idx]
        const inline = tokens[idx + 1]
        const text = inline?.type === 'inline' ? self.renderInlineAsText(inline.children ?? [], opts, _env) : ''
        const level = Number(token.tag.slice(1))
        const base = publishSlug(text) || 'section'
        let id = base
        for (let n = 2; state.ids.has(id); n++) id = `${base}-${n}`
        state.ids.add(id)
        token.attrSet('id', id)
        if (level >= 2 && level <= 4) state.toc.push({ level, id, text })
        return self.renderToken(tokens, idx, opts)
    }

    function render(body: string): RenderedDocument {
        state = { toc: [], ids: new Set(), hasMath: false, hasMermaid: false, mermaidFallback: false, assets: [] }
        const env = {}
        const tokens = md.parse(body, env)
        const html = md.renderer.render(tokens, md.options, env)
        const hasMath = state.hasMath || html.includes('class="math math-inline"')
        const text = plainText(tokens)
        return {
            html,
            toc: state.toc,
            hasMath,
            hasMermaid: state.hasMermaid,
            mermaidFallback: state.mermaidFallback,
            text,
            excerpt: excerptOf(text),
            assets: state.assets,
        }
    }

    function renderInline(text: string): string {
        return md.renderInline(text, {})
    }

    function fences(body: string): FenceRef[] {
        const out: FenceRef[] = []
        for (const token of md.parse(body, {})) {
            if (token.type !== 'fence') continue
            const lang = token.info.trim().split(/\s+/)[0] ?? ''
            out.push({ lang, code: token.content })
        }
        return out
    }

    return { render, renderInline, fences }
}
