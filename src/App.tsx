import {
  startTransition,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type PointerEvent,
} from 'react'
import './App.css'
import monsterBackdrop from './assets/Paso 3.jpeg'

type DrawingRecord = {
  id: string
  name: string
  imageData: string
  createdAt: string
}

type ActorState = {
  id: string
  name: string
  imageData: string
  routeIndex: number
  progress: number
  speed: number
  laneOffset: number
  facing: 1 | -1
  size: number
  hopStartedAt: number
  hopDuration: number
  hopHeight: number
  nextHopAt: number
  conversationUntil: number
  coolDownUntil: number
  phrase: string
  lastUpdatedAt: number
}

type Step = 'intro' | 'draw' | 'park'
type CanvasCursor = {
  x: number
  y: number
  visible: boolean
}
type CanvasSnapshot = ImageData | null

const CANVAS_SIZE = 280
const PARK_POPULATION_LIMIT = 20
const BRUSH_COLORS = ['#000000', '#ffffff', '#eb5a46', '#48c0f0', '#f2dc36', '#58e63e', '#dc36e6', '#f0b63b']
const ERASER_COLOR = '#ffffff'
const BRUSH_SIZES = [4, 9, 16]
const CHAT_LINES = [
  'Te subes conmigo, {name}?',
  'Ese salto ha sido de campeon.',
  'Creo que la noria esta cantando.',
  'Huele a algodon de azucar por aqui.',
  'Nos vemos en el carrusel, {name}.',
  'Has oido el rugido de la montana rusa?',
]
const PATH_POINTS = [
  { x: 78, y: 104 },
  { x: 180, y: 60 },
  { x: 308, y: 96 },
  { x: 398, y: 154 },
  { x: 454, y: 248 },
  { x: 392, y: 354 },
  { x: 246, y: 408 },
  { x: 120, y: 368 },
  { x: 62, y: 258 },
] as const

function lerp(start: number, end: number, progress: number) {
  return start + (end - start) * progress
}

function hashString(value: string) {
  let hash = 0

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index)
    hash |= 0
  }

  return Math.abs(hash)
}

function createSeededRandom(seed: number) {
  let value = seed || 1

  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296
    return value / 4294967296
  }
}

function isoProject(x: number, y: number, z = 0) {
  return {
    x: (x - y) * 1.12,
    y: (x + y) * 0.56 - z,
  }
}

function toScenePoint(x: number, y: number, z = 0) {
  const point = isoProject(x, y, z)

  return {
    x: 452 + point.x,
    y: 98 + point.y,
  }
}

function getPathPoint(routeIndex: number, progress: number) {
  const from = PATH_POINTS[routeIndex]
  const to = PATH_POINTS[(routeIndex + 1) % PATH_POINTS.length]

  return {
    x: lerp(from.x, to.x, progress),
    y: lerp(from.y, to.y, progress),
  }
}

function linePoints(points: readonly { x: number; y: number }[]) {
  return points
    .map((point) => {
      const scene = toScenePoint(point.x, point.y)
      return `${scene.x},${scene.y}`
    })
    .join(' ')
}

function speechFor(speaker: ActorState, listener: ActorState, timestamp: number) {
  const choice =
    (hashString(`${speaker.id}${listener.id}${Math.floor(timestamp / 1000)}`) + speaker.name.length) %
    CHAT_LINES.length

  return CHAT_LINES[choice].replace('{name}', listener.name.split(' ')[0] || 'amiga')
}

function createActor(drawing: DrawingRecord, index: number): ActorState {
  const random = createSeededRandom(hashString(`${drawing.id}-${index}`))
  const now = performance.now()

  return {
    id: drawing.id,
    name: drawing.name,
    imageData: drawing.imageData,
    routeIndex: Math.floor(random() * PATH_POINTS.length),
    progress: random(),
    speed: 20 + random() * 14,
    laneOffset: (random() - 0.5) * 28,
    facing: random() > 0.5 ? 1 : -1,
    size: 54 + random() * 18,
    hopStartedAt: now - random() * 300,
    hopDuration: 360 + random() * 200,
    hopHeight: 12 + random() * 18,
    nextHopAt: now + 800 + random() * 2600,
    conversationUntil: 0,
    coolDownUntil: now + random() * 3000,
    phrase: '',
    lastUpdatedAt: now,
  }
}

function syncActors(current: ActorState[], drawings: DrawingRecord[]) {
  const currentMap = new Map(current.map((actor) => [actor.id, actor]))

  return drawings.map((drawing, index) => {
    const currentActor = currentMap.get(drawing.id)

    if (!currentActor) {
      return createActor(drawing, index)
    }

    return {
      ...currentActor,
      name: drawing.name,
      imageData: drawing.imageData,
    }
  })
}

function shuffleDrawings(drawings: DrawingRecord[]) {
  const shuffled = [...drawings]

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    const drawing = shuffled[index]
    shuffled[index] = shuffled[swapIndex]
    shuffled[swapIndex] = drawing
  }

  return shuffled
}

