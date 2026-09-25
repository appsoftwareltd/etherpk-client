/** Public entry point for Navigation History (ADR 0023). */
export { documentUrl, encodeConceptPath, graphUrl } from './document-url'
export {
    capturePosition,
    clearPendingRestores,
    focusEditor,
    focusEditorIfEmpty,
    registerPositionAdapter,
    restorePosition,
    setActiveReadingPositions,
    tryGetActiveReadingPositions,
    type PositionAdapter,
    type ViewPosition,
} from './position'
export {
    READING_POSITIONS_KEY_PREFIX,
    createReadingPositions,
    type ReadingPositionStore,
} from './reading-positions'
export { VISIT_SNAPSHOTS_KEY, createVisitSnapshots, type VisitSnapshots } from './visit-snapshots'
export {
    createHistoryEngine,
    type HistoryEngine,
    type HistoryEngineOptions,
    type VisitState,
} from './history'
