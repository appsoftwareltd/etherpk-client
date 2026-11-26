/**
 * What has to be settled before the window of a Native App closes: edits still waiting for their
 * save, and work that closing would lose.
 *
 * A browser's page gets no time as it goes and can only have the browser ask "Leave site?". An
 * Native App's shell asks the page before it closes the window and waits for the answer, so the
 * page can finish its saves, and say what it could not save.
 */
import { CLOSE_SETTLE_MS } from '@appsoftwareltd/etherpk-native-bridge'

/** Finish what can be finished. Answers with what closing now would lose, in words, or null. */
export type LeaveGuard = () => string | null | Promise<string | null>

/** How long saves may take as the window closes. The shell gives a page that has hung a little longer. */
export const SETTLE_LIMIT_MS = CLOSE_SETTLE_MS

export const STILL_SAVING = 'EtherPK is still saving your latest edits.'
const COULD_NOT_CHECK = 'EtherPK could not check whether everything is saved.'

const guards = new Set<LeaveGuard>()

/** Ask `guard` before the window closes. Returns a function that stops asking. */
export function guardLeaving(guard: LeaveGuard): () => void {
    guards.add(guard)
    return () => {
        guards.delete(guard)
    }
}

/** Let every guard finish, and answer with what closing now would lose: nothing when it may close. */
export async function settleBeforeLeaving(limitMs: number = SETTLE_LIMIT_MS): Promise<string[]> {
    // All at once: one slow disk must not use up the time of the others.
    const answers = await Promise.all([...guards].map((guard) => answerWithin(guard, limitMs)))
    return [...new Set(answers.filter((answer): answer is string => answer !== null))]
}

async function answerWithin(guard: LeaveGuard, limitMs: number): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(STILL_SAVING), limitMs)
    })
    try {
        return await Promise.race([Promise.resolve().then(guard), late])
    } catch (error) {
        // Not knowing is not being safe to close: the person decides.
        console.error('[native] a guard failed as the window was closing', error)
        return COULD_NOT_CHECK
    } finally {
        clearTimeout(timer)
    }
}