function selectParkDrawings(drawings: DrawingRecord[], sessionDrawingIds: string[]) {
  const sessionIdSet = new Set(sessionDrawingIds)
  const seen = new Set<string>()
  const sessionDrawings = drawings.filter((drawing) => {
    if (!sessionIdSet.has(drawing.id) || seen.has(drawing.id)) {
      return false
    }

    seen.add(drawing.id)
    return true
  })
  const randomDrawings = shuffleDrawings(drawings.filter((drawing) => !seen.has(drawing.id)))
  const availableSlots = Math.max(PARK_POPULATION_LIMIT - sessionDrawings.length, 0)

  return [...sessionDrawings, ...randomDrawings.slice(0, availableSlots)].slice(0, PARK_POPULATION_LIMIT)
}

function getHopOffset(actor: ActorState, timestamp: number) {
  if (timestamp < actor.hopStartedAt || timestamp > actor.hopStartedAt + actor.hopDuration) {
    return 0
  }

  const progress = (timestamp - actor.hopStartedAt) / actor.hopDuration
  return Math.sin(progress * Math.PI) * actor.hopHeight
}

function stepActors(current: ActorState[], timestamp: number, pausedActorId: string | null) {
  if (current.length === 0) {
    return current
  }

  const next = current.map((actor) => {
    const deltaTime = Math.min((timestamp - actor.lastUpdatedAt) / 1000, 0.05)
    const updated: ActorState = {
      ...actor,
      lastUpdatedAt: timestamp,
      phrase: timestamp > actor.conversationUntil ? '' : actor.phrase,
    }

    if (actor.id === pausedActorId) {
      return updated
    }

    if (timestamp >= updated.nextHopAt) {
      updated.hopStartedAt = timestamp
      updated.hopDuration = 360 + Math.random() * 240
      updated.hopHeight = 12 + Math.random() * 18
      updated.nextHopAt = timestamp + 1600 + Math.random() * 2800
    }

    if (timestamp < updated.conversationUntil) {
      return updated
    }

    let remainingDistance = updated.speed * deltaTime
    let routeIndex = updated.routeIndex
    let progress = updated.progress

    while (remainingDistance > 0) {
      const from = PATH_POINTS[routeIndex]
      const to = PATH_POINTS[(routeIndex + 1) % PATH_POINTS.length]
      const segmentLength = Math.hypot(to.x - from.x, to.y - from.y) || 1
      const segmentRemaining = (1 - progress) * segmentLength

      updated.facing = to.x >= from.x ? 1 : -1

      if (remainingDistance < segmentRemaining) {
        progress += remainingDistance / segmentLength
        remainingDistance = 0
      } else {
        remainingDistance -= segmentRemaining
        progress = 0
        routeIndex = (routeIndex + 1) % PATH_POINTS.length
      }
    }

    updated.routeIndex = routeIndex
    updated.progress = progress
    return updated
  })

  const engaged = new Set<string>()

  for (let firstIndex = 0; firstIndex < next.length; firstIndex += 1) {
    const first = next[firstIndex]

    if (
      engaged.has(first.id) ||
      first.conversationUntil > timestamp ||
      first.coolDownUntil > timestamp
    ) {
      continue
    }

    const firstPoint = getPathPoint(first.routeIndex, first.progress)

    for (let secondIndex = firstIndex + 1; secondIndex < next.length; secondIndex += 1) {
      const second = next[secondIndex]

      if (
        engaged.has(second.id) ||
        second.conversationUntil > timestamp ||
        second.coolDownUntil > timestamp
      ) {
        continue
      }

      const secondPoint = getPathPoint(second.routeIndex, second.progress)
      const distance = Math.hypot(firstPoint.x - secondPoint.x, firstPoint.y - secondPoint.y)

      if (distance > 28) {
        continue
      }

      const duration = 2300 + Math.random() * 1700

      first.conversationUntil = timestamp + duration
      second.conversationUntil = timestamp + duration
      first.coolDownUntil = timestamp + duration + 4600
      second.coolDownUntil = timestamp + duration + 4600
      first.phrase = speechFor(first, second, timestamp)
      second.phrase = speechFor(second, first, timestamp + 17)

      engaged.add(first.id)
      engaged.add(second.id)
      break
    }
  }

  return next
}

function isCanvasBlank(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d')

  if (!context) {
    return true
  }

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data

  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] !== 0) {
      return false
    }
  }

  return true
}

function paintBrushDot(context: CanvasRenderingContext2D, point: { x: number; y: number }, size: number, color: string) {
  context.fillStyle = color
  context.beginPath()
  context.arc(point.x, point.y, size / 2, 0, Math.PI * 2)
  context.fill()
}

function paintBrushTrail(
  context: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  size: number,
  color: string,
) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y)
  const step = Math.max(size * 0.3, 1)
  const steps = Math.max(1, Math.ceil(distance / step))

  for (let index = 0; index <= steps; index += 1) {
    const progress = index / steps
    paintBrushDot(
      context,
      {
        x: lerp(from.x, to.x, progress),
        y: lerp(from.y, to.y, progress),
      },
      size,
      color,
    )
  }
}

