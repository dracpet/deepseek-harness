/**
 * Id-addressed line editing (`ops` mode of the `edit` tool) — pure primitives.
 *
 * A line id `N#hash` is minted by a `read` with `line_ids=true`: `N` is the
 * 1-based line number at read time (a hint), and `hash` is the content address
 * (sha1, first 8 hex chars, of the line text without its newline). Ops resolve
 * anchors by hash, so a moved line self-locates and a changed line refuses with
 * an actionable message instead of a naked zero-hit. All ops resolve against
 * the ORIGINAL snapshot and apply atomically; overlapping ops refuse.
 *
 * Additive patch (upstream-tool-fs-line-ids): the literal old_string mode is
 * untouched. This module is the tool-layer home of the pure mechanics — the
 * provider layer keeps its smaller edit surface (read-transform-write over the
 * existing writeText CAS), so no FileSystem interface change was needed.
 * @module @deepseek-ai/dsh-tool-fs/id-edit
 */

import { createHash } from 'node:crypto'

/** Hex chars kept from the sha1 of a line. 8 chars = 32 bits; a collision needs ~65k same-file lines. */
export const LINE_ID_HASH_LENGTH = 8

/** Per-line storage cap in `line_ids` reads: beyond it the hash still covers the whole line but the tail is not rendered. */
export const LINE_IDS_LINE_CAP = 128 * 1024

/** Content address of one line: sha1 over the line text (no trailing newline), first 8 hex chars. */
export function hashLine(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, LINE_ID_HASH_LENGTH)
}

/** Render a line id as `N#hash` — the exact shape ops and the `line_ids` read share. */
export function formatLineId(lineNumber: number, hash: string): string {
  return `${String(lineNumber)}#${hash}`
}

const LINE_ID_RE = /^(\d+)#([0-9a-f]{8})$/

/** Parse `N#hash`; malformed ids throw an Error naming the expected shape. */
export function parseLineId(id: string): { lineNumber: number; hash: string } {
  const match = LINE_ID_RE.exec(id)
  if (match === null) {
    throw new Error(`malformed line id "${id}" — expected \`N#hash\` (8 hex chars) as printed by a read with line_ids=true`)
  }
  return { lineNumber: Number(match[1]), hash: match[2]! }
}

/** One id-addressed edit operation (tool-facing JSON shape, camelCased after validation). */
export type IdEditOp =
  | { op: 'replace'; id: string; endId?: string; text: string }
  | { op: 'insert_before'; id: string; text: string }
  | { op: 'insert_after'; id: string; text: string }
  | { op: 'delete'; id: string; endId?: string }

/** Validate one raw ops item; throws an Error naming the offending field. */
export function parseIdEditOp(raw: unknown, index: number): IdEditOp {
  const where = `ops[${String(index)}]`
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${where}: each op must be an object`)
  }
  const record = raw as Record<string, unknown>
  const kind = record.op
  if (kind !== 'replace' && kind !== 'insert_before' && kind !== 'insert_after' && kind !== 'delete') {
    throw new Error(`${where}.op must be one of replace | insert_before | insert_after | delete`)
  }
  if (typeof record.id !== 'string') throw new Error(`${where}.id must be a string \`N#hash\``)
  parseLineId(record.id)
  if (record.end_id !== undefined) {
    if (kind !== 'replace' && kind !== 'delete') throw new Error(`${where}.end_id only applies to replace/delete`)
    if (typeof record.end_id !== 'string') throw new Error(`${where}.end_id must be a string \`N#hash\``)
    parseLineId(record.end_id)
  }
  if (kind === 'replace' || kind === 'insert_before' || kind === 'insert_after') {
    if (typeof record.text !== 'string') throw new Error(`${where}.text is required for ${kind}`)
    return kind === 'replace'
      ? { op: 'replace', id: record.id, ...record.end_id !== undefined ? { endId: record.end_id as string } : {}, text: record.text }
      : { op: kind, id: record.id, text: record.text }
  }
  return { op: 'delete', id: record.id, ...record.end_id !== undefined ? { endId: record.end_id as string } : {} }
}

/** Kept-range renumber segment; `newStart`/`newEnd` absent means the old range was deleted. */
export interface RenumberSegment {
  oldStart: number
  oldEnd: number
  newStart?: number
  newEnd?: number
}

/** One inserted block: `count` lines now living at `newStart..`; `firstId` seeds chained edits. */
export interface InsertedBlock {
  newStart: number
  count: number
  firstId?: string
}

