import { describe, expect, it } from 'vitest'

import { checkableWords, spellingForm } from './words'

/** The words `text` offers for checking, as the text each range covers. */
function words(text: string): string[] {
    return checkableWords(text).map((w) => text.slice(w.from, w.to))
}

describe('checkableWords', () => {
    it('finds the words of a sentence, apostrophes kept inside them', () => {
        expect(words("Don't say it's teh colour")).toEqual(["Don't", 'say', "it's", 'teh', 'colour'])
        expect(words('Sidney’s notebok')).toEqual(['Sidney’s', 'notebok'])
    })

    it('checks a hyphenated word part by part', () => {
        expect(words('a well-knwon tool')).toEqual(['well', 'knwon', 'tool'])
    })

    it('reports offsets into the text it was given', () => {
        expect(checkableWords('  hello wrold')).toEqual([
            { from: 2, to: 7, word: 'hello' },
            { from: 8, to: 13, word: 'wrold' },
        ])
    })

    it('never offers names, codes and identifiers', () => {
        // All capitals, a capital inside, a digit, an underscore, a dot, a single letter.
        expect(words('PKMS API EtherPK iPhone camelCase v2 3rd Q3 snake_case e.g. a I x')).toEqual([])
    })

    it('never offers a hashtag, but does offer a capitalised word', () => {
        expect(words('#projectx Monday')).toEqual(['Monday'])
    })

    it('reads words in other scripts and accented letters', () => {
        expect(words('Größe café naïve')).toEqual(['Größe', 'café', 'naïve'])
    })
})

describe('spellingForm', () => {
    it('straightens a curly apostrophe, which the dictionaries spell straight', () => {
        expect(spellingForm('it’s')).toBe("it's")
        expect(spellingForm('plain')).toBe('plain')
    })
})
