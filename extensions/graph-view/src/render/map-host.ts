/**
 * The [[Graph View]]'s drawing surface: one sigma renderer (WebGL) over a container, the
 * ForceAtlas2 layout that moves the dots, and what is picked out on top.
 *
 * Nothing here runs on its own. sigma draws a frame only when the graph or the camera changes,
 * and the layout runs for a time budget after a new picture is set and then stops for good.
 * `setPaused(true)` stops the layout early when the View goes off screen and keeps the rest of
 * its budget for when it comes back, so a hidden Graph View costs nothing but its memory.
 *
 * Browser only, so it is tested through the Playwright specs rather than in Node.
 */
import { createNodeBorderProgram } from '@sigma/node-border'
import { UndirectedGraph } from 'graphology'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import FA2Layout from 'graphology-layout-forceatlas2/worker'
import Sigma from 'sigma'
import type { NodeDisplayData, PartialButFor } from 'sigma/types'
import type { Settings } from 'sigma/settings'

import type { MapColours } from './map-colours'
import type { DrawnEdgeAttributes, DrawnGraph, DrawnNodeAttributes, Position } from './map-graph'

/** Labels are drawn at this size and never smaller: the 14px text floor (ADR 0106). */
export const LABEL_SIZE = 14

/** At or below this many dots the layout runs in one go on the main thread; above, in a worker. */
const SYNC_LAYOUT_LIMIT = 400

/** How much the layout should move a new picture's dots. */
export type LayoutAmount = 'full' | 'brief' | 'none'

export interface MapHostOptions {
    colours: MapColours
    /** A click on a dot. */
    onOpen(key: string): void
    /** The pointer entering (a key) or leaving (null) a dot. */
    onHover?(key: string | null): void
    /** The local copy shows labels on smaller dots, because it shows far fewer. */
    dense: boolean
}

