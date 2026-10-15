/** "just now", "5 minutes ago", "yesterday", or a date: how long ago something happened, asked at the moment of use. */
export function since(at: number, now = Date.now()): string {
    const seconds = Math.max(0, Math.round((now - at) / 1000))
    if (seconds < 60) return 'just now'
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`
    const hours = Math.round(minutes / 60)
    if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`
    const days = Math.round(hours / 24)
    if (days === 1) return 'yesterday'
    if (days < 7) return `${days} days ago`
    const date = new Date(at)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
