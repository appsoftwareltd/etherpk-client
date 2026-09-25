/**
 * The `math` Augmentation renderer (ADR 0022): KaTeX, synchronous under the hood (what makes
 * the flip model free), `throwOnError: false` so invalid TeX renders in red in place. A hard
 * throw rejects — the host falls back to raw source. CSS + fonts are bundled by Vite from the
 * local package (no CDN — ADR 0022): the same files a future publish bundle copies.
 */

import katex from 'katex'
import 'katex/dist/katex.min.css'

import type { AugmentationRenderer } from './contract'

export const katexRenderer: AugmentationRenderer = {
    editing: 'flip',
    render(source, { inline = false }) {
        const el = document.createElement(inline ? 'span' : 'div')
        el.className = inline ? 'gk-math gk-math--inline' : 'gk-math gk-math--block'
        katex.render(source, el, { displayMode: !inline, throwOnError: false })
        return Promise.resolve(el)
    },
}
