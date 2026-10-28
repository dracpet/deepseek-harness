/**
 * Event-only filesystem observation policy; it registers no service. A weak owner/target map
 * records every authoritative presence/absence observation, single-slot intent listeners derive
 * guards from that state, and the provider performs the atomic freshness/no-clobber check. Without
 * this plugin, tools retain the bare provider's unconditional mutation behavior. See the package
 * README for composition rules.
 * @module @deepseek-ai/dsh-fs-observation-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsObservation, FsTarget, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import type { Session } from '@deepseek-ai/dsh-session'
import type { FsObservationActor } from './types.ts'

export type { FsObservationActor } from './types.ts'

interface PersistedObservation {
  readonly target: FsTarget
  readonly observation: FsObservation
}

/**
 * Narrow one tool-owned `tool/result.meta` value to its optional observation.
 * Absent metadata means an older or unrelated result; a present but malformed
 * `fsObservation` fails the restore instead of fabricating an unobserved state.
 */
function persistedObservation(meta: unknown): PersistedObservation | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const value = (meta as Record<string, unknown>).fsObservation
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('tool/result meta fsObservation must be an object')
  }
  const { target, observation } = value as Record<string, unknown>
  if (typeof target !== 'object' || target === null || Array.isArray(target)) {
    throw new TypeError('tool/result meta fsObservation.target must be an object')
  }
  const { targetKey, displayPath } = target as Record<string, unknown>
  if (typeof targetKey !== 'string' || typeof displayPath !== 'string') {
    throw new TypeError('tool/result meta fsObservation.target paths must be strings')
  }
  if (typeof observation !== 'object' || observation === null || Array.isArray(observation)) {
    throw new TypeError('tool/result meta fsObservation.observation must be an object')
  }
  const { kind, version } = observation as Record<string, unknown>
  if (kind === 'absent' && version === undefined) {
    return {
      target: { targetKey: FsTargetKey(targetKey), displayPath },
      observation: { kind: 'absent' },
    }
  }
  if (kind === 'present' && typeof version === 'string') {
    return {
      target: { targetKey: FsTargetKey(targetKey), displayPath },
      observation: { kind: 'present', version: FsVersion(version) },
    }
  }
  throw new TypeError('tool/result meta fsObservation.observation has an invalid kind or version')
}

/**
 * Per-context observed-file state and the three `fs/*` decisions over it. One
 * instance is created per `apply()` so disposal can drop all state for HMR.
 */
class ObservedStateGate {
  /**
   * Observed-file state, keyed first by the owner object (weakly held, so a
   * collected session frees its state), then by {@link FsTarget.targetKey}. An
   * entry's presence is the prior-observation record; its discriminant keeps
   * confirmed absence distinct from an unseen target.
   */
  private observed = new WeakMap<object, Map<string, FsObservation>>()

  /**
   * Derive the observed-state owner from the opaque event actor — normally the
   * active agent session. `undefined` when no owner can be derived (e.g. a
   * direct tool call with no agent); such calls read freely but cannot satisfy
   * the write/edit prior-observation policy.
   */
  private owner(actor: object | undefined): object | undefined {
    // tsgolint treats object as assignable to weak FsObservationActor, while tsc still requires the structural cast for property access.
    // See the analyzer-divergence consequence in .agents/notes/archived/process/2026-07-29-oxlint-linter.md.
    return (actor as FsObservationActor | undefined)?.agent?.session
  }

  private get(owner: object, targetKey: string): FsObservation | undefined {
    return this.observed.get(owner)?.get(targetKey)
  }

  private set(owner: object, targetKey: string, observation: FsObservation): void {
    let byTarget = this.observed.get(owner)
    if (!byTarget) {
      byTarget = new Map()
      this.observed.set(owner, byTarget)
    }
    byTarget.set(targetKey, observation)
  }

  /** Drop all recorded state (HMR safety / disposal). */
  clear(): void {
    this.observed = new WeakMap()
  }

