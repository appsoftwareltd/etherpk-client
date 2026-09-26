/**
 * A browser and system named from a user agent, "Chrome on macOS", so a person can tell their
 * signed-in sessions apart. Order matters: Edge and Opera also say Chrome, Chrome also says
 * Safari, and an iPhone also says "like Mac OS X".
 */
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
    [/Edg(e|A|iOS)?\//, 'Edge'],
    [/OPR\/|Opera/, 'Opera'],
    [/Firefox\/|FxiOS\//, 'Firefox'],
    [/Chrome\/|CriOS\//, 'Chrome'],
    [/Safari\//, 'Safari'],
]

const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
    [/iPhone/, 'iPhone'],
    [/iPad/, 'iPad'],
    [/Android/, 'Android'],
    [/CrOS/, 'ChromeOS'],
    [/Windows/, 'Windows'],
    [/Macintosh|Mac OS X/, 'macOS'],
    [/Linux/, 'Linux'],
]

export function describeDevice(userAgent: string | null | undefined): string {
    if (!userAgent) return 'Unknown device'
    const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1]
    const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1]
    if (!browser && !system) return 'Unknown device'
    if (!browser) return system!
    return system ? `${browser} on ${system}` : browser
}
