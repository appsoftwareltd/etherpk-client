import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { isWorkspaceAddress } from '#lib/install/launch-target.js'

import { documentUrl } from './document-url'
import type { GraphAddress } from './graph-address'
import { type AddressPlace, pageLink, readableAddress, readAddress } from './page-address'

/**
 * The page's address, over every name a page can have: what the field shows reads back to the page
 * it was copied from, and nothing a person types leads anywhere but a page of notes.
 *
 * Fixed seed and run count, so a failure reproduces. `PAGE_ADDRESS_FUZZ_RUNS` and
 * `PAGE_ADDRESS_FUZZ_SEED` change them for a longer local run, or to replay a seed a failure printed.
 */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.PAGE_ADDRESS_FUZZ_SEED
    return { numRuns: Number(process.env.PAGE_ADDRESS_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261126 : Number(seed) }
}

const PLACES: AddressPlace[] = [
    { origin: 'https://app.example.test', webOrigin: null, native: false },
    { origin: 'http://localhost:5288', webOrigin: null, native: false },
    { origin: 'app://etherpk', webOrigin: 'https://app.example.test', native: true },
    { origin: 'https://installed.app.example.test', webOrigin: null, native: true },
]

/** Characters a name is made of, weighted towards the ones an address treats specially. */
const nameChar = fc.oneof(
    { weight: 4, arbitrary: fc.constantFrom('a', 'B', '1', ' ', '-', '_') },
    { weight: 3, arbitrary: fc.constantFrom('/', '?', '#', '%', '\\', '&', '=', '+', '@', ':', '.', "'", '"', '<', '>', '|', '^', '`', '{', '}', '[', ']', '~', '!', '*', '(', ')', ';', ',', '$') },
    { weight: 2, arbitrary: fc.constantFrom('\t', '\n', ' ', ' ', '\u0007', '\u007f') },
    { weight: 2, arbitrary: fc.constantFrom('é', 'ß', '日', '😀', 'ﬁ', 'Å') },
)

/**
 * A page's name. A part of `.` or `..`, or an empty one, is left out: a web address folds those away,
 * so the app's own address for such a name already leads somewhere else, before any field reads it.
 */
const pageName = fc
    .array(nameChar, { minLength: 1, maxLength: 24 })
    .map((chars) => chars.join(''))
    .filter((name) => name.split('/').every((part) => part !== '' && part !== '.' && part !== '..'))

const graph: fc.Arbitrary<GraphAddress> = fc.oneof(
    fc.uuid().map((name) => ({ where: 'sync' as const, name })),
    pageName.filter((name) => !name.includes('/')).map((name) => ({ where: 'folder' as const, name })),
)

/** A fragment the app writes: a task, or none. */
const fragment = fc.oneof(fc.constant(''), fc.tuple(fc.nat(500), fc.stringMatching(/^[0-9a-f]{12}$/)).map(([line, print]) => `#task=${line}-${print}`))

describe('the address a person sees', () => {
    it('reads back to the page it was copied from, wherever the app runs', () => {
        fc.assert(
            fc.property(graph, pageName, fragment, fc.constantFrom(...PLACES), (where, name, hash, place) => {
                const path = `${documentUrl(where, name)}${hash}`
                const shown = readableAddress(pageLink(path, place))
                expect(readAddress(shown, place)).toEqual({ ok: true, path })
            }),
            fuzz(500),
        )
    })

    it('reads back from the link as copied, unescaped or not', () => {
        fc.assert(
            fc.property(graph, pageName, fc.constantFrom(...PLACES), (where, name, place) => {
                const path = documentUrl(where, name)
                expect(readAddress(pageLink(path, place), place)).toEqual({ ok: true, path })
            }),
            fuzz(300),
        )
    })
})

describe('what a person types', () => {
    const typed = fc.oneof(
        fc.string(),
        fc.string().map((text) => `etherpk:${text}`),
        fc.webPath().map((path) => `/graph/sync${path}`),
        fc.webUrl({ withQueryParameters: true, withFragments: true }),
        fc.tuple(fc.constantFrom(...PLACES), fc.webPath()).map(([place, path]) => `${place.origin}${path}`),
        fc.array(fc.oneof(fc.string(), fc.webPath().map((path) => `etherpk:/graph/sync${path}`)), { maxLength: 4 }).map((lines) => lines.join('\n')),
    )

    it('leads only to a page of notes of this app, and reads the same a second time', () => {
        fc.assert(
            fc.property(typed, fc.constantFrom(...PLACES), (text, place) => {
                const reading = readAddress(text, place)
                if (!reading.ok) return
                expect(reading.path.startsWith('/')).toBe(true)
                const url = new URL(reading.path, 'https://address.invalid')
                expect(url.origin).toBe('https://address.invalid')
                expect(isWorkspaceAddress(url.pathname)).toBe(true)
                expect(readAddress(reading.path, place)).toEqual(reading)
            }),
            fuzz(1000),
        )
    })
})