/** Structured report carried on the tool result (`idEdit` field) and rendered into the reply. */
export interface IdEditReport {
  applied: number
  renumber: RenumberSegment[]
  inserted: InsertedBlock[]
  replaced: InsertedBlock[]
}

/** Outcome of {@link applyIdEdits}: the new full content plus the renumber report. */
export interface IdEditOutcome {
  content: string
  report: IdEditReport
}

interface ResolvedSegment {
  start: number
  end: number
  replacement: string[]
  label: string
}

function splitLines(text: string): string[] {
  return text.split('\n')
}

function quoteLine(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * Locate an anchor against the snapshot lines: the hinted number wins when its
 * hash still matches (cheap path and the disambiguator for duplicate lines);
 * otherwise exactly one surviving hash match self-locates a moved line. Zero
 * matches refuse with the hinted line's current hash and first divergence;
 * multiple matches refuse listing the candidate line numbers.
 */
function resolveAnchor(lines: string[], hashes: string[], id: string): number {
  const { lineNumber, hash } = parseLineId(id)
  const hinted = lineNumber - 1
  if (hinted >= 0 && hinted < lines.length && hashes[hinted] === hash) return hinted
  const matches: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (hashes[i] === hash) matches.push(i)
  }
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) {
    const at = matches.slice(0, 8).map(i => String(i + 1)).join(', ')
    throw new Error(
      `id ${id}: hash ${hash} now matches ${String(matches.length)} lines (${at}${matches.length > 8 ? ', …' : ''})`
      + ` — the hinted line ${String(lineNumber)} changed. Re-read with line_ids=true and address a distinctive line.`,
    )
  }
  if (hinted >= 0 && hinted < lines.length) {
    throw new Error(
      `id ${id}: no line carries hash ${hash} — the content changed since the read.`
      + ` Line ${String(lineNumber)} is now "${quoteLine(lines[hinted]!)}" (hash ${hashes[hinted]}).`
      + ` Re-read with line_ids=true for fresh ids.`,
    )
  }
  throw new Error(
    `id ${id}: no line carries hash ${hash} and the file now has ${String(lines.length)} lines`
    + ` (line ${String(lineNumber)} is out of range). Re-read with line_ids=true for fresh ids.`,
  )
}

/**
 * Split LF-normalized content into lines, matching the read side exactly: a
 * trailing newline TERMINATES the last line (no phantom empty line), so `'a\n'`
 * is one line and `'\n'` is one (empty) line.
 */
function contentToLines(content: string): string[] {
  if (content === '') return []
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** Join lines back, restoring the trailing-newline shape the content had. */
function linesToContent(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) return ''
  return lines.join('\n') + (trailingNewline ? '\n' : '')
}

/**
 * Resolve and apply id-addressed ops against LF-normalized content, atomically.
 * Ops are anchored on the original snapshot, sorted, checked for overlap, then
 * applied from the bottom up; the report maps every kept old range to its new
 * numbers and lists inserted blocks with their first fresh id.
 * @param content - LF-normalized file content.
 * @param ops - validated ops in caller order.
 * @returns the new LF-normalized content plus the renumber report.
 */
