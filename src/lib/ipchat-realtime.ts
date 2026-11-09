/**
 * IPChat realtime bootstrap.
 *
 * The Socket.IO relay lives inside the Next.js process so it survives
 * sandbox process reaping. It listens on 127.0.0.1:3003 — the gateway
 * forwards `/?XTransformPort=3003` traffic to this port. If a standalone
 * copy of the same server (mini-services/ipchat-server) is already
 * listening, we simply reuse it.
 */
import { createServer } from 'http'
import { Server as SocketServer, type Socket } from 'socket.io'

const PORT = 3003
const MAX_TEXT_LEN = 500
const MAX_NAME_LEN = 20
const MAX_IMAGE_CHARS = 2_400_000 // sealed image envelope ceiling
const MAX_CAPTION_CHARS = 1_500 // sealed caption ceiling
const RELAY_VERSION = 2 // bump to force a relay reboot after handler changes

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
  const message = typeof r.message === 'string' ? r.message.slice(0, 120) : ''
  if (!username && !message) return null
  return { username, message, isImage: r.isImage === true }
}

function membersOf(room: string): Member[] {
  const map = rooms.get(room)
  return map ? [...map.values()] : []
}

function broadcastMembers(io: SocketServer, room: string) {
  io.to(room).emit('members_update', { members: membersOf(room) })
}

function registerHandlers(io: SocketServer) {
  io.on('connection', (socket: Socket) => {
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
      broadcastMembers(io, room)

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
      // Photos arrive client-side encrypted as `data:image/oc1;base64,…` —
      // opaque to this relay. Legacy plaintext data URLs are still forwarded.
      const imageData = typeof data.imageData === 'string' ? data.imageData : ''
      if (!imageData.startsWith('data:image/') && !imageData.startsWith('oc1:')) return
      if (imageData.length > MAX_IMAGE_CHARS) {
        socket.emit('image_rejected', { reason: 'Image too large (max ~1.8 MB).' })
        return
      }
      const caption = typeof data.caption === 'string' && data.caption.length <= MAX_CAPTION_CHARS ? data.caption : ''
      const body: ChatPayload & { imageData: string; caption: string } = {
        username: currentName,
        imageData,
        caption,
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
        broadcastMembers(io, currentRoom)
        if (members.size === 0) rooms.delete(currentRoom)
      }
    })
  })
}

interface BootState {
  started: boolean
  version: number
  io?: SocketServer
}

export async function ensureRealtimeServer(): Promise<BootState> {
  const g = globalThis as unknown as {
    __ipchatRealtime?: BootState
    __ipchatRealtimeBoot?: Promise<BootState>
  }

  const alive = async (): Promise<boolean> => {
    try {
      const probe = await fetch(`http://127.0.0.1:${PORT}/?EIO=4&transport=polling`, {
        signal: AbortSignal.timeout(1500),
      })
      return probe.ok
    } catch {
      return false
    }
  }

  const existing = g.__ipchatRealtime
  if (existing) {
    if (existing.version === RELAY_VERSION && (await alive())) return existing
    if (!(await alive())) {
      // stale and dead — clear the way for a reboot
      try {
        existing.io?.close()
      } catch {
        /* already gone */
      }
      g.__ipchatRealtime = undefined
    }
    // else: stale handlers but still listening and we hold no handle — keep
    // serving (the wire protocol stays compatible) instead of bricking the port
  }

  if (g.__ipchatRealtimeBoot) return g.__ipchatRealtimeBoot

  g.__ipchatRealtimeBoot = (async (): Promise<BootState> => {
    const httpServer = createServer()
    const io = new SocketServer(httpServer, {
      path: '/',
      cors: { origin: '*', methods: ['GET', 'POST'] },
      pingTimeout: 60000,
      pingInterval: 25000,
      maxHttpBufferSize: 4e6,
    })
    registerHandlers(io)

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        httpServer.close()
        reject(err)
      }
      httpServer.once('error', onError)
      httpServer.listen(PORT, '127.0.0.1', () => {
        httpServer.off('error', onError)
        resolve()
      })
    })

    const state: BootState = { started: true, version: RELAY_VERSION, io }
    g.__ipchatRealtime = state
    return state
  })()

  try {
    return await g.__ipchatRealtimeBoot
  } catch {
    // Boot raced with another listener (e.g. hot-reload takeover). If the port
    // is served, treat it as usable — the client protocol stays compatible.
    const state: BootState = { started: await alive(), version: RELAY_VERSION }
    if (state.started) {
      g.__ipchatRealtime = state
      return state
    }
    g.__ipchatRealtime = undefined
    throw new Error('realtime relay failed to start')
  } finally {
    g.__ipchatRealtimeBoot = undefined
  }
}