export interface MapHost {
    /**
     * Draw a new picture. Its dots keep the positions `graph` gives them, then the layout refines
     * them. `resetCamera` frames the whole picture; leave it off for a refresh of the same one,
     * so the view does not jump while someone is looking at a corner of it. `layout` says how
     * much moving the picture needs: `full` for a new one, `brief` for one that kept most of its
     * dots where they were (a refresh after an edit), `none` for one that only changed colour.
     */
    setGraph(graph: DrawnGraph, options: { resetCamera: boolean; layout: LayoutAmount }): void
    /** Where every dot is now, to carry into the next picture. */
    positions(): Map<string, Position>
    /** Stop the layout while off screen; carry on with what is left of its budget when back. */
    setPaused(paused: boolean): void
    /** Pick out these dots and the lines between them, setting the rest back; null clears. */
    setEmphasis(keys: ReadonlySet<string> | null): void
    /** Hide the dots `hidden` says yes to, and every line touching one; null shows all. */
    setHidden(hidden: ((key: string) => boolean) | null): void
    /**
     * Ring this dot in the accent colour, as the active document. Done when drawing rather than
     * in the picture, so moving between documents never sets the layout off again.
     */
    setActive(key: string | null): void
    /** Move the camera to a dot. */
    focus(key: string): void
    /** Zoom in (1), out (-1) or back to the whole picture (0). */
    zoom(step: 1 | -1 | 0): void
    setColours(colours: MapColours): void
    /** Whether the layout is still moving dots. */
    isSettling(): boolean
    /**
     * What sigma is drawing, for the dev-only introspection hook the Playwright specs read
     * (a WebGL canvas shows them nothing they can assert on).
     */
    inspect(): { dots: number; lines: number; settling: boolean; paused: boolean; reducers: boolean; frames: number; line?: { color: string; size: number; hidden: boolean } }
    /**
     * One dot as sigma draws it now (after reducers), for the same hook; null when it is not
     * drawn. `at` is its centre in pixels from the container's top left, where a spec clicks it.
     */
    inspectDot(key: string): { type: string; color: string; borderColor?: string; hidden: boolean; zIndex: number; at: { x: number; y: number } } | null
    kill(): void
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export function createMapHost(container: HTMLElement, options: MapHostOptions): MapHost {
    let colours = options.colours
    let graph: DrawnGraph | null = null
    let layout: FA2Layout | null = null
    let layoutLeft = 0
    let layoutStartedAt = 0
    let layoutTimer: ReturnType<typeof setTimeout> | undefined
    let paused = false
    /**
     * The hovered dot and its neighbours, built once when the pointer enters the dot. sigma runs
     * the reducers for every dot and line on each refresh, and every layout step, so building the
     * set inside them cost 600 to 900 ms per refresh for a well-linked Hub on a 5,000 dot graph.
     */
    let hoverSet: ReadonlySet<string> | null = null
    let emphasis: ReadonlySet<string> | null = null
    let hidden: ((key: string) => boolean) | null = null
    let active: string | null = null
    /** The dot wearing the active ring, and what its ring settings were before. */
    let ringed: { key: string; before: Pick<DrawnNodeAttributes, 'type' | 'borderColor' | 'zIndex'> } | null = null
    /** The size the picture was last drawn at, so a report of the same size redraws nothing. */
    let drawnSize = { width: container.offsetWidth, height: container.offsetHeight }

    type LabelData = PartialButFor<NodeDisplayData, 'x' | 'y' | 'size' | 'label' | 'color'>
    type MapSettings = Settings<DrawnNodeAttributes, DrawnEdgeAttributes>

    /** A label on a plate of the background colour, so it reads over lines and other dots. */
    const drawLabel = (context: CanvasRenderingContext2D, data: LabelData, settings: MapSettings) => {
        if (!data.label) return
        context.font = `${settings.labelWeight} ${LABEL_SIZE}px ${settings.labelFont}`
        const width = context.measureText(data.label).width
        const x = data.x + data.size + 4
        const top = data.y - LABEL_SIZE / 2 - 3
        context.fillStyle = colours.labelPlate
        context.beginPath()
        context.roundRect(x - 4, top, width + 8, LABEL_SIZE + 6, 4)
        context.fill()
        context.fillStyle = colours.label
        context.fillText(data.label, x, data.y + LABEL_SIZE / 3)
    }
    /** The hovered dot: its label always, on a plate with an edge, and a halo round the dot. */
    const drawHover = (context: CanvasRenderingContext2D, data: LabelData, settings: MapSettings) => {
        context.beginPath()
        context.arc(data.x, data.y, data.size + 3, 0, Math.PI * 2)
        context.fillStyle = colours.labelPlate
        context.fill()
        context.strokeStyle = colours.accent
        context.lineWidth = 1.5
        context.stroke()
        drawLabel(context, data, settings)
    }

    // One program draws both rings: a Pageless Concept's (filled with the background) and the
    // active document's (filled with its own colour). Each reads its colours from the dot.
    const BorderedProgram = createNodeBorderProgram<DrawnNodeAttributes, DrawnEdgeAttributes>({
        borders: [
            { size: { value: 0.3, mode: 'relative' }, color: { attribute: 'borderColor' } },
            { size: { fill: true }, color: { attribute: 'color' } },
        ],
        drawLabel: undefined,
        drawHover: undefined,
    })

    // What is hovered, picked out or hidden by the replay is drawn through sigma's reducers, which
    // sigma runs on every dot and line of every refresh and of every layout step. They are set
    // only while one of those is in use (see syncReducers); the rest of the time sigma skips them.
    // sigma hands a reducer its own shallow copy of the attributes, so it changes that copy in
    // place rather than making another for every dot and line.
    type NodeDisplay = Partial<NodeDisplayData> & DrawnNodeAttributes
    const nodeReducer = (key: string, data: DrawnNodeAttributes): NodeDisplay => {
        const shown = data as NodeDisplay
        if (hidden?.(key)) {
            shown.hidden = true
            return shown
        }
        const focus = picked()
        if (focus && !focus.has(key)) {
            shown.color = data.type === 'bordered' && data.kind === 'pageless' ? colours.background : colours.faded
            shown.borderColor = colours.faded
            shown.label = ''
            shown.zIndex = 0
        } else if (focus) {
            shown.forceLabel = true
            shown.zIndex = Math.max(data.zIndex, 2)
        }
        return shown
    }
    const edgeReducer = (edge: string, data: DrawnEdgeAttributes): DrawnEdgeAttributes => {
        // The graph sigma is drawing, not `graph`: while a new picture is being set, sigma
        // still reduces the old one's lines, which the new graph does not hold.
        const drawing = sigma.getGraph()
        if (!drawing.hasEdge(edge)) return data
        const [source, target] = drawing.extremities(edge)
        if (hidden && (hidden(source) || hidden(target))) {
            data.hidden = true
            return data
        }
        const focus = picked()
        if (focus && focus.has(source) && focus.has(target)) {
            data.color = colours.accent
            data.size = Math.max(data.size, 1.4)
            data.zIndex = 1
        } else if (focus) {
            data.color = colours.faded
        }
        return data
    }

    const sigma = new Sigma<DrawnNodeAttributes, DrawnEdgeAttributes>(emptyGraph(), container, {
        // A collapsed Sidebar gives the container no width; sigma must wait rather than throw.
        allowInvalidContainer: true,
        renderEdgeLabels: false,
        labelFont: colours.font,
        labelSize: LABEL_SIZE,
        labelWeight: '500',
        labelColor: { color: colours.label },
        // A label appears once its dot is this many pixels across, so zooming in reveals more.
        labelRenderedSizeThreshold: options.dense ? 3 : 9,
        // sigma shows at most `labelDensity` labels per grid cell. The local copy shows a few
        // dozen dots at most, so it names nearly all of them; the whole graph names the biggest.
        labelDensity: options.dense ? 4 : 0.5,
        labelGridCellSize: options.dense ? 60 : 140,
        defaultDrawNodeLabel: drawLabel,
        defaultDrawNodeHover: drawHover,
        nodeProgramClasses: { bordered: BorderedProgram },
        zIndex: true,
        // Thin lines: sigma's default floor (1.7px) turns a large graph's lines into a grey mass.
        minEdgeThickness: 1,
        // Labels sit to the right of their dot, so the narrow local copy needs more room at the
        // edges than the whole graph does to keep the outermost names on screen.
        stagePadding: options.dense ? 64 : 32,
        minCameraRatio: 0.03,
        maxCameraRatio: 3,
    })

    /** What is picked out: the hovered dot and its neighbours, or else the emphasis set. */
    function picked(): ReadonlySet<string> | null {
        return hoverSet ?? emphasis
    }

    let reducersOn = false
    /**
     * Turn the reducers on while something is hovered, picked out or hidden, and off otherwise,
     * then redraw once at the next frame. Several changes in one frame (a new picture's active
     * ring, its emphasis and its replay state) cost one refresh between them.
     */
    function syncReducers() {
        const wanted = hoverSet !== null || emphasis !== null || hidden !== null
        if (wanted === reducersOn) {
            sigma.scheduleRefresh()
            return
        }
        reducersOn = wanted
        // setSettings schedules the refresh itself.
        sigma.setSettings({ nodeReducer: wanted ? nodeReducer : null, edgeReducer: wanted ? edgeReducer : null })
    }

    /**
     * Put the active ring on the active document's dot and take it off the last one. Written
     * onto the dot rather than drawn by a reducer, so the reducers stay off for the common case of
     * a document being open and nothing else picked out.
     */
    function applyActiveRing() {
        if (ringed && graph?.hasNode(ringed.key)) graph.mergeNodeAttributes(ringed.key, ringed.before)
        ringed = null
        if (!active || !graph?.hasNode(active)) return
        const dot = graph.getNodeAttributes(active)
        ringed = { key: active, before: { type: dot.type, borderColor: dot.borderColor, zIndex: dot.zIndex } }
        graph.mergeNodeAttributes(active, { type: 'bordered', borderColor: colours.accent, zIndex: 3 })
    }

    // sigma sizes its canvases on a window resize only. A Pane is resized far more often than the
    // window (a Sidebar dragged wider, the list beneath the local copy opened), so follow the
    // container itself. While paused there is nothing to draw, and `setPaused(false)` resizes. A
    // report of the size already drawn (ResizeObserver's first report always is) changes nothing.
    function followSize(): boolean {
        const size = { width: container.offsetWidth, height: container.offsetHeight }
        if (size.width === 0 || size.height === 0) return false
        if (size.width === drawnSize.width && size.height === drawnSize.height) return false
        drawnSize = size
        sigma.resize()
        return true
    }
    const resizeObserver =
        typeof ResizeObserver === 'undefined'
            ? null
            : new ResizeObserver(() => {
                  if (!paused && followSize()) sigma.scheduleRefresh()
              })
    resizeObserver?.observe(container)

    // Frames drawn, for the dev-only inspect hook: what a performance measurement divides by.
    let frames = 0
    sigma.on('afterRender', () => {
        frames += 1
    })

    sigma.on('clickNode', ({ node }) => options.onOpen(node))
    sigma.on('enterNode', ({ node }) => {
        hoverSet = graph?.hasNode(node) ? new Set([node, ...graph.neighbors(node)]) : null
        container.style.cursor = 'pointer'
        options.onHover?.(node)
        syncReducers()
    })
    sigma.on('leaveNode', () => {
        hoverSet = null
        container.style.cursor = ''
        options.onHover?.(null)
        syncReducers()
    })

    function stopLayout() {
        clearTimeout(layoutTimer)
        if (layout?.isRunning()) {
            layout.stop()
            layoutLeft = Math.max(0, layoutLeft - (performance.now() - layoutStartedAt))
        }
    }

    function runLayout() {
        if (!layout || paused || layoutLeft <= 0) return
        layoutStartedAt = performance.now()
        layout.start()
        layoutTimer = setTimeout(() => {
            layout?.stop()
            layoutLeft = 0
        }, layoutLeft)
    }

    return {
        setGraph(next, { resetCamera, layout: amount }) {
            // What the last picture's layout had left: a picture set while the last was still
            // settling (a theme change, an edit seconds after opening) carries on settling.
            stopLayout()
            const remaining = layoutLeft
            layout?.kill()
            layout = null
            layoutLeft = 0
            hoverSet = null
            graph = next
            if (next.order === 0) {
                // Nothing to move.
            } else if (next.order <= SYNC_LAYOUT_LIMIT) {
                // Small enough to settle in one go before the first frame: no worker, no motion.
                if (amount !== 'none') {
                    forceAtlas2.assign(next, {
                        iterations: amount === 'full' ? 160 : 50,
                        settings: { ...forceAtlas2.inferSettings(next), strongGravityMode: true, gravity: 0.6 },
                    })
                }
            } else {
                // A new picture: about three seconds plus a millisecond per dot, at most twelve.
                // A refresh starts from settled positions and needs only to fit the change in.
                const wanted = amount === 'full' ? Math.min(12_000, 3_000 + next.order) : amount === 'brief' ? Math.min(3_000, 1_000 + next.order / 4) : 0
                const budget = Math.max(remaining, wanted)
                if (budget > 0) {
                    layout = new FA2Layout(next, { settings: layoutSettings(next), getEdgeWeight: null })
                    layoutLeft = budget
                    runLayout()
                }
            }
            // The new picture's own dot wears the active ring; the last picture's is gone with it.
            ringed = null
            applyActiveRing()
            // A hover ended with the old picture: the reducers go off now unless something else
            // still needs them. Rare, so its extra refresh does not matter.
            if (reducersOn && emphasis === null && hidden === null) syncReducers()
            // Thousands of lines redrawn on every frame of a pan make it stutter; they come back
            // the moment the camera stops. Set only when it changes: every setting change costs
            // sigma a full refresh of its own, on top of the one setGraph makes.
            const hideOnMove = next.size > 4_000
            if (sigma.getSetting('hideEdgesOnMove') !== hideOnMove) sigma.setSetting('hideEdgesOnMove', hideOnMove)
            // While paused sigma holds an empty graph (see setPaused); it is handed this one on resume.
            if (!paused) sigma.setGraph(next)
            if (resetCamera) sigma.getCamera().setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 })
        },
        positions() {
            const out = new Map<string, Position>()
            graph?.forEachNode((key, attributes) => out.set(key, { x: attributes.x, y: attributes.y }))
            return out
        },
        setPaused(next) {
            if (paused === next) return
            paused = next
            if (paused) {
                stopLayout()
                hoverSet = null
                // sigma redraws on every window resize through a listener of its own, which pausing
                // the layout does not reach. Handing it an empty graph leaves it nothing to redraw
                // while hidden; the picture, its positions and the camera are kept here.
                sigma.setGraph(emptyGraph())
            } else {
                // The container may have changed size while hidden (a Sidebar dragged wider).
                // Sized first, so handing the picture back draws it once, at the right size.
                followSize()
                if (graph) sigma.setGraph(graph)
                runLayout()
            }
        },
        setEmphasis(keys) {
            const next = keys && keys.size > 0 ? keys : null
            if (sameKeys(emphasis, next)) return
            emphasis = next
            syncReducers()
        },
        setHidden(next) {
            if (hidden === next) return
            hidden = next
            syncReducers()
        },
        setActive(key) {
            if (active === key) return
            active = key
            // A change to the dot's attributes is a change sigma draws by itself.
            applyActiveRing()
        },
        focus(key) {
            const display = sigma.getNodeDisplayData(key)
            if (!display) return
            void sigma.getCamera().animate({ x: display.x, y: display.y, ratio: Math.min(sigma.getCamera().ratio, 0.4) }, { duration: reducedMotion() ? 0 : 300 })
        },
        zoom(step) {
            const camera = sigma.getCamera()
            const duration = reducedMotion() ? 0 : 200
            if (step === 0) void camera.animatedReset({ duration })
            else if (step > 0) void camera.animatedZoom({ duration })
            else void camera.animatedUnzoom({ duration })
        },
        setColours(next) {
            if (next === colours) return
            colours = next
            sigma.setSettings({ labelFont: next.font, labelColor: { color: next.label } })
            applyActiveRing()
        },
        isSettling() {
            return layout?.isRunning() ?? false
        },
        inspect() {
            const drawnGraph = sigma.getGraph()
            const firstLine = drawnGraph.edges()[0]
            const line = firstLine === undefined ? undefined : sigma.getEdgeDisplayData(firstLine)
            return {
                dots: drawnGraph.order,
                lines: drawnGraph.size,
                settling: layout?.isRunning() ?? false,
                paused,
                reducers: reducersOn,
                frames,
                ...(line ? { line: { color: line.color, size: line.size, hidden: line.hidden } } : {}),
            }
        },
        inspectDot(key) {
            const dot = sigma.getNodeDisplayData(key) as (NodeDisplayData & { borderColor?: string }) | undefined
            if (!dot) return null
            // Display data holds the dot's framed coordinates, sigma's own unit square.
            const at = sigma.framedGraphToViewport({ x: dot.x, y: dot.y })
            return {
                type: dot.type,
                color: dot.color,
                ...(dot.borderColor ? { borderColor: dot.borderColor } : {}),
                hidden: dot.hidden,
                zIndex: dot.zIndex,
                at: { x: at.x, y: at.y },
            }
        },
        kill() {
            resizeObserver?.disconnect()
            stopLayout()
            layout?.kill()
            layout = null
            sigma.kill()
        },
    }
}

/**
 * ForceAtlas2 for a large picture. LinLog mode with outbound attraction distribution is the
 * combination its authors give for making communities stand apart: Clusters pull into tight
 * groups with space between them, and a Hub is pushed out towards the groups it joins instead of
 * dragging everything into one ball. Ordinary gravity keeps Isolated Documents in view without
 * crushing the rest together, which strong gravity did.
 */
function layoutSettings(graph: DrawnGraph) {
    return {
        ...forceAtlas2.inferSettings(graph),
        strongGravityMode: true,
        gravity: 0.05,
        scalingRatio: 10,
        barnesHutOptimize: true,
    }
}

/** Whether two pick-out sets hold the same dots: the panel builds a new set on every change it hears. */
function sameKeys(a: ReadonlySet<string> | null, b: ReadonlySet<string> | null): boolean {
    if (a === b) return true
    if (!a || !b || a.size !== b.size) return false
    for (const key of a) if (!b.has(key)) return false
    return true
}

/** sigma needs a graph to start with; the first `setGraph` replaces it. */
function emptyGraph(): DrawnGraph {
    return new UndirectedGraph()
}
