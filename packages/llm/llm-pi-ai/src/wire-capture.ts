/**
 * Opt-in raw wire capture for incident forensics.
 *
 * Native comparison: pi-ai already exposes `onPayload`, `onResponse`, and a
 * custom `fetch` transport. This module only composes those hooks with local
 * 0600/0700 writes; it does not alter request payloads, response bytes, retry
 * behavior, or assistant assembly. Disabled unless DSH_PI_AI_WIRE_CAPTURE_DIR
 * is set. DSH_PI_AI_WIRE_CAPTURE_PROVIDER optionally limits the route.
 *
 * Captured payloads and SSE contain conversation content and stay on the local
 * filesystem. Credentials and request headers are never written.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SimpleStreamOptions } from '@earendil-works/pi-ai'

export interface PiAiWireCapture {
  readonly options: Pick<SimpleStreamOptions, 'onPayload' | 'onResponse' | 'fetch'>
  readonly done: Promise<void>
}

interface CaptureIdentity {
  readonly provider: string
  readonly model: string
  readonly sessionId: string | undefined
}

const safe = (value: string): string => value.replace(/[^A-Za-z0-9_.-]/g, '-')

export function piAiWireCapture(identity: CaptureIdentity): PiAiWireCapture | undefined {
  const directory = process.env.DSH_PI_AI_WIRE_CAPTURE_DIR
  if (!directory) return undefined
  const allowedProvider = process.env.DSH_PI_AI_WIRE_CAPTURE_PROVIDER
  if (allowedProvider && identity.provider !== allowedProvider) return undefined

  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stem = `${new Date().toISOString().replace(/[:.]/g, '-')}-${safe(identity.provider)}-${safe(identity.model)}-${randomUUID()}`
  const pending: Promise<void>[] = []
  let settle = (): void => {}
  const done = new Promise<void>((resolve) => { settle = resolve })
  const report = (error: unknown): void => {
    // Capture failure must not break the model call. Keep the diagnostic free of content.
    console.warn('[pi-ai-wire-capture] %s', error instanceof Error ? error.message : String(error))
  }
  const write = (suffix: string, value: string): void => {
    try {
      writeFileSync(join(directory, `${stem}-${suffix}`), value, { mode: 0o600 })
    } catch (error) {
      report(error)
    }
  }
  write('identity.json', JSON.stringify({ ...identity, capturedAt: new Date().toISOString() }, null, 2))

  return {
    options: {
      onPayload: async (payload) => {
        write('payload.json', JSON.stringify(payload, null, 2))
        // Return undefined: pi-ai keeps the original payload unchanged.
        return undefined
      },
      onResponse: async (response) => {
        write('response-meta.json', JSON.stringify({ status: response.status }, null, 2))
      },
      fetch: async (url, init) => {
        try {
          const response = await fetch(url, init)
          if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
            pending.push(response.clone().text().then(
              (body) => { write('response.sse', body) },
              (error) => { report(error) },
            ))
          }
          void Promise.all(pending).then(() => { settle() })
          return response
        } catch (error) {
          settle()
          throw error
        }
      },
    },
    done,
  }
}
