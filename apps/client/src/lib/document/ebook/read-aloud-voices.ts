/**
 * Which voice reads an EBook aloud. Only a voice on the device: a browser's other voices send the text to a
 * service somewhere else, and nothing in an EBook leaves the device. `localService` is the browser's own word
 * for this, so a voice that does not say so is left out.
 */
export interface VoiceLike {
    name: string
    lang: string
    localService: boolean
}

export const READING_RATES = [0.8, 1, 1.25, 1.5, 2] as const

export function localVoices<T extends VoiceLike>(voices: readonly T[]): T[] {
    return voices.filter((voice) => voice.localService === true)
}

/** The voice the person chose, else one for the EBook's language, else the first there is. */
export function voiceFor<T extends VoiceLike>(voices: readonly T[], chosen: string | null, lang: string): T | null {
    const local = localVoices(voices)
    const language = lang.toLowerCase().split('-')[0]
    return local.find((voice) => voice.name === chosen) ?? local.find((voice) => voice.lang.toLowerCase().startsWith(language)) ?? local[0] ?? null
}
