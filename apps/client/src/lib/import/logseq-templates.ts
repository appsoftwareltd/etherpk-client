/**
 * Logseq's templates, read for the Logseq converter.
 *
 * Logseq marks a template with a block property, `template:: Name`, on any block, and inserts the
 * block with its children (or the children alone, with `template-including-parent:: false`).
 * EtherPK's [[Template]] is a whole page (ADR 0144), so the converter moves each such block to a
 * page of its own and takes it out of the page it sat on, so its tasks and links are not in two
 * places. Logseq's dynamic variables (`<% today %>`) become EtherPK's [[Template Variable]]s.
 *
 * Pure. The blocks are lifted from a document's lines before any other conversion runs on them,
 * and the variables are rewritten in a Template page's text after it has been converted.
 */

/** A block property line, `key:: value`, as Logseq writes one under a bullet's first line. */
const PROPERTY = /^([A-Za-z][A-Za-z0-9_-]*)::\s*(.*)$/

/** A bullet's opening: indentation, the marker and at least one space. */
const BULLET = /^\s*[-*]\s+/

/** The same opening fence `createFenceTracker` recognises, bullet-carried or not. */
const FENCE = /^\s*(?:[-*+]\s+)?(`{3,}|~{3,})/

/** The columns a tab stands for, as the converter's own indent normalising counts it. */
const TAB_WIDTH = 2

/** The property lines that make a block a template. They mean nothing in a Template page. */
const TEMPLATE_KEYS = new Set(['template', 'template-including-parent'])

/** A template block lifted out of its page. */
export interface LogseqTemplateBlock {
    /** The name its `template::` property gives it. */
    name: string
    /** The Template page's body: the block or its children at the margin, without its template property lines. */
    lines: string[]
}

/**
 * For each line, whether it sits inside a fence opened on an earlier line (its interior or its
 * closing line). The opening line itself is not inside: it belongs to whichever block its
 * indentation puts it in, while the lines after it belong to that block whatever their indentation.
 */
function insideFence(lines: string[]): boolean[] {
    let open: string | null = null
    return lines.map((line) => {
        const fence = FENCE.exec(line)
        if (open !== null) {
            if (fence && fence[1][0] === open[0] && fence[1].length >= open.length) open = null
            return true
        }
        if (fence) open = fence[1]
        return false
    })
}

/** A line's leading whitespace in columns, a tab counting {@link TAB_WIDTH}. */
function indentWidth(line: string): number {
    let width = 0
    for (const ch of line) {
        if (ch === ' ') width += 1
        else if (ch === '\t') width += TAB_WIDTH
        else break
    }
    return width
}

/**
 * The line with `columns` of its leading whitespace removed. A tab that straddles the cut leaves
 * its remainder as spaces, and a line with less indentation than that simply loses all of it.
 */
function dropColumns(line: string, columns: number): string {
    let removed = 0
    let i = 0
    while (removed < columns && i < line.length && (line[i] === ' ' || line[i] === '\t')) {
        removed += line[i] === '\t' ? TAB_WIDTH : 1
        i += 1
    }
    return ' '.repeat(Math.max(0, removed - columns)) + line.slice(i)
}

/** A template block found in a document: where it runs, and how to read its body. */
interface TemplateRoot {
    name: string
    /** The bullet line. */
    start: number
    /** The first line after the bullet's property lines. */
    afterProperties: number
    /** The first line after the block's last child. */
    end: number
    /** False when only the children are the template: `template-including-parent:: false`, or a block whose only text is its properties. */
    includingParent: boolean
}

/**
 * Lift every template block out of a document. Returns the document's lines without them, and
 * each template's body in the order the blocks appear.
 *
 * A block is a template when a `template:: Name` property line sits directly under its bullet's
 * first line, deeper than the bullet, or on the bullet line itself when the block has no other
 * text. The block runs to the next line at or above the bullet's indentation. A template inside
 * another template is a template of its own and stays part of the outer one, as in Logseq. Lines
 * inside a fenced code block are never read as bullets or properties.
 */
export function extractTemplateBlocks(lines: string[]): { lines: string[]; templates: LogseqTemplateBlock[] } {
    const fenced = insideFence(lines)
    const width = lines.map(indentWidth)
    const blank = lines.map((line) => line.trim() === '')
    const isBullet = (k: number) => !fenced[k] && BULLET.test(lines[k])

    const roots: TemplateRoot[] = []
    // Every `template::` and `template-including-parent::` line of every template, dropped from
    // each Template page that holds it, nested templates included.
    const templateLines = new Set<number>()
    for (let i = 0; i < lines.length; i++) {
        if (!isBullet(i)) continue
        const properties = new Map<string, string>()
        const propertyLines: number[] = []
        const read = (k: number, text: string): boolean => {
            const match = PROPERTY.exec(text.trim())
            if (!match) return false
            properties.set(match[1].toLowerCase(), match[2].trim())
            propertyLines.push(k)
            return true
        }
        // A block with no text of its own is written with its first property on the bullet line.
        const titleless = read(i, lines[i].replace(BULLET, ''))
        let next = i + 1
        while (next < lines.length && !fenced[next] && !blank[next] && width[next] > width[i] && !isBullet(next) && read(next, lines[next])) {
            next += 1
        }
        const name = properties.get('template')
        if (!name) continue

        for (const k of propertyLines) {
            if (TEMPLATE_KEYS.has(PROPERTY.exec(lines[k].replace(BULLET, '').trim())?.[1].toLowerCase() ?? '')) templateLines.add(k)
        }
        let end = next
        while (end < lines.length && (fenced[end] || blank[end] || width[end] > width[i])) end += 1
        // Blank lines after the last child separate it from what follows, so they stay on the page.
        while (end > next && blank[end - 1] && !fenced[end - 1]) end -= 1
        roots.push({
            name,
            start: i,
            afterProperties: next,
            end,
            includingParent: !titleless && properties.get('template-including-parent')?.toLowerCase() !== 'false',
        })
    }

    const templates = roots.map((root): LogseqTemplateBlock => {
        let from = root.start
        let columns = width[root.start]
        if (!root.includingParent) {
            // The children start at the first bullet after the block's own text. Every line before
            // the end is fenced, blank or deeper than the parent, so this one is a child.
            from = root.afterProperties
            while (from < root.end && !isBullet(from)) from += 1
            columns = from < root.end ? width[from] : 0
        }
        const body: string[] = []
        for (let k = from; k < root.end; k++) {
            if (!templateLines.has(k)) body.push(dropColumns(lines[k], columns))
            // A nested template written with its property on its bullet line keeps the bullet, empty,
            // as Logseq copies it, so the block's children stay at their depth.
            else if (isBullet(k)) body.push(dropColumns(lines[k].replace(/^(\s*[-*])\s.*$/, '$1'), columns))
        }
        return { name: root.name, lines: body }
    })

    // Only the outermost templates are cut: a nested one goes with the block around it.
    const kept: string[] = []
    let cutUntil = 0
    let k = 0
    for (const root of roots) {
        if (root.start < cutUntil) continue
        kept.push(...lines.slice(k, root.start))
        k = root.end
        cutUntil = root.end
    }
    kept.push(...lines.slice(k))
    return { lines: kept, templates }
}

/** Logseq's dynamic variables EtherPK has an equal for, by their name trimmed and lower-cased. */
const DYNAMIC_VARIABLES: Record<string, { variable: string; link: boolean }> = {
    // Logseq writes these as page references, `[[Oct 14th, 2026]]`. EtherPK's variables are
    // plain text, so the link is written around them.
    today: { variable: '{{date}}', link: true },
    yesterday: { variable: '{{yesterday}}', link: true },
    tomorrow: { variable: '{{tomorrow}}', link: true },
    'current page': { variable: '{{title}}', link: true },
    time: { variable: '{{time}}', link: false },
}

/**
 * A Template page's text with Logseq's dynamic variables turned into Template Variables:
 * `<% today %>` becomes `[[{{date}}]]`, and `<% time %>` becomes `{{time}}`. A variable already
 * inside a wikilink (`[[<% today %>]]`, `[[<% today %> harvest]]`) gets no second pair of brackets.
 *
 * Every variable is converted, code included, because Logseq fills them in everywhere and so
 * does EtherPK. Any other `<% … %>` (a natural-language date such as `<% next monday %>`) is kept
 * as written and returned in `kept`, in order, once each, for the Import Report.
 */
export function convertDynamicVariables(text: string): { text: string; kept: string[] } {
    const kept: string[] = []
    let out = ''
    // How many wikilinks are open at this point of the line: a link never runs past its line.
    let depth = 0
    let i = 0
    while (i < text.length) {
        if (text[i] === '\n') {
            depth = 0
        } else if (text.startsWith('[[', i)) {
            depth += 1
            out += '[['
            i += 2
            continue
        } else if (text.startsWith(']]', i) && depth > 0) {
            depth -= 1
            out += ']]'
            i += 2
            continue
        } else if (text.startsWith('<%', i)) {
            const close = text.indexOf('%>', i + 2)
            const newline = text.indexOf('\n', i)
            if (close !== -1 && (newline === -1 || close < newline)) {
                const written = text.slice(i, close + 2)
                const name = text
                    .slice(i + 2, close)
                    .trim()
                    .replace(/\s+/g, ' ')
                    .toLowerCase()
                const known = DYNAMIC_VARIABLES[name]
                if (known) {
                    out += known.link && depth === 0 ? `[[${known.variable}]]` : known.variable
                } else {
                    out += written
                    if (!kept.includes(written)) kept.push(written)
                }
                i = close + 2
                continue
            }
        }
        out += text[i]
        i += 1
    }
    return { text: out, kept }
}

/** The Import Report's line for the dynamic variables a Template page keeps as written. */
export function keptVariablesDetail(kept: string[]): string {
    const quoted = kept.map((variable) => `\`${variable}\``)
    if (quoted.length === 1) return `The template variable ${quoted[0]} was kept as written. EtherPK does not fill it in.`
    const list = `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`
    return `The template variables ${list} were kept as written. EtherPK does not fill them in.`
}
