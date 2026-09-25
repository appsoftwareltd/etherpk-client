import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChangeOrigin, EditorDocument, TextChange } from '../types'
import { CIPHER_FENCE_INFO } from './fence-info'
import {
    PROTECTED_MAX_WAIT_MS,
    PROTECTED_SETTLE_MS,
    ProtectedEditorDocument,
    applyTextChange,
} from './protected-document'

/** A fence whose armoured body encodes its own plaintext, so a fake decrypt can be exact. */
const fence = (body: string) => [`\`\`\`${CIPHER_FENCE_INFO}`, `ARMOURED(${body})`, '```'].join('\n')
const FRONTMATTER = '---\ntitle: Bank\n---\n'
/** A Protected Document: frontmatter in the clear, the body one fence. */
const protectedDoc = (body: string, frontmatter = FRONTMATTER) => frontmatter + fence(body)

/** A minimal in-memory EditorDocument, so the decorator is tested without a store. */
function fakeDocument(initial: string) {
    let text = initial
    const listeners = new Set<(t: string) => void>()
    /** The origin of every write, in order - what a store decides persistence and echo from. */
    const origins: ChangeOrigin[] = []
    const doc: EditorDocument = {
        id: 'doc-1',
        getText: () => text,
        applyChange(change: TextChange, origin: ChangeOrigin = 'editor') {
            origins.push(origin)
            text = applyTextChange(text, change)
        },
        subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
    }
    return {
        doc,
        origins,
        get text() {
            return text
        },
        external(next: string) {
            text = next
            for (const l of listeners) l(next)
        },
    }
}

function build(stored: string, options: { locked?: boolean } = {}) {
    const inner = fakeDocument(stored)
    let locked = options.locked ?? false
    let clock = 0
    /** Set to hold every `encrypt` open until released — for testing the mid-seal edit race. */
    let gate: { release: () => void; waited: Promise<void> } | null = null
    const wrapped = new ProtectedEditorDocument(inner.doc, {
        encrypt: async (plaintext) => {
            if (locked) throw new Error('locked')
            if (gate) await gate.waited
            return `ARMOURED(${plaintext})`
        },
        decryptEnvelope: async (armoured) => {
            if (locked) throw new Error('locked')
            const match = /^ARMOURED\((.*)\)$/s.exec(armoured)
            if (!match) throw new Error('not ours')
            return match[1]
        },
        now: () => clock,
    })
    return {
        inner,
        wrapped,
        lock: () => (locked = true),
        unlockKey: () => (locked = false),
        advance: (ms: number) => (clock += ms),
        /** Make every subsequent `encrypt` hang until the returned function is called. */
        holdEncrypt() {
            let release = (): void => {}
            const waited = new Promise<void>((resolve) => {
                release = resolve
            })
            gate = { release, waited }
            return () => {
                gate = null
                release()
            }
        },
    }
}

/** What the editor shows for a projected document: the frontmatter, then the body. */
const projected = (body: string, frontmatter = FRONTMATTER) => frontmatter + body

/** Replace the whole projected body, leaving the frontmatter alone. */
function replaceBody(wrapped: ProtectedEditorDocument, next: string, frontmatter = FRONTMATTER) {
    wrapped.applyChange({ from: frontmatter.length, to: wrapped.getText().length, insert: next })
}

