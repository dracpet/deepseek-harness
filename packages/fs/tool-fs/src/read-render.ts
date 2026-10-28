/**
 * Pure read presentation: turn provider-decoded text into a bounded, line-numbered window and
 * model-facing envelope. Chunk scanning caps the current line, so even one newline-free giant
 * line cannot grow memory without bound.
 * @module @deepseek-ai/dsh-tool-fs/read-render
 */

import { FsError } from '@deepseek-ai/dsh-fs'
import { createHash, type Hash } from 'node:crypto'
import { formatLineId, LINE_IDS_LINE_CAP } from './id-edit.ts'

/** Default maximum characters returned for a single line (the `readMaxLineLength` config). */
export const READ_MAX_LINE_LENGTH = 2000

/** Default maximum bytes returned for selected file lines (the `readMaxBytes` config). */
export const READ_MAX_BYTES = 50 * 1024

/** Resolved read window. The consumer applies its defaults/caps before calling. */
export interface ReadWindow {
  /** 1-based first line to return. */
  offset: number
  /** Maximum number of lines to return. */
  limit: number
  /** Maximum characters returned for a single line; overflow is truncated with a suffix. */
  maxLineLength: number
  /** Maximum bytes of selected output; overflow stops the scan and marks `truncatedByBytes`. */
  maxBytes: number
  /** Mint a `N#hash` id per line and wrap over-long lines losslessly (the `line_ids` arg). */
  lineIds?: boolean
  /** Per-line storage cap in `line_ids` mode; the hash still covers the whole line. */
  lineIdsLineCap?: number
}

/** One line returned from a text file. */
export interface FileTextLine {
  /** 1-based line number in the file. */
  number: number
  /** Line text without its trailing newline. */
  text: string
  /** Line id `N#hash` minted in `line_ids` mode; the hash addresses the whole line. */
  id?: string
  /** This segment continues on the next emitted entry — join by exact concatenation. */
  continued?: boolean
  /** Characters of this line beyond the storage cap that were not rendered (declared truncation). */
  lineTruncated?: number
}

/** The windowed result {@link buildWindow} produces from a file's decoded text. */
export interface WindowResult {
  /** Returned lines, already numbered. */
  lines: FileTextLine[]
  /** Exact total line count in the file. */
  totalLines: number
  /** Whether selected output hit the byte cap. */
  truncatedByBytes: boolean
}

/** Outcome of a bounded text read — what {@link formatReadOutput} renders. */
export interface FileReadOutcome {
  /** 1-based first line requested. */
  offset: number
  /** Returned lines, already numbered. */
  lines: FileTextLine[]
  /** Exact total line count in the file. */
  totalLines: number
  /** Whether selected output hit the byte cap. */
  truncatedByBytes?: true
}

interface WindowAccumulator {
  lines: FileTextLine[]
  totalLines: number
  outputBytes: number
  truncatedByBytes: boolean
}

function newAccumulator(): WindowAccumulator {
  return { lines: [], totalLines: 0, outputBytes: 0, truncatedByBytes: false }
}

function truncateLine(line: string, maxLineLength: number): string {
  return line.length > maxLineLength ? `${line.substring(0, maxLineLength)}... (line truncated to ${maxLineLength} chars)` : line
}

function lineByteSize(line: string, currentLineCount: number): number {
  return Buffer.byteLength(line, 'utf8') + (currentLineCount > 0 ? 1 : 0)
}

function consumeLine(acc: WindowAccumulator, rawLine: string, request: ReadWindow): void {
  acc.totalLines += 1
  if (acc.truncatedByBytes || acc.totalLines < request.offset || acc.lines.length >= request.limit) return

  const text = truncateLine(rawLine, request.maxLineLength)
  const bytes = lineByteSize(text, acc.lines.length)
  if (acc.outputBytes + bytes > request.maxBytes) {
    acc.truncatedByBytes = true
    return
  }
  acc.outputBytes += bytes
  acc.lines.push({ number: acc.totalLines, text })
}