export function applyIdEdits(content: string, ops: IdEditOp[]): IdEditOutcome {
  const trailingNewline = content.endsWith('\n')
  const lines = contentToLines(content)
  const hashes = lines.map(hashLine)
  const segments: ResolvedSegment[] = ops.map((edit, index) => {
    const label = `ops[${String(index)}]`
    const anchor = resolveAnchor(lines, hashes, edit.id)
    if (edit.op === 'insert_before') {
      return { start: anchor, end: anchor, replacement: splitLines(edit.text), label }
    }
    if (edit.op === 'insert_after') {
      return { start: anchor + 1, end: anchor + 1, replacement: splitLines(edit.text), label }
    }
    let end = anchor + 1
    if (edit.endId !== undefined) {
      const endAnchor = resolveAnchor(lines, hashes, edit.endId)
      if (endAnchor < anchor) throw new Error(`${label}: span end ${edit.endId} sorts before span start ${edit.id}`)
      end = endAnchor + 1
    }
    return edit.op === 'replace'
      ? { start: anchor, end, replacement: splitLines(edit.text), label }
      : { start: anchor, end, replacement: [], label }
  })

  const ordered = [...segments].sort((a, b) => a.start - b.start)
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i]!.start < ordered[i - 1]!.end) {
      throw new Error(
        `overlapping ops: ${ordered[i - 1]!.label} covers lines ${String(ordered[i - 1]!.start + 1)}–${String(ordered[i - 1]!.end)}`
        + ` but ${ordered[i]!.label} starts at line ${String(ordered[i]!.start + 1)} — merge them into one op or shrink the span.`,
      )
    }
  }

  const next = [...lines]
  for (let i = ordered.length - 1; i >= 0; i--) {
    const segment = ordered[i]!
    next.splice(segment.start, segment.end - segment.start, ...segment.replacement)
  }

  // Renumber: walk the original lines; a segment covering [start,end) deletes
  // those old numbers (unless start===end, a pure insertion), and every line
  // after a segment shifts by (replacement.length - (end - start)).
  const renumber: RenumberSegment[] = []
  const inserted: InsertedBlock[] = []
  const replaced: InsertedBlock[] = []
  let shift = 0
  let cursor = 0
  let keptStart: number | undefined
  const flushKept = (upTo: number): void => {
    if (keptStart !== undefined && upTo > keptStart) {
      renumber.push({ oldStart: keptStart + 1, oldEnd: upTo, newStart: keptStart + 1 + shift, newEnd: upTo + shift })
    }
    keptStart = undefined
  }
  for (const segment of ordered) {
    if (cursor < segment.start) {
      if (keptStart === undefined) keptStart = cursor
      flushKept(segment.start)
      cursor = segment.start
    }
    if (segment.replacement.length > 0) {
      const block = {
        newStart: segment.start + 1 + shift,
        count: segment.replacement.length,
        firstId: formatLineId(segment.start + 1 + shift, hashLine(segment.replacement[0]!)),
      }
      // A pure insertion opens new address space; a replace re-uses its span's
      // numbers — the two are reported apart so chained edits address correctly.
      if (segment.start === segment.end) inserted.push(block)
      else replaced.push(block)
    }
    shift += segment.replacement.length - (segment.end - segment.start)
    if (segment.end > segment.start) {
      renumber.push({ oldStart: segment.start + 1, oldEnd: segment.end })
    }
    cursor = segment.end
  }
  if (cursor < lines.length) {
    keptStart = keptStart ?? cursor
    flushKept(lines.length)
  }

  return {
    content: linesToContent(next, trailingNewline),
    report: { applied: ops.length, renumber, inserted, replaced },
  }
}

/** Render the renumber report as one compact model-facing paragraph. */
export function formatIdEditReport(report: IdEditReport): string {
  const parts: string[] = [`${String(report.applied)} op${report.applied === 1 ? '' : 's'} applied`]
  const deleted = report.renumber.filter(seg => seg.newStart === undefined)
  const moved = report.renumber.filter(seg => seg.newStart !== undefined && seg.newStart !== seg.oldStart)
  if (moved.length > 0) {
    parts.push(`renumber: ${moved.map(seg => `lines ${String(seg.oldStart)}–${String(seg.oldEnd)} → ${String(seg.newStart)}–${String(seg.newEnd)}`).join(', ')}`)
  }
  if (deleted.length > 0) {
    parts.push(`deleted: ${deleted.map(seg => `lines ${String(seg.oldStart)}–${String(seg.oldEnd)}`).join(', ')}`)
  }
  if (report.inserted.length > 0) {
    parts.push(`inserted: ${report.inserted.map(block => `${String(block.count)} line${block.count === 1 ? '' : 's'} at ${String(block.newStart)} (first id ${block.firstId ?? '?'})`).join(', ')}`)
  }
  if (report.replaced.length > 0) {
    parts.push(`replaced: ${report.replaced.map(block => `${String(block.count)} line${block.count === 1 ? '' : 's'} at ${String(block.newStart)} (first id ${block.firstId ?? '?'})`).join(', ')}`)
  }
  return parts.join('; ')
}

export type LineEndings = 'LF' | 'CRLF'

/**
 * Detect the line-ending style of raw content — a local copy of the fs-local
 * helper (the tool layer must not import the provider layer; keep in sync with
 * `detectLineEndings` in `@deepseek-ai/dsh-fs-local`).
 */
export function detectLineEndings(raw: string): LineEndings {
  const sample = raw.slice(0, 4096)
  const crlfCount = sample.split('\r\n').length - 1
  const lfCount = sample.split('\n').length - 1 - crlfCount
  return crlfCount > lfCount ? 'CRLF' : 'LF'
}

/** Collapse CRLF to LF — the canonical basis every id/hash computation uses. */
export function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n')
}

/** Restore LF-normalized content to the style detected at read time (never doubles an existing CRLF). */
export function restoreLineEndings(content: string, lineEndings: LineEndings): string {
  return lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n')
}
