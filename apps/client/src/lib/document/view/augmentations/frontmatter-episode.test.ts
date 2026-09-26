import { describe, expect, it } from 'vitest'

import { FrontmatterEpisode } from './frontmatter-episode'

const END = 20 // '---\ntitle: Kanban\n---' → last offset inside the block

const typing = (caret: number, from = 11) => ({
    blockEndBefore: END,
    blockEndAfter: END + 1,
    changes: [{ from, to: from }],
    caret,
    focused: true,
})
const move = (caret: number, focused = true) => ({
    blockEndBefore: END,
    blockEndAfter: END,
    changes: [],
    caret,
    focused,
})

describe('FrontmatterEpisode', () => {
    it('does not end while the caret is still typing inside the block', () => {
        const episode = new FrontmatterEpisode()
        expect(episode.update(typing(12))).toBe(false)
        expect(episode.update(typing(13))).toBe(false)
    })

    it('ends when the caret leaves the block after an edit, once', () => {
        const episode = new FrontmatterEpisode()
        episode.update(typing(12))
        expect(episode.update(move(END + 5))).toBe(true)
        expect(episode.update(move(END + 6))).toBe(false)
    })

    it('ends when the editor loses focus with the caret still inside', () => {
        const episode = new FrontmatterEpisode()
        episode.update(typing(12))
        expect(episode.update(move(12, false))).toBe(true)
    })

    it('does not end for caret movement alone', () => {
        const episode = new FrontmatterEpisode()
        expect(episode.update(move(12))).toBe(false)
        expect(episode.update(move(END + 5))).toBe(false)
        expect(episode.update(move(12, false))).toBe(false)
    })

    it('ignores edits below the block', () => {
        const episode = new FrontmatterEpisode()
        expect(episode.update({ ...typing(END + 9, END + 8), blockEndAfter: END })).toBe(false)
        expect(episode.update(move(END + 30))).toBe(false)
    })

    it('ends at once for an edit to the block made with the caret already outside it', () => {
        const episode = new FrontmatterEpisode()
        // A paste that replaced the whole document, caret landing in the body.
        expect(episode.update({ blockEndBefore: END, blockEndAfter: END + 3, changes: [{ from: 0, to: 40 }], caret: 60, focused: true })).toBe(true)
    })

    it('counts a block appearing or vanishing as touched', () => {
        const appears = new FrontmatterEpisode()
        expect(appears.update({ blockEndBefore: -1, blockEndAfter: END, changes: [{ from: 0, to: 0 }], caret: 5, focused: true })).toBe(false)
        expect(appears.update(move(END + 5))).toBe(true)
        const vanishes = new FrontmatterEpisode()
        expect(vanishes.update({ blockEndBefore: END, blockEndAfter: -1, changes: [{ from: 17, to: 21 }], caret: 17, focused: true })).toBe(true)
    })

    it('says whether an episode is open', () => {
        const episode = new FrontmatterEpisode()
        expect(episode.open).toBe(false)
        episode.update(typing(12))
        expect(episode.open).toBe(true)
        episode.update(move(END + 5))
        expect(episode.open).toBe(false)
    })

    // A block the person typed in this episode has made no claim about aliases yet: without an
    // `aliases:` line it must not clear the ones the registry holds (ADR 0061).
    it('says whether the block it touched was created during the episode', () => {
        const typed = new FrontmatterEpisode()
        // The closing delimiter typed: the block appears, with the caret still inside it.
        expect(typed.update({ blockEndBefore: -1, blockEndAfter: END, changes: [{ from: 18, to: 18 }], caret: 19, focused: true })).toBe(false)
        typed.update(typing(12))
        expect(typed.update(move(END + 5))).toBe(true)
        expect(typed.blockIsNew).toBe(true)

        const edited = new FrontmatterEpisode()
        edited.update(typing(12))
        expect(edited.update(move(END + 5))).toBe(true)
        expect(edited.blockIsNew).toBe(false)

        // Each episode is judged on its own start: the next one finds the block already there.
        typed.update(typing(12))
        expect(typed.update(move(END + 5))).toBe(true)
        expect(typed.blockIsNew).toBe(false)
    })

    it('reports a touched block when the editor closes', () => {
        const episode = new FrontmatterEpisode()
        episode.update(typing(12))
        expect(episode.close()).toBe(true)
        expect(episode.close()).toBe(false)
    })
})