  /**
   * Rebuild this Session's observations from durable tool-result metadata.
   * Historical versions remain the CAS basis; restore never stats the current
   * file, so an external change still fails with `FS_STALE_VERSION`.
   */
  restore(session: Session): void {
    for (const event of session.snapshotEvents()) {
      if (event.type !== 'tool/result') continue
      try {
        const persisted = persistedObservation(event.data.meta)
        if (persisted !== undefined) this.set(session, persisted.target.targetKey, persisted.observation)
      } catch (error) {
        throw new TypeError(`cannot restore fsObservation at session "${session.id}" seq ${event.seq}`, { cause: error })
      }
    }
  }

  /**
   * Decide the write intent: unseen or confirmed absent ⇒ `createIfAbsent`;
   * confirmed present ⇒ `replaceIfVersion` at the observed version.
   */
  writeIntent(target: FsTarget, actor: object | undefined): FsWriteIntent {
    const owner = this.owner(actor)
    const prior = owner ? this.get(owner, target.targetKey) : undefined
    return prior?.kind === 'present'
      ? { kind: 'replaceIfVersion', version: prior.version }
      : { kind: 'createIfAbsent' }
  }

  /**
   * Decide the edit version guard: unseen rejects with `FS_NOT_OBSERVED`,
   * confirmed absence rejects with `FS_NOT_FOUND`, and presence supplies the
   * observed version as the CAS basis.
   */
  editIntent(target: FsTarget, actor: object | undefined): { version: FsVersion } {
    const owner = this.owner(actor)
    const prior = owner ? this.get(owner, target.targetKey) : undefined
    if (!owner || prior === undefined) {
      throw new FsError(`edit requires reading "${target.displayPath}" first`, 'FS_NOT_OBSERVED')
    }
    if (prior.kind === 'absent') {
      throw new FsError(`cannot edit "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    }
    return { version: prior.version }
  }

  /** Record an authoritative present or absent observation for this owner and target. */
  observe(target: FsTarget, observation: FsObservation, actor: object | undefined): void {
    const owner = this.owner(actor)
    if (owner) this.set(owner, target.targetKey, observation)
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'fs-observation-policy'

/**
 * Register the `fs/*` listeners and Session restore. No `inject` — this plugin
 * reads no services; it operates only on its own `WeakMap` and Session log. The waterfalls are unbound
 * (the tool dispatches them with no `this`), so the listeners take the raw
 * `(target, actor, next)` arguments.
 */
export function apply(ctx: Context): void {
  const gate = new ObservedStateGate()

  // A restored Session carries the same tool-result metadata in a new object.
  // Rebuild before agent work resumes; startup with no matching metadata is a no-op.
  ctx.on('session/created', (session) => {
    gate.restore(session)
  })

  ctx.effect(() => () => {
    // Drop all recorded state on disposal so a reloaded plugin starts clean
    // (HMR safety). The WeakMap itself would be GC'd, but replacing it makes the
    // release observable and immediate for tests.
    gate.clear()
  }, 'fs-observation-policy observed-state teardown')

  // fs/write-intent: occupy the single decision slot — do NOT call next().
  // Deferred through Promise.resolve().then so the declared Promise return type
  // holds (a throw rejects, never escapes synchronously through the waterfall).
  ctx.on('fs/write-intent', (target, actor) => Promise.resolve().then(() => gate.writeIntent(target, actor)))

  // fs/edit-intent: occupy the single decision slot — do not call next().
  ctx.on('fs/edit-intent', (target, actor) => Promise.resolve().then(() => gate.editIntent(target, actor)))

  // fs/observed must remain synchronous and non-throwing: emit does not await
  // promises, and successful mutations have already committed. WeakMap.set
  // satisfies that contract for both presence and absence.
  ctx.on('fs/observed', (target, observation, actor) => {
    gate.observe(target, observation, actor)
  })
}
