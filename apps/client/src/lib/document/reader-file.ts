/** The files a reader opens in a tab of its own and keeps something about: a PDF and an EBook, by name or reference. */
const READER_FILE = /\.(pdf|epub)$/i

export const isReaderFile = (name: string): boolean => READER_FILE.test(name.split(/[?#]/)[0])
