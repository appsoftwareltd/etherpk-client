/**
 * The `AGENTS.md` a Filesystem Backend graph keeps at its root, so a coding agent pointed at the
 * folder (Claude Code, Codex, Copilot, an editor's chat) knows what it is looking at and how not
 * to break it. The pattern is Agent Kanban's: the file is the user's, and EtherPK owns one
 * **sentinel section** inside it, fenced by two HTML comments. Text outside the fence is never
 * touched; the text between them is rewritten to the current build's on every open, so a graph
 * created by an older EtherPK picks up the newer description without anyone doing anything.
 *
 * Pure over the {@link DirectoryAdapter} seam: the merge is a string function, the ensure reads
 * one root file and writes it only when the bytes would differ (an open must not dirty a git
 * checkout).
 */

import type { DirectoryAdapter } from './directory-adapter'
// Vite's `?raw` import: the markdown arrives as a string at build time, so the section ships in
// the bundle and needs no fetch. Node tests get the same through Vitest's Vite pipeline.
import sectionMarkdown from './agents-md-section.md?raw'

/** The file, at the graph root beside `journals/ pages/ assets/ etherpk/`. */
export const AGENTS_MD_FILE = 'AGENTS.md'
/**
 * Claude Code reads `CLAUDE.md` and not `AGENTS.md` (its own docs say so and recommend exactly
 * this: a CLAUDE.md whose `@AGENTS.md` import loads the shared file). It also picks a CLAUDE.md
 * up on demand from a subdirectory of wherever it was started, which is what reaches an agent
 * working in a project that merely *contains* the graph folder. Same sentinel, same merge.
 */
export const CLAUDE_MD_FILE = 'CLAUDE.md'

/**
 * The fence. HTML comments so the section reads as prose in any markdown viewer, and a warning
 * on the opener itself because that is the line a reader is looking at when tempted to edit.
 */
export const AGENTS_MD_BEGIN = '<!-- BEGIN ETHERPK - DO NOT EDIT THIS SECTION. It is managed by EtherPK and rewritten on every open; put your own notes above or below it. -->'
export const AGENTS_MD_END = '<!-- END ETHERPK -->'

/**
 * The managed section: what EtherPK is, the folder layout, the document syntax in full, and the
 * rules that keep a file editable by EtherPK afterwards. The text lives in
 * `agents-md-section.md` beside this module - plain markdown, editable by hand, bundled at build
 * time - and is wrapped in the sentinels here so the file and the merge can never disagree about
 * where the section starts and ends. Written for an agent that has never seen EtherPK and will
 * act on that text alone, so it states the mechanism and the reason together. Every claim in it
 * is a rule the app enforces somewhere - keep it in step with `Editor Content Rules.md`,
 * `Frontmatter.md`, `Wikilinks.md` and `Protected Documents.md`.
 */
export function buildAgentsMdSection(): string {
    // Whatever the editor left at the ends of the resource is not the section's: one newline
    // after the opener, one before the closer, LF throughout.
    const body = sectionMarkdown.replaceAll('\r\n', '\n').trim()
    return `${AGENTS_MD_BEGIN}\n${body}\n${AGENTS_MD_END}`
}

/**
 * The CLAUDE.md section: one import and one sentence. Everything an agent needs is in AGENTS.md
 * (the user's own notes there included, since the import pulls in the whole file); duplicating
 * the text here would only give the two a chance to disagree. The import line has to sit
 * outside any code span or fence, or Claude Code treats it as literal text.
 */
export function buildClaudeMdSection(): string {
    return [
        AGENTS_MD_BEGIN,
        `@${AGENTS_MD_FILE}`,
        '',
        `Claude Code reads \`CLAUDE.md\` rather than \`AGENTS.md\`, so this file imports the \`${AGENTS_MD_FILE}\` beside it - EtherPK's description of this knowledge graph folder, plus any notes of your own in it. Put Claude-specific instructions outside this section.`,
        AGENTS_MD_END,
    ].join('\n')
}

/**
 * Merge the managed section into whatever is in the file. The section replaces the fenced
 * region when both sentinels are present in order; otherwise it is appended after the user's
 * text, separated by one blank line. A begin sentinel with no end is treated as no section at
 * all - replacing from it to the end of the file would eat whatever the user wrote below - so
 * the broken fragment stays where it is and a whole section is appended after it.
 *
 * The file's own line ending is honoured: a file with CRLF anywhere gets the section in CRLF,
 * so a Windows-edited AGENTS.md is not left mixed (and a fresh file is LF, as everything EtherPK
 * writes is).
 */
export function mergeAgentsMdSection(existing: string | null, section: string): string {
    if (existing === null || existing === '') return `${section}\n`
    const eol = existing.includes('\r\n') ? '\r\n' : '\n'
    const fenced = eol === '\n' ? section : section.replaceAll('\n', eol)

    const beginIdx = existing.indexOf(AGENTS_MD_BEGIN)
    const endIdx = beginIdx === -1 ? -1 : existing.indexOf(AGENTS_MD_END, beginIdx + AGENTS_MD_BEGIN.length)
    if (beginIdx !== -1 && endIdx !== -1) {
        const before = existing.slice(0, beginIdx)
        const after = existing.slice(endIdx + AGENTS_MD_END.length)
        return `${before}${fenced}${after}`
    }

    const separator = existing.endsWith(eol) ? eol : `${eol}${eol}`
    return `${existing}${separator}${fenced}${eol}`
}

export type EnsureAgentsMdOutcome = 'created' | 'updated' | 'unchanged'

/**
 * Make sure one root file carries its current managed section. Reads the file, merges, and
 * writes only when the result differs from what is on disk, so an open of an up-to-date graph
 * touches nothing (no mtime bump, no dirty git checkout). Rejects when the file cannot be read:
 * an unreadable file is not an absent one, and writing over it would lose the user's text.
 */
async function ensureManagedSection(
    adapter: DirectoryAdapter,
    name: string,
    section: string,
): Promise<EnsureAgentsMdOutcome> {
    const existing = await adapter.readRootFile(name)
    const merged = mergeAgentsMdSection(existing?.text ?? null, section)
    if (existing !== null && existing.text === merged) return 'unchanged'
    await adapter.writeRootFile(name, merged)
    return existing === null ? 'created' : 'updated'
}

/** {@link ensureAgentInstructions} for `AGENTS.md` alone. */
export function ensureAgentsMd(adapter: DirectoryAdapter): Promise<EnsureAgentsMdOutcome> {
    return ensureManagedSection(adapter, AGENTS_MD_FILE, buildAgentsMdSection())
}

/** {@link ensureAgentInstructions} for `CLAUDE.md` alone. */
export function ensureClaudeMd(adapter: DirectoryAdapter): Promise<EnsureAgentsMdOutcome> {
    return ensureManagedSection(adapter, CLAUDE_MD_FILE, buildClaudeMdSection())
}

/**
 * What an open runs: both files, AGENTS.md first so the import in CLAUDE.md never points at a
 * file that is not there yet. Each file's outcome is reported on its own.
 */
export async function ensureAgentInstructions(
    adapter: DirectoryAdapter,
): Promise<{ agents: EnsureAgentsMdOutcome; claude: EnsureAgentsMdOutcome }> {
    const agents = await ensureAgentsMd(adapter)
    const claude = await ensureClaudeMd(adapter)
    return { agents, claude }
}
