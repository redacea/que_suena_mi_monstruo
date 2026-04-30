import express from 'express'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const port = Number(process.env.PORT || 3001)
const storageDir = path.join(__dirname, 'storage')
const storageFile = path.join(storageDir, 'drawings.json')
const distDir = path.join(__dirname, 'dist')
const maxItems = 24

let writeQueue = Promise.resolve()

app.use(express.json({ limit: '2mb' }))

async function ensureStorage() {
  await fs.mkdir(storageDir, { recursive: true })

  try {
    await fs.access(storageFile)
  } catch {
    await fs.writeFile(storageFile, '[]\n', 'utf8')
  }
}

async function readDrawings() {
  await ensureStorage()

  try {
    const raw = await fs.readFile(storageFile, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function writeDrawings(drawings) {
  await ensureStorage()
  await fs.writeFile(storageFile, `${JSON.stringify(drawings, null, 2)}\n`, 'utf8')
}

function enqueueWrite(operation) {
  const nextTask = writeQueue.then(operation, operation)
  writeQueue = nextTask.then(
    () => undefined,
    () => undefined,
  )
  return nextTask
}

function sanitizeName(value) {
  const normalized = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return normalized.slice(0, 24) || 'Visitante'
}

function isValidImageData(value) {
  return typeof value === 'string' && /^data:image\/png;base64,/.test(value) && value.length <= 1_500_000
}

app.get('/api/drawings', async (_request, response) => {
  const drawings = await readDrawings()
  drawings.sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt))
  response.json(drawings.slice(0, maxItems))
})

app.post('/api/drawings', async (request, response) => {
  const name = sanitizeName(request.body?.name)
  const imageData = request.body?.imageData

  if (!isValidImageData(imageData)) {
    response.status(400).json({ message: 'Imagen invalida.' })
    return
  }

  const drawing = {
    id: crypto.randomUUID(),
    name,
    imageData,
    createdAt: new Date().toISOString(),
  }

  await enqueueWrite(async () => {
    const drawings = await readDrawings()
    drawings.unshift(drawing)
    await writeDrawings(drawings.slice(0, maxItems))
  })

  response.status(201).json(drawing)
})

if (await fs.access(distDir).then(() => true).catch(() => false)) {
  app.use(express.static(distDir))

  app.get(/^(?!\/api).*/, (_request, response) => {
    response.sendFile(path.join(distDir, 'index.html'))
  })
}

await ensureStorage()

app.listen(port, () => {
  console.log(`Park server listening on http://localhost:${port}`)
})