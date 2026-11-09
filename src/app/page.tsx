'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import './orbit.css'

/* ---------------------------------- types --------------------------------- */

interface Member {
  id: string
  username: string
}

interface ReplyRef {
  username: string
  message: string
  isImage: boolean
}

interface PendingImage {
  dataUrl: string
  name: string
  kb: number
}

interface ChatMessage {
  kind: 'system' | 'text' | 'image'
  id: string
  username?: string
  text?: string // decrypted plaintext (images: data URL)
  caption?: string // decrypted optional photo caption
  timestamp?: string
  isSelf?: boolean
  reply?: ReplyRef | null
}

const SOCKET_URL = '/?XTransformPort=3003'
const RT_BOOT_URL = '/api/rt'
const TYPING_RESET_MS = 1200
const MAX_TEXT = 500
const MAX_IMAGE_DIM = 1024
const MAX_CAPTION = 300
const OC1_MIME = 'data:image/oc1;base64,'

let idCounter = 0
const nextId = () => `m${Date.now()}_${idCounter++}`

/* ------------------------- client-side encryption ------------------------- */
/* AES-GCM with a key derived from the room code; the relay never sees
   plaintext. IV is random per message and prepended to the ciphertext.      */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

async function deriveRoomKey(room: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw',
    encoder.encode(`ipchat:${room}`),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: encoder.encode(`salt:${room}`), iterations: 120_000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function sealText(key: CryptoKey, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plain))
  const combined = new Uint8Array(iv.length + cipher.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(cipher), iv.length)
  return bufToBase64(combined.buffer)
}

async function openText(key: CryptoKey, payload: string): Promise<string> {
  const bytes = base64ToBytes(payload)
  const iv = bytes.subarray(0, 12)
  const cipher = bytes.subarray(12)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher)
  return decoder.decode(plain)
}

/* Sealed photo envelope: images travel as `data:image/oc1;base64,…` — shaped
   like a data URL so the relay passes it through untouched, while the custom
   mime marks the body as AES-GCM ciphertext that only room members can open. */

async function sealImagePacket(key: CryptoKey, plain: string): Promise<string> {
  return OC1_MIME + (await sealText(key, plain))
}

async function openPacket(key: CryptoKey, payload: string): Promise<string> {
  if (payload.startsWith(OC1_MIME)) return openText(key, payload.slice(OC1_MIME.length))
  if (payload.startsWith('oc1:')) return openText(key, payload.slice(4))
  return payload // legacy plaintext passthrough
}

/* ------------------------------- utilities -------------------------------- */

const IPV4_RE = /^(\d{1,3})(\.(\d{1,3})){3}$/

function isValidRoomCode(value: string): boolean {
  if (!IPV4_RE.test(value.trim())) return false
  return value.trim().split('.').every((part) => Number(part) <= 255)
}

function formatTime(iso?: string): string {
  const d = iso ? new Date(iso) : new Date()
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

async function shrinkImage(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('read failed'))
    reader.readAsDataURL(file)
  })
  const img = document.createElement('img')
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('decode failed'))
    img.src = dataUrl
  })
  const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(img.width, img.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.width * scale))
  canvas.height = Math.max(1, Math.round(img.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return dataUrl
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.82)
}

/* --------------------------------- icons ---------------------------------- */

const OrbitMark = ({ size = 40 }: { size?: number }) => (
  <span className="oc-orbit-mark" aria-hidden="true">
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <defs>
        <linearGradient id="oc-gold-grad" x1="6" y1="6" x2="34" y2="36">
          <stop offset="0%" stopColor="#f0d9a8" />
          <stop offset="55%" stopColor="#d8b26e" />
          <stop offset="100%" stopColor="#a8874f" />
        </linearGradient>
      </defs>
      <circle cx="20" cy="20" r="8.5" fill="url(#oc-gold-grad)" />
      <circle cx="17.2" cy="17.2" r="2.6" fill="rgba(255,255,255,0.45)" />
      <g className="oc-orbit-ring">
        <ellipse cx="20" cy="20" rx="16" ry="6.5" stroke="url(#oc-gold-grad)" strokeWidth="1.1" opacity="0.85" transform="rotate(-24 20 20)" />
        <circle cx="35" cy="13.5" r="1.9" fill="#f0d9a8" />
      </g>
    </svg>
  </span>
)

const ArrowIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
    <path d="M5 12h14M12 5l7 7-7 7" />
  </svg>
)

