import express from 'express'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const port = Number(process.env.PORT || 3001)
const storageDir = path.join(__dirname, 'storage')
const storageFile = path.join(storageDir, 'drawings.json')
const distDir = path.join(__dirname, 'dist')
const maxItems = 100
const adminUser = process.env.ADMIN_USER || 'admin'
const adminPassword = process.env.ADMIN_PASSWORD || 'monstruo'
const adminCookieName = 'monstruo_admin'
const adminSessionToken = randomUUID()

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

function getCookie(request, name) {
  const cookies = request.get('cookie') || ''
  const parts = cookies.split(';').map((part) => part.trim())
  const prefix = `${name}=`
  const cookie = parts.find((part) => part.startsWith(prefix))

  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : ''
}

function requireAdminAuth(request, response, next) {
  const hasValidCookie = getCookie(request, adminCookieName) === adminSessionToken
  const hasValidToken = request.get('x-admin-token') === adminSessionToken

  if (hasValidCookie || hasValidToken) {
    next()
    return
  }

  const authorization = request.get('authorization') || ''
  const [scheme, encodedCredentials] = authorization.split(' ')

  if (scheme === 'Basic' && encodedCredentials) {
    const [user = '', password = ''] = Buffer.from(encodedCredentials, 'base64').toString('utf8').split(':')

    if (user === adminUser && password === adminPassword) {
      response.cookie(adminCookieName, adminSessionToken, {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
      })
      next()
      return
    }
  }

  response.set('WWW-Authenticate', 'Basic realm="Administracion de dibujos"')
  response.status(401).send('Autenticacion requerida.')
}

async function sendAdminApp(_request, response) {
  const indexFile = path.join(distDir, 'index.html')
  const html = await fs.readFile(indexFile, 'utf8')
  const adminBootstrap = `<meta name="monstruo-admin-token" content="${adminSessionToken}">`
  const htmlWithAdminToken = html.includes('<script type="module"')
    ? html.replace('<script type="module"', `${adminBootstrap}\n    <script type="module"`)
    : html.replace('</head>', `${adminBootstrap}</head>`)

  response
    .set('Cache-Control', 'no-store')
    .type('html')
    .send(htmlWithAdminToken)
}

app.use((request, response, next) => {
  if (request.path === '/admin' || request.path.startsWith('/admin/') || request.path.startsWith('/api/admin')) {
    requireAdminAuth(request, response, next)
    return
  }

  next()
})

app.get('/api/drawings', async (_request, response) => {
  const drawings = await readDrawings()
  drawings.sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt))
  response.json(drawings.slice(0, maxItems))
})

app.get('/api/admin/drawings', async (_request, response) => {
  const drawings = await readDrawings()
  drawings.sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt))
  response.json(drawings)
})

app.post('/api/drawings', async (request, response) => {
  const name = sanitizeName(request.body?.name)
  const imageData = request.body?.imageData

  if (!isValidImageData(imageData)) {
    response.status(400).json({ message: 'Imagen invalida.' })
    return
  }

  const drawing = {
    id: randomUUID(),
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

app.put('/api/drawings/:id', async (request, response) => {
  const id = typeof request.params.id === 'string' ? request.params.id : ''
  const name = sanitizeName(request.body?.name)
  const imageData = request.body?.imageData

  if (!isValidImageData(imageData)) {
    response.status(400).json({ message: 'Imagen invalida.' })
    return
  }

  const updatedDrawing = await enqueueWrite(async () => {
    const drawings = await readDrawings()
    const drawingIndex = drawings.findIndex((drawing) => drawing.id === id)

    if (drawingIndex === -1) {
      return null
    }

    const updated = {
      ...drawings[drawingIndex],
      name,
      imageData,
    }

    drawings[drawingIndex] = updated
    await writeDrawings(drawings.slice(0, maxItems))
    return updated
  })

  if (!updatedDrawing) {
    response.status(404).json({ message: 'Dibujo no encontrado.' })
    return
  }

  response.json(updatedDrawing)
})

app.delete('/api/admin/drawings/:id', async (request, response) => {
  const id = typeof request.params.id === 'string' ? request.params.id : ''

  const deletedCount = await enqueueWrite(async () => {
    const drawings = await readDrawings()
    const nextDrawings = drawings.filter((drawing) => drawing.id !== id)

    if (nextDrawings.length === drawings.length) {
      return 0
    }

    await writeDrawings(nextDrawings)
    return 1
  })

  if (deletedCount === 0) {
    response.status(404).json({ message: 'Dibujo no encontrado.' })
    return
  }

  response.json({ deletedCount })
})

app.delete('/api/admin/drawings', async (request, response) => {
  const ids = Array.isArray(request.body?.ids)
    ? request.body.ids.filter((id) => typeof id === 'string' && id.trim())
    : []

  if (ids.length === 0) {
    response.status(400).json({ message: 'No hay dibujos seleccionados.' })
    return
  }

  const idSet = new Set(ids)
  const deletedCount = await enqueueWrite(async () => {
    const drawings = await readDrawings()
    const nextDrawings = drawings.filter((drawing) => !idSet.has(drawing.id))
    const count = drawings.length - nextDrawings.length

    if (count > 0) {
      await writeDrawings(nextDrawings)
    }

    return count
  })

  response.json({ deletedCount })
})

if (await fs.access(distDir).then(() => true).catch(() => false)) {
  app.use('/admin', async (request, response, next) => {
    if (request.method !== 'GET') {
      next()
      return
    }

    await sendAdminApp(request, response)
  })

  app.use(express.static(distDir))

  app.use((request, response, next) => {
    if (request.path.startsWith('/api')) {
      next()
      return
    }

    response.sendFile(path.join(distDir, 'index.html'))
  })
}

await ensureStorage()

app.listen(port, () => {
  console.log(`Park server listening on http://localhost:${port}`)
})
