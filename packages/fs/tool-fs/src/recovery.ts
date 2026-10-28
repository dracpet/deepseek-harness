/**
 * Recovery payloads for the two guarded-mutation refusals that hand the model no
 * information it can act on: an unread existing target (`FS_NOT_OBSERVED`) and a
 * version that moved since the session's last read (`FS_STALE_VERSION`).
 *
 * Both are bookkeeping mismatches, not content problems — the file is perfectly
 * readable, the session's observation record simply does not cover it. That
 * happens whenever the model learned the content through a channel the policy
 * does not register (bash, grep, an editor round-trip) or mutated the file
 * between two edits. The plain diagnostic says "read the file, then retry",
 * which costs a separate round-trip and leaves the model guessing at the cause.
 *
 * This module converts the refusal into what the retry needs: it performs the
 * read, registers the observation so the retry clears the gate, and quotes the
 * current content (or the region around the anchor) inside the diagnostic. The
 * mutation itself does NOT happen on the failing call, so the gate's guarantee —
 * never overwrite content the model has not seen — still holds: the model sees
 * the content in this message, then retries deliberately.
 * @module @deepseek-ai/dsh-tool-fs/src/recovery
 */

import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { remediateFsError } from './error.ts'

/**
 * Character budget for the quoted content. Kept well under the host's
 * tool-result pruner threshold (8 KiB, which keeps head+tail only), so an
 * oversize message never loses its middle.
 */
const MAX_QUOTE_CHARS = 5_000

/** Files above this size are not quoted: read them with offset/limit instead. */
const MAX_READ_BYTES = 256 * 1024

/** Hard cap on quoted lines, so a file of short lines cannot blow the budget. */
const MAX_QUOTE_LINES = 120

/** Lines of context kept before the anchor line in a windowed quote. */
const ANCHOR_LEAD_LINES = 20

/**
 * Pick the content to quote: the whole file when it fits the budget, else a
 * window around the anchor's most likely location, else the head of the file.
 * @param text - the file's current full content.
 * @param anchor - the literal the model tried to edit, when the caller has one.
 * @returns the quoted text plus a one-line note when the quote is partial.
 */
function quoteWindow(text: string, anchor: string | undefined): { quoted: string; note: string } {
  const lines = text.split('\n')
  if (text.length <= MAX_QUOTE_CHARS) return { quoted: text, note: '' }

  let start = 0
  if (anchor !== undefined) {
    const head = anchor.split('\n').find(line => line.trim().length > 0)
    if (head !== undefined) {
      const probe = head.trim()
      const exact = lines.findIndex(line => line.includes(probe))
      const trimmed = exact >= 0 ? exact : lines.findIndex(line => line.trim() === probe)
      if (trimmed >= 0) start = Math.max(0, trimmed - ANCHOR_LEAD_LINES)
    }
  }

  const slice: string[] = []
  let used = 0
  for (let i = start; i < lines.length && slice.length < MAX_QUOTE_LINES; i++) {
    const line = lines[i] ?? ''
    if (used + line.length + 1 > MAX_QUOTE_CHARS) break
    slice.push(line)
    used += line.length + 1
  }
  const end = start + slice.length
  return {
    quoted: slice.join('\n'),
    note: `\n(quoted lines ${String(start + 1)}–${String(end)} of ${String(lines.length)}; the file is ${String(text.length)} chars)`,
  }
}

/**
 * Reason clause naming what the gate objected to.
 * @param code - the guarded-mutation error code.
 * @param displayPath - the resolved path shown to the model.
 * @returns the opening sentence of the recovered diagnostic.
 */
function reasonClause(code: string, displayPath: string): string {
  return code === 'FS_NOT_OBSERVED'
    ? `cannot modify "${displayPath}": the file already exists and this session had not read it`
    : `cannot edit "${displayPath}": it changed since this session read it`
}

/**
 * Replace a guarded-mutation refusal with a self-healing diagnostic.
 *
 * For `FS_NOT_OBSERVED` and `FS_STALE_VERSION` only: read the target, record the
 * observation for the calling session, and return an error whose message carries
 * the current content plus an explicit "retry the same call" instruction. Any
 * other error (including the sandbox marker and `FS_EDIT_NOT_FOUND`, which
 * already quotes its closest match) is returned untouched.
 * @param ctx - the plugin context providing the filesystem service and observation events.
 * @param exec - the current tool execution, carrying the owning session and cancellation.
 * @param target - the already-resolved mutation target.
 * @param error - the caught value from the failed guarded mutation.
 * @param anchor - the model's `old_string`, used to aim a windowed quote.
 * @returns a recovered `FsError`, or the original value when recovery does not apply.
 */
export async function explainMutationFailure(
  ctx: Context,
  exec: ToolExecution,
  target: FsTarget,
  error: unknown,
  anchor?: string,
): Promise<unknown> {
  const plain = remediateFsError(error, target.displayPath)
  if (!(plain instanceof FsError)) return plain
  if (plain.code !== 'FS_NOT_OBSERVED' && plain.code !== 'FS_STALE_VERSION') return plain

  const lead = reasonClause(plain.code, target.displayPath)
  let info: FsInfo | undefined
  try {
    info = await ctx.fs.stat(target, exec.signal)
  } catch {
    return plain
  }
  if (info === undefined || info.type !== 'file') return plain
  if (info.size !== undefined && info.size > MAX_READ_BYTES) {
    return new FsError(
      `${lead}. The file is ${String(info.size)} bytes, too large to quote here — read the region you intend to change (read with offset/limit), then retry.`,
      plain.code,
      { cause: plain },
    )
  }

  let text: string
  try {
    text = await ctx.fs.readText(target, exec.signal)
  } catch {
    return plain
  }

  // Register the observation for this session so the retry clears the gate. The
  // mutation on the failing call still did not happen.
  ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)

  const { quoted, note } = quoteWindow(text, anchor)
  return new FsError(
    `${lead}. The read is now registered — retry the same call now, unchanged.\n--- current content ---\n${quoted}${note}`,
    plain.code,
    { cause: plain },
  )
}
