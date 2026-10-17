/**
 * A loaded extension's stylesheets, for the shadow roots its Views mount in (ADR 0121), and the
 * Client's own sheets each of those shadow roots starts with: the host's base rules, then EtherPK's
 * control classes (`controls.css`, ADR 0151), so the extension's buttons and fields are the Client's.
 *
 * Each sheet is fetched once from the Client's own origin and kept as a constructed stylesheet,
 * which every shadow root of every View of the extension adopts, so two Graph View tabs parse its
 * CSS once.
 *
 * One thing has to leave the shadow root: `@property` rules. A browser ignores them inside a
 * shadow root, and Tailwind v4's shadow, ring and transform utilities depend on the initial values
 * they register: without them `shadow-(--gk-shadow)` computed to no shadow at all (checked on
 * 2026-10-02 against the Graph View's own stylesheet in Chromium). A registration made at the
 * document level applies inside shadow roots too, so each sheet's `@property` rules are copied
 * into a stylesheet the document adopts. Never one naming the Client's own `--gk-*` properties,
 * which would change them for the whole page (`claimsClientProperty`).
 */
import controlsCss from '@appsoftwareltd/etherpk-extension-api/controls.css?raw'

import { claimsClientProperty } from './page-styles'

const sheets = new Map<string, Promise<CSSStyleSheet>>()

/** The Client's sheets for an extension shadow root, made once and shared by every shadow root. */
let clientSheets: CSSStyleSheet[] | undefined

/**
 * What every extension shadow root starts with, ahead of the extension's own sheets: the host fills
 * its panel, as a View in the page does, and EtherPK's control classes. An extension mounted in the
 * page needs neither, since the Client's own stylesheet imports the controls.
 */
export function clientShadowSheets(): CSSStyleSheet[] {
    clientSheets ??= [constructed(':host { display: block; height: 100%; } .extension-view, .extension-fence { height: 100%; }'), constructed(controlsCss)]
    return clientSheets
}

/** The constructed stylesheets for these addresses, fetching each the first time it is asked for. */
export function extensionStyleSheets(urls: readonly string[]): Promise<CSSStyleSheet[]> {
    return Promise.all(urls.map(sheetFor))
}

function sheetFor(url: string): Promise<CSSStyleSheet> {
    let pending = sheets.get(url)
    if (!pending) {
        pending = fetch(url)
            .then((response) => {
                if (!response.ok) throw new Error(`The stylesheet ${url} answered ${response.status}.`)
                return response.text()
            })
            .then((text) => {
                const sheet = constructed(text)
                registerPropertyRules(sheet)
                return sheet
            })
        // A failed fetch is not kept, so the next mount tries again.
        pending.catch(() => sheets.delete(url))
        sheets.set(url, pending)
    }
    return pending
}

function constructed(text: string): CSSStyleSheet {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(text)
    return sheet
}

/**
 * Copy a sheet's top-level `@property` rules into a stylesheet the document adopts, all but those
 * naming one of the Client's own properties.
 */
function registerPropertyRules(sheet: CSSStyleSheet): void {
    const rules = [...sheet.cssRules].filter((rule) => isPropertyRule(rule) && !claimsClientProperty(rule.cssText))
    if (rules.length === 0) return
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, constructed(rules.map((rule) => rule.cssText).join('\n'))]
}

function isPropertyRule(rule: CSSRule): boolean {
    return typeof CSSPropertyRule !== 'undefined' ? rule instanceof CSSPropertyRule : rule.cssText.startsWith('@property')
}
