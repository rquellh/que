// instructions.get and instructions.set over the socket: the file named by
// instructions_file in the user config, read and written by the daemon.
import fs from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startTestDaemon, type TestDaemon } from '../../src/testing/daemon-harness'

let daemon: TestDaemon | undefined

afterEach(async () => {
  await daemon?.close()
  daemon = undefined
})

async function start(): Promise<TestDaemon> {
  daemon = await startTestDaemon()
  return daemon
}

describe('instructions', () => {
  it('reports no path and no content while instructions_file is unset', async () => {
    const d = await start()

    expect(await d.client.request('instructions.get')).toEqual({ exists: false, content: '' })
  })

  it('refuses to write without a configured path', async () => {
    const d = await start()

    await expect(
      d.client.request('instructions.set', { content: 'Delegate broad searches.\n' })
    ).rejects.toMatchObject({
      code: 'not_configured',
      message: 'no instructions file: set instructions_file in the que config first'
    })
  })

  it('writes the configured file, creating its directory, and reads it back', async () => {
    const d = await start()
    const path = join(d.home, 'notes', 'que', 'delegation.md')
    await d.client.request('config.set', { patch: { instructions_file: path } })
    expect(await d.client.request('instructions.get')).toEqual({
      path,
      exists: false,
      content: ''
    })

    const written = await d.client.request('instructions.set', {
      content: 'Delegate broad searches to a smaller model.\n'
    })

    expect(written).toEqual({
      path,
      exists: true,
      content: 'Delegate broad searches to a smaller model.\n'
    })
    expect(fs.readFileSync(path, 'utf8')).toBe('Delegate broad searches to a smaller model.\n')
    expect(await d.client.request('instructions.get')).toEqual(written)
  })
})
