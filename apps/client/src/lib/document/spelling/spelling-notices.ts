/**
 * What the activity rail says about dictionary downloads (ADR 0095), from the spell service's
 * language statuses:
 *
 * - a download still running after two seconds gets a notice naming it and its size, taken
 *   down when it finishes; a quick one is never mentioned, and the underlines appearing are the
 *   visible result either way;
 * - a failed download gets an error notice that stays until closed, with Retry;
 * - an offline one says nothing here: nothing has failed, and the Spelling tab shows "downloads
 *   when you're back online".
 */

import { dismissNotice, showNotice } from '$lib/activity/notices'
import { formatBytes } from '$lib/format-bytes'

import type { LanguageStatus, SpellService } from './spell-service'

const DOWNLOADING_NOTICE = 'spelling-download'
const FAILED_NOTICE = 'spelling-failed'
/** How long a download runs before it is worth mentioning. */
const SLOW_DOWNLOAD_MS = 2000

function describe(languages: readonly LanguageStatus[]): string {
    const names = languages.map((l) => l.name)
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
    const bytes = languages.reduce((sum, l) => sum + l.bytes, 0)
    return `${list} ${names.length === 1 ? 'dictionary' : 'dictionaries'} (${formatBytes(bytes)})`
}

export function bindSpellingNotices(service: SpellService): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined
    let shownFailure = ''

    function update(): void {
        const languages = service.languages()
        const downloading = languages.filter((l) => l.state === 'downloading')
        if (downloading.length === 0) {
            clearTimeout(timer)
            timer = undefined
            dismissNotice(DOWNLOADING_NOTICE)
        } else if (timer === undefined) {
            timer = setTimeout(() => {
                const still = service.languages().filter((l) => l.state === 'downloading')
                if (still.length > 0) {
                    showNotice({
                        id: DOWNLOADING_NOTICE,
                        tone: 'info',
                        dismissal: 'manual',
                        text: `Downloading the ${describe(still)}…`,
                    })
                }
            }, SLOW_DOWNLOAD_MS)
        }

        const failed = languages.filter((l) => l.state === 'failed')
        const key = failed.map((l) => `${l.tag}:${l.error ?? ''}`).join('|')
        if (key === shownFailure) return
        shownFailure = key
        if (failed.length === 0) {
            dismissNotice(FAILED_NOTICE)
            return
        }
        const reasons = [...new Set(failed.map((l) => l.error).filter(Boolean))].join(' ')
        showNotice({
            id: FAILED_NOTICE,
            tone: 'error',
            text: `The ${describe(failed)} could not be downloaded, so spelling is not being checked. ${reasons}`.trim(),
            actions: [{ label: 'Retry', primary: true, run: () => service.retry() }],
        })
    }

    const unsubscribe = service.subscribe(update)
    update()
    return () => {
        unsubscribe()
        clearTimeout(timer)
        dismissNotice(DOWNLOADING_NOTICE)
        dismissNotice(FAILED_NOTICE)
    }
}
