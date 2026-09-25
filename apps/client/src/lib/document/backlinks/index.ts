/**
 * Public entry point for the backlinks (linked-references) subsystem: the pure
 * index + queries, the index-backed resolver, the live graph index, and the
 * reactive accessors the Views read.
 */

export {
    type BacklinkGroup,
    type BacklinkIndex,
    type BacklinkRef,
    type IndexDoc,
    backlinkCount,
    backlinksFor,
    buildBacklinkIndex,
    canonicalKey,
    conceptExists,
    conceptKey,
} from './backlink-index'
export { createIndexResolver } from './index-resolver'
export { nestSubtree, type SubtreeBranch } from './subtree'
export { type GraphIndex, type IndexSource, createGraphIndex } from './live-index'
export {
    type ConceptCandidate,
    type ConceptCandidateKind,
    type DbBacklinkGroup,
    type DbBacklinkRef,
    type RefSubtreeNode,
} from '../index-db'
export {
    OPEN_TASK_STATUSES,
    TASK_PRIORITY_FILTERS,
    TASK_STATUSES,
    type TaskDueWindow,
    type TaskGroupBy,
    type TaskHit,
    type TaskPriorityFilter,
    type TaskQuery,
    type TaskStatus,
    taskDateKey,
} from '../index-db'
export { openInMemorySqlDb } from '../index-db-sqlite'
export { setActiveGraphIndex, getActiveGraphIndex } from './active-index'
