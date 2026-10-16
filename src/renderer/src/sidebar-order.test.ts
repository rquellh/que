import { describe, expect, it } from 'vitest'
import { makeProject, makeWorkspace } from '@renderer/testing/fixtures'
import { filterSidebar, matches, sortProjects, sortWorkspaces } from './sidebar-order'

const alpha = makeProject({ id: 'p_a', name: 'alpha' })
const beta = makeProject({ id: 'p_b', name: 'Beta' })
const empty = makeProject({ id: 'p_c', name: 'charlie' })
const old = makeWorkspace({
  projectId: 'p_a',
  name: 'old-one',
  statusAt: '2026-10-01T00:00:00.000Z'
})
const fresh = makeWorkspace({
  projectId: 'p_b',
  name: 'fresh-one',
  branch: 'feature/zeta',
  statusAt: '2026-10-02T00:00:00.000Z',
  lastActivityAt: '2026-10-10T00:00:00.000Z'
})
const mid = makeWorkspace({
  projectId: 'p_b',
  name: 'mid-one',
  statusAt: '2026-10-05T00:00:00.000Z'
})

describe('matches', () => {
  it('is a case-insensitive substring over any string', () => {
    expect(matches('ETR', 'retry', null)).toBe(true)
    expect(matches('zz', 'retry', undefined, 'buzz')).toBe(true)
    expect(matches('zz', 'retry')).toBe(false)
  })

  it('matches everything for an empty or blank needle', () => {
    expect(matches('', 'x')).toBe(true)
    expect(matches('   ', undefined)).toBe(true)
  })
})

describe('filterSidebar', () => {
  const all = [old, fresh, mid]

  it('keeps a project whose workspace matches by name or branch, with only those workspaces', () => {
    const r = filterSidebar('zeta', [alpha, beta, empty], all)
    expect(r.projects).toEqual([beta])
    expect(r.workspacesOf('p_b')).toEqual([fresh])
  })

  it('keeps every workspace of a project whose name matches', () => {
    const r = filterSidebar('beta', [alpha, beta], all)
    expect(r.projects).toEqual([beta])
    expect(r.workspacesOf('p_b')).toEqual([fresh, mid])
  })

  it('matches a workspace by its title or its brief', () => {
    const briefed = makeWorkspace({
      projectId: 'p_a',
      name: 'speed-up-the-diff-view',
      title: 'Speed up the diff view',
      brief: 'Speed up the diff view\n\nVirtualize the file list past 500 files.'
    })

    expect(filterSidebar('diff VIEW', [alpha], [old, briefed]).workspacesOf('p_a')).toEqual([
      briefed
    ])
    expect(filterSidebar('virtualize', [alpha], [old, briefed]).workspacesOf('p_a')).toEqual([
      briefed
    ])
  })

  it('keeps everything for an empty needle', () => {
    const r = filterSidebar('', [alpha, beta, empty], all)
    expect(r.projects).toHaveLength(3)
    expect(r.workspacesOf('p_a')).toEqual([old])
  })
})

describe('sortWorkspaces', () => {
  it('sorts by name, ascending', () => {
    expect(sortWorkspaces([old, mid, fresh], 'name')).toEqual([fresh, mid, old])
  })

  it('sorts by lastActivityAt, else statusAt, newest first', () => {
    expect(sortWorkspaces([old, mid, fresh], 'activity')).toEqual([fresh, mid, old])
    const quiet = makeWorkspace({ name: 'aaa', statusAt: '2026-10-20T00:00:00.000Z' })
    expect(sortWorkspaces([fresh, quiet], 'activity')).toEqual([quiet, fresh])
  })

  it('sorts by the title when there is one, as the sidebar shows it', () => {
    const titled = makeWorkspace({ name: 'zz-fix-upload', title: 'Fix the upload retry' })
    expect(sortWorkspaces([old, titled, mid], 'name')).toEqual([titled, mid, old])
  })

  it('breaks ties by name and does not mutate its input', () => {
    const a = makeWorkspace({ name: 'a' })
    const b = makeWorkspace({ name: 'b' })
    const input = [b, a]
    expect(sortWorkspaces(input, 'activity')).toEqual([a, b])
    expect(input).toEqual([b, a])
  })
})

describe('sortProjects', () => {
  it('sorts by name, ignoring case', () => {
    expect(sortProjects([empty, beta, alpha], [], 'name').map((p) => p.name)).toEqual([
      'alpha',
      'Beta',
      'charlie'
    ])
  })

  it('sorts by the newest workspace, projects without workspaces last', () => {
    const ordered = sortProjects([empty, alpha, beta], [old, fresh, mid], 'activity')
    expect(ordered.map((p) => p.id)).toEqual(['p_b', 'p_a', 'p_c'])
  })
})
