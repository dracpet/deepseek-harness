/**
 * Model-facing literal edit, unique-match by default. It obtains an optional guard from the
 * single intent slot, calls `ctx.fs.editText` without a separate stat, then records the observed
 * version; no policy means an unconditional atomic edit.
 * @module @deepseek-ai/dsh-tool-fs/src/edit
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DiffResultView, ToolCallView, ToolResult } from '@deepseek-ai/dsh-tools'
import type { FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { computeHunkDiffs, diffsFromMeta } from './diff.ts'
import { explainMutationFailure } from './recovery.ts'
import { mutationResult } from './mutation-result.ts'
import { sessionResolveOptions } from './session-cwd.ts'
import type { FsSandboxController } from './sandbox.ts'
import { applyIdEdits, detectLineEndings, formatIdEditReport, normalizeLineEndings, parseIdEditOp, restoreLineEndings } from './id-edit.ts'
import type { IdEditOp, IdEditReport } from './id-edit.ts'

/** Validated `edit` arguments after defaulting — the literal mode (unchanged upstream shape). */
interface LiteralEditInput {
  mode: 'literal'
  filePath: string
  oldString: string
  newString: string
  replaceAll: boolean
}

/** Validated `edit` arguments for the id-addressed ops mode. */
interface OpsEditInput {
  mode: 'ops'
  filePath: string
  ops: IdEditOp[]
}

type EditInput = LiteralEditInput | OpsEditInput

/**
 * The `edit` tool's validated arguments: literal fields (`old_string`/`new_string`)
 * or an `ops` array, plus the two escalation fields, advertised only under a
 * confining `ctx.fs` (absent from the schema otherwise, so the validator rejects
 * them before `execute`).
 */
interface EditToolArgs {
  file_path: string
  old_string?: string
  new_string?: string
  ops?: unknown[]
  replace_all?: boolean
  sandbox_permissions?: string
  justification?: string
}

/**
 * Validate value constraints the schema DSL can't express: a non-blank
 * `file_path`, then exactly one mode — `ops` (a non-empty array of id-addressed
 * ops, each validated) or the literal pair (non-empty `old_string` different
 * from `new_string`). Mixing modes is rejected with a mode-naming message.
 * @param args - the schema-validated raw tool arguments.
 * @returns the mode-tagged input with `replace_all` defaulted to false in literal mode.
 */
export function parseEditArgs(args: { file_path: string; old_string?: string; new_string?: string; ops?: unknown[]; replace_all?: boolean }): EditInput {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  if (args.ops !== undefined) {
    if (args.old_string !== undefined || args.new_string !== undefined) {
      throw new Error('ops mode does not take old_string/new_string — pick one mode (ops from a line_ids read, or the literal pair)')
    }
    if (!Array.isArray(args.ops) || args.ops.length === 0) throw new Error('ops must be a non-empty array')
    return { mode: 'ops', filePath: args.file_path, ops: args.ops.map((op, index) => parseIdEditOp(op, index)) }
  }
  if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') {
    throw new Error('provide old_string + new_string, or an ops array from a read with line_ids=true')
  }
  if (args.old_string.length === 0) throw new Error('old_string must be a non-empty string')
  if (args.old_string === args.new_string) throw new Error('old_string and new_string must differ')
  return {
    mode: 'literal',
    filePath: args.file_path,
    oldString: args.old_string,
    newString: args.new_string,
    replaceAll: args.replace_all ?? false,
  }
}

/**
 * Format an edit success (single-match or replace-all) as a Claude-style model-facing message.
 * @param displayPath - the backend-resolved path shown to the model.
 * @param replaceAll - selects the all-occurrences wording over the single-replacement one.
 * @returns the confirmation sentence the model sees as the tool result.
 */
export function formatEditOutput(displayPath: string, replaceAll: boolean): string {
  return replaceAll
    ? `The file ${displayPath} has been updated. All occurrences were successfully replaced.`
    : `The file ${displayPath} has been updated successfully.`
}

