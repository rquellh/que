// Projects and workspaces over the real socket, against real git repos in the
// test's QUE_HOME: worktree creation, include copies, setup/teardown from
// que.toml, refusals, and removal.
import fs from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DaemonClient } from '@shared/client'
import type { Events } from '@shared/protocol'
import { startTestDaemon, type TestDaemon } from '../../src/testing/daemon-harness'
import { readFakeLog } from '../../src/testing/fakes'
import { pidAlive } from '../../src/testing/leak-check'
import { addBareOrigin, gitIn, makeTempRepo } from '../../src/testing/temp-repo'

let daemon: TestDaemon
let client: DaemonClient

beforeEach(async () => {
  daemon = await startTestDaemon()
  client = daemon.client
})

afterEach(async () => {
  await daemon.close()
})

function record<E extends keyof Events>(c: DaemonClient, event: E): Events[E][] {
  const seen: Events[E][] = []
  c.on(event, (data) => seen.push(data))
  return seen
}

describe('projects', () => {
  it('registers the git toplevel once, with its default branch', async () => {
    const repo = makeTempRepo(daemon.home)
    fs.mkdirSync(join(repo, 'src'))

    const project = await client.request('project.add', { path: repo })
    const again = await client.request('project.add', { path: join(repo, 'src') })

    expect(project).toMatchObject({ name: 'uploader', path: repo, defaultBranch: 'main' })
    expect(project.id).toMatch(/^prj_[a-z2-7]{12}$/)
    expect(again.id).toBe(project.id)
    expect(await client.request('project.list')).toEqual([project])
  })

  it("takes the default branch from origin's HEAD in a clone", async () => {
    const origin = makeTempRepo(daemon.home, { name: 'origin-uploader', branch: 'develop' })
    gitIn(daemon.home, 'clone', '--quiet', origin, join(daemon.home, 'uploader'))

    const project = await client.request('project.add', { path: join(daemon.home, 'uploader') })

    expect(project).toMatchObject({ name: 'uploader', defaultBranch: 'develop' })
  })

  it('rejects a directory that is not a git repository', async () => {
    const plain = join(daemon.home, 'notes')
    fs.mkdirSync(plain)

    await expect(client.request('project.add', { path: plain })).rejects.toMatchObject({
      code: 'bad_request'
    })
  })

  it('refuses to remove a project with workspaces unless forced', async () => {
    const project = await client.request('project.add', { path: makeTempRepo(daemon.home) })
    const ws = await client.request('workspace.create', {
      projectId: project.id,
      name: 'app-1440-quiet-board'
    })

    await expect(client.request('project.remove', { id: project.id })).rejects.toMatchObject({
      code: 'conflict'
    })
    await client.request('project.remove', { id: project.id, force: true })

    expect(await client.request('project.list')).toEqual([])
    expect(fs.existsSync(ws.path)).toBe(false)
  }, 20_000)
})

