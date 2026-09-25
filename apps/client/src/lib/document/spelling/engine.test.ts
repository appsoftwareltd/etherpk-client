/**
 * The Hunspell engine over a small committed fixture dictionary (`fixtures/test.aff|dic`): a
 * suffix rule, compounding, replacement pairs and the case rules, run through the real WASM
 * build under Node.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Hunspell, getWasmModule } from 'hunspell-wasm'
import { beforeAll, describe, expect, it } from 'vitest'

import { SpellEngine, type HunspellFactory } from './engine'

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
const AFF = fixture('test.aff')
const DIC = fixture('test.dic')

/** The fixture again as a second "language": only these words. */
const OTHER_AFF = 'SET UTF-8\n'
const OTHER_DIC = '2\nBuch\nNotiz\n'

let factory: HunspellFactory
beforeAll(async () => {
    const module = await getWasmModule()
    factory = async (aff, dic) => new Hunspell(module, aff, dic)
})

describe('SpellEngine', () => {
    it('accepts dictionary words, their affixed forms and compounds, and rejects the rest', async () => {
        const engine = new SpellEngine(factory)
        await engine.load('test', AFF, DIC)
        expect(engine.check(['word', 'words', 'notebook', 'colours', 'wrod', 'teh'])).toEqual([
            true,
            true,
            true,
            true,
            false,
            false,
        ])
    })

    it('follows Hunspell’s case rules', async () => {
        const engine = new SpellEngine(factory)
        await engine.load('test', AFF, DIC)
        // A capitalised entry accepts itself and all capitals, never lower case; a lower-case one
        // accepts every capitalisation.
        expect(engine.check(['London', 'LONDON', 'london', 'Word', 'WORD'])).toEqual([true, true, false, true, true])
    })

    it('checks a curly apostrophe as the dictionary spells it', async () => {
        const engine = new SpellEngine(factory)
        await engine.load('test', "SET UTF-8\nWORDCHARS '\n", "1\ndon't\n")
        expect(engine.check(['don’t'])).toEqual([true])
    })

    it('suggests corrections, the replacement pairs first', async () => {
        const engine = new SpellEngine(factory)
        await engine.load('test', AFF, DIC)
        expect(engine.suggest('wrod')[0]).toBe('word')
        expect(engine.suggest('teh')[0]).toBe('the')
        expect(engine.suggest('wrod', 1)).toHaveLength(1)
    })

    it('accepts a word any loaded language accepts, and merges their suggestions', async () => {
        const engine = new SpellEngine(factory)
        await engine.load('test', AFF, DIC)
        await engine.load('other', OTHER_AFF, OTHER_DIC)
        expect(engine.check(['word', 'Notiz', 'nonsenze'])).toEqual([true, true, false])
        expect(engine.loaded()).toEqual(['test', 'other'])
        engine.unload('other')
        expect(engine.check(['Notiz'])).toEqual([false])
    })

    it('accepts the Graph Dictionary’s words under the same case rules, in every language, including one loaded later', async () => {
        const engine = new SpellEngine(factory)
        await engine.load('test', AFF, DIC)
        engine.setWords(['sidney', 'EtherPK'])
        expect(engine.check(['sidney', 'Sidney', 'EtherPK'])).toEqual([true, true, true])
        await engine.load('other', OTHER_AFF, OTHER_DIC)
        engine.unload('test')
        expect(engine.check(['Sidney'])).toEqual([true])
        engine.setWords(['EtherPK'])
        expect(engine.check(['sidney'])).toEqual([false])
    })

    it('leaves alone a word in a script no loaded language is written in', async () => {
        // A browser set to Chinese and English gets an English dictionary only (there is no
        // Chinese one): its Chinese, Thai or Russian words are not misspellings of English.
        const engine = new SpellEngine(factory)
        await engine.load('test', AFF, DIC)
        expect(engine.check(['我们', 'สวัสดี', 'Привет', 'wrod'])).toEqual([true, true, true, false])
        await engine.load('ru', 'SET UTF-8\n', '1\nПривет\n')
        expect(engine.check(['Привет', 'Првет', '我们'])).toEqual([true, false, true])
    })

    it('judges nothing wrong with no language loaded', () => {
        expect(new SpellEngine(factory).check(['wrod'])).toEqual([true])
    })
})