/**
 * Format an id-addressed ops success: the confirmation plus the renumber report,
 * so a chained edit re-addresses by the new numbers without a re-read.
 * @param displayPath - the backend-resolved path shown to the model.
 * @param report - the applied-ops/renumber/inserted summary from `applyIdEdits`.
 * @returns the confirmation sentence plus the compact renumber paragraph.
 */
export function formatOpsEditOutput(displayPath: string, report: IdEditReport): string {
  return `The file ${displayPath} has been updated successfully. ${formatIdEditReport(report)}.`
}

/**
 * Register the `edit` tool and its scope-aware system-prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it, and execution uses its `fs` service.
 * @param sandbox - the shared sandbox-escalation API (advertisement, mode stamping, denial mapping).
 */
export function applyEditTool(ctx: Context, sandbox: FsSandboxController): void {
  ctx.systemPrompt.section({
    name: 'tool:edit',
    order: ctx.systemPrompt.getSectionOrder('TOOL_EDIT'),
    text: ({ scope }) => ctx.tools.get('edit', scope) === undefined
      ? ''
      : 'Read a file before editing it (the default fs-observation-policy requires it), unless you just created or edited it in this session.'
        + ' For multi-hunk or staleness-prone edits, read with `line_ids=true` and edit with `ops` (id-addressed, hash-guarded); the reply carries a renumber map so chained edits skip the re-read.',
  })

  ctx.tools.register(defineTool({
    name: 'edit',
    description: 'Edit an existing UTF-8 text file by replacing literal text, or by id-addressed `ops` against a `line_ids` read.',
    parameters: {
      file_path: {
        type: 'string', required: true,
        description: 'Path to edit, resolved by the filesystem backend. '
          + 'Provide `file_path` before `old_string` and `new_string` in the arguments.',
      },
      old_string: { type: 'string', description: 'Literal text to replace. Required unless `ops` is given.' },
      new_string: { type: 'string', description: 'Literal replacement text. Use an empty string to delete the match.' },
      replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.' },
      ops: {
        type: 'array',
        description: 'Id-addressed ops against a `line_ids` read (mutually exclusive with old_string/new_string).'
          + ' Each op: `{op, id, end_id?, text?}` with op in replace | insert_before | insert_after | delete;'
          + ' `id` = `N#hash` anchor (span end `end_id` inclusive, replace/delete only; `text` required except delete).'
          + ' Hash is the address — a moved line self-locates, a changed line refuses with its current hash.'
          + ' The reply carries a renumber map and fresh ids for inserted lines.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            op: { type: 'string', required: true, enum: ['replace', 'insert_before', 'insert_after', 'delete'] },
            id: { type: 'string', required: true, description: 'Anchor line id `N#hash` from a `line_ids` read.' },
            end_id: { type: 'string', description: 'Inclusive span end id (replace/delete only).' },
            text: { type: 'string', description: 'Replacement or inserted text (required except delete).' },
          },
        },
      },
      ...sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: 'Canonical absolute path in the filesystem execution world.' },
          before: {
            required: true,
            oneOf: [{ type: 'string' }, { type: 'null' }],
          },
          after: { type: 'string', required: true },
          operation: { type: 'string', enum: ['create', 'update'], description: 'Present for ops-mode edits (write path).' },
          idEdit: {
            type: 'object',
            description: 'Renumber report, present for ops-mode edits.',
            additionalProperties: false,
            properties: {
              applied: { type: 'integer', required: true },
              renumber: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    oldStart: { type: 'integer', required: true },
                    oldEnd: { type: 'integer', required: true },
                    newStart: { type: 'integer', description: 'Absent (with newEnd) when the range was deleted.' },
                    newEnd: { type: 'integer' },
                  },
                },
              },
              inserted: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    newStart: { type: 'integer', required: true },
                    count: { type: 'integer', required: true },
                    firstId: { type: 'string', description: 'Id of the block\'s first line, for chained edits.' },
                  },
                },
              },
              replaced: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    newStart: { type: 'integer', required: true },
                    count: { type: 'integer', required: true },
                    firstId: { type: 'string', description: 'Id of the block\'s first line, for chained edits.' },
                  },
                },
              },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.idEdit === undefined
          ? formatEditOutput(value.path, args.replace_all ?? false)
          : formatOpsEditOutput(value.path, value.idEdit),
      }],
      presentationMeta: (_args, value) => ({
        path: value.path,
        diffs: value.before === null
          ? []
          : computeHunkDiffs(value.path, value.before, value.after)
            .map(({ path, oldText, newText }) => ({ path, oldText, newText })),
      }),
    },
    async execute(args: EditToolArgs, exec) {
      const input = parseEditArgs(args)
      // Resolve the per-call sandbox policy (approved mode > session override
      // > backend default, plus the session cwd root) BEFORE anything executes.
      const sandboxPolicy = await sandbox.resolvePolicy('edit', args, exec)
      const target = await ctx.fs.resolve(input.filePath, await sessionResolveOptions(ctx, exec))
      if (input.mode === 'ops') {
        // Id-addressed ops: the gate supplies the CAS basis (or refuses), the
        // current content is read, transformed in memory, and committed through
        // the write path's own replaceIfVersion check — no provider change.
        let outcome
        let report: IdEditReport
        try {
          const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
          const raw = await ctx.fs.readText(target, exec.signal)
          const lineEndings = detectLineEndings(raw)
          const applied = applyIdEdits(normalizeLineEndings(raw), input.ops)
          const content = restoreLineEndings(applied.content, lineEndings)
          const expected: FsWriteIntent | undefined = intent === undefined
            ? undefined
            : { kind: 'replaceIfVersion', version: intent.version }
          outcome = await ctx.fs.writeText(target, content, expected, exec.signal, sandboxPolicy)
          report = applied.report
        } catch (error: unknown) {
          throw await explainMutationFailure(ctx, exec, target, sandbox.mapError(error, sandboxPolicy), undefined)
        }
        return { ...mutationResult(ctx, target, outcome, exec), idEdit: report }
      }
      // Single-slot decision: the policy plugin returns { version: vObserved } or
      // throws FS_NOT_OBSERVED; the bare default is undefined (unconditional edit).
      // No stat — the bare default never manufactures a version basis. The intent
      // slot itself can throw FS_NOT_OBSERVED for an unread target, so it sits
      // inside the try: both that refusal and the provider's guarded-mutation
      // failure get the model-facing remedy below.
      let outcome
      try {
        const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
        outcome = await ctx.fs.editText(
          target,
          { oldString: input.oldString, newString: input.newString, replaceAll: input.replaceAll },
          intent,
          exec.signal,
          sandboxPolicy,
        )
      } catch (error: unknown) {
        // A sandbox denial becomes the shared [sandbox: …] marker (the model
        // recognizes it from bash); guarded mutation failures receive their
        // stable model-facing diagnostic; anything else passes through. The two
        // bookkeeping refusals (unread target / moved version) additionally carry
        // the current content, so the retry needs no separate read.
        throw await explainMutationFailure(ctx, exec, target, sandbox.mapError(error, sandboxPolicy), input.oldString)
      }
      return mutationResult(ctx, target, outcome, exec)
    },
    // Pure display: a diff card of the literal replacement (old_string → new_string), derived
    // from the call args. `oldText: old_string || null` matches claude-agent-acp's Edit arm;
    // ops-mode calls carry no literal pair and degrade to a generic card titled by the op count.
    presentCall(args): ToolCallView {
      if (args.ops !== undefined) {
        return {
          card: 'generic',
          title: `Edit ${args.file_path} (${String(args.ops.length)} id-addressed ops)`,
          kind: 'edit',
          locations: [{ path: args.file_path }],
        }
      }
      return {
        card: 'diff',
        title: `Edit ${args.file_path}`,
        diffs: [{ path: args.file_path, oldText: args.old_string || null, newText: args.new_string ?? '' }],
        locations: [{ path: args.file_path }],
      }
    },
    // Applied metadata replaces the call-time snippet; errors or malformed replay metadata use
    // the generic result rendering.
    presentResult(args, result: ToolResult): DiffResultView | undefined {
      if (result.isError) return undefined
      const diffs = diffsFromMeta(result.meta)
      if (diffs === undefined) return undefined
      return { card: 'diff', title: `Edit ${args.file_path}`, diffs }
    },
  }))
}