const ImageIcon = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="M21 15l-5-5L5 21" />
  </svg>
)

const SendIcon = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
    <path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" />
  </svg>
)

const LockIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
)

/* --------------------------------- page ----------------------------------- */

export default function IpChatPage() {
  const [screen, setScreen] = useState<'join' | 'chat'>('join')
  const [username, setUsername] = useState('')
  const [roomInput, setRoomInput] = useState('')
  const [joinError, setJoinError] = useState('')
  const [connecting, setConnecting] = useState(false)

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [typingNames, setTypingNames] = useState<string[]>([])
  const [replyTarget, setReplyTarget] = useState<ReplyRef | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null)
  const [captionDraft, setCaptionDraft] = useState('')
  const [sendingImage, setSendingImage] = useState(false)

  const socketRef = useRef<Socket | null>(null)
  const roomRef = useRef('')
  const nameRef = useRef('')
  const keyRef = useRef<CryptoKey | null>(null)
  const replyRef = useRef<ReplyRef | null>(null)
  const typingFlagRef = useRef(false)
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const typingResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = messagesRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [])

  const pushSystem = useCallback((text: string) => {
    setMessages((prev) => [...prev, { kind: 'system', id: nextId(), text }])
  }, [])

  /* ------------------------------ socket wiring ----------------------------- */

  useEffect(() => {
    if (screen !== 'chat') return

    let socket: Socket | null = null
    let disposed = false

    const boot = async () => {
      // boot the in-process relay first so the gateway has an upstream
      try {
        await fetch(RT_BOOT_URL, { cache: 'no-store' })
      } catch {
        /* socket.io will retry anyway */
      }
      if (disposed) return

      socket = io(SOCKET_URL, {
        path: '/',
        transports: ['websocket', 'polling'],
        forceNew: true,
        reconnection: true,
        reconnectionAttempts: 8,
        reconnectionDelay: 1000,
        timeout: 10000,
      })
      socketRef.current = socket

      socket.on('connect', () => {
        socket!.emit('join_room', { username: nameRef.current, room: roomRef.current })
      })

    socket.on('members_update', ({ members: list }: { members: Member[] }) => {
      setMembers(list ?? [])
    })

    socket.on('user_joined', ({ message }: { message: string }) => pushSystem(message))
    socket.on('user_left', ({ message }: { message: string }) => pushSystem(message))

    socket.on('receive_message', async (body: { username: string; message: string; senderId: string; timestamp: string; reply: ReplyRef | null }) => {
      let text = '[could not decrypt]'
      try {
        if (keyRef.current) text = await openText(keyRef.current, body.message)
      } catch {
        /* keep fallback text */
      }
      setMessages((prev) => [
        ...prev,
        {
          kind: 'text',
          id: nextId(),
          username: body.username,
          text,
          timestamp: body.timestamp,
          isSelf: body.senderId === socket!.id,
          reply: body.reply,
        },
      ])
      setTypingNames((prev) => prev.filter((n) => n !== body.username))
      scrollToBottom()
    })

    socket.on('receive_image', async (body: { username: string; imageData: string; caption?: string; senderId: string; timestamp: string; reply: ReplyRef | null }) => {
      let dataUrl = ''
      let caption = ''
      try {
        if (keyRef.current) {
          dataUrl = await openPacket(keyRef.current, body.imageData)
          if (body.caption) caption = await openPacket(keyRef.current, body.caption)
        }
      } catch {
        dataUrl = ''
      }
      if (!dataUrl.startsWith('data:image/')) {
        pushSystem(`A photo from ${body.username} could not be decrypted.`)
        return
      }
      setMessages((prev) => [
        ...prev,
        {
          kind: 'image',
          id: nextId(),
          username: body.username,
          text: dataUrl,
          caption,
          timestamp: body.timestamp,
          isSelf: body.senderId === socket!.id,
          reply: body.reply,
        },
      ])
      scrollToBottom()
    })

    socket.on('user_typing', ({ username: who }: { username: string }) => {
      setTypingNames((prev) => (prev.includes(who) ? prev : [...prev, who]))
    })

    socket.on('user_stopped_typing', ({ username: who }: { username: string }) => {
      setTypingNames((prev) => prev.filter((n) => n !== who))
    })

    socket.on('chat_cleared', ({ clearedBy }: { clearedBy: string }) => {
      setMessages([{ kind: 'system', id: nextId(), text: `${clearedBy} cleared the conversation` }])
      setTypingNames([])
    })

    socket.on('image_rejected', ({ reason }: { reason: string }) => pushSystem(reason))
    socket.on('join_error', ({ message }: { message: string }) => pushSystem(message))
    }

    boot()

    return () => {
      disposed = true
      if (socket) {
        socket.removeAllListeners()
        socket.disconnect()
      }
      socketRef.current = null
    }
  }, [screen, pushSystem, scrollToBottom])

  /* --------------------------------- actions -------------------------------- */

  const handleConnect = async () => {
    setJoinError('')
    const name = username.trim().slice(0, 20)
    const room = roomInput.trim()
    if (!name) {
      setJoinError('Pick a username first.')
      return
    }
    if (!isValidRoomCode(room)) {
      setJoinError('Room code must be a valid IPv4-style address, e.g. 192.168.1.1.')
      return
    }
    setConnecting(true)
    try {
      nameRef.current = name
      roomRef.current = room
      keyRef.current = await deriveRoomKey(room)
      setMessages([{ kind: 'system', id: nextId(), text: '— Start of conversation —' }])
      setScreen('chat')
    } catch {
      setJoinError('Could not prepare encryption for this room. Try again.')
    } finally {
      setConnecting(false)
    }
  }

  const leaveRoom = () => window.location.reload()

  const setReply = (msg: ChatMessage) => {
    if (msg.kind === 'system') return
    const ref: ReplyRef = {
      username: msg.username ?? '',
      message:
        msg.kind === 'image'
          ? msg.caption?.trim()
            ? msg.caption.slice(0, 120)
            : '🖼 photo'
          : (msg.text ?? '').slice(0, 120),
      isImage: msg.kind === 'image',
    }
    replyRef.current = ref
    setReplyTarget(ref)
    inputRef.current?.focus()
  }

  const cancelReply = () => {
    replyRef.current = null
    setReplyTarget(null)
  }

  const stopTypingSignal = useCallback(() => {
    if (typingFlagRef.current) {
      typingFlagRef.current = false
      socketRef.current?.emit('typing_stop', { room: roomRef.current })
    }
  }, [])

  const handleDraftChange = (value: string) => {
    setDraft(value)
    const socket = socketRef.current
    if (!socket) return
    if (!typingFlagRef.current && value.trim()) {
      typingFlagRef.current = true
      socket.emit('typing_start', { room: roomRef.current })
    }
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
    typingTimerRef.current = setTimeout(stopTypingSignal, TYPING_RESET_MS)
  }

  const handleSend = async () => {
    const socket = socketRef.current
    const plain = draft.trim()
    if (!socket || !plain || !keyRef.current) return

    stopTypingSignal()
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current)

    let sealed = ''
    try {
      sealed = await sealText(keyRef.current, plain)
    } catch {
      return
    }
    socket.emit('send_message', {
      message: sealed,
      reply: replyRef.current,
    })
    setDraft('')
    cancelReply()
  }

  /* Photo picking never sends directly — the file lands in a WhatsApp-style
     confirmation sheet first; only the explicit Send button puts it on the
     wire, so an accidental pick can always be discarded.                    */

  const handlePickImage = async (file: File | undefined) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      pushSystem('That file is not an image.')
      return
    }
    try {
      const dataUrl = await shrinkImage(file)
      setCaptionDraft('')
      setPendingImage({ dataUrl, name: file.name || 'photo', kb: Math.max(1, Math.round(file.size / 1024)) })
    } catch {
      pushSystem('Could not read that image.')
    }
  }

  const cancelPendingImage = () => {
    if (sendingImage) return
    setPendingImage(null)
    setCaptionDraft('')
  }

  const confirmSendImage = async () => {
    const socket = socketRef.current
    if (!socket || !keyRef.current || !pendingImage || sendingImage) return
    setSendingImage(true)
    try {
      const sealed = await sealImagePacket(keyRef.current, pendingImage.dataUrl)
      if (sealed.length > 1_950_000) {
        pushSystem('That photo is too large once sealed — try a smaller one.')
        return
      }
      const cap = captionDraft.trim().slice(0, MAX_CAPTION)
      const sealedCaption = cap ? 'oc1:' + (await sealText(keyRef.current, cap)) : ''
      socket.emit('send_image', { imageData: sealed, caption: sealedCaption, reply: replyRef.current })
      cancelReply()
      setPendingImage(null)
      setCaptionDraft('')
    } catch {
      pushSystem('Could not seal that photo for sending.')
    } finally {
      setSendingImage(false)
    }
  }

  // Escape dismisses the confirmation sheet (never mid-send)
  useEffect(() => {
    if (!pendingImage) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !sendingImage) {
        setPendingImage(null)
        setCaptionDraft('')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pendingImage, sendingImage])

  const handleClear = () => {
    if (window.confirm('Clear the chat for everyone in this room?')) {
      socketRef.current?.emit('clear_chat', { room: roomRef.current })
    }
  }

  /* --------------------------------- render --------------------------------- */

  const myId = socketRef.current?.id
  const onlineCount = members.length || 1

  if (screen === 'join') {
    return (
      <div className="orbit-root">
        <div className="oc-join">
          <div className="oc-orbit-deco one" aria-hidden="true"><span className="oc-planet" /></div>
          <div className="oc-orbit-deco two" aria-hidden="true"><span className="oc-planet" /></div>
          <div className="oc-card">
            <div className="oc-join-logo">
              <span className="oc-logo">
                <OrbitMark size={46} />
                <span className="oc-logo-word">
                  <span className="oc-logo-title">Orbit</span>
                  <span className="oc-logo-sub">Chat</span>
                </span>
              </span>
            </div>
            <p className="oc-tagline">A private lounge in the cloud — share one address, and everyone who enters it lands in the same room.</p>

            <label className="oc-field">
              <span className="oc-field-label">USERNAME</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
                placeholder="e.g. alice"
                maxLength={20}
                autoComplete="off"
              />
            </label>

            <label className="oc-field">
              <span className="oc-field-label">Room Code</span>
              <input
                value={roomInput}
                onChange={(e) => setRoomInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
                placeholder="e.g. 192.168.1.1"
                autoComplete="off"
                inputMode="decimal"
              />
              <span className="oc-hint">Everyone who enters this exact code joins the same conversation.</span>
            </label>

            <button className="oc-connect" onClick={handleConnect} disabled={connecting}>
              <span>{connecting ? 'Entering…' : 'Enter the room'}</span>
              <ArrowIcon />
            </button>

            <p className="oc-error" role="alert">{joinError}</p>

            <p className="oc-enc-note">
              <LockIcon />
              Sealed with a key derived from the room code
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="orbit-root">
      <div className="oc-chat">
        <div className={`oc-scrim${sidebarOpen ? ' show' : ''}`} onClick={() => setSidebarOpen(false)} aria-hidden="true" />

        <aside className={`oc-sidebar${sidebarOpen ? ' open' : ''}`}>
          <div className="oc-logo oc-side-logo">
            <OrbitMark size={28} />
            <span className="oc-logo-word">
              <span className="oc-logo-title">Orbit</span>
              <span className="oc-logo-sub">Chat</span>
            </span>
          </div>

          <div className="oc-room-block">
            <div className="oc-block-label">Room</div>
            <div className="oc-room-ip">{roomRef.current || '—'}</div>
            <div className="oc-online">
              <span className="oc-dot" />
              <span>{onlineCount} online</span>
            </div>
          </div>

          <div className="oc-members">
            <div className="oc-block-label">Members</div>
            <div className="oc-members-list">
              {members.map((m) => (
                <div key={m.id} className={`oc-member${m.id === myId ? ' is-me' : ''}`}>
                  <span className="oc-member-dot" />
                  <span className="oc-member-name">{m.username}</span>
                  {m.id === myId && <span className="oc-you-tag">YOU</span>}
                </div>
              ))}
              {members.length === 0 && <div className="oc-member"><span className="oc-member-name">connecting…</span></div>}
            </div>
          </div>

          <button className="oc-leave" onClick={leaveRoom}>← Leave Room</button>
        </aside>

        <main className="oc-main">
          <header className="oc-header">
            <button className="oc-menu-btn" onClick={() => setSidebarOpen((v) => !v)} aria-label="Toggle sidebar">☰</button>
            <div className="oc-header-room">
              <span className="oc-header-label">Room</span>
              <span className="oc-header-ip">{roomRef.current || '—'}</span>
            </div>
            <button className="oc-clear-btn" onClick={handleClear} title="Clear chat for everyone">🗑 Clear</button>
            <div className="oc-header-user">{nameRef.current || '—'}</div>
          </header>

          <div className="oc-messages" ref={messagesRef}>
            {messages.map((msg) => {
              if (msg.kind === 'system') {
                return msg.id.startsWith('m') && msg.text === '— Start of conversation —' ? (
                  <div key={msg.id} className="oc-start-divider"><span>— Start of conversation —</span></div>
                ) : (
                  <div key={msg.id} className="oc-sys">{msg.text}</div>
                )
              }
              return (
                <div key={msg.id} className={`oc-msg${msg.isSelf ? ' self' : ''}`} onDoubleClick={() => setReply(msg)}>
                  <div className="oc-msg-meta">
                    <span className="oc-msg-author">{msg.username}</span>
                    <span className="oc-msg-time">{formatTime(msg.timestamp)}</span>
                  </div>
                  <div className="oc-bubble">
                    {msg.reply && (
                      <div className="oc-reply-chip">
                        <span className="oc-reply-name">↩ {msg.reply.username}</span>
                        <span className="oc-reply-body">{msg.reply.message}</span>
                      </div>
                    )}
                    {msg.kind === 'image' ? (
                      <>
                        <img
                          className="oc-img-thumb"
                          src={msg.text}
                          alt={`photo from ${msg.username}`}
                          onClick={(e) => { e.stopPropagation(); setLightbox(msg.text ?? null) }}
                        />
                        {msg.caption && <span className="oc-img-caption">{msg.caption}</span>}
                      </>
                    ) : (
                      <span className="oc-text">{msg.text}</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="oc-typing">
            {typingNames.length > 0 &&
              `${typingNames.slice(0, 2).join(', ')}${typingNames.length > 2 ? ' and others' : ''} ${typingNames.length > 1 ? 'are' : 'is'} typing…`}
          </div>

          <div className={`oc-replybar${replyTarget ? ' show' : ''}`}>
            <span className="oc-rb-text">
              <b>↩ {replyTarget?.username}</b> · {replyTarget?.message}
            </span>
            <button className="oc-rb-cancel" onClick={cancelReply} aria-label="Cancel reply">✕</button>
          </div>

          <div className="oc-inputbar">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                handlePickImage(e.target.files?.[0])
                e.target.value = ''
              }}
            />
            <button className="oc-icon-btn" onClick={() => fileRef.current?.click()} aria-label="Send image" title="Send image">
              <ImageIcon />
            </button>
            <input
              ref={inputRef}
              className="oc-msg-input"
              value={draft}
              onChange={(e) => handleDraftChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
              placeholder="Type a message…"
              maxLength={MAX_TEXT}
              autoComplete="off"
            />
            <button className="oc-send-btn" onClick={handleSend} aria-label="Send" title="Send">
              <SendIcon />
            </button>
          </div>
        </main>
      </div>

      {pendingImage && (
        <div className="oc-overlay confirm" onClick={cancelPendingImage}>
          <div className="oc-confirm" role="dialog" aria-modal="true" aria-label="Confirm sending photo" onClick={(e) => e.stopPropagation()}>
            <header className="oc-confirm-head">
              <div className="oc-confirm-titles">
                <span className="oc-confirm-title">Send photo?</span>
                <span className="oc-confirm-sub">to room {roomRef.current || '—'}</span>
              </div>
              <button className="oc-confirm-x" onClick={cancelPendingImage} aria-label="Discard photo" disabled={sendingImage}>✕</button>
            </header>
            <div className="oc-confirm-preview">
              <img src={pendingImage.dataUrl} alt="Selected photo preview" />
            </div>
            <div className="oc-confirm-meta">
              <LockIcon />
              <span>Encrypted end-to-end · {pendingImage.name} · {pendingImage.kb} KB</span>
            </div>
            <input
              className="oc-confirm-caption"
              value={captionDraft}
              onChange={(e) => setCaptionDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirmSendImage() } }}
              placeholder="Add a caption… (optional)"
              maxLength={MAX_CAPTION}
              autoFocus
              disabled={sendingImage}
            />
            <footer className="oc-confirm-foot">
              <button className="oc-confirm-cancel" onClick={cancelPendingImage} disabled={sendingImage}>Cancel</button>
              <button className="oc-confirm-send" onClick={confirmSendImage} disabled={sendingImage}>
                <SendIcon />
                <span>{sendingImage ? 'Sealing…' : 'Send'}</span>
              </button>
            </footer>
          </div>
        </div>
      )}

      {lightbox && (
        <div className="oc-overlay" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="photo preview" />
        </div>
      )}
    </div>
  )
}
