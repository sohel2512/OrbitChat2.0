import { createServer } from 'http'
import { Server } from 'socket.io'

/**
 * IPChat clone — Socket.IO relay service
 * Rooms are keyed by a dotted IPv4-style code. The server only relays
 * opaque ciphertext (encryption happens on the client), images are capped.
 */

const PORT = 3003
const MAX_TEXT_LEN = 500
const MAX_NAME_LEN = 20
const MAX_IMAGE_CHARS = 2_000_000 // ~1.5 MB binary after base64

interface Member {
  id: string
  username: string
}

interface ReplyRef {
  username: string
  message: string
  isImage: boolean
}

interface ChatPayload {
  username: string
  senderId: string
  timestamp: string
  reply: ReplyRef | null
}

const rooms = new Map<string, Map<string, Member>>()

const httpServer = createServer()
const io = new Server(httpServer, {
  // DO NOT change the path, it is used by Caddy to forward the request
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 4e6,
})

const IPV4_RE = /^(\d{1,3})(\.(\d{1,3})){3}$/

function normalizeRoom(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!IPV4_RE.test(value)) return null
  const octets = value.split('.').map(Number)
  if (octets.some((o) => o < 0 || o > 255)) return null
  return octets.join('.')
}

function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[^\p{L}\p{N}_.\- ]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LEN)
}

function cleanReply(raw: unknown): ReplyRef | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const username = sanitizeName(r.username)
  const message =
    typeof r.message === 'string' ? r.message.slice(0, 120) : ''
  if (!username && !message) return null
  return { username, message, isImage: r.isImage === true }
}

function membersOf(room: string): Member[] {
  const map = rooms.get(room)
  return map ? [...map.values()] : []
}

function broadcastMembers(room: string) {
  io.to(room).emit('members_update', { members: membersOf(room) })
}

io.on('connection', (socket) => {
  let currentRoom: string | null = null
  let currentName = ''

  socket.on('join_room', (payload: unknown, ack?: unknown) => {
    const data = (payload ?? {}) as Record<string, unknown>
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
    rooms.get(room)!.set(socket.id, { id: socket.id, username: name })

    socket.to(room).emit('user_joined', { message: `${name} joined the room` })
    broadcastMembers(room)

    if (typeof ack === 'function') {
      try {
        ;(ack as (result: unknown) => void)({ ok: true, room })
      } catch {
        /* client may not pass a callback */
      }
    }
  })

  socket.on('send_message', (payload: unknown) => {
    if (!currentRoom) return
    const data = (payload ?? {}) as Record<string, unknown>
    // message text arrives encrypted client-side; treated as opaque here
    const message = typeof data.message === 'string' ? data.message : ''
    if (!message || message.length > MAX_TEXT_LEN * 4) return
    const body: ChatPayload & { message: string } = {
      username: currentName,
      message,
      senderId: socket.id,
      timestamp: new Date().toISOString(),
      reply: cleanReply(data.reply),
    }
    io.to(currentRoom).emit('receive_message', body)
  })

  socket.on('send_image', (payload: unknown) => {
    if (!currentRoom) return
    const data = (payload ?? {}) as Record<string, unknown>
    const imageData = typeof data.imageData === 'string' ? data.imageData : ''
    if (!imageData.startsWith('data:image/')) return
    if (imageData.length > MAX_IMAGE_CHARS) {
      socket.emit('image_rejected', { reason: 'Image too large (max ~1.5 MB).' })
      return
    }
    const body: ChatPayload & { imageData: string } = {
      username: currentName,
      imageData,
      senderId: socket.id,
      timestamp: new Date().toISOString(),
      reply: cleanReply(data.reply),
    }
    io.to(currentRoom).emit('receive_image', body)
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
      broadcastMembers(currentRoom)
      if (members.size === 0) rooms.delete(currentRoom)
    }
  })
})

httpServer.listen(PORT, () => {
  console.log(`[ipchat-server] listening on :${PORT}`)
})
