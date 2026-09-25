import { afterEach, describe, expect, it } from 'vitest'

import { createContributionRegistry, setActiveContributionRegistry } from '$lib/surface'

import {
    AUGMENTATION_RENDERER_KIND,
    type AugmentationRenderer,
    lookupAugmentationRenderer,
    registerAugmentationRenderer,
} from './contract'

const fake = (editing: AugmentationRenderer['editing'] = 'flip'): AugmentationRenderer => ({
    editing,
    render: () => Promise.reject(new Error('unused')),
})

afterEach(() => setActiveContributionRegistry(null))

describe('augmentation renderer contract', () => {
    it('registers under the augmentation-renderer kind and looks up by info-string', () => {
        const registry = createContributionRegistry()
        setActiveContributionRegistry(registry)
        const renderer = fake('preview')
        registerAugmentationRenderer(registry, 'mermaid', renderer)
        expect(lookupAugmentationRenderer('mermaid')).toBe(renderer)
        expect(registry.get(AUGMENTATION_RENDERER_KIND, 'mermaid')).toBe(renderer)
    })

    it('returns undefined for an unregistered info-string', () => {
        setActiveContributionRegistry(createContributionRegistry())
        expect(lookupAugmentationRenderer('d2')).toBeUndefined()
    })

    it('returns undefined for the empty info-string (a bare fence is never dispatched)', () => {
        const registry = createContributionRegistry()
        setActiveContributionRegistry(registry)
        registerAugmentationRenderer(registry, 'math', fake())
        expect(lookupAugmentationRenderer('')).toBeUndefined()
    })

    it('returns undefined when no registry is active', () => {
        expect(lookupAugmentationRenderer('mermaid')).toBeUndefined()
    })

    it('unregisters via the returned detach fn', () => {
        const registry = createContributionRegistry()
        setActiveContributionRegistry(registry)
        const detach = registerAugmentationRenderer(registry, 'math', fake())
        detach()
        expect(lookupAugmentationRenderer('math')).toBeUndefined()
    })
})
