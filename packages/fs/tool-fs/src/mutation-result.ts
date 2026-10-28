/** Shared observation and result fields for successful file mutations. */

import type { Context } from '@deepseek-ai/cordis'
import type { FsObservation, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/** The durable observation carried beside a successful tool result. */
export interface FsObservationResult {
  readonly fsObservation: {
    readonly target: FsTarget
    readonly observation: Extract<FsObservation, { kind: 'present' }>
  }
}

/** Output-schema fragment for {@link FsObservationResult}. */
export const FS_OBSERVATION_RESULT_SCHEMA = {
  type: 'object',
  required: true,
  additionalProperties: false,
  properties: {
    target: {
      type: 'object',
      additionalProperties: false,
      properties: {
        targetKey: { type: 'string', required: true },
        displayPath: { type: 'string', required: true },
      },
    },
    observation: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, enum: ['present'] },
        version: { type: 'string', required: true },
      },
    },
  },
} as const

/**
 * Attach the exact observation emitted on the capability event to the structured
 * result, so `presentationMeta` can persist it for a later Session restore.
 * @param target - resolved file whose observation was emitted.
 * @param observation - authoritative presence and version from the same event.
 * @returns the observation in the structured result and persisted-metadata position.
 */
export function observationResult(target: FsTarget, observation: FsObservationResult['fsObservation']['observation']): FsObservationResult {
  return { fsObservation: { target, observation } }
}

/**
 * Record the new file version and expose the mutation result with its canonical path.
 * @param ctx - filesystem and observation event owner.
 * @param target - resolved file that was mutated.
 * @param outcome - successful provider result; its version stays in the observation event.
 * @param exec - calling tool execution.
 * @returns the provider's result fields without the version, plus the canonical absolute path and durable observation.
 */
export function mutationResult<T extends { version: FsVersion }>(
  ctx: Context, target: FsTarget, outcome: T, exec: ToolExecution,
): Omit<T, 'version'> & { path: string } & FsObservationResult {
  const { version, ...result } = outcome
  ctx.emit('fs/observed', target, { kind: 'present', version }, exec)
  return { path: ctx.fs.processPath(target), ...result, ...observationResult(target, { kind: 'present', version }) }
}
