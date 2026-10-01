/**
 * AS Notes kanban boards as EtherPK pages (ADR 0115). AS Notes keeps a board as a folder,
 * `kanban/<board>/`, with a `board.yaml`, one folder per lane and one `card_*.md` file per card.
 * An EtherPK [[Kanban Board]] takes its lanes from the task statuses on each task line (ADR 0113),
 * so a board becomes one page holding one task per card, and the lane a card sat in becomes its
 * task's status. The card's description, notes and entries are nested under its task.
 *
 * Reading follows AS Notes's `KanbanStore`: a card is a `card_*.md` file in a lane folder whose
 * frontmatter parses and has a `title`. Anything else under `kanban/` is left to the ordinary
 * note and file handling, as AS Notes itself indexes those files as notes.
 */

import { parse as parseYaml } from 'yaml'

import { readSourceFrontmatter } from './convert-shared'
import type { PlannedAsset } from './assets'
import { type TaskTags, taskLine } from './task-tags'
import { readText } from './source'
import type { ReportEntry, SourceFile } from './types'

export interface KanbanCard {
    /** Root-relative source path. */
    path: string
    /** The file name without `.md`, which AS Notes uses as the card's id and its asset folder's name. */
    id: string
    lane: string
    title: string
    data: Record<string, unknown>
    body: string
}

export interface KanbanBoard {
    slug: string
    name: string
    /** Lane folder names, in board order. */
    lanes: string[]
    cards: KanbanCard[]
    config: Record<string, unknown>
}

const CARD = /^kanban\/([^/]+)\/([^/]+)\/(card_[^/]*)\.md$/i
const BOARD_CONFIG = /^kanban\/([^/]+)\/board\.yaml$/i
/** AS Notes keeps each card's files in `kanban/<board>/assets/<card id>/`, never a lane. */
const ASSETS_FOLDER = 'assets'
/** The lane AS Notes moves archived cards to and never shows. */
const ARCHIVE = 'archive'

/**
 * Every board under `kanban/`, and the files that were read as part of one (board configs and
 * cards) so the caller converts nothing twice.
 */
export async function readKanbanBoards(files: SourceFile[]): Promise<{ boards: KanbanBoard[]; consumed: Set<string> }> {
    const consumed = new Set<string>()
    const boards = new Map<string, KanbanBoard>()
    const board = (slug: string) => {
        let found = boards.get(slug)
        if (!found) {
            found = { slug, name: slug, lanes: [], cards: [], config: {} }
            boards.set(slug, found)
        }
        return found
    }

    for (const file of files) {
        const config = BOARD_CONFIG.exec(file.path)
        if (config) {
            consumed.add(file.path)
            const target = board(config[1])
            try {
                const parsed = parseYaml(await readText(file)) as unknown
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) target.config = parsed as Record<string, unknown>
            } catch {
                // An unreadable config leaves the board named after its folder, as AS Notes would show it.
            }
            continue
        }
        const card = CARD.exec(file.path)
        if (!card || card[2].toLowerCase() === ASSETS_FOLDER) continue
        const source = readSourceFrontmatter(await readText(file))
        if (source.kind !== 'yaml' || typeof source.data.title !== 'string') continue
        consumed.add(file.path)
        board(card[1]).cards.push({ path: file.path, id: card[3], lane: card[2], title: source.data.title, data: source.data, body: source.body })
    }

    const result: KanbanBoard[] = []
    for (const found of boards.values()) {
        if (found.cards.length === 0) continue
        const { name, lanes } = found.config
        if (typeof name === 'string' && name.trim() !== '') found.name = name.trim()
        // The board's own lane order first, then any other lane folder, and the archive last.
        const configured = Array.isArray(lanes) ? lanes.filter((l): l is string => typeof l === 'string') : []
        const seen = [...new Set(found.cards.map((c) => c.lane))].sort()
        found.lanes = [...new Set([...configured, ...seen])].filter((l) => l !== ARCHIVE && seen.includes(l))
        if (seen.includes(ARCHIVE)) found.lanes.push(ARCHIVE)
        result.push(found)
    }
    return { boards: result, consumed }
}

