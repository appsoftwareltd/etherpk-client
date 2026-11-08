/**
 * Whether an EPUB is protected by DRM, read from the files that say so. foliate logs a warning at an
 * encryption it does not know and carries on, so a protected EBook would draw as garbage. EtherPK does
 * not open one, and says why. Fonts obfuscated with either published algorithm are not protection.
 */
const FONT_OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'])

export interface EpubProtectionFiles {
    /** `META-INF/encryption.xml`, or null when the EBook has none. */
    encryption: string | null
    /** `META-INF/rights.xml` (Adobe) or `META-INF/license.lcpl` (Readium LCP) is present. */
    hasRightsFile: boolean
}

/** The `Algorithm` of every `EncryptionMethod`, however the namespace is written. */
function encryptionAlgorithms(xml: string): string[] {
    return [...xml.matchAll(/<(?:[\w-]+:)?EncryptionMethod\b[^>]*\bAlgorithm\s*=\s*["']([^"']+)["']/g)].map((match) => match[1])
}

export function isProtectedEpub({ encryption, hasRightsFile }: EpubProtectionFiles): boolean {
    if (hasRightsFile) return true
    if (encryption === null) return false
    return encryptionAlgorithms(encryption).some((algorithm) => !FONT_OBFUSCATION.has(algorithm))
}

/** A hint a browser may act on before any policy is asked, and a DNS lookup would say who is reading. */
const RESOURCE_HINT = /<link\b[^>]*\brel\s*=\s*["']?[^"'>]*\b(?:preconnect|dns-prefetch|prefetch|prerender|preload|modulepreload)\b[^>]*>/gi

/**
 * A section with nothing that reaches outside its frame by itself: a `<meta http-equiv="refresh">`, which
 * would try to take the frame somewhere else, and any hint to fetch or connect ahead of time.
 */
export function withoutReachingOut(section: string): string {
    return section.replace(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']?\s*refresh\b[^>]*>/gi, '').replace(RESOURCE_HINT, '')
}