describe('workspaces', () => {
  describe('create', () => {
    it('makes a worktree on its own branch, copies includes, runs setup, and goes idle', async () => {
      const repo = makeTempRepo(daemon.home, {
        queToml: `setup = "printf ready > .que-setup-ok; echo setup-output-3e1d"
worktree_include = ["config/local", "missing.json"]
`,
        ignored: { '.env': 'API_TOKEN=tok_51f2\n', 'config/local/db.json': '{"port":5433}\n' }
      })
      fs.writeFileSync(join(repo, '.worktreeinclude'), '.env\n')
      const mainHead = gitIn(repo, 'rev-parse', 'HEAD')
      const created = record(client, 'workspace.created')
      const statuses = record(client, 'workspace.status')
      const project = await client.request('project.add', { path: repo })

      const ws = await client.request('workspace.create', {
        projectId: project.id,
        name: 'APP-1432 retry logic'
      })

      expect(ws).toMatchObject({
        projectId: project.id,
        name: 'app-1432-retry-logic',
        branch: 'app-1432-retry-logic',
        path: join(daemon.home, 'worktrees', 'uploader', 'app-1432-retry-logic'),
        baseRef: 'main',
        status: 'preparing'
      })
      expect(ws.id).toMatch(/^ws_[a-z2-7]{12}$/)
      expect(created).toEqual([ws])
      expect(gitIn(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('app-1432-retry-logic')
      expect(gitIn(ws.path, 'rev-parse', 'HEAD')).toBe(mainHead)
      expect(fs.readFileSync(join(ws.path, '.env'), 'utf8')).toBe('API_TOKEN=tok_51f2\n')
      expect(fs.readFileSync(join(ws.path, 'config/local/db.json'), 'utf8')).toContain('5433')

      await expect
        .poll(() => statuses.filter((s) => s.id === ws.id).map((s) => s.status), {
          timeout: 10_000
        })
        .toEqual(['preparing', 'idle'])
      expect(fs.readFileSync(join(ws.path, '.que-setup-ok'), 'utf8')).toBe('ready')
      expect(
        fs.readFileSync(join(daemon.home, 'logs', 'workspaces', `${ws.id}-setup.log`), 'utf8')
      ).toContain('setup-output-3e1d')
      expect(await client.request('workspace.get', { id: ws.id })).toMatchObject({
        status: 'idle'
      })
      expect(await client.request('workspace.list', { projectId: project.id })).toHaveLength(1)
    }, 20_000)

    it('is stuck with setup_failed when the setup command fails', async () => {
      const repo = makeTempRepo(daemon.home, { queToml: 'setup = "echo boom-7a2c >&2; exit 3"\n' })
      const project = await client.request('project.add', { path: repo })

      const ws = await client.request('workspace.create', {
        projectId: project.id,
        name: 'app-1433-flaky-setup'
      })

      await expect
        .poll(async () => client.request('workspace.get', { id: ws.id }), { timeout: 10_000 })
        .toMatchObject({ status: 'stuck', statusReason: 'setup_failed' })
      expect(
        fs.readFileSync(join(daemon.home, 'logs', 'workspaces', `${ws.id}-setup.log`), 'utf8')
      ).toContain('boom-7a2c')
    }, 20_000)

    it('bases a clone on origin/<default branch> after fetching', async () => {
      const origin = makeTempRepo(daemon.home, { name: 'origin-uploader', branch: 'develop' })
      const clone = join(daemon.home, 'uploader')
      gitIn(daemon.home, 'clone', '--quiet', origin, clone)
      fs.writeFileSync(join(origin, 'CHANGELOG.md'), '## 2.1.0\n')
      gitIn(origin, 'add', '.')
      gitIn(origin, 'commit', '-m', 'Changelog for 2.1.0')
      const project = await client.request('project.add', { path: clone })

      const ws = await client.request('workspace.create', {
        projectId: project.id,
        name: 'app-1450-changelog'
      })

      expect(ws.baseRef).toBe('origin/develop')
      expect(gitIn(ws.path, 'rev-parse', 'HEAD')).toBe(gitIn(origin, 'rev-parse', 'HEAD'))
    }, 20_000)
  })

  describe('errors', () => {
    it('refuses bad names, taken branches, duplicates, and unknown projects', async () => {
      const repo = makeTempRepo(daemon.home)
      gitIn(repo, 'branch', 'app-1460-taken')
      const project = await client.request('project.add', { path: repo })
      await client.request('workspace.create', { projectId: project.id, name: 'app-1461-dupe' })

      await expect(
        client.request('workspace.create', { projectId: project.id, name: '!!!' })
      ).rejects.toMatchObject({ code: 'bad_request' })
      await expect(
        client.request('workspace.create', { projectId: project.id, name: 'app-1460-taken' })
      ).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('branch') })
      await expect(
        client.request('workspace.create', { projectId: project.id, name: 'APP-1461 dupe' })
      ).rejects.toMatchObject({ code: 'conflict' })
      await expect(
        client.request('workspace.create', { projectId: 'prj_missing0000', name: 'app-1462' })
      ).rejects.toMatchObject({ code: 'not_found' })
      expect(fs.existsSync(join(daemon.home, 'worktrees', 'uploader', 'app-1460-taken'))).toBe(
        false
      )
    }, 20_000)
  })

  describe('remove', () => {
    it('kills its terminals, runs teardown, removes the worktree and branch', async () => {
      const marker = join(daemon.home, 'teardown-ran.txt')
      const repo = makeTempRepo(daemon.home, {
        queToml: `setup = "true"\nteardown = "pwd > '${marker}'"\n`
      })
      const project = await client.request('project.add', { path: repo })
      const ws = await client.request('workspace.create', {
        projectId: project.id,
        name: 'app-1470-cleanup'
      })
      const { id: termId } = await client.request('workspace.openTerminal', {
        id: ws.id,
        cols: 80,
        rows: 24
      })
      const [term] = await client.request('term.list', { workspaceId: ws.id })
      expect(term).toMatchObject({ id: termId, workspaceId: ws.id, cwd: ws.path, alive: true })
      const killed = record(client, 'term.killed')
      const removed = record(client, 'workspace.removed')

      await client.request('workspace.remove', { id: ws.id, deleteBranch: true })

      expect(killed).toContainEqual({ id: termId })
      expect(removed).toEqual([{ id: ws.id }])
      await expect.poll(() => pidAlive(term.pid), { timeout: 5_000 }).toBe(false)
      expect(fs.readFileSync(marker, 'utf8').trim()).toBe(ws.path)
      expect(fs.existsSync(ws.path)).toBe(false)
      expect(gitIn(repo, 'worktree', 'list')).not.toContain(ws.path)
      expect(gitIn(repo, 'branch', '--list', 'app-1470-cleanup')).toBe('')
      expect(await client.request('workspace.list')).toEqual([])
      await expect(client.request('workspace.get', { id: ws.id })).rejects.toMatchObject({
        code: 'not_found'
      })
    }, 20_000)
  })
})

