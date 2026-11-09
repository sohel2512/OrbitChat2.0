/**
 * Wiretap client: joins the room like any relay member and prints the raw
 * image/caption payloads it receives. If the relay truly only ever sees
 * ciphertext, every payload must start with the sealed `data:image/oc1;`
 * envelope — never a plain `data:image/jpeg;base64,…` photo.
 */
import { io } from 'socket.io-client'

const socket = io('http://127.0.0.1:3003', { path: '/', transports: ['websocket'] })

socket.on('connect', () => {
  console.log('WIRETAP connected', socket.id)
  socket.emit('join_room', { username: 'wiretap', room: '10.0.0.7' })
})

socket.on('receive_image', (b) => {
  const img = String(b?.imageData ?? '')
  const cap = String(b?.caption ?? '')
  console.log('WIRETAP image prefix :', img.slice(0, 34))
  console.log('WIRETAP caption prefix:', (cap || '(empty)').slice(0, 16))
  console.log('WIRETAP verdict:', img.startsWith('data:image/oc1;') ? 'SEALED (ciphertext)' : 'PLAINTEXT LEAK')
  process.exit(0)
})

setTimeout(() => {
  console.log('WIRETAP timeout — no image received')
  process.exit(1)
}, 40000)
