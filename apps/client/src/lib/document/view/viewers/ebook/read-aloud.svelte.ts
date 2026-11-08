/**
 * An EBook read aloud, a sentence at a time, by a voice on the device. The frame finds each sentence and
 * marks it on the page, and this speaks it, because a frame with no secure context cannot be relied on
 * for speech. A short utterance also keeps clear of browsers that stop a long one part way through.
 */
import { localVoices, voiceFor, type VoiceLike } from '#lib/document/ebook/read-aloud-voices.js'

export interface SpeechPort {
    voices(): VoiceLike[]
    speak(text: string, options: { voice: VoiceLike | null; rate: number; lang: string }, ended: (failed: boolean) => void): void
    pause(): void
    resume(): void
    cancel(): void
    onVoicesChanged(listener: () => void): () => void
}

/** The browser's speech, or null where it has none. */
export function browserSpeech(): SpeechPort | null {
    const synth = typeof window === 'undefined' ? undefined : window.speechSynthesis
    if (!synth) return null
    return {
        voices: () => synth.getVoices(),
        speak(text, { voice, rate, lang }, ended) {
            const utterance = new SpeechSynthesisUtterance(text)
            if (voice) utterance.voice = voice as SpeechSynthesisVoice
            utterance.rate = rate
            utterance.lang = voice?.lang ?? lang
            utterance.onend = () => ended(false)
            utterance.onerror = () => ended(true)
            synth.speak(utterance)
        },
        pause: () => synth.pause(),
        resume: () => synth.resume(),
        cancel: () => synth.cancel(),
        onVoicesChanged(listener) {
            synth.addEventListener?.('voiceschanged', listener)
            return () => synth.removeEventListener?.('voiceschanged', listener)
        },
    }
}

export interface ReadAloudHost {
    start(): void
    next(): void
    stop(): void
    voiceName(): string | null
    rate(): number
}

export class ReadAloud {
    state = $state<'off' | 'reading' | 'paused'>('off')
    voices = $state.raw<VoiceLike[]>([])
    /** Why reading stopped or could not start, to show beside the controls. */
    problem = $state('')
    /** The device has no voice of its own, so the tab says how to add one. */
    noVoice = $state(false)

    private stopVoices: (() => void) | null = null
    /** A newer utterance makes an older one's ending mean nothing. */
    private speaking = 0

    constructor(
        private readonly speech: SpeechPort | null,
        private readonly host: ReadAloudHost,
    ) {
        this.refreshVoices()
        this.stopVoices = speech?.onVoicesChanged(() => this.refreshVoices()) ?? null
    }

    private refreshVoices(): void {
        this.voices = localVoices(this.speech?.voices() ?? [])
    }

    start(): void {
        this.refreshVoices()
        this.problem = ''
        this.noVoice = this.voices.length === 0
        if (this.noVoice) {
            this.problem = "Read aloud needs a voice installed on this device. EtherPK does not send an EBook's words to an online voice."
            return
        }
        this.state = 'reading'
        this.host.start()
    }

    /** The next sentence from the frame, or null at the end of the EBook. */
    sentence(text: string | null, lang: string): void {
        if (this.state === 'off') return
        if (text === null) return this.stop()
        const id = ++this.speaking
        this.speech?.speak(text, { voice: voiceFor(this.voices, this.host.voiceName(), lang), rate: this.host.rate(), lang }, (failed) => {
            if (id !== this.speaking || this.state === 'off') return
            if (failed) {
                this.problem = 'The voice stopped. Try another, or try again.'
                this.stop()
            } else {
                this.host.next()
            }
        })
    }

    pause(): void {
        this.state = 'paused'
        this.speech?.pause()
    }

    resume(): void {
        this.state = 'reading'
        this.speech?.resume()
    }

    stop(): void {
        this.state = 'off'
        this.speaking++
        this.speech?.cancel()
        this.host.stop()
    }

    destroy(): void {
        if (this.state !== 'off') this.stop()
        this.stopVoices?.()
    }
}