const THREE_WORDS = /^[a-z]+-[a-z]+-[a-z]+$/

describe('workspaces from a brief', () => {
  const brief = 'Fix the flaky upload test\n\nIt times out on slow CI runners; raise the timeout.'

  it('takes the title from the first line, draws a three-word name, and writes the brief', async () => {
    const repo = makeTempRepo(daemon.home)
    const project = await client.request('project.add', { path: repo })

    const ws = await client.request('workspace.create', { projectId: project.id, brief })

    expect(ws.name).toMatch(THREE_WORDS)
    expect(ws).toMatchObject({
      branch: ws.name,
      path: join(daemon.home, 'worktrees', 'uploader', ws.name),
      title: 'Fix the flaky upload test',
      brief
    })
    expect(gitIn(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(ws.name)
    expect(fs.readFileSync(join(ws.path, '.que', 'brief.md'), 'utf8')).toBe(brief)
    expect(gitIn(ws.path, 'status', '--porcelain')).toBe('')
    expect(await client.request('workspace.get', { id: ws.id })).toMatchObject({
      title: 'Fix the flaky upload test',
      brief
    })
  }, 20_000)

  it('gives two workspaces from the same brief different names, and keeps a given name exactly', async () => {
    const project = await client.request('project.add', { path: makeTempRepo(daemon.home) })

    const first = await client.request('workspace.create', { projectId: project.id, brief })
    const second = await client.request('workspace.create', {
      projectId: project.id,
      title: 'Speed up the diff view',
      brief
    })
    const named = await client.request('workspace.create', {
      projectId: project.id,
      name: 'APP-1490 upload timeout',
      brief
    })

    expect(second.name).toMatch(THREE_WORDS)
    expect(second.name).not.toBe(first.name)
    expect(second.title).toBe('Speed up the diff view')
    expect(named).toMatchObject({
      name: 'app-1490-upload-timeout',
      title: 'Fix the flaky upload test'
    })
    await expect(
      client.request('workspace.create', { projectId: project.id, name: first.name, brief })
    ).rejects.toMatchObject({ code: 'conflict' })
  }, 20_000)

  it('draws again when the name, branch, or folder is taken, and gives up after 50 draws', async () => {
    await daemon.close()
    const draws = ['taken-branch-name', 'calm-amber-otter', 'calm-amber-otter', 'brisk-tidy-heron']
    let n = 0
    daemon = await startTestDaemon({
      randomWorkspaceName: () => draws[Math.min(n++, draws.length - 1)]
    })
    client = daemon.client
    const repo = makeTempRepo(daemon.home)
    gitIn(repo, 'branch', 'taken-branch-name')
    const project = await client.request('project.add', { path: repo })

    const first = await client.request('workspace.create', { projectId: project.id, brief })
    const second = await client.request('workspace.create', { projectId: project.id, brief })
    expect([first.name, second.name]).toEqual(['calm-amber-otter', 'brisk-tidy-heron'])

    await expect(
      client.request('workspace.create', { projectId: project.id, brief })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(n).toBe(54)
  }, 30_000)
})

describe('workspace.start', () => {
  /** The claude runs the fake recorded, once at least `n` have started. */
  async function claudeRuns(n = 1) {
    await expect
      .poll(() => readFakeLog(daemon.claudeLog).length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(n)
    return readFakeLog(daemon.claudeLog)
  }

  it('opens the first terminal at once and, once setup ends, starts claude on the brief verbatim', async () => {
    const gate = join(daemon.home, 'setup-gate')
    const repo = makeTempRepo(daemon.home, {
      queToml: `setup = "until [ -f '${gate}' ]; do sleep 0.05; done"\n`
    })
    const instructions = join(daemon.home, 'instructions.md')
    fs.writeFileSync(instructions, 'Delegate broad searches to a smaller model.\n')
    await client.request('config.set', { patch: { instructions_file: instructions } })
    const project = await client.request('project.add', { path: repo })
    const brief =
      'Don\'t drop uploads on a 503\n\nRetry with backoff; cap the wait at $MAX_WAIT seconds.\n  Keep `the` indent and "quotes".'
    const ws = await client.request('workspace.create', { projectId: project.id, brief })

    const { terminalId } = await client.request('workspace.start', { id: ws.id })

    expect(await client.request('term.list', { workspaceId: ws.id })).toMatchObject([
      { id: terminalId, cwd: ws.path, alive: true }
    ])
    expect((await client.request('workspace.get', { id: ws.id })).status).toBe('preparing')
    expect(readFakeLog(daemon.claudeLog)).toEqual([])

    fs.writeFileSync(gate, '')

    const [started] = await claudeRuns()
    expect(started.argv.at(-1)).toBe(brief)
    expect(started.argv[started.argv.indexOf('--append-system-prompt-file') + 1]).toBe(instructions)
    const again = await client.request('workspace.start', { id: ws.id })
    expect(again.terminalId).toBe(terminalId)
    expect(await client.request('term.list', { workspaceId: ws.id })).toHaveLength(1)
  }, 30_000)

  it('sends a configured start prompt instead of the brief', async () => {
    await client.request('config.set', {
      patch: { start_prompt: "Read .que/brief.md, then say what you'd do first." }
    })
    const project = await client.request('project.add', { path: makeTempRepo(daemon.home) })
    const ws = await client.request('workspace.create', {
      projectId: project.id,
      brief: 'Fix the flaky upload test'
    })

    await client.request('workspace.start', { id: ws.id })

    const [started] = await claudeRuns()
    expect(started.argv.at(-1)).toBe("Read .que/brief.md, then say what you'd do first.")
  }, 30_000)

  it('starts a bare claude in a workspace without a brief', async () => {
    const project = await client.request('project.add', { path: makeTempRepo(daemon.home) })
    const ws = await client.request('workspace.create', {
      projectId: project.id,
      name: 'app-1490-no-brief'
    })

    await client.request('workspace.start', { id: ws.id })

    const [started] = await claudeRuns()
    expect(started.argv).toEqual(['--settings', join(daemon.home, 'hooks.json')])
  }, 30_000)

  it('answers not_found for an unknown workspace', async () => {
    await expect(
      client.request('workspace.start', { id: 'ws_missing00000' })
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('workspace.rename', () => {
  async function created() {
    const repo = makeTempRepo(daemon.home)
    const project = await client.request('project.add', { path: repo })
    const ws = await client.request('workspace.create', {
      projectId: project.id,
      brief: 'Fix the flaky upload test'
    })
    return { repo, ws }
  }

  it('changes the title, announces it, and keeps the branch and folder', async () => {
    const { ws } = await created()
    const updated = record(client, 'workspace.updated')

    const renamed = await client.request('workspace.rename', {
      id: ws.id,
      title: '  Raise the upload test timeout '
    })

    expect(renamed).toMatchObject({
      title: 'Raise the upload test timeout',
      name: ws.name,
      branch: ws.branch,
      path: ws.path
    })
    expect(updated).toEqual([renamed])
    expect(await client.request('workspace.get', { id: ws.id })).toEqual(renamed)
    await expect(
      client.request('workspace.rename', { id: ws.id, title: ' ' })
    ).rejects.toMatchObject({ code: 'bad_request' })
  }, 20_000)

  it('renames a branch never pushed, but not to an invalid or existing name', async () => {
    const { repo, ws } = await created()
    gitIn(repo, 'branch', 'taken-branch-name')
    expect(await client.request('workspace.canRenameBranch', { id: ws.id })).toEqual({
      allowed: true
    })

    const renamed = await client.request('workspace.rename', {
      id: ws.id,
      title: 'Raise the upload test timeout',
      branch: 'fix/upload-timeout'
    })

    expect(renamed).toMatchObject({
      branch: 'fix/upload-timeout',
      name: ws.name,
      path: ws.path
    })
    expect(gitIn(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('fix/upload-timeout')
    await expect(
      client.request('workspace.rename', { id: ws.id, title: 'Again', branch: 'taken-branch-name' })
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(
      client.request('workspace.rename', { id: ws.id, title: 'Again', branch: 'bad..name' })
    ).rejects.toMatchObject({ code: 'bad_request' })
    expect(await client.request('workspace.get', { id: ws.id })).toMatchObject({
      title: 'Raise the upload test timeout',
      branch: 'fix/upload-timeout'
    })
  }, 20_000)

  it('keeps the name of a branch that is on origin', async () => {
    const { repo, ws } = await created()
    addBareOrigin(repo)
    gitIn(ws.path, 'push', '--quiet', 'origin', ws.branch)
    gitIn(ws.path, 'fetch', '--quiet', 'origin')

    expect(await client.request('workspace.canRenameBranch', { id: ws.id })).toEqual({
      allowed: false
    })
    await expect(
      client.request('workspace.rename', {
        id: ws.id,
        title: 'Raise the upload test timeout',
        branch: 'raise-the-upload-test-timeout'
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(gitIn(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(ws.branch)
    // The same branch is not a rename: the title still changes.
    const renamed = await client.request('workspace.rename', {
      id: ws.id,
      title: 'Raise the upload test timeout',
      branch: ws.branch
    })
    expect(renamed).toMatchObject({ title: 'Raise the upload test timeout', branch: ws.branch })
  }, 20_000)
})

describe('workspace.createPr', () => {
  async function workspaceWithOrigin(branch?: string) {
    const repo = makeTempRepo(daemon.home)
    const origin = addBareOrigin(repo)
    const { id: projectId } = await client.request('project.add', { path: repo })
    const ws = await client.request('workspace.create', {
      projectId,
      name: 'APP-1432 retry logic',
      ...(branch ? { branch } : {})
    })
    return { origin, ws }
  }

  it('commits the uncommitted work as the title, pushes, and opens a draft PR', async () => {
    const { origin, ws } = await workspaceWithOrigin()
    const updates = record(client, 'workspace.updated')
    fs.writeFileSync(join(ws.path, 'retry.ts'), 'export const retries = 3\n')

    const result = await client.request('workspace.createPr', {
      id: ws.id,
      title: 'Add retry logic to the uploader'
    })

    expect(result.prUrl).toMatch(/^https:\/\/github\.com\/.+\/pull\/\d+$/)
    expect(gitIn(ws.path, 'log', '-1', '--format=%s')).toBe('Add retry logic to the uploader')
    expect(gitIn(origin, 'rev-parse', 'app-1432-retry-logic')).toBe(
      gitIn(ws.path, 'rev-parse', 'HEAD')
    )
    const pr = readFakeLog(daemon.ghLog).find((c) => c.argv[0] === 'pr')
    expect(pr?.argv).toEqual(
      expect.arrayContaining(['create', '--draft', '--title', 'Add retry logic to the uploader'])
    )
    expect(pr?.cwd).toBe(ws.path)
    expect((await client.request('workspace.get', { id: ws.id })).prUrl).toBe(result.prUrl)
    await expect.poll(() => updates.map((w) => w.prUrl)).toContain(result.prUrl)
  }, 30_000)

  it('refuses a protected branch before committing anything', async () => {
    const { origin, ws } = await workspaceWithOrigin('release')
    fs.writeFileSync(join(ws.path, 'hotfix.ts'), 'export const hotfix = true\n')

    await expect(
      client.request('workspace.createPr', { id: ws.id, title: 'Hotfix the release' })
    ).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('protected') })
    expect(gitIn(ws.path, 'status', '--porcelain')).toContain('hotfix.ts')
    expect(gitIn(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).toBe('main')
    expect(readFakeLog(daemon.ghLog)).toEqual([])
  }, 30_000)

  it('answers structured errors for nothing to push, a blank title, and an unknown id', async () => {
    const { ws } = await workspaceWithOrigin()

    await expect(
      client.request('workspace.createPr', { id: ws.id, title: 'Nothing here yet' })
    ).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('no commits') })
    await expect(
      client.request('workspace.createPr', { id: ws.id, title: '  ' })
    ).rejects.toMatchObject({ code: 'bad_request' })
    await expect(
      client.request('workspace.createPr', { id: 'ws_01hzx9nope00', title: 'Anything' })
    ).rejects.toMatchObject({ code: 'not_found' })
    expect((await client.request('workspace.get', { id: ws.id })).prUrl).toBeNull()
    expect(readFakeLog(daemon.ghLog)).toEqual([])
  }, 30_000)
})
