/**
 * Id-addressed editing (upstream-tool-fs-line-ids patch) — pure mechanics tests:
 * hash/id round-trip, `applyIdEdits` op semantics and guard refusals, the renumber
 * report, EOL helpers, and `line_ids` window building (including hash consistency
 * with the edit side, exact-join wrapping, and declared truncation).
 */

import { describe, expect, it } from 'vitest'
import {
  applyIdEdits,
  detectLineEndings,
  formatIdEditReport,
  formatLineId,
  hashLine,
  normalizeLineEndings,
  parseIdEditOp,
  parseLineId,
  restoreLineEndings,
} from '../src/id-edit.ts'
import { buildWindow, formatReadOutput } from '../src/read-render.ts'

const windowDefaults = { offset: 1, limit: 2000, maxLineLength: 2000, maxBytes: 50 * 1024 }

async function windowOf(content: string, request: Partial<typeof windowDefaults & { lineIds: boolean; lineIdsLineCap: number }> = {}) {
  return buildWindow([content], { ...windowDefaults, ...request }, 'test.txt')
}

/** Mint ids for content exactly as a `line_ids` read would (read↔edit consistency anchor). */
async function idsOf(content: string): Promise<string[]> {
  const result = await windowOf(content, { lineIds: true })
  return result.lines.map(line => line.id!)
}

