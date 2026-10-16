// The quiet-hours and config commands as subprocesses against an in-process
// daemon whose quiet window is chosen around the real time (the CLI prints
// countdowns from its own clock): unlock, lock, quiet status, config get/set,
// the refused detail commands exiting 3, and que status's header.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConfigGetResult } from '@shared/protocol'
import type { QuietState } from '@shared/types'
import { hhmm } from '@daemon/quiet-hours'
import type { StatusJson } from '../../src/cli/workspaces'
import { runCli } from '../../src/testing/cli'
import { startTestDaemon, type TestDaemon } from '../../src/testing/daemon-harness'
import { makeTempRepo } from '../../src/testing/temp-repo'

let daemon: TestDaemon
let windowEnd: string

beforeEach(async () => {
  // An hour either side of now, so the window holds for the whole test.
  const now = Date.now()
  windowEnd = hhmm(now + 60 * 60_000)
  daemon = await startTestDaemon({
    config: `[quiet_hours]\nenabled = true\ndefault = ["${hhmm(now - 60 * 60_000)}", "${windowEnd}"]\n`
  })
})

afterEach(async () => {
  await daemon.close()
})

describe('que quiet status', () => {
  it('says quiet hours are on and until when, as text and as JSON', async () => {
    const text = await runCli('quiet', 'status')
    const json = await runCli('quiet', 'status', '--json')

    expect(text).toMatchObject({ code: 0, stdout: `quiet hours until ${windowEnd}\n` })
    expect(JSON.parse(json.stdout) as QuietState).toMatchObject({
      enabled: true,
      inQuietHours: true,
      unlockedUntil: null,
      unlockMinutes: 20
    })
  }, 30_000)
})

describe('que unlock and que lock', () => {
  it('unlocks for the given minutes with a reason, and locks again', async () => {
    const unlock = await runCli('unlock', '5', '--why', 'check the deploy')

    expect(unlock.code).toBe(0)
    expect(unlock.stdout).toMatch(
      new RegExp(`^quiet hours until ${windowEnd} · unlocked, [45]:\\d\\d left\\n$`)
    )
    expect((await daemon.client.request('quiet.state')).unlockedUntil).not.toBeNull()
    expect(await daemon.client.request('quiet.log')).toEqual([
      expect.objectContaining({ minutes: 5, why: 'check the deploy', endedAt: null })
    ])

    const lock = await runCli('lock')

    expect(lock).toMatchObject({ code: 0, stdout: `quiet hours until ${windowEnd}\n` })
    expect((await daemon.client.request('quiet.log'))[0].endedAt).not.toBeNull()
  }, 30_000)

  it('rejects minutes that are not a positive number', async () => {
    const r = await runCli('unlock', 'soon')

    expect(r.code).toBe(1)
    expect(r.stderr).toContain('que: minutes must be a positive number')
  }, 30_000)
})

describe('que config', () => {
  it('prints the config path and values, and sets dotted keys that the daemon reloads', async () => {
    const got = JSON.parse((await runCli('config', 'get', '--json')).stdout) as ConfigGetResult
    expect(got.path).toBe(daemon.configPath)
    expect(got.config.notifications.chimeOnComplete).toBe(true)

    const set = await runCli(
      'config',
      'set',
      'concurrency=3',
      'notifications.chime_on_complete=false',
      'quiet_hours.unlock_minutes=0.5'
    )

    expect(set).toMatchObject({ code: 0, stdout: `updated ${daemon.configPath}\n` })
    const after = await daemon.client.request('config.get')
    expect(after.config).toMatchObject({
      concurrency: 3,
      notifications: { chimeOnComplete: false },
      quietHours: { unlockMinutes: 0.5, enabled: true }
    })
    expect((await daemon.client.request('queue.state')).concurrency).toBe(3)
    expect((await runCli('config', 'get')).stdout).toContain('unlock 0.5 min')
  }, 30_000)

  it('refuses an invalid value and names the key', async () => {
    const r = await runCli('config', 'set', 'quiet_hours.default=7pm,07:00')

    expect(r.code).toBe(1)
    expect(r.stderr).toContain('quiet_hours.default: 7pm is not a 24-hour HH:MM time')
  }, 30_000)

  it("keeps tonight's window on an early end unless --apply-tonight", async () => {
    const endNow = `quiet_hours.default=${hhmm(Date.now() - 60 * 60_000)},${hhmm(Date.now() - 30 * 60_000)}`

    await runCli('config', 'set', endNow)
    expect((await daemon.client.request('quiet.state')).inQuietHours).toBe(true)

    const r = await runCli('config', 'set', endNow, '--apply-tonight')
    expect(r.code).toBe(0)
    expect((await daemon.client.request('quiet.state')).inQuietHours).toBe(false)
  }, 30_000)
})

describe('detail commands during quiet hours', () => {
  it('attach, open, report, run and term new print the refusal and exit 3', async () => {
    const repo = makeTempRepo(daemon.home)
    expect((await runCli('work', '--name', 'app-1490-quiet-cli', '-r', repo)).code).toBe(0)
    const refusal = `quiet hours until ${windowEnd}; run \`que unlock\` for 20 minutes\n`

    for (const args of [
      ['attach', 'app-1490-quiet-cli'],
      ['open', 'app-1490-quiet-cli'],
      ['ws', 'terminal', 'app-1490-quiet-cli'],
      ['report'],
      ['run'],
      ['term', 'new', '--cwd', daemon.home],
      ['add', '-r', repo, 'Add retry logic to the uploader']
    ]) {
      expect(await runCli(...args), args.join(' ')).toEqual({
        code: 3,
        stdout: '',
        stderr: refusal
      })
    }
  }, 60_000)

  it('que status keeps working and says quiet hours are on', async () => {
    const text = await runCli('status')
    const json = JSON.parse((await runCli('status', '--json')).stdout) as StatusJson

    expect(text.code).toBe(0)
    expect(text.stdout.split('\n')[0]).toBe(`quiet hours until ${windowEnd}`)
    expect(json.quiet).toMatchObject({ inQuietHours: true })
  }, 30_000)
})
