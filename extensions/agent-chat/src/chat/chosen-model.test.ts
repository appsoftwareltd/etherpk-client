import { afterEach, describe, expect, it } from 'vitest'

import { type AgentChatSettings, EMPTY_SETTINGS, type ModelConnection, withPrimary } from '../settings/connections'
import { forgetChosenModel, noteChosenModel, startingModel } from './chosen-model'

const garden: ModelConnection = { id: 'c1', provider: 'anthropic', name: 'Garden', apiKey: 'sk-1', address: '', defaultModel: 'fake-model' }
const kitchen: ModelConnection = { id: 'c2', provider: 'openai', name: 'Kitchen', apiKey: 'sk-2', address: '', defaultModel: 'other-model' }
const settings: AgentChatSettings = { ...EMPTY_SETTINGS, connections: [garden, kitchen], defaultConnection: 'c1' }

// The model a person picks in a chat is where every new chat starts until the page reloads
// (2026-10-20 refinements). It lives in the page, not in the settings.
describe('the model a new chat starts on', () => {
    afterEach(() => forgetChosenModel())

    it('is the default connection and its model until the person chooses another in a chat', () => {
        expect(startingModel(settings)).toEqual({ connectionId: 'c1', modelId: 'fake-model' })
        noteChosenModel({ connectionId: 'c2', modelId: 'third-model' }, settings)
        expect(startingModel(settings)).toEqual({ connectionId: 'c2', modelId: 'third-model' })
        expect(startingModel(settings)).toEqual({ connectionId: 'c2', modelId: 'third-model' })
    })

    it('goes back to the default once the chosen connection is removed', () => {
        noteChosenModel({ connectionId: 'c2', modelId: 'third-model' }, settings)
        expect(startingModel({ ...settings, connections: [garden] })).toEqual({ connectionId: 'c1', modelId: 'fake-model' })
    })

    it('gives way to a change of the primary connection or its default model in Settings, the newer choice', () => {
        noteChosenModel({ connectionId: 'c2', modelId: 'third-model' }, settings)
        expect(startingModel(withPrimary(settings, 'c2'))).toEqual({ connectionId: 'c2', modelId: 'other-model' })
        noteChosenModel({ connectionId: 'c1', modelId: 'third-model' }, settings)
        const changed = { ...settings, connections: [{ ...garden, defaultModel: 'new-model' }, kitchen] }
        expect(startingModel(changed)).toEqual({ connectionId: 'c1', modelId: 'new-model' })
    })

    it('is nothing with no connection', () => {
        expect(startingModel(EMPTY_SETTINGS)).toEqual({ connectionId: null, modelId: null })
    })
})
