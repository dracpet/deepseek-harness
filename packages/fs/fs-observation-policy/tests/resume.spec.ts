/** Durable observation replay across Session object rebuilds. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsObservation, FsTarget, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import type { FsObservationActor } from '@deepseek-ai/dsh-fs-observation-policy'

function target(path: string): FsTarget {
  return { targetKey: FsTargetKey(path), displayPath: path }
}
const jsonTarget = (path: string) => ({ targetKey: path, displayPath: path })
const ownerExec = (session: object): FsObservationActor => ({ agent: { session } })
const present = (version: string): FsObservation => ({ kind: 'present', version: FsVersion(version) })

type ResultMeta = SessionEvent<'tool/result'>['data']['meta']

function appendResultMeta(session: Session, meta: ResultMeta, callId: string): void {
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: ToolCallId(callId),
      content: [{ type: 'text', text: 'updated' }],
      isError: false,
    }),
    ...meta === undefined ? {} : { meta },
  }, { surfaceOp: 'append' })
}

function appendObservedMutation(session: Session, version: string): void {
  const file = jsonTarget('a.txt')
  appendResultMeta(session, { fsObservation: { target: file, observation: present(version) } }, `mutation-${version}`)
}

function editIntent(ctx: Context, file: FsTarget, actor: object | undefined): Promise<{ version: FsVersion } | undefined> {
  return ctx.waterfall('fs/edit-intent', file, actor, () => undefined)
}

function writeIntent(ctx: Context, file: FsTarget, actor: object | undefined): Promise<FsWriteIntent | undefined> {
  return ctx.waterfall('fs/write-intent', file, actor, () => undefined)
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(FsPolicy)
  return ctx
}

describe('durable observation replay', () => {
  it('restores the latest mutation observation when a Session object is rebuilt', async () => {
    const ctx = await setup()
    const before = Session.create(SessionId('before-rebuild'))
    appendObservedMutation(before, 'v1')
    appendObservedMutation(before, 'v2')

    const rebuilt = ctx.sessions.create(SessionId('after-rebuild'), { seed: before.snapshotEvents() })

    expect(rebuilt).not.toBe(before)
    expect(await editIntent(ctx, target('a.txt'), ownerExec(rebuilt))).toEqual({ version: 'v2' })
    expect(await writeIntent(ctx, target('a.txt'), ownerExec(rebuilt))).toEqual({ kind: 'replaceIfVersion', version: 'v2' })
  })

  it('keeps the restored historical CAS basis when another writer advances the target', async () => {
    const ctx = await setup()
    const before = Session.create(SessionId('before-external-write'))
    appendObservedMutation(before, 'v1')
    const rebuilt = ctx.sessions.create(SessionId('after-external-write'), { seed: before.snapshotEvents() })
    const otherWriter = Session.create(SessionId('other-writer'))
    appendObservedMutation(otherWriter, 'v2')

    // The provider compares this historical v1 with the current file. It must
    // not be replaced by the other writer's v2 while restoring the Session.
    expect(await editIntent(ctx, target('a.txt'), ownerExec(rebuilt))).toEqual({ version: 'v1' })
  })

  it('restores confirmed absence rather than treating it as unseen', async () => {
    const ctx = await setup()
    const before = Session.create(SessionId('before-absent-restore'))
    appendResultMeta(before, { fsObservation: { target: jsonTarget('a.txt'), observation: { kind: 'absent' } } }, 'absent')
    const rebuilt = ctx.sessions.create(SessionId('after-absent-restore'), { seed: before.snapshotEvents() })

    await expect(editIntent(ctx, target('a.txt'), ownerExec(rebuilt))).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    expect(await writeIntent(ctx, target('a.txt'), ownerExec(rebuilt))).toEqual({ kind: 'createIfAbsent' })
  })

  it('ignores older and unrelated result metadata', async () => {
    const ctx = await setup()
    const before = Session.create(SessionId('before-unrelated-meta'))
    appendResultMeta(before, undefined, 'old')
    appendResultMeta(before, null, 'null')
    appendResultMeta(before, [], 'array')
    appendResultMeta(before, { unrelated: true }, 'other')
    const rebuilt = ctx.sessions.create(SessionId('after-unrelated-meta'), { seed: before.snapshotEvents() })

    await expect(editIntent(ctx, target('a.txt'), ownerExec(rebuilt))).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })

  it.each([
    ['a non-object record', { fsObservation: 1 }],
    ['a non-object target', { fsObservation: { target: 1, observation: present('v1') } }],
    ['non-string target paths', { fsObservation: { target: { targetKey: 1, displayPath: 'a.txt' }, observation: present('v1') } }],
    ['a non-object observation', { fsObservation: { target: jsonTarget('a.txt'), observation: 1 } }],
    ['a present observation without a version', { fsObservation: { target: jsonTarget('a.txt'), observation: { kind: 'present' } } }],
    ['an absent observation carrying a version', { fsObservation: { target: jsonTarget('a.txt'), observation: { kind: 'absent', version: 'v1' } } }],
  ])('rejects malformed persisted metadata: %s', async (_name, meta) => {
    const ctx = await setup()
    const before = Session.create(SessionId('before-malformed-meta'))
    appendResultMeta(before, meta, 'bad')

    expect(() => ctx.sessions.create(SessionId('after-malformed-meta'), { seed: before.snapshotEvents() }))
      .toThrow(/cannot restore fsObservation/u)
  })
})