describe('line id primitives', () => {
  it('hashes deterministically and formats/parses round-trip', () => {
    const hash = hashLine('hello world')
    expect(hash).toMatch(/^[0-9a-f]{8}$/)
    expect(hashLine('hello world')).toBe(hash)
    expect(hashLine('hello worlD')).not.toBe(hash)
    const id = formatLineId(42, hash)
    expect(id).toBe(`42#${hash}`)
    expect(parseLineId(id)).toEqual({ lineNumber: 42, hash })
  })

  it('rejects malformed ids with the expected shape named', () => {
    expect(() => parseLineId('42')).toThrow(/malformed line id/)
    expect(() => parseLineId('42#xyz')).toThrow(/N#hash/)
    expect(() => parseLineId('0#abcdef12')).not.toThrow() // line 0 is validated against the file, not the shape
  })
})

describe('parseIdEditOp validation', () => {
  it('accepts every op kind and camelCases end_id', () => {
    expect(parseIdEditOp({ op: 'replace', id: '1#abcdef12', text: 'x' }, 0)).toEqual({ op: 'replace', id: '1#abcdef12', text: 'x' })
    expect(parseIdEditOp({ op: 'delete', id: '1#abcdef12', end_id: '3#abcdef12' }, 0)).toEqual({ op: 'delete', id: '1#abcdef12', endId: '3#abcdef12' })
    expect(parseIdEditOp({ op: 'insert_before', id: '1#abcdef12', text: 'x' }, 0)).toEqual({ op: 'insert_before', id: '1#abcdef12', text: 'x' })
  })

  it('rejects bad shapes with the offending field named', () => {
    expect(() => parseIdEditOp({ op: 'rewrite', id: '1#abcdef12' }, 2)).toThrow(/ops\[2\]\.op must be one of/)
    expect(() => parseIdEditOp({ op: 'replace', id: '1#abcdef12' }, 0)).toThrow(/\.text is required for replace/)
    expect(() => parseIdEditOp({ op: 'insert_after', id: '1#abcdef12', text: 'x', end_id: '2#abcdef12' }, 0)).toThrow(/end_id only applies to replace\/delete/)
    expect(() => parseIdEditOp({ op: 'replace', id: 'nope', text: 'x' }, 1)).toThrow(/malformed line id/)
  })
})

describe('applyIdEdits', () => {
  const content = 'alpha\nbravo\ncharlie\ndelta\n'
  let ids: string[]

  const setup = async () => {
    ids = await idsOf(content)
    expect(ids).toHaveLength(4)
    expect(ids[0]).toBe(`1#${hashLine('alpha')}`)
  }

  it('replaces a single line and reports no renumber shift', async () => {
    await setup()
    const result = applyIdEdits(content, [{ op: 'replace', id: ids[1]!, text: 'BRAVO' }])
    expect(result.content).toBe('alpha\nBRAVO\ncharlie\ndelta\n')
    expect(result.report.applied).toBe(1)
    expect(result.report.inserted).toEqual([])
    expect(result.report.replaced).toEqual([{ newStart: 2, count: 1, firstId: `2#${hashLine('BRAVO')}` }])
    expect(result.report.renumber).toEqual([
      { oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 },
      { oldStart: 2, oldEnd: 2 },
      { oldStart: 3, oldEnd: 4, newStart: 3, newEnd: 4 },
    ])
  })

  it('replaces a span end-to-end inclusive', async () => {
    await setup()
    const result = applyIdEdits(content, [{ op: 'replace', id: ids[1]!, endId: ids[2]!, text: 'X\nY\nZ' }])
    expect(result.content).toBe('alpha\nX\nY\nZ\ndelta\n')
    expect(result.report.inserted).toEqual([])
    expect(result.report.replaced).toEqual([{ newStart: 2, count: 3, firstId: `2#${hashLine('X')}` }])
    expect(result.report.renumber).toContainEqual({ oldStart: 4, oldEnd: 4, newStart: 5, newEnd: 5 })
  })

  it('inserts before and after, preserving the trailing newline', async () => {
    await setup()
    const before = applyIdEdits(content, [{ op: 'insert_before', id: ids[0]!, text: 'zero' }])
    expect(before.content).toBe('zero\nalpha\nbravo\ncharlie\ndelta\n')
    const after = applyIdEdits(content, [{ op: 'insert_after', id: ids[3]!, text: 'echo' }])
    expect(after.content).toBe('alpha\nbravo\ncharlie\ndelta\necho\n')
    expect(after.report.inserted).toEqual([{ newStart: 5, count: 1, firstId: `5#${hashLine('echo')}` }])
  })

  it('deletes a span and renumbers the tail', async () => {
    await setup()
    const result = applyIdEdits(content, [{ op: 'delete', id: ids[1]!, endId: ids[2]! }])
    expect(result.content).toBe('alpha\ndelta\n')
    expect(result.report.renumber).toEqual([
      { oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 },
      { oldStart: 2, oldEnd: 3 },
      { oldStart: 4, oldEnd: 4, newStart: 2, newEnd: 2 },
    ])
    expect(formatIdEditReport(result.report)).toContain('deleted: lines 2–3')
  })

  it('applies several ops against the original snapshot', async () => {
    await setup()
    const result = applyIdEdits(content, [
      { op: 'replace', id: ids[0]!, text: 'ALPHA' },
      { op: 'delete', id: ids[2]! },
      { op: 'insert_after', id: ids[3]!, text: 'echo' },
    ])
    expect(result.content).toBe('ALPHA\nbravo\ndelta\necho\n')
    expect(result.report.applied).toBe(3)
  })

  it('self-locates a moved line by hash when the hint is stale', async () => {
    await setup()
    // The file gained a line at the top since the read: id `2#hash(bravo)` now sits at line 3.
    const shifted = 'zero\nalpha\nbravo\ncharlie\ndelta\n'
    const result = applyIdEdits(shifted, [{ op: 'replace', id: ids[1]!, text: 'BRAVO' }])
    expect(result.content).toBe('zero\nalpha\nBRAVO\ncharlie\ndelta\n')
  })

  it('keeps the hint authoritative for duplicate lines', async () => {
    const dup = 'x\n\ny\n\nz\n'
    const dupIds = await idsOf(dup)
    expect(dupIds[1]).toBe(`2#${hashLine('')}`)
    expect(dupIds[3]).toBe(`4#${hashLine('')}`)
    // Same hash on lines 2 and 4; the hint disambiguates to line 4.
    const result = applyIdEdits(dup, [{ op: 'replace', id: dupIds[3]!, text: 'filled' }])
    expect(result.content).toBe('x\n\ny\nfilled\nz\n')
  })

  it('refuses an ambiguous hash when the hinted line changed', async () => {
    const dup = 'x\n\ny\n\nz\n\nw\n'
    const dupIds = await idsOf(dup)
    expect(dupIds[5]).toBe(`6#${hashLine('')}`)
    // Line 6 changed content, so the hint misses and lines 2/4 remain as candidates.
    const changed = 'x\n\ny\n\nz\nfilled\nw\n'
    expect(() => applyIdEdits(changed, [{ op: 'replace', id: dupIds[5]!, text: 'v' }]))
      .toThrow(/now matches 2 lines \(2, 4\)/)
  })

  it('refuses a changed line naming its current hash', async () => {
    await setup()
    const changed = 'alpha\nBRAVO\ncharlie\ndelta\n'
    expect(() => applyIdEdits(changed, [{ op: 'replace', id: ids[1]!, text: 'x' }]))
      .toThrow(new RegExp(`no line carries hash ${ids[1]!.split('#')[1]}.*Line 2 is now "BRAVO" \\(hash ${hashLine('BRAVO')}\\)`))
  })

  it('refuses an out-of-range hint with the line count', async () => {
    expect(() => applyIdEdits('a\nb\n', [{ op: 'delete', id: `9#${hashLine('zzz')}` }]))
      .toThrow(/file now has 2 lines/)
  })

  it('refuses overlapping ops and reversed spans', async () => {
    await setup()
    expect(() => applyIdEdits(content, [
      { op: 'replace', id: ids[0]!, endId: ids[2]!, text: 'x' },
      { op: 'delete', id: ids[1]! },
    ])).toThrow(/overlapping ops/)
    expect(() => applyIdEdits(content, [{ op: 'replace', id: ids[2]!, endId: ids[0]!, text: 'x' }]))
      .toThrow(/span end .* sorts before span start/)
  })

  it('handles a file without a trailing newline', async () => {
    const bare = 'alpha\nbravo'
    const bareIds = await idsOf(bare)
    expect(bareIds).toHaveLength(2)
    const result = applyIdEdits(bare, [{ op: 'insert_after', id: bareIds[1]!, text: 'charlie' }])
    expect(result.content).toBe('alpha\nbravo\ncharlie')
  })

  it('treats a single empty line as line 1', async () => {
    const ids = await idsOf('\n')
    expect(ids).toEqual([`1#${hashLine('')}`])
    const result = applyIdEdits('\n', [{ op: 'replace', id: ids[0]!, text: 'filled' }])
    expect(result.content).toBe('filled\n')
  })
})

describe('EOL helpers', () => {
  it('detects, normalizes, and restores CRLF without doubling', () => {
    const crlf = 'a\r\nb\r\nc\r\n'
    expect(detectLineEndings(crlf)).toBe('CRLF')
    const lf = normalizeLineEndings(crlf)
    expect(lf).toBe('a\nb\nc\n')
    expect(restoreLineEndings(lf, 'CRLF')).toBe(crlf)
    expect(restoreLineEndings(lf, 'LF')).toBe(lf)
  })

  it('keeps CRLF hashes consistent with the LF edit basis', async () => {
    // The read mints ids over CR-stripped lines; the edit hashes LF-normalized
    // content — both must produce the same id for the same logical line.
    const ids = await idsOf('alpha\r\nbravo\r\n')
    expect(ids[1]).toBe(`2#${hashLine('bravo')}`)
  })
})

describe('line_ids window building', () => {
  it('mints ids in the rendered output', async () => {
    const result = await windowOf('alpha\nbravo\n', { lineIds: true })
    expect(result.lines.map(line => line.id)).toEqual([`1#${hashLine('alpha')}`, `2#${hashLine('bravo')}`])
    const text = formatReadOutput('test.txt', { offset: 1, lines: result.lines, totalLines: result.totalLines })
    expect(text).toContain(`1#${hashLine('alpha')}| alpha`)
    expect(text).toContain(`2#${hashLine('bravo')}| bravo`)
    expect(text).toContain('(End of file - total 2 lines)')
  })

  it('wraps an over-long line into exact-join segments', async () => {
    const long = 'x'.repeat(5000)
    const result = await windowOf(`alpha\n${long}\nomega\n`, { lineIds: true })
    const segments = result.lines.filter(line => line.number === 2)
    expect(segments).toHaveLength(3)
    expect(segments.map(segment => segment.text).join('')).toBe(long)
    expect(segments[0]!.continued).toBe(true)
    expect(segments[1]!.continued).toBe(true)
    expect(segments[2]!.continued).toBeUndefined()
    // One id for the whole line — the hash covers all 5000 chars.
    expect(segments[0]!.id).toBe(`2#${hashLine(long)}`)
    const text = formatReadOutput('test.txt', { offset: 1, lines: result.lines, totalLines: result.totalLines })
    expect(text).toContain(`2#${hashLine(long)}> ${'x'.repeat(2000)}`)
  })

  it('declares the hidden tail of a line beyond the storage cap', async () => {
    const long = 'y'.repeat(300)
    const result = await windowOf(`${long}\n`, { lineIds: true, lineIdsLineCap: 100, maxLineLength: 60 })
    const segments = result.lines.filter(line => line.number === 1)
    // 100 stored chars render as two 60/40 segments; the last declares 200 hidden.
    expect(segments).toHaveLength(2)
    expect(segments[1]!.lineTruncated).toBe(200)
    // The id still addresses the WHOLE line (edit-side consistency survives the cap).
    expect(segments[0]!.id).toBe(`1#${hashLine(long)}`)
    const text = formatReadOutput('test.txt', { offset: 1, lines: result.lines, totalLines: result.totalLines })
    expect(text).toContain(`1#${hashLine(long)}! (200 more chars on this line not shown)`)
  })

  it('honours offset and keeps numbering in line_ids mode', async () => {
    const result = await windowOf('a\nb\nc\nd\n', { lineIds: true, offset: 3 })
    expect(result.lines.map(line => line.id)).toEqual([`3#${hashLine('c')}`, `4#${hashLine('d')}`])
  })

  it('keeps plain mode byte-identical (no ids, old truncation marker)', async () => {
    const long = 'z'.repeat(3000)
    const result = await windowOf(`a\n${long}\n`, {})
    expect(result.lines[1]!.id).toBeUndefined()
    expect(result.lines[1]!.text).toContain('... (line truncated to 2000 chars)')
  })
})