/** Retitle the fixture's frontmatter in place: `title: Bank` → `title: <next>`. */
function retitle(wrapped: ProtectedEditorDocument, next: string, origin?: 'editor' | 'external') {
    const from = '---\ntitle: '.length
    wrapped.applyChange({ from, to: from + 'Bank'.length, insert: next }, origin)
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('applying a change to a string', () => {
    it('replaces the range, matching CodeMirror’s shape', () => {
        expect(applyTextChange('hello world', { from: 6, to: 11, insert: 'there' })).toBe('hello there')
        expect(applyTextChange('ab', { from: 1, to: 1, insert: 'X' })).toBe('aXb')
    })
})

// The projection is the stored frontmatter — shown, because it is the part that is NOT protected
// — followed by the decrypted body.
describe('projecting a Protected Document', () => {
    it('shows the frontmatter above the decrypted body', async () => {
        const { wrapped } = build(protectedDoc('- the secret\n- and another'))

        await wrapped.unlock()

        expect(wrapped.getText()).toBe(projected('- the secret\n- and another'))
    })

    it('leaves the stored document as ciphertext', async () => {
        const stored = protectedDoc('secret')
        const { inner, wrapped } = build(stored)

        await wrapped.unlock()

        expect(inner.text).toBe(stored)
    })

    it('projects a document with no frontmatter too', async () => {
        const { wrapped } = build(protectedDoc('secret', ''))
        await wrapped.unlock()
        expect(wrapped.getText()).toBe('secret')
    })

    it('does not project at all while locked', async () => {
        const stored = protectedDoc('secret')
        const { wrapped } = build(stored, { locked: true })

        await wrapped.unlock()

        expect(wrapped.getText()).toBe(stored)
        expect(wrapped.isProjecting).toBe(false)
    })

    it('leaves a fence it cannot open as it is', async () => {
        const stored = FRONTMATTER + '```etherpk-cipher\nNOT-OURS\n```'
        const { wrapped } = build(stored)
        await wrapped.unlock()
        expect(wrapped.getText()).toBe(stored)
        expect(wrapped.isProjecting).toBe(false)
    })

    // Protection is whole-document only (ADR 0060): a fence among other content is markdown.
    it('does not project a fence that is not the whole body', async () => {
        const stored = ['prose', fence('not a protected document'), 'more prose'].join('\n')
        const { wrapped } = build(stored)
        await wrapped.unlock()
        expect(wrapped.getText()).toBe(stored)
        expect(wrapped.isProtected).toBe(false)
    })

    it('reads the stored classification, never the projection', async () => {
        const { wrapped } = build(protectedDoc('secret'))
        await wrapped.unlock()
        expect(wrapped.isProtected).toBe(true)
        expect(wrapped.protectionKind).toBe('document')
    })
})

describe('editing the projected body', () => {
    const stored = protectedDoc('secret')

    it('re-encrypts only once the body has settled', async () => {
        const { inner, wrapped, advance } = build(stored)
        await wrapped.unlock()

        wrapped.applyChange({ from: FRONTMATTER.length + 1, to: FRONTMATTER.length + 1, insert: 'X' })
        advance(500)
        await vi.advanceTimersByTimeAsync(500)
        expect(inner.text).toContain('ARMOURED(secret)')

        advance(PROTECTED_SETTLE_MS)
        await vi.advanceTimersByTimeAsync(PROTECTED_SETTLE_MS)
        expect(inner.text).toContain('ARMOURED(sXecret)')
    })

    it('re-encrypts at the cap even while typing continues', async () => {
        const { inner, wrapped, advance } = build(stored)
        await wrapped.unlock()

        for (let elapsed = 0; elapsed <= PROTECTED_MAX_WAIT_MS; elapsed += 1_000) {
            wrapped.applyChange({ from: FRONTMATTER.length + 1, to: FRONTMATTER.length + 1, insert: 'x' })
            advance(1_000)
            await vi.advanceTimersByTimeAsync(1_000)
        }
        await vi.advanceTimersByTimeAsync(PROTECTED_SETTLE_MS)

        expect(inner.text).not.toContain('ARMOURED(secret)')
    })

    // The frontmatter is re-read from the store at commit, never carried from the projection.
    it('writes the frontmatter back verbatim around the fresh fence', async () => {
        const { inner, wrapped } = build(stored)
        await wrapped.unlock()
        replaceBody(wrapped, 'changed')

        await wrapped.commit()

        expect(inner.text).toBe(FRONTMATTER + fence('changed'))
    })

    // A rename is the one legitimate way the frontmatter changes, and it lands underneath an
    // open editor through the store. The fence is the one we already opened, so the body — and
    // anything typed into it since — must survive; only the frontmatter moves.
    it('carries a rename that lands underneath, keeping an edited body', async () => {
        const { inner, wrapped } = build(stored)
        const seen: string[] = []
        await wrapped.unlock()
        wrapped.subscribe((t) => seen.push(t))
        replaceBody(wrapped, 'typed before the rename')

        inner.external('---\ntitle: Savings\n---\n' + fence('secret'))
        await vi.advanceTimersByTimeAsync(0)

        expect(wrapped.getText()).toBe('---\ntitle: Savings\n---\n' + 'typed before the rename')
        expect(seen.at(-1)).toBe(wrapped.getText())
        expect(wrapped.isDirty).toBe(true)

        await wrapped.commit()
        expect(inner.text).toBe('---\ntitle: Savings\n---\n' + fence('typed before the rename'))
    })

    it('writes a frontmatter edit through at once, as a change to the prefix alone', async () => {
        const { inner, wrapped } = build(stored)
        await wrapped.unlock()
        const applied = vi.spyOn(inner.doc, 'applyChange')

        retitle(wrapped, 'Savings')

        // Plaintext metadata needs no settle: the store has it before any timer runs...
        expect(wrapped.getText()).toBe('---\ntitle: Savings\n---\nsecret')
        expect(inner.text).toBe('---\ntitle: Savings\n---\n' + fence('secret'))
        // ...and the fence was not rewritten to get it there (ADR 0028: no churn for other members).
        expect(applied).toHaveBeenCalledTimes(1)
        expect(applied.mock.calls[0][0]).toEqual({ from: 0, to: FRONTMATTER.length, insert: '---\ntitle: Savings\n---\n' })
        expect(wrapped.isDirty).toBe(false)
    })

    it('echoes a frontmatter write-back from outside the editor to its listeners', async () => {
        const { wrapped } = build(stored)
        await wrapped.unlock()
        const seen: string[] = []
        wrapped.subscribe((t) => seen.push(t))

        retitle(wrapped, 'Savings', 'external')

        expect(seen.at(-1)).toBe('---\ntitle: Savings\n---\nsecret')
    })

    it('re-splits when an edit crosses the block boundary: what is no longer frontmatter is body', async () => {
        const { inner, wrapped } = build(stored)
        await wrapped.unlock()

        // Delete the closing delimiter line - the editor's guard refuses this; the wrapper is honest if it lands.
        wrapped.applyChange({ from: FRONTMATTER.length - 4, to: FRONTMATTER.length, insert: '' })

        expect(wrapped.getText()).toBe('---\ntitle: Bank\nsecret')
        expect(wrapped.isDirty).toBe(true)
        await wrapped.commit()
        expect(inner.text).toBe(fence('---\ntitle: Bank\nsecret'))
    })

    it('forwards a frontmatter edit straight to the store while locked', () => {
        const { inner, wrapped } = build(stored, { locked: true })

        retitle(wrapped, 'Savings')

        expect(inner.text).toBe('---\ntitle: Savings\n---\n' + fence('secret'))
        expect(wrapped.getText()).toBe(inner.text)
    })

    it('keeps a block typed below the existing frontmatter as body', async () => {
        const { inner, wrapped } = build(stored)
        await wrapped.unlock()
        replaceBody(wrapped, '---\ntitle: Evil\n---\nbody')

        await wrapped.commit()

        expect(inner.text.startsWith(FRONTMATTER)).toBe(true)
        expect(inner.text).toContain('ARMOURED(---\ntitle: Evil\n---\nbody)')
    })

    it('a block typed at the top of a document that had none becomes frontmatter, written at the next commit', async () => {
        const { inner, wrapped } = build(protectedDoc('secret', ''))
        await wrapped.unlock()

        replaceBody(wrapped, '---\ntitle: Bank\n---\nsecret', '')

        // Shown as frontmatter at once, but the lines it took were body a keystroke ago, so the
        // store learns of it with the body's own commit, not immediately.
        expect(wrapped.getText()).toBe('---\ntitle: Bank\n---\nsecret')
        expect(inner.text).toBe(fence('secret'))
        expect(wrapped.isDirty).toBe(true)
        await wrapped.commit()
        expect(inner.text).toBe('---\ntitle: Bank\n---\n' + fence('secret'))
    })

    it('refuses an existing block growing to take in body text', async () => {
        const { inner, wrapped } = build(protectedDoc('secret line\n---\nmore'))
        await wrapped.unlock()

        // Delete the closing delimiter line: the rule below would close the block around the secret.
        wrapped.applyChange({ from: FRONTMATTER.length - 4, to: FRONTMATTER.length, insert: '' })

        expect(wrapped.getText()).toBe(projected('secret line\n---\nmore'))
        expect(inner.text).toBe(protectedDoc('secret line\n---\nmore'))
    })

    it('writes an untouched body back as the exact envelope it came from', async () => {
        const { inner, wrapped } = build(stored)
        await wrapped.unlock()
        await wrapped.commit()
        expect(inner.text).toBe(stored)
    })
})

describe('the forced commit', () => {
    const stored = protectedDoc('secret')

    it('re-encrypts a body that has not settled', async () => {
        const { inner, wrapped } = build(stored)
        await wrapped.unlock()
        replaceBody(wrapped, 'changed')

        await wrapped.commit()

        expect(inner.text).toContain('ARMOURED(changed)')
    })

    it('writes nothing when nothing changed', async () => {
        const { inner, wrapped } = build(stored)
        await wrapped.unlock()
        const before = inner.text

        await wrapped.commit()

        expect(inner.text).toBe(before)
    })
})

describe('relocking', () => {
    const stored = protectedDoc('secret')

    it('commits pending work before dropping the plaintext', async () => {
        const { inner, wrapped } = build(stored)
        await wrapped.unlock()
        replaceBody(wrapped, 'changed')

        await wrapped.relock()

        expect(inner.text).toContain('ARMOURED(changed)')
    })

    it('pushes the ciphertext back, so no decrypted text is left on screen', async () => {
        const { wrapped } = build(stored)
        const seen: string[] = []
        await wrapped.unlock()
        wrapped.subscribe((t) => seen.push(t))

        await wrapped.relock()

        expect(wrapped.isProjecting).toBe(false)
        expect(seen.at(-1)).toContain(CIPHER_FENCE_INFO)
    })

    it('cancels the pending save, so nothing fires after the key has gone', async () => {
        const { inner, wrapped } = build(stored)
        await wrapped.unlock()
        wrapped.applyChange({ from: 0, to: 0, insert: 'X' })

        await wrapped.relock()
        const after = inner.text
        await vi.advanceTimersByTimeAsync(PROTECTED_MAX_WAIT_MS * 2)

        expect(inner.text).toBe(after)
    })
})

// Sealing is asynchronous, so an edit can always land between reading the projection and writing
// the result. Getting this wrong is unrecoverable at exactly one moment - the forced commit before
// a lock, where the plaintext is dropped immediately afterwards.
describe('an edit landing mid-commit', () => {
    const stored = protectedDoc('secret')

    it('is not lost by the forced commit that precedes a relock', async () => {
        const { inner, wrapped, holdEncrypt } = build(stored)
        await wrapped.unlock()
        replaceBody(wrapped, 'first')

        const release = holdEncrypt()
        const relocking = wrapped.relock()
        await Promise.resolve()
        replaceBody(wrapped, 'second')
        release()
        await relocking

        expect(inner.text).toContain('ARMOURED(second)')
        expect(inner.text).not.toContain('ARMOURED(first)')
    })

    it('does not have a stale seal recorded against it by the autosave', async () => {
        const { inner, wrapped, advance, holdEncrypt } = build(stored)
        await wrapped.unlock()
        replaceBody(wrapped, 'first')
        advance(PROTECTED_SETTLE_MS)

        const release = holdEncrypt()
        const saving = vi.advanceTimersByTimeAsync(PROTECTED_SETTLE_MS)
        await Promise.resolve()
        replaceBody(wrapped, 'second')
        release()
        await saving

        advance(PROTECTED_SETTLE_MS)
        await wrapped.commit()
        expect(inner.text).toContain('ARMOURED(second)')
    })
})

describe('overlapping re-projections', () => {
    it('leave the projection matching the newest stored text', async () => {
        const { inner, wrapped } = build(protectedDoc('one'))
        await wrapped.unlock()

        inner.external(protectedDoc('two'))
        inner.external(protectedDoc('three'))
        await vi.advanceTimersByTimeAsync(0)

        expect(wrapped.getText()).toBe(projected('three'))
    })
})

describe('an external change to the stored document', () => {
    it('is forwarded verbatim when not projecting', async () => {
        const { inner, wrapped } = build('# Notes')
        const seen: string[] = []
        wrapped.subscribe((t) => seen.push(t))

        inner.external('# Notes edited elsewhere')

        expect(seen).toEqual(['# Notes edited elsewhere'])
    })

    it('re-projects while projecting, so the editor never sees ciphertext', async () => {
        const { inner, wrapped } = build(protectedDoc('one'))
        const seen: string[] = []
        await wrapped.unlock()
        wrapped.subscribe((t) => seen.push(t))

        inner.external(protectedDoc('two'))
        await vi.advanceTimersByTimeAsync(0)

        expect(seen.at(-1)).toBe(projected('two'))
        expect(seen.some((t) => t.includes(CIPHER_FENCE_INFO))).toBe(false)
    })

    it('falls back to the stored text when the document stops being protected', async () => {
        const { inner, wrapped } = build(protectedDoc('one'))
        const seen: string[] = []
        await wrapped.unlock()
        wrapped.subscribe((t) => seen.push(t))

        inner.external('# plain again')
        await vi.advanceTimersByTimeAsync(0)

        expect(wrapped.isProjecting).toBe(false)
        expect(seen.at(-1)).toBe('# plain again')
    })
})

// Every synced document on a fresh page, and every filesystem document on first open, seeds AFTER
// its editor has mounted and opened it. If the key is already held, nothing else would attempt a
// projection until the next lock transition.
describe('the stored text arriving after open', () => {
    it('projects on its own once a fence appears, while the key is held', async () => {
        const { inner, wrapped } = build('')
        const seen: string[] = []
        wrapped.subscribe((t) => seen.push(t))
        await wrapped.unlock()
        expect(wrapped.isProjecting).toBe(false)

        inner.external(protectedDoc('late secret'))
        await vi.advanceTimersByTimeAsync(0)

        expect(wrapped.isProjecting).toBe(true)
        expect(seen.at(-1)).toBe(projected('late secret'))
    })

    it('shows the fence, and stays that way, while the key is not held', async () => {
        const { inner, wrapped } = build('', { locked: true })
        const seen: string[] = []
        wrapped.subscribe((t) => seen.push(t))

        inner.external(protectedDoc('late secret'))
        await vi.advanceTimersByTimeAsync(0)

        expect(wrapped.isProjecting).toBe(false)
        expect(seen.at(-1)).toBe(protectedDoc('late secret'))
    })
})

// A protection change written through the RAW store is invisible to the projection: a store
// notifies only remote and external writes. Left alone, the stale projection re-encrypted the old
// body over the plaintext on its next save and the page was silently protected again.
describe('reproject', () => {
    it('drops a projection whose document was unprotected underneath it', async () => {
        const { inner, wrapped } = build(protectedDoc('secret'))
        const seen: string[] = []
        await wrapped.unlock()
        wrapped.subscribe((t) => seen.push(t))
        inner.doc.applyChange({ from: 0, to: inner.text.length, insert: FRONTMATTER + 'secret' }, 'external')

        await wrapped.reproject()
        wrapped.applyChange({ from: FRONTMATTER.length, to: FRONTMATTER.length, insert: 'X' })
        await vi.advanceTimersByTimeAsync(PROTECTED_MAX_WAIT_MS * 2)

        expect(wrapped.isProjecting).toBe(false)
        expect(seen.at(-1)).toBe(FRONTMATTER + 'secret')
        expect(inner.text).not.toContain(CIPHER_FENCE_INFO)
    })

    it('projects a document that was protected underneath it', async () => {
        const { inner, wrapped } = build(FRONTMATTER + 'plain')
        await wrapped.unlock()
        inner.doc.applyChange({ from: 0, to: inner.text.length, insert: protectedDoc('plain') }, 'external')

        await wrapped.reproject()

        expect(wrapped.getText()).toBe(projected('plain'))
    })
})

describe('protect, in one step', () => {
    it('writes the fence and projects the sealed body over it, so no listener ever hears the fence', () => {
        const { inner, wrapped } = build(FRONTMATTER + 'plain')
        const seen: string[] = []
        wrapped.subscribe((t) => seen.push(t))

        expect(wrapped.protect('ARMOURED(plain)', 'plain')).toBe(true)

        expect(inner.text).toBe(protectedDoc('plain'))
        expect(wrapped.isProjecting).toBe(true)
        expect(wrapped.getText()).toBe(projected('plain'))
        // The text every listener shows is what the projection reads as, so nothing to say -
        // and certainly not the fence, which is what write-then-reproject flashed as a card.
        expect(seen).toEqual([])
    })

    it('writes the fence as an external change, the origin a collaborative undo manager does not track', () => {
        // Under the default origin the plaintext it deletes would be pinned against garbage
        // collection and serialised into every later state (server-document-store.ts).
        const { inner, wrapped } = build(FRONTMATTER + 'plain')

        wrapped.protect('ARMOURED(plain)', 'plain')

        expect(inner.origins).toEqual(['external'])
    })

    it('refuses a document that is already protected, writing nothing', async () => {
        const { inner, wrapped } = build(protectedDoc('secret'))
        await wrapped.unlock()

        expect(wrapped.protect('ARMOURED(other)', 'other')).toBe(false)

        expect(inner.text).toBe(protectedDoc('secret'))
        expect(wrapped.getText()).toBe(projected('secret'))
    })

    it('is a projection like any other afterwards: an edit re-encrypts on the settle, a lock drops it', async () => {
        const { inner, wrapped, advance } = build(FRONTMATTER + 'plain')
        wrapped.protect('ARMOURED(plain)', 'plain')

        wrapped.applyChange({ from: projected('plain').length, to: projected('plain').length, insert: '!' })
        advance(PROTECTED_SETTLE_MS)
        await vi.advanceTimersByTimeAsync(PROTECTED_SETTLE_MS)
        expect(inner.text).toBe(protectedDoc('plain!'))

        await wrapped.relock()
        expect(wrapped.isProjecting).toBe(false)
        expect(wrapped.getText()).toBe(protectedDoc('plain!'))
    })

    it('keeps the body when a rename lands underneath, recognising the fence it wrote', async () => {
        const { inner, wrapped } = build(FRONTMATTER + 'plain')
        wrapped.protect('ARMOURED(plain)', 'plain')
        const renamed = '---\ntitle: Vault\n---\n'

        inner.external(protectedDoc('plain', renamed))
        await vi.advanceTimersByTimeAsync(0)

        expect(wrapped.getText()).toBe(renamed + 'plain')
    })
})

describe('disposal', () => {
    it('drops the plaintext and stops listening', async () => {
        const { inner, wrapped } = build(protectedDoc('secret'))
        await wrapped.unlock()
        const seen: string[] = []
        wrapped.subscribe((t) => seen.push(t))

        wrapped.dispose()
        inner.external(protectedDoc('later'))
        await vi.advanceTimersByTimeAsync(0)

        expect(wrapped.isProjecting).toBe(false)
        expect(seen).toEqual([])
    })
})

describe('while nothing is projected, the stored fence is the document', () => {
    const stored = protectedDoc('secret')

    it('drops an editor change into the fence interior - what an undo past the guard would send', () => {
        const { inner, wrapped } = build(stored, { locked: true })
        const inside = stored.indexOf('ARMOURED') + 3

        wrapped.applyChange({ from: inside, to: inside, insert: 'x' })
        wrapped.applyChange({ from: FRONTMATTER.length, to: stored.length, insert: 'the plaintext, back again' })

        expect(inner.text).toBe(stored)
    })

    it('drops an editor change that would leave the document unprotected', () => {
        const { inner, wrapped } = build(fence('secret'), { locked: true })

        wrapped.applyChange({ from: 0, to: 0, insert: 'x' })

        expect(inner.text).toBe(fence('secret'))
    })

    it('still allows deleting the fence whole, and editing the frontmatter', () => {
        const { inner, wrapped } = build(stored, { locked: true })

        retitle(wrapped, 'Savings')
        expect(inner.text).toBe('---\ntitle: Savings\n---\n' + fence('secret'))
        const from = '---\ntitle: Savings\n---\n'.length
        wrapped.applyChange({ from, to: inner.text.length, insert: '' })
        expect(inner.text).toBe('---\ntitle: Savings\n---\n')
    })

    it('lets an external write through untouched', () => {
        const { inner, wrapped } = build(stored, { locked: true })

        wrapped.applyChange({ from: 0, to: stored.length, insert: 'reloaded from disk' }, 'external')

        expect(inner.text).toBe('reloaded from disk')
    })
})

describe('masking (ADR 0058)', () => {
    const stored = protectedDoc('secret')

    it('shows the fence to the editor while keeping the body, and shows the body again without decrypting', async () => {
        const { inner, wrapped, lock } = build(stored)
        await wrapped.unlock()
        const seen: string[] = []
        wrapped.subscribe((t) => seen.push(t))
        replaceBody(wrapped, 'secret, edited')

        wrapped.mask()

        expect(wrapped.isMasked).toBe(true)
        expect(wrapped.getText()).toBe(stored)
        expect(seen.at(-1)).toBe(stored)
        // The key may be gone from the service's point of view while masked; unmasking must
        // not need it.
        lock()
        wrapped.unmask()

        expect(wrapped.isMasked).toBe(false)
        expect(wrapped.getText()).toBe(projected('secret, edited'))
        expect(seen.at(-1)).toBe(projected('secret, edited'))
        expect(wrapped.isDirty).toBe(true)
        expect(inner.text).toBe(stored)
    })

    it('treats edits while masked as edits to a locked document', async () => {
        const { inner, wrapped } = build(stored)
        await wrapped.unlock()
        wrapped.mask()

        const inside = stored.indexOf('ARMOURED') + 3
        wrapped.applyChange({ from: inside, to: inside, insert: 'x' })
        retitle(wrapped, 'Savings')

        expect(inner.text).toBe('---\ntitle: Savings\n---\n' + fence('secret'))
        wrapped.unmask()
        // The frontmatter edited through the store while masked is adopted; the body is the kept one.
        expect(wrapped.getText()).toBe('---\ntitle: Savings\n---\nsecret')
    })

    it('still commits and relocks from behind the mask', async () => {
        const { inner, wrapped } = build(stored)
        await wrapped.unlock()
        replaceBody(wrapped, 'secret, edited')
        wrapped.mask()

        await wrapped.relock()

        expect(inner.text).toBe(protectedDoc('secret, edited'))
        expect(wrapped.isProjecting).toBe(false)
        expect(wrapped.getText()).toBe(inner.text)
    })

    it('is a no-op on a document that is not projecting', () => {
        const { wrapped } = build(stored, { locked: true })
        wrapped.mask()
        expect(wrapped.isMasked).toBe(false)
        expect(wrapped.getText()).toBe(stored)
    })
})