/**
 * Emit one full line in `line_ids` mode: short lines render as one entry;
 * over-long lines wrap into `maxLineLength` segments that re-join by exact
 * concatenation (`continued` marks every segment but the last). A line beyond
 * the storage cap emits its prefix with `lineTruncated` naming the hidden tail
 * — a declared truncation, never the silent 2000-char stub.
 */
function consumeLineIds(
  acc: WindowAccumulator,
  rawLine: string,
  meta: { hash: string; length: number; capped: boolean },
  request: ReadWindow,
): void {
  acc.totalLines += 1
  if (acc.truncatedByBytes || acc.totalLines < request.offset || acc.lines.length >= request.limit) return

  const id = formatLineId(acc.totalLines, meta.hash)
  const push = (text: string, continued: boolean, lineTruncated?: number): void => {
    // Account the rendered form (id + one marker char + one space) so the byte
    // budget covers what the model actually receives.
    const rendered = `${id}${continued ? '>' : '|'} ${text}`
    const bytes = lineByteSize(rendered, acc.lines.length)
    if (acc.outputBytes + bytes > request.maxBytes) {
      acc.truncatedByBytes = true
      return
    }
    acc.outputBytes += bytes
    acc.lines.push({
      number: acc.totalLines,
      text,
      id,
      ...continued ? { continued: true } : {},
      ...lineTruncated !== undefined ? { lineTruncated } : {},
    })
  }

  if (rawLine.length <= request.maxLineLength && !meta.capped) {
    push(rawLine, false)
    return
  }
  const segments: string[] = []
  for (let at = 0; at < rawLine.length; at += request.maxLineLength) {
    segments.push(rawLine.slice(at, at + request.maxLineLength))
  }
  if (segments.length === 0) segments.push('')
  segments.forEach((segment, index) => {
    if (acc.truncatedByBytes) return
    const last = index === segments.length - 1
    push(segment, !last, last && meta.capped ? meta.length - rawLine.length : undefined)
  })
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/**
 * Incremental per-line hasher for `line_ids` mode. Every segment is fed (even
 * beyond the render/storage cap, so the id addresses the WHOLE line); the last
 * character of each segment is held back so a trailing `\r` — stripped from the
 * rendered text — is also excluded from the digest, keeping the id identical to
 * the one the edit side computes over LF-normalized content.
 */
class LineHasher {
  private hash: Hash = createHash('sha1')
  private pending: string | undefined
  /** Characters fed so far, including a trailing `\r` if present. */
  total = 0

  update(segment: string): void {
    this.total += segment.length
    if (this.pending !== undefined) this.hash.update(this.pending)
    this.pending = segment.slice(-1)
    this.hash.update(segment.slice(0, -1))
  }

  /** Finalize: the content hash plus the line length as the edit side sees it (no trailing CR). */
  finalize(): { hash: string; length: number } {
    const stripped = this.pending === '\r' ? 1 : 0
    if (this.pending !== undefined && this.pending !== '\r') this.hash.update(this.pending)
    return { hash: this.hash.digest('hex').slice(0, 8), length: this.total - stripped }
  }
}

function finish(acc: WindowAccumulator, request: ReadWindow, displayPath: string): WindowResult {
  if (!acc.truncatedByBytes && request.offset > acc.totalLines && !(acc.totalLines === 0 && request.offset === 1)) {
    throw new FsError(`offset ${request.offset} is out of range for "${displayPath}" (${acc.totalLines} lines)`, 'FS_NOT_FOUND')
  }
  return { lines: acc.lines, totalLines: acc.totalLines, truncatedByBytes: acc.truncatedByBytes }
}

/**
 * Build one window from streamed or whole-file chunks, enforcing line and byte caps while still
 * scanning to an exact total line count, and throwing `FS_NOT_FOUND` when the requested offset is
 * past EOF.
 * @param chunks - decoded text chunks in file order; chunk boundaries carry no meaning.
 * @param request - the resolved window; the caller has already applied its defaults and caps.
 * @param displayPath - the caller-facing path used in the offset-out-of-range error.
 * @returns the numbered window lines, the total line count seen, and the byte-cap truncation flag.
 */
export async function buildWindow(
  chunks: AsyncIterable<string> | Iterable<string>,
  request: ReadWindow,
  displayPath: string,
): Promise<WindowResult> {
  const acc = newAccumulator()
  const lineIds = request.lineIds === true
  // Plain mode: one char past the truncation point proves a line overflows.
  // line_ids mode: store up to the per-line cap for lossless wrapping; the
  // hasher sees the whole line regardless, so ids always address full content.
  const lineStorageCap = lineIds ? (request.lineIdsLineCap ?? LINE_IDS_LINE_CAP) : request.maxLineLength + 1
  let lineBuffer = ''
  let hasher: LineHasher | undefined

  function appendToLineBuffer(segment: string): void {
    if (lineIds) {
      hasher ??= new LineHasher()
      hasher.update(segment)
    }
    if (lineBuffer.length >= lineStorageCap) return
    lineBuffer += segment
    if (lineBuffer.length > lineStorageCap) lineBuffer = lineBuffer.slice(0, lineStorageCap)
  }

  function flushLine(): void {
    if (lineIds) {
      const state = (hasher ?? new LineHasher()).finalize()
      const stored = stripCarriageReturn(lineBuffer)
      consumeLineIds(acc, stored, { hash: state.hash, length: state.length, capped: state.length > stored.length }, request)
      hasher = undefined
    } else {
      consumeLine(acc, stripCarriageReturn(lineBuffer), request)
    }
    lineBuffer = ''
  }

  for await (const chunk of chunks) {
    let startPos = 0
    let newlinePos: number
    while ((newlinePos = chunk.indexOf('\n', startPos)) !== -1) {
      appendToLineBuffer(chunk.slice(startPos, newlinePos))
      flushLine()
      startPos = newlinePos + 1
    }
    appendToLineBuffer(chunk.slice(startPos))
  }
  if (lineBuffer.length > 0) flushLine()
  return finish(acc, request, displayPath)
}

/**
 * Render one window line: plain mode keeps the `N: text` shape; `line_ids`
 * mode prints `N#hash| text`, `N#hash> segment` for join-by-concatenation
 * continuations, and a trailing `N#hash! (…)` declaration when the line's tail
 * exceeded the storage cap.
 */
function formatOutputLine(line: FileTextLine): string {
  if (line.id === undefined) return `${line.number}: ${line.text}`
  const marker = line.continued ? '>' : '|'
  const tail = line.lineTruncated !== undefined
    ? `\n${line.id}! (${String(line.lineTruncated)} more char${line.lineTruncated === 1 ? '' : 's'} on this line not shown)`
    : ''
  return `${line.id}${marker} ${line.text}${tail}`
}

/**
 * Format a read outcome as one OpenCode-style line-numbered text block body.
 * @param displayPath - the backend-resolved path rendered in the envelope's `<path>` element.
 * @param outcome - the windowed read to render.
 * @returns the model-facing envelope: numbered lines plus a continuation or end-of-file footer.
 */
export function formatReadOutput(displayPath: string, outcome: FileReadOutcome): string {
  const endLine = outcome.lines.at(-1)?.number ?? Math.max(0, outcome.offset - 1)
  let footer: string
  if (outcome.truncatedByBytes) {
    footer = `(Output capped. Showing lines ${outcome.offset}-${endLine}. Use offset=${endLine + 1} to continue.)`
  } else if (endLine < outcome.totalLines) {
    footer = `(Showing lines ${outcome.offset}-${endLine} of ${outcome.totalLines}. Use offset=${endLine + 1} to continue.)`
  } else {
    footer = `(End of file - total ${outcome.totalLines} lines)`
  }
  const body = outcome.lines.length > 0
    ? `${outcome.lines.map(formatOutputLine).join('\n')}\n\n${footer}`
    : footer
  return `<path>${displayPath}</path>
<type>file</type>
<content>
${body}
</content>`
}

/**
 * Derive the persisted `lang` hint from a read path's file extension. The shared
 * table in `@deepseek-ai/dsh-util-code-language` owns the recognized suffixes and
 * the path rules (both separators, a leading dot as the extension separator, and
 * prototype-key safety); `readLangHintForPath` projects the read card's short ids
 * over it, so a suffix whose value a recorded session already holds keeps it
 * byte-identical while every other suffix uses its language's short name.
 * @param path - the model-facing path the read reported.
 * @returns the persisted language hint, or `undefined` when the extension maps to none.
 */
export { readLangHintForPath as langFromPath } from '@deepseek-ai/dsh-util-code-language'

/**
 * The `read` tool's private `tool/result` `meta` payload: the structured
 * line-numbered window a capable UI renders as a code view. Attached opaquely (as
 * `unknown`) on the tool result and persisted with the session log — it must be
 * JSON-serializable (the session validates this at `append`), so `presentResult`
 * reproduces the read card on replay when the raw structured output is no longer
 * on the wire. The producing tool owns and narrows this opaque shape.
 */
export interface FsReadMeta {
  /** The read file's model-facing path. */
  path: string
  /** The 1-based first line the window requested, kept even when `lines` is empty. */
  offset: number
  /** The returned window's lines, each keeping its file line number. */
  lines: FileTextLine[]
  /** Exact total line count in the file. */
  totalLines: number
  /** Syntax-highlighting language hint from the extension, or omitted for plain text. */
  lang?: string
}

/**
 * Whether `value` is a valid {@link FileTextLine} (defensive narrowing from
 * opaque `meta`). `number` must be a 1-based integer line number, since a card
 * rendered from a zero, fractional, or non-finite line number would violate the
 * 1-based numbering contract the read window promises.
 */
function isFileTextLine(value: unknown): value is FileTextLine {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { number, text } = value as Record<string, unknown>
  return typeof number === 'number' && Number.isInteger(number) && number >= 1 && typeof text === 'string'
}

/**
 * Narrow opaque live or replayed result metadata to a structured read window.
 * Malformed metadata returns `undefined` so presentation can fall back to the
 * generic text card instead of throwing during replay. Beyond shape, the
 * semantic contract of a read window is enforced against replayed JSON that is
 * well-typed but out of range: `offset` must be a 1-based integer, `totalLines`
 * must be a non-negative integer, each line number must be a 1-based integer no
 * less than `offset`, the line numbers must strictly increase, and no line number
 * may exceed `totalLines`. Any violation declines to the generic fallback rather
 * than emitting a card that misnumbers or overcounts.
 * @param meta - result metadata.
 * @returns the validated read window, or `undefined` for absent, malformed, or semantically invalid data.
 */
export function readMetaFromMeta(meta: unknown): FsReadMeta | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const { path, offset, lines, totalLines, lang } = meta as Record<string, unknown>
  if (typeof path !== 'string' || typeof totalLines !== 'number' || typeof offset !== 'number') return undefined
  if (!Number.isInteger(offset) || offset < 1) return undefined
  if (!Number.isInteger(totalLines) || totalLines < 0) return undefined
  if (!Array.isArray(lines) || !lines.every(isFileTextLine)) return undefined
  if (lang !== undefined && typeof lang !== 'string') return undefined
  let previous = offset - 1
  for (const { number } of lines) {
    if (number <= previous || number > totalLines) return undefined
    previous = number
  }
  return { path, offset, lines, totalLines, ...lang === undefined ? {} : { lang } }
}