function snapshotCanvas(canvas: HTMLCanvasElement): CanvasSnapshot {
  const context = canvas.getContext('2d')

  if (!context || isCanvasBlank(canvas)) {
    return null
  }

  return context.getImageData(0, 0, canvas.width, canvas.height)
}

function restoreCanvasSnapshot(canvas: HTMLCanvasElement, snapshot: CanvasSnapshot) {
  const context = canvas.getContext('2d')

  if (!context) {
    return
  }

  context.clearRect(0, 0, canvas.width, canvas.height)

  if (!snapshot) {
    return
  }

  context.putImageData(snapshot, 0, 0)
}

function snapshotFromImageDataUrl(imageData: string) {
  return new Promise<ImageData>((resolve, reject) => {
    const image = new Image()

    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = CANVAS_SIZE
      canvas.height = CANVAS_SIZE

      const context = canvas.getContext('2d')

      if (!context) {
        reject(new Error('No se pudo preparar el dibujo.'))
        return
      }

      context.clearRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      resolve(context.getImageData(0, 0, canvas.width, canvas.height))
    }

    image.onerror = () => reject(new Error('No se pudo cargar el dibujo.'))
    image.src = imageData
  })
}

function isImageDataSnapshot(snapshot: CanvasSnapshot | string | undefined): snapshot is ImageData {
  return Boolean(snapshot && typeof snapshot === 'object' && 'data' in snapshot)
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const isDrawingRef = useRef(false)
  const lastPointRef = useRef<{ x: number; y: number } | null>(null)
  const hoveredActorIdRef = useRef<string | null>(null)

  const [drawings, setDrawings] = useState<DrawingRecord[]>([])
  const [parkDrawings, setParkDrawings] = useState<DrawingRecord[]>([])
  const [sessionDrawingIds, setSessionDrawingIds] = useState<string[]>([])
  const [actors, setActors] = useState<ActorState[]>([])
  const [hoveredActorId, setHoveredActorId] = useState<string | null>(null)
  const [creatureName, setCreatureName] = useState('')
  const [brushColor, setBrushColor] = useState(BRUSH_COLORS[0])
  const [brushSize, setBrushSize] = useState(BRUSH_SIZES[1])
  const [editingDrawing, setEditingDrawing] = useState<DrawingRecord | null>(null)
  const [formMessage, setFormMessage] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [currentStep, setCurrentStep] = useState<Step>('intro')
  const [canvasCursor, setCanvasCursor] = useState<CanvasCursor>({ x: 0, y: 0, visible: false })
  const [undoStack, setUndoStack] = useState<CanvasSnapshot[]>([null])
  const [redoStack, setRedoStack] = useState<CanvasSnapshot[]>([])

  const refreshDrawings = useEffectEvent(async () => {
    try {
      const response = await fetch('/api/drawings')

      if (!response.ok) {
        throw new Error('No se pudieron cargar los dibujos.')
      }

      const data = (await response.json()) as DrawingRecord[]
      setLoadError('')

      startTransition(() => {
        setDrawings(data)
      })
    } catch {
      setLoadError('No puedo leer la coleccion compartida ahora mismo.')
    }
  })

  const animatePark = useEffectEvent((timestamp: number) => {
    setActors((current) => stepActors(current, timestamp, hoveredActorIdRef.current))
  })

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')

    if (!canvas || !context) {
      return
    }

    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.strokeStyle = brushColor
    context.lineWidth = brushSize
  }, [brushColor, brushSize])

  useEffect(() => {
    if (currentStep !== 'draw' || !editingDrawing) {
      return
    }

    let isCancelled = false

    snapshotFromImageDataUrl(editingDrawing.imageData)
      .then((snapshot) => {
        if (isCancelled) {
          return
        }

        setUndoStack([snapshot])
        setRedoStack([])
      })
      .catch(() => {
        if (!isCancelled) {
          setFormMessage('No puedo abrir ese monstruo para editarlo.')
        }
      })

    return () => {
      isCancelled = true
    }
  }, [currentStep, editingDrawing])

  useEffect(() => {
    if (currentStep !== 'draw') {
      return
    }

    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')

    if (!canvas || !context) {
      return
    }

    const currentSnapshot = undoStack[undoStack.length - 1] ?? null
    restoreCanvasSnapshot(canvas, currentSnapshot)
  }, [currentStep, undoStack])

  useEffect(() => {
    void refreshDrawings()

    const intervalId = window.setInterval(() => {
      void refreshDrawings()
    }, 12000)

    return () => window.clearInterval(intervalId)
  }, [])

  useEffect(() => {
    if (currentStep === 'park' && parkDrawings.length === 0 && drawings.length > 0) {
      setParkDrawings(selectParkDrawings(drawings, sessionDrawingIds))
    }
  }, [currentStep, drawings, parkDrawings.length, sessionDrawingIds])

  useEffect(() => {
    setActors((current) => syncActors(current, parkDrawings))
  }, [parkDrawings])

  useEffect(() => {
    let frameId = 0

    const frame = (timestamp: number) => {
      animatePark(timestamp)
      frameId = window.requestAnimationFrame(frame)
    }

    frameId = window.requestAnimationFrame(frame)

    return () => window.cancelAnimationFrame(frameId)
  }, [])

  function toCanvasPoint(event: PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current

    if (!canvas) {
      return { x: 0, y: 0 }
    }

    const bounds = canvas.getBoundingClientRect()
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * canvas.width,
      y: ((event.clientY - bounds.top) / bounds.height) * canvas.height,
    }
  }

  function pushCanvasHistory() {
    const canvas = canvasRef.current

    if (!canvas) {
      return
    }

    const nextSnapshot = snapshotCanvas(canvas)

    setUndoStack((current) => {
      const previousSnapshot = current[current.length - 1]

      if (
        isImageDataSnapshot(previousSnapshot) &&
        isImageDataSnapshot(nextSnapshot) &&
        previousSnapshot.data.length === nextSnapshot.data.length &&
        previousSnapshot.data.every((value, index) => value === nextSnapshot.data[index])
      ) {
        return current
      }

      if (!previousSnapshot && !nextSnapshot) {
        return current
      }

      return [...current, nextSnapshot]
    })
    setRedoStack([])
  }

  function beginStroke(event: PointerEvent<HTMLCanvasElement>) {
    const context = canvasRef.current?.getContext('2d')

    if (!context) {
      return
    }

    const point = toCanvasPoint(event)
    setCanvasCursor({ x: point.x, y: point.y, visible: true })
    isDrawingRef.current = true
    lastPointRef.current = point

    paintBrushDot(context, point, brushSize, brushColor)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function continueStroke(event: PointerEvent<HTMLCanvasElement>) {
    const point = toCanvasPoint(event)
    setCanvasCursor({ x: point.x, y: point.y, visible: true })

    if (!isDrawingRef.current) {
      return
    }

    const context = canvasRef.current?.getContext('2d')
    const lastPoint = lastPointRef.current

    if (!context || !lastPoint) {
      return
    }

    paintBrushTrail(context, lastPoint, point, brushSize, brushColor)
    lastPointRef.current = point
  }

  function finishStroke() {
    if (isDrawingRef.current) {
      pushCanvasHistory()
    }

    isDrawingRef.current = false
    lastPointRef.current = null
  }

  function showCanvasCursor(event: PointerEvent<HTMLCanvasElement>) {
    const point = toCanvasPoint(event)
    setCanvasCursor({ x: point.x, y: point.y, visible: true })
  }

  function hideCanvasCursor() {
    setCanvasCursor((current) => ({ ...current, visible: false }))
  }

  function updateHoveredActorFromPointer(event: PointerEvent<HTMLDivElement>) {
    const actorElements = event.currentTarget.querySelectorAll<HTMLElement>('.park-actor')
    const floatingPopoverBounds = document.querySelector('.park-floating-popover')?.getBoundingClientRect()
    const hoverPadding = 28
    let nextHoveredActorId: string | null = null

    actorElements.forEach((actorElement) => {
      if (nextHoveredActorId) {
        return
      }

      const bounds = actorElement.getBoundingClientRect()
      const actorId = actorElement.dataset.actorId ?? null
      const popoverBounds = actorId === hoveredActorIdRef.current ? floatingPopoverBounds : null
      const connectorBounds = popoverBounds
        ? {
            left: Math.min(bounds.left, popoverBounds.left) - hoverPadding,
            right: Math.max(bounds.right, popoverBounds.right) + hoverPadding,
            top: Math.min(bounds.top, popoverBounds.top) - hoverPadding,
            bottom: Math.max(bounds.bottom, popoverBounds.bottom) + hoverPadding,
          }
        : null
      const isInsideActor =
        event.clientX >= bounds.left - hoverPadding &&
        event.clientX <= bounds.right + hoverPadding &&
        event.clientY >= bounds.top - hoverPadding &&
        event.clientY <= bounds.bottom + hoverPadding
      const isInsidePopover = popoverBounds
        ? event.clientX >= popoverBounds.left &&
          event.clientX <= popoverBounds.right &&
          event.clientY >= popoverBounds.top &&
          event.clientY <= popoverBounds.bottom
        : false
      const isInsideConnector = connectorBounds
        ? event.clientX >= connectorBounds.left &&
          event.clientX <= connectorBounds.right &&
          event.clientY >= connectorBounds.top &&
          event.clientY <= connectorBounds.bottom
        : false

      if (isInsideActor || isInsidePopover || isInsideConnector) {
        nextHoveredActorId = actorId
      }
    })

    hoveredActorIdRef.current = nextHoveredActorId
    setHoveredActorId((current) => (current === nextHoveredActorId ? current : nextHoveredActorId))
  }

  function enterPark(nextDrawings = drawings, nextSessionDrawingIds = sessionDrawingIds) {
    setEditingDrawing(null)
    setCanvasCursor((current) => ({ ...current, visible: false }))
    setParkDrawings(selectParkDrawings(nextDrawings, nextSessionDrawingIds))
    setCurrentStep('park')
  }

  function undoDrawing() {
    setUndoStack((current) => {
      if (current.length <= 1) {
        return current
      }

      const previousSnapshot = current[current.length - 1]
      setRedoStack((redoCurrent) => [previousSnapshot, ...redoCurrent])
      return current.slice(0, -1)
    })
  }

  function redoDrawing() {
    setRedoStack((current) => {
      if (current.length === 0) {
        return current
      }

      const [nextSnapshot, ...rest] = current
      setUndoStack((undoCurrent) => [...undoCurrent, nextSnapshot])
      return rest
    })
  }

  function restartDrawing() {
    setCreatureName('')
    setBrushColor(BRUSH_COLORS[0])
    setBrushSize(BRUSH_SIZES[1])
    setEditingDrawing(null)
    setUndoStack([null])
    setRedoStack([])
    setFormMessage('')
    setCurrentStep('draw')
  }

  function editDrawing(drawing: DrawingRecord) {
    setCreatureName(drawing.name)
    setBrushColor((current) => (current === ERASER_COLOR ? BRUSH_COLORS[0] : current))
    setBrushSize(BRUSH_SIZES[1])
    setEditingDrawing(drawing)
    setUndoStack([null])
    setRedoStack([])
    setFormMessage('')
    setCurrentStep('draw')
  }

  function cancelDrawing() {
    setCreatureName('')
    setEditingDrawing(null)
    setUndoStack([null])
    setRedoStack([])
    setFormMessage('')
    enterPark()
  }

  async function saveDrawing() {
    const canvas = canvasRef.current

    if (!canvas) {
      return
    }

    if (isCanvasBlank(canvas)) {
      setFormMessage('Dibuja algo antes de mandarlo al parque.')
      return
    }

    setIsSaving(true)
    setFormMessage('Guardando criatura...')

    try {
      const response = await fetch(editingDrawing ? `/api/drawings/${editingDrawing.id}` : '/api/drawings', {
        method: editingDrawing ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: creatureName.trim() || 'Visitante',
          imageData: canvas.toDataURL('image/png'),
        }),
      })

      if (!response.ok) {
        throw new Error('No se pudo guardar.')
      }

      const created = (await response.json()) as DrawingRecord
      const nextDrawings = [created, ...drawings.filter((drawing) => drawing.id !== created.id)]
      let nextSessionDrawingIds = sessionDrawingIds

      startTransition(() => {
        setDrawings(nextDrawings)
      })

      if (!sessionDrawingIds.includes(created.id)) {
        nextSessionDrawingIds = [created.id, ...sessionDrawingIds]
        setSessionDrawingIds(nextSessionDrawingIds)
      }

      setCreatureName('')
      setEditingDrawing(null)
      setUndoStack([null])
      setRedoStack([])
      setFormMessage('Tu dibujo ya esta paseando por el parque.')
      enterPark(nextDrawings, nextSessionDrawingIds)
    } catch {
      setFormMessage('Fallo al guardar. Prueba otra vez.')
    } finally {
      setIsSaving(false)
    }
  }

  const now = performance.now()
  const polyline = linePoints(PATH_POINTS)
  const activeChats = Math.floor(actors.filter((actor) => actor.conversationUntil > now).length / 2)
  const newestCreature = parkDrawings[0]?.name ?? 'Nadie todavia'
  const availableBrushColors = editingDrawing
    ? BRUSH_COLORS.filter((color) => color !== ERASER_COLOR)
    : BRUSH_COLORS

  const ferrisWheel = toScenePoint(92, 120)
  const carousel = toScenePoint(260, 118)
  const fountain = toScenePoint(316, 286)
  const coasterA = toScenePoint(160, 286)
  const coasterB = toScenePoint(244, 250)
  const booth = toScenePoint(118, 222)
  const hoveredActor = currentStep === 'park' ? actors.find((actor) => actor.id === hoveredActorId) ?? null : null
  const hoveredActorScreenPoint = hoveredActor
    ? toScenePoint(
        getPathPoint(hoveredActor.routeIndex, hoveredActor.progress).x + hoveredActor.laneOffset,
        getPathPoint(hoveredActor.routeIndex, hoveredActor.progress).y - hoveredActor.laneOffset,
        getHopOffset(hoveredActor, now),
      )
    : null
  const isHoveredPopoverBelow = hoveredActorScreenPoint ? hoveredActorScreenPoint.y < 360 : false

  return (
    <main className="dream-app">
      <section className="dream-stage">
        {currentStep === 'intro' ? (
          <div className="step-screen step-screen--intro">
            <img className="stage-image" src={monsterBackdrop} alt="Pantalla de inicio del monstruo" />

            <div className="intro-overlay">
              <h1 className="intro-title">¿QUÉ SUEÑA MI MONSTRUO?</h1>

              <button type="button" className="monster-action monster-action--start" onClick={() => enterPark()}>
                Empezar
              </button>
            </div>
          </div>
        ) : null}

        {currentStep === 'draw' ? (
          <div className="step-screen step-screen--draw">
            <img className="stage-image" src={monsterBackdrop} alt="Zona de dibujo del monstruo" />

            <div className="draw-overlay">
              <div className="draw-workspace">
                <div className="draw-tools draw-tools--sizes" aria-label="Herramientas de pincel">
                  <div className="draw-tools__icon" aria-hidden="true">
                    <span className="draw-pencil">✎</span>
                  </div>

                  {BRUSH_SIZES.map((size) => (
                    <button
                      key={size}
                      type="button"
                      aria-label={`Usar grosor ${size}`}
                      className={size === brushSize ? 'tool-square is-active' : 'tool-square'}
                      onClick={() => setBrushSize(size)}
                    >
                      <span
                        className="tool-square__dot"
                        style={{
                          width: `${Math.max(8, size + 4)}px`,
                          height: `${Math.max(8, size + 4)}px`,
                        }}
                      />
                    </button>
                  ))}
                </div>

                <div className="draw-board">
                  <div className="draw-canvas-wrap">
                    <canvas
                      ref={canvasRef}
                      className="drawing-canvas"
                      width={CANVAS_SIZE}
                      height={CANVAS_SIZE}
                      aria-label="Lienzo para dibujar lo que imagina el monstruo"
                      onPointerCancel={() => {
                        finishStroke()
                        hideCanvasCursor()
                      }}
                      onPointerDown={beginStroke}
                      onPointerEnter={showCanvasCursor}
                      onPointerLeave={() => {
                        finishStroke()
                        hideCanvasCursor()
                      }}
                      onPointerMove={continueStroke}
                      onPointerUp={finishStroke}
                    />

                    <span
                      aria-hidden="true"
                      className={canvasCursor.visible ? 'draw-cursor is-visible' : 'draw-cursor'}
                      style={{
                        left: `${(canvasCursor.x / CANVAS_SIZE) * 100}%`,
                        top: `${(canvasCursor.y / CANVAS_SIZE) * 100}%`,
                        width: `${(Math.max(brushSize, 10) / CANVAS_SIZE) * 100}%`,
                        height: `${(Math.max(brushSize, 10) / CANVAS_SIZE) * 100}%`,
                        borderColor: brushColor === '#ffffff' ? '#111111' : brushColor,
                      }}
                    />
                  </div>
                </div>

                <div className="draw-tools draw-tools--colors" aria-label="Paleta de color">
                  {availableBrushColors.map((color) => (
                    <button
                      key={color}
                      type="button"
                      aria-label={`Usar ${color}`}
                      className={color === brushColor ? 'color-swatch is-active' : 'color-swatch'}
                      style={{ backgroundColor: color }}
                      onClick={() => setBrushColor(color)}
                    />
                  ))}
                </div>
              </div>

              <div className="draw-name-field">
                <label className="draw-name-label" htmlFor="creature-name">
                  Nombre del personaje
                </label>

                <input
                  id="creature-name"
                  type="text"
                  className="draw-name-input"
                  value={creatureName}
                  maxLength={32}
                  placeholder="Ponle un nombre"
                  onChange={(event) => setCreatureName(event.target.value)}
                />
              </div>

              <div className="draw-utility-actions">
                <button
                  type="button"
                  className="utility-icon"
                  disabled={undoStack.length <= 1}
                  onClick={undoDrawing}
                  aria-label="Deshacer"
                >
                  ↺
                </button>

                <button
                  type="button"
                  className="utility-icon"
                  disabled={redoStack.length === 0}
                  onClick={redoDrawing}
                  aria-label="Rehacer"
                >
                  ↻
                </button>
              </div>

              <div className="draw-main-actions">
                <button
                  type="button"
                  className="monster-action monster-action--cancel"
                  onClick={() => {
                    cancelDrawing()
                  }}
                >
                  Cancelar
                </button>

                <button
                  type="button"
                  className="monster-action monster-action--done"
                  disabled={isSaving}
                  onClick={saveDrawing}
                >
                  {isSaving ? 'Guardando' : 'Listo'}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {currentStep === 'park' ? (
          <div className="step-screen step-screen--park">
            <img className="stage-image" src={monsterBackdrop} alt="Monstruo imaginando el parque" />

            <div className="park-overlay">
              <div className="park-window">
                <div
                  className="park-scene"
                  onPointerMove={updateHoveredActorFromPointer}
                >
                  <svg
                    className="park-svg"
                    viewBox="0 0 900 620"
                    role="img"
                    aria-label="Parque de atracciones isometrico con personajes paseando"
                  >
                    <defs>
                      <linearGradient id="skyGlow" x1="0" x2="1" y1="0" y2="1">
                        <stop offset="0%" stopColor="#fff7d1" />
                        <stop offset="100%" stopColor="#ffd8b2" />
                      </linearGradient>
                      <linearGradient id="grassTone" x1="0" x2="1" y1="0" y2="1">
                        <stop offset="0%" stopColor="#9fd29a" />
                        <stop offset="100%" stopColor="#5f9a68" />
                      </linearGradient>
                      <linearGradient id="pathTone" x1="0" x2="1" y1="0" y2="1">
                        <stop offset="0%" stopColor="#ffe6c6" />
                        <stop offset="100%" stopColor="#efbf84" />
                      </linearGradient>
                    </defs>

                    <ellipse cx="450" cy="160" rx="340" ry="120" fill="url(#skyGlow)" opacity="0.42" />
                    <polygon points="450,86 778,250 450,418 122,250" fill="url(#grassTone)" stroke="#3f7b58" strokeWidth="6" />
                    <polygon points="450,140 715,250 450,382 185,250" fill="#86be7d" opacity="0.55" />

                    <polyline points={polyline} fill="none" stroke="#f7edd7" strokeWidth="44" strokeLinejoin="round" strokeLinecap="round" />
                    <polyline points={polyline} fill="none" stroke="url(#pathTone)" strokeWidth="28" strokeLinejoin="round" strokeLinecap="round" />
                    <polyline points={polyline} fill="none" stroke="#c8864f" strokeWidth="4" strokeLinejoin="round" strokeLinecap="round" strokeDasharray="10 10" opacity="0.6" />

                    <ellipse cx={ferrisWheel.x} cy={ferrisWheel.y + 58} rx="52" ry="16" fill="#426b56" opacity="0.22" />
                    <circle cx={ferrisWheel.x} cy={ferrisWheel.y} r="50" fill="#f9fbff" stroke="#335d7e" strokeWidth="8" />
                    <line x1={ferrisWheel.x - 50} y1={ferrisWheel.y} x2={ferrisWheel.x + 50} y2={ferrisWheel.y} stroke="#335d7e" strokeWidth="6" />
                    <line x1={ferrisWheel.x} y1={ferrisWheel.y - 50} x2={ferrisWheel.x} y2={ferrisWheel.y + 50} stroke="#335d7e" strokeWidth="6" />
                    <line x1={ferrisWheel.x - 36} y1={ferrisWheel.y - 36} x2={ferrisWheel.x + 36} y2={ferrisWheel.y + 36} stroke="#335d7e" strokeWidth="6" />
                    <line x1={ferrisWheel.x + 36} y1={ferrisWheel.y - 36} x2={ferrisWheel.x - 36} y2={ferrisWheel.y + 36} stroke="#335d7e" strokeWidth="6" />
                    <path d={`M ${ferrisWheel.x - 22} ${ferrisWheel.y + 58} L ${ferrisWheel.x} ${ferrisWheel.y + 6} L ${ferrisWheel.x + 22} ${ferrisWheel.y + 58}`} fill="none" stroke="#335d7e" strokeWidth="8" strokeLinecap="round" />

                    <ellipse cx={carousel.x} cy={carousel.y + 50} rx="54" ry="16" fill="#426b56" opacity="0.2" />
                    <ellipse cx={carousel.x} cy={carousel.y + 18} rx="52" ry="18" fill="#ffddb0" stroke="#b15d32" strokeWidth="6" />
                    <path d={`M ${carousel.x - 52} ${carousel.y + 18} L ${carousel.x} ${carousel.y - 42} L ${carousel.x + 52} ${carousel.y + 18}`} fill="#ff7a59" stroke="#b15d32" strokeWidth="6" />
                    <line x1={carousel.x} y1={carousel.y - 42} x2={carousel.x} y2={carousel.y + 34} stroke="#b15d32" strokeWidth="6" />
                    <line x1={carousel.x - 28} y1={carousel.y - 8} x2={carousel.x - 28} y2={carousel.y + 32} stroke="#b15d32" strokeWidth="5" />
                    <line x1={carousel.x + 28} y1={carousel.y - 8} x2={carousel.x + 28} y2={carousel.y + 32} stroke="#b15d32" strokeWidth="5" />

                    <ellipse cx={fountain.x} cy={fountain.y + 16} rx="42" ry="14" fill="#426b56" opacity="0.2" />
                    <ellipse cx={fountain.x} cy={fountain.y} rx="38" ry="14" fill="#d1f0ff" stroke="#4f8aa3" strokeWidth="6" />
                    <path d={`M ${fountain.x} ${fountain.y - 26} C ${fountain.x - 14} ${fountain.y - 10}, ${fountain.x - 10} ${fountain.y + 2}, ${fountain.x} ${fountain.y + 6} C ${fountain.x + 10} ${fountain.y + 2}, ${fountain.x + 14} ${fountain.y - 10}, ${fountain.x} ${fountain.y - 26}`} fill="#f3fbff" stroke="#4f8aa3" strokeWidth="4" />

                    <ellipse cx={booth.x} cy={booth.y + 28} rx="46" ry="14" fill="#426b56" opacity="0.2" />
                    <rect x={booth.x - 38} y={booth.y - 10} width="76" height="36" rx="10" fill="#ffe7a3" stroke="#8d5b2b" strokeWidth="6" />
                    <path d={`M ${booth.x - 44} ${booth.y - 10} L ${booth.x} ${booth.y - 38} L ${booth.x + 44} ${booth.y - 10}`} fill="#ff6f61" stroke="#8d5b2b" strokeWidth="6" />

                    <ellipse cx={coasterA.x} cy={coasterA.y + 48} rx="96" ry="18" fill="#426b56" opacity="0.2" />
                    <path d={`M ${coasterA.x - 90} ${coasterA.y + 12} C ${coasterA.x - 40} ${coasterA.y - 70}, ${coasterB.x - 30} ${coasterB.y - 110}, ${coasterB.x} ${coasterB.y - 36} S ${coasterA.x + 54} ${coasterA.y + 34}, ${coasterA.x + 94} ${coasterA.y - 16}`} fill="none" stroke="#324f74" strokeWidth="8" strokeLinecap="round" />
                    <path d={`M ${coasterA.x - 90} ${coasterA.y + 32} C ${coasterA.x - 40} ${coasterA.y - 50}, ${coasterB.x - 30} ${coasterB.y - 90}, ${coasterB.x} ${coasterB.y - 16} S ${coasterA.x + 54} ${coasterA.y + 54}, ${coasterA.x + 94} ${coasterA.y + 4}`} fill="none" stroke="#f06d43" strokeWidth="8" strokeLinecap="round" />
                    <line x1={coasterA.x - 62} y1={coasterA.y + 20} x2={coasterA.x - 62} y2={coasterA.y + 70} stroke="#324f74" strokeWidth="6" />
                    <line x1={coasterA.x - 2} y1={coasterA.y - 24} x2={coasterA.x - 2} y2={coasterA.y + 68} stroke="#324f74" strokeWidth="6" />
                    <line x1={coasterA.x + 54} y1={coasterA.y + 12} x2={coasterA.x + 54} y2={coasterA.y + 66} stroke="#324f74" strokeWidth="6" />

                    <g className="park-labels">
                      <text x={ferrisWheel.x} y={ferrisWheel.y - 72}>Noria</text>
                      <text x={carousel.x} y={carousel.y - 62}>Carrusel</text>
                      <text x={coasterB.x + 42} y={coasterB.y - 118}>Montana rusa</text>
                      <text x={fountain.x} y={fountain.y - 34}>Fuente</text>
                    </g>
                  </svg>

                  {actors.map((actor) => {
                    const worldPoint = getPathPoint(actor.routeIndex, actor.progress)
                    const screenPoint = toScenePoint(
                      worldPoint.x + actor.laneOffset,
                      worldPoint.y - actor.laneOffset,
                      getHopOffset(actor, now),
                    )

                    const actorClassName = [
                      'park-actor',
                      actor.conversationUntil > now ? 'is-chatting' : '',
                      hoveredActorId === actor.id ? 'is-hovered' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')

                    return (
                      <div
                        key={actor.id}
                        data-actor-id={actor.id}
                        className={actorClassName}
                        onPointerEnter={() => {
                          hoveredActorIdRef.current = actor.id
                          setHoveredActorId(actor.id)
                        }}
                        style={{
                          left: `${screenPoint.x}px`,
                          top: `${screenPoint.y}px`,
                          width: `${actor.size}px`,
                          zIndex: Math.round(screenPoint.y),
                        }}
                      >
                        <div className="actor-shadow" />
                        <img
                          src={actor.imageData}
                          alt={actor.name}
                          style={{ transform: `scaleX(${actor.facing})` }}
                        />
                        {actor.conversationUntil > now && actor.phrase ? (
                          <div className="speech-bubble">{actor.phrase}</div>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>

            <div className="park-mask" aria-hidden="true" style={{ backgroundImage: `url(${monsterBackdrop})` }} />

            {hoveredActor && hoveredActorScreenPoint ? (
              <div className="park-popover-layer">
                <div
                  className={[
                    'actor-popover',
                    'park-floating-popover',
                    isHoveredPopoverBelow ? 'is-below' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onPointerEnter={() => {
                    hoveredActorIdRef.current = hoveredActor.id
                    setHoveredActorId(hoveredActor.id)
                  }}
                  style={{
                    left: `${hoveredActorScreenPoint.x}px`,
                    top: `${
                      isHoveredPopoverBelow
                        ? hoveredActorScreenPoint.y + 2
                        : hoveredActorScreenPoint.y - hoveredActor.size - 2
                    }px`,
                  }}
                >
                  <strong>{hoveredActor.name}</strong>
                  <div className="actor-popover__image-frame">
                    <img src={hoveredActor.imageData} alt="" />
                  </div>
                  <button
                    type="button"
                    className="actor-edit-button"
                    aria-label={`Editar ${hoveredActor.name}`}
                    onClick={() => {
                      editDrawing({
                        id: hoveredActor.id,
                        name: hoveredActor.name,
                        imageData: hoveredActor.imageData,
                        createdAt: '',
                      })
                    }}
                  >
                    {'\u270e'}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      {currentStep === 'park' ? (
        <div className="park-summary">
          <div className="park-info-row">
            <div className="info-chip">
              <span>Habitantes</span>
              <strong>{parkDrawings.length}</strong>
            </div>
            <div className="info-chip">
              <span>Charlas</span>
              <strong>{activeChats}</strong>
            </div>
            <div className="info-chip">
              <span>Ultimo</span>
              <strong>{newestCreature}</strong>
            </div>
          </div>

          <button type="button" className="park-restart" onClick={restartDrawing}>
            Dibujar monstruo
          </button>
        </div>
      ) : null}

      <p className="stage-message">{loadError || formMessage || 'La coleccion se actualiza sola y conserva el parque vivo.'}</p>
    </main>
  )
}

export default App
