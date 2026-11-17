/**
 * Orbit Chat — production server for plain Node hosts (Embarko).
 *
 * Attaches the Socket.IO relay to the SAME http server that serves Next.js,
 * under the `/orb` path, so the deployed app needs no private port or
 * gateway. The client detects this at runtime by probing
 * `/orb/?EIO=4&transport=polling` for an engine.io handshake.
 *
 * Per Embarko requirements: reads PORT, binds 0.0.0.0. Socket.IO keeps an
 * HTTP long-polling fallback in case websockets are not proxied.
 *
 * NOTE: realtime handlers mirror src/lib/ipchat-realtime.ts (RELAY_VERSION 2)
 * — keep the two in sync.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: runs under plain `node server-prod.cjs`, no bundler */
process.env.EMBARKO_SAME_ORIGIN = '1'

const { createServer } = require('http')
const next = require('next')
const { Server } = require('socket.io')

const PORT = Number(process.env.PORT) || 3000
const HOST = '0.0.0.0'
const RELAY_PATH = '/orb'
const MAX_TEXT_LEN = 500
const MAX_NAME_LEN = 20
const MAX_IMAGE_CHARS = 2_400_000 // sealed image envelope ceiling
const MAX_CAPTION_CHARS = 1_500 // sealed caption ceiling

/* ------------------------------- relay state ------------------------------ */

const rooms = new Map() // room -> Map(socketId -> {id, username})
const IPV4_RE = /^(\d{1,3})(\.(\d{1,3})){3}$/

function normalizeRoom(raw) {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!IPV4_RE.test(value)) return null
  const octets = value.split('.').map(Number)
  if (octets.some((o) => o < 0 || o > 255)) return null
  return octets.join('.')
}

function sanitizeName(raw) {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[^\p{L}\p{N}_.\- ]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LEN)
}

function cleanReply(raw) {
  if (!raw || typeof raw !== 'object') return null
  const username = sanitizeName(raw.username)
  const message = typeof raw.message === 'string' ? raw.message.slice(0, 120) : ''
  if (!username && !message) return null
  return { username, message, isImage: raw.isImage === true }
}

function membersOf(room) {
  const map = rooms.get(room)
  return map ? [...map.values()] : []
}

function broadcastMembers(io, room) {
  io.to(room).emit('members_update', { members: membersOf(room) })
}

/* -------------------------------- handlers -------------------------------- */

function registerHandlers(io) {
  io.on('connection', (socket) => {
    let currentRoom = null
    let currentName = ''

    socket.on('join_room', (payload, ack) => {
      const data = payload ?? {}
      const name = sanitizeName(data.username)
      const room = normalizeRoom(data.room)

      if (!name) {
        socket.emit('join_error', { message: 'Enter a username (letters, numbers, _ - . only).' })
        return
      }
      if (!room) {
        socket.emit('join_error', { message: 'Room code must look like an IPv4 address, e.g. 192.168.1.1.' })
        return
      }

      currentRoom = room
      currentName = name
      socket.join(room)

      if (!rooms.has(room)) rooms.set(room, new Map())
      rooms.get(room).set(socket.id, { id: socket.id, username: name })

      socket.to(room).emit('user_joined', { message: `${name} joined the room` })
      broadcastMembers(io, room)

      if (typeof ack === 'function') {
        try {
          ack({ ok: true, room })
        } catch {
          /* client may not pass a callback */
        }
      }
    })

    socket.on('send_message', (payload) => {
      if (!currentRoom) return
      const data = payload ?? {}
      // message text arrives encrypted client-side; treated as opaque here
      const message = typeof data.message === 'string' ? data.message : ''
      if (!message || message.length > MAX_TEXT_LEN * 4) return
      io.to(currentRoom).emit('receive_message', {
        username: currentName,
        message,
        senderId: socket.id,
        timestamp: new Date().toISOString(),
        reply: cleanReply(data.reply),
      })
    })

    socket.on('send_image', (payload) => {
      if (!currentRoom) return
      const data = payload ?? {}
      // Photos arrive client-side encrypted as `data:image/oc1;base64,…` —
      // opaque to this relay. Legacy plaintext data URLs are still forwarded.
      const imageData = typeof data.imageData === 'string' ? data.imageData : ''
      if (!imageData.startsWith('data:image/') && !imageData.startsWith('oc1:')) return
      if (imageData.length > MAX_IMAGE_CHARS) {
        socket.emit('image_rejected', { reason: 'Image too large (max ~1.8 MB).' })
        return
      }
      const caption =
        typeof data.caption === 'string' && data.caption.length <= MAX_CAPTION_CHARS ? data.caption : ''
      io.to(currentRoom).emit('receive_image', {
        username: currentName,
        imageData,
        caption,
        senderId: socket.id,
        timestamp: new Date().toISOString(),
        reply: cleanReply(data.reply),
      })
    })

    socket.on('typing_start', () => {
      if (currentRoom) socket.to(currentRoom).emit('user_typing', { username: currentName })
    })

    socket.on('typing_stop', () => {
      if (currentRoom) socket.to(currentRoom).emit('user_stopped_typing', { username: currentName })
    })

    socket.on('clear_chat', () => {
      if (!currentRoom) return
      io.to(currentRoom).emit('chat_cleared', { clearedBy: currentName })
    })

    socket.on('disconnect', () => {
      if (!currentRoom) return
      const members = rooms.get(currentRoom)
      if (!members) return
      if (members.delete(socket.id)) {
        socket.to(currentRoom).emit('user_left', { message: `${currentName} left the room` })
        broadcastMembers(io, currentRoom)
        if (members.size === 0) rooms.delete(currentRoom)
      }
    })
  })
}

/* --------------------------------- boot ----------------------------------- */

const app = next({ dev: false })
const handle = app.getRequestHandler()

app
  .prepare()
  .then(() => {
    const server = createServer((req, res) => handle(req, res))
    const io = new Server(server, {
      path: RELAY_PATH,
      cors: { origin: '*', methods: ['GET', 'POST'] },
      pingTimeout: 60000,
      pingInterval: 25000,
      maxHttpBufferSize: 4e6,
    })
    registerHandlers(io)

    server.listen(PORT, HOST, () => {
      console.log(`orbit-chat ready on http://${HOST}:${PORT} (relay at ${RELAY_PATH})`)
    })
  })
  .catch((err) => {
    console.error('orbit-chat failed to start:', err)
    process.exit(1)
  })
