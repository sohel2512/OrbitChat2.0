import { NextResponse } from 'next/server'
import { ensureRealtimeServer } from '@/lib/ipchat-realtime'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    const state = await ensureRealtimeServer()
    return NextResponse.json({ ok: true, realtime: state.started, port: 3003 })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'realtime boot failed' },
      { status: 500 },
    )
  }
}
