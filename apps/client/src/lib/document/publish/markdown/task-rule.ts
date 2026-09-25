/**
 * Task lines on the site: the checkbox becomes a static, disabled `<input>` (the `DESIGN.md`
 * rule) and the tag run after it becomes badges in the as-notes `TaskTagPlugin` markup
 * (`<span class="task-tag priority-1">Priority 1</span>`), parsed by the editor's own
 * `parseTaskLine` so every tag the editor knows (`#D` doing, `#C` cancelled, `#S-` scheduled
 * included) is a badge and nothing else on the line is touched.
 */

import type { MarkdownIt } from 'markdown-it'

import { type TaskTags, parseTaskLine } from '../../task-tags'

const CHECKBOX = /^\[([ xX])\]\s*/

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function badge(cls: string, label: string): string {
    return `<span class="task-tag ${cls}">${escapeHtml(label)}</span>`
}

/** The badges for a task's tags, in the order the [[Tasks View]] shows them. */
export function taskBadges(tags: TaskTags): string[] {
    const out: string[] = []
    if (tags.priority !== null) out.push(badge(`priority-${tags.priority}`, `Priority ${tags.priority}`))
    if (tags.doing) out.push(badge('doing', 'Doing'))
    if (tags.waiting) out.push(badge('waiting', 'Waiting'))
    if (tags.cancelled) out.push(badge('cancelled', 'Cancelled'))
    if (tags.due) out.push(badge('due-date', `Due ${tags.due}`))
    if (tags.scheduled) out.push(badge('scheduled-date', `Scheduled ${tags.scheduled}`))
    if (tags.completion) out.push(badge('completed-date', `Completed ${tags.completion}`))
    return out
}

export function taskRule(md: MarkdownIt): void {
    // Before the inline parser runs, so the rewritten content is parsed like any other markdown.
    md.core.ruler.before('inline', 'etherpk_tasks', (state) => {
        const tokens = state.tokens
        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i].type !== 'list_item_open') continue
            const paragraph = tokens[i + 1]
            const inline = tokens[i + 2]
            if (!paragraph || paragraph.type !== 'paragraph_open' || !inline || inline.type !== 'inline') continue
            const checkbox = CHECKBOX.exec(inline.content)
            if (!checkbox) continue
            const parsed = parseTaskLine(`- ${inline.content}`)
            if (!parsed) continue
            tokens[i].attrJoin('class', parsed.done ? 'task done' : 'task')
            const input = `<input type="checkbox" disabled${parsed.done ? ' checked' : ''}> `
            const badges = taskBadges(parsed)
            inline.content = `${input}${badges.join(' ')}${badges.length > 0 ? ' ' : ''}${parsed.text}`
        }
        return true
    })
}