/** The task state a lane stands for, or null for a lane with no EtherPK status. */
function laneState(lane: string): { done: boolean; tags: TaskTags } | null {
    switch (lane.toLowerCase()) {
        case 'todo':
            return { done: false, tags: {} }
        case 'doing':
            return { done: false, tags: { doing: true } }
        case 'waiting':
            return { done: false, tags: { waiting: true } }
        case 'done':
        case ARCHIVE:
            return { done: true, tags: {} }
        case 'cancelled':
        case 'canceled':
            return { done: true, tags: { cancelled: true } }
        default:
            return null
    }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ENTRY_HEADING = /^##\s+entry(?:\s+(.*))?$/i
const ENTRY_DATE = /^(\d{4}-\d{2}-\d{2})(?:\s+(.*))?$/

/** Cards in the order AS Notes shows them in a lane: by `sortOrder`, then by when they were made. */
function byCardOrder(a: KanbanCard, b: KanbanCard): number {
    const order = (card: KanbanCard) => (typeof card.data.sortOrder === 'number' ? card.data.sortOrder : Infinity)
    const created = (card: KanbanCard) => (typeof card.data.created === 'string' ? card.data.created : '')
    return order(a) - order(b) || created(a).localeCompare(created(b)) || a.path.localeCompare(b.path)
}

/** Blank lines trimmed from both ends of a block of lines. */
function trimLines(text: string): string[] {
    const lines = text.split(/\r?\n/)
    while (lines.length > 0 && lines[0].trim() === '') lines.shift()
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
    return lines
}

const indent = (lines: string[], by: string) => lines.map((line) => (line.trim() === '' ? '' : `${by}${line}`))

/**
 * A card's detail as markdown at the card's own level: the assignee and labels, the description,
 * the notes above its first entry, then each `## entry` as a bullet with its text beneath it.
 */
function cardDetail(card: KanbanCard): string[] {
    const lines: string[] = []
    const { assignee, labels, description, dueDate } = card.data
    const meta: string[] = []
    if (typeof assignee === 'string' && assignee.trim() !== '') meta.push(`Assignee: ${assignee.trim()}.`)
    const labelList = Array.isArray(labels) ? labels.filter((l): l is string => typeof l === 'string') : []
    if (labelList.length > 0) meta.push(`Labels: ${labelList.join(', ')}.`)
    // A due date that is not a date cannot be a `#D-` tag, so it stays readable beside the others.
    if (typeof dueDate === 'string' && dueDate !== '' && !ISO_DATE.test(dueDate)) meta.push(`Due: ${dueDate}.`)
    if (meta.length > 0) lines.push(meta.join(' '))
    if (typeof description === 'string') lines.push(...trimLines(description))

    const bodyLines = card.body.split(/\r?\n/)
    const firstEntry = bodyLines.findIndex((line) => ENTRY_HEADING.test(line))
    lines.push(...trimLines(bodyLines.slice(0, firstEntry === -1 ? undefined : firstEntry).join('\n')))
    if (firstEntry === -1) return lines

    let entry: string[] = []
    const flush = () => lines.push(...indent(trimLines(entry.join('\n')), '  '))
    for (const line of bodyLines.slice(firstEntry)) {
        const heading = ENTRY_HEADING.exec(line)
        if (!heading) {
            entry.push(line)
            continue
        }
        flush()
        entry = []
        const rest = (heading[1] ?? '').trim()
        const dated = ENTRY_DATE.exec(rest)
        const label = dated ? [dated[1], dated[2]?.trim()].filter(Boolean).join(' ') : rest
        lines.push(`- ${label || 'Entry'}`)
    }
    flush()
    return lines
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/**
 * A board's page body: one task per card, lane by lane. `convert` gives card text the same
 * handling as a note's (links, files, tasks), from the card's own folder. `cardFile` finds one
 * of the files a card lists in its `assets`; a listed file the card's text does not already link
 * is linked under the task, so it stays with its card.
 */
export function boardPageBody(
    board: KanbanBoard,
    concept: string,
    convert: (text: string, card: KanbanCard) => string,
    cardFile: (card: KanbanCard, fileName: string) => PlannedAsset | null,
    markReferenced: (planned: PlannedAsset) => void,
    report: ReportEntry[],
): string {
    const out: string[] = []
    const unknownLanes = new Map<string, number>()
    let archived = 0
    let keptPeople = false
    let hadTimes = false
    let hadOrder = false

    for (const lane of board.lanes) {
        const state = laneState(lane)
        const cards = board.cards.filter((c) => c.lane === lane).sort(byCardOrder)
        if (!state) unknownLanes.set(lane, cards.length)
        if (lane === ARCHIVE) archived += cards.length
        for (const card of cards) {
            const tags: TaskTags = { ...(state?.tags ?? {}) }
            const { priority, waiting, dueDate, assignee, labels, created, updated, sortOrder } = card.data
            const level = typeof priority === 'string' ? /^p([1-5])$/i.exec(priority)?.[1] : undefined
            if (level && Number(level) <= 3) tags.priority = Number(level) as 1 | 2 | 3
            else if (level) {
                report.push({ category: 'drop', concept, detail: `Priority ${priority} on "${card.title}" dropped (EtherPK has three priority levels)` })
            }
            if (waiting === true) tags.waiting = true
            if (typeof dueDate === 'string' && ISO_DATE.test(dueDate)) tags.due = dueDate
            if (assignee || (Array.isArray(labels) && labels.length > 0)) keptPeople = true
            if (created !== undefined || updated !== undefined) hadTimes = true
            if (sortOrder !== undefined) hadOrder = true

            out.push(taskLine('', '-', state?.done ?? false, tags, convert(card.title, card)))
            const detail = convert(cardDetail(card).join('\n'), card)
            const detailLines = detail === '' ? [] : detail.split('\n')
            const listed = Array.isArray(card.data.assets) ? card.data.assets : []
            for (const item of listed) {
                const fileName = item && typeof item === 'object' ? (item as { filename?: unknown }).filename : undefined
                if (typeof fileName !== 'string') continue
                const planned = cardFile(card, fileName)
                if (!planned || detail.includes(planned.ref)) continue
                markReferenced(planned)
                detailLines.push(`- ${planned.isImage ? '!' : ''}[${planned.stem}](${planned.ref})`)
            }
            out.push(...indent(detailLines, '  '))
        }
    }

    report.push({ category: 'degradation', concept, detail: `AS Notes kanban board "${board.name}" became this page, one task per card` })
    for (const [lane, n] of unknownLanes) {
        report.push({
            category: 'degradation',
            concept,
            detail: `Lane "${lane}" has no EtherPK task status, so its ${n} ${plural(n, 'card was imported as an open task', 'cards were imported as open tasks')}`,
        })
    }
    if (archived > 0) {
        report.push({
            category: 'degradation',
            concept,
            detail: `${archived} archived ${plural(archived, 'card was imported as a done task', 'cards were imported as done tasks')}`,
        })
    }
    if (keptPeople) {
        report.push({ category: 'degradation', concept, detail: 'Assignees and labels kept as text under each task: EtherPK tasks have neither' })
    }
    // Metadata with no place on a task line: the board's page order is lane by lane, but an
    // EtherPK board orders cards by priority and due date.
    const dropped: string[] = []
    if (hadTimes) dropped.push('card creation and update times')
    if (hadOrder) dropped.push('the card order within each lane')
    for (const key of ['users', 'labels']) {
        const list = board.config[key]
        if (Array.isArray(list) && list.length > 0) dropped.push(`the board's list of ${key}`)
    }
    if (dropped.length > 0) report.push({ category: 'drop', concept, detail: `Dropped: ${dropped.join(', ')}` })

    return `${out.join('\n')}\n`
}
