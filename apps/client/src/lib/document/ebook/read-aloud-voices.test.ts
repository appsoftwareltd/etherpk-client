import { describe, expect, it } from 'vitest'

import { localVoices, voiceFor } from './read-aloud-voices'

const voices = [
    { name: 'Cloud English', lang: 'en-GB', localService: false },
    { name: 'Hazel', lang: 'en-GB', localService: true },
    { name: 'Amelie', lang: 'fr-FR', localService: true },
]

describe('the voice that reads an EBook aloud', () => {
    it('is never one that sends the text elsewhere', () => {
        expect(localVoices(voices).map((voice) => voice.name)).toEqual(['Hazel', 'Amelie'])
        expect(voiceFor([voices[0]], 'Cloud English', 'en')).toBeNull()
        expect(voiceFor(voices, 'Cloud English', 'en')?.name).toBe('Hazel')
    })

    it('is the one the person chose, else one in the EBook\'s language, else the first', () => {
        expect(voiceFor(voices, 'Amelie', 'en')?.name).toBe('Amelie')
        expect(voiceFor(voices, null, 'fr-CA')?.name).toBe('Amelie')
        expect(voiceFor(voices, null, 'de')?.name).toBe('Hazel')
    })
})
