// Pure helpers behind the sidebar's filter and sort.
import type { Project, Workspace } from '../../preload/index.d'

export type SidebarSort = 'name' | 'activity'

/** Case-insensitive substring over any of the strings; a blank needle matches everything. */
export function matches(needle: string, ...haystack: (string | null | undefined)[]): boolean {
  const n = needle.trim().toLowerCase()
  if (n === '') return true
  return haystack.some((h) => h?.toLowerCase().includes(n))
}

export function filterSidebar(
  needle: string,
  projects: Project[],
  workspaces: Workspace[]
): { projects: Project[]; workspacesOf: (projectId: string) => Workspace[] } {
  const of = (id: string): Workspace[] => workspaces.filter((w) => w.projectId === id)
  const hits = (id: string): Workspace[] =>
    of(id).filter((w) => matches(needle, w.title, w.name, w.branch, w.brief))
  const kept = projects.filter((p) => matches(needle, p.name) || hits(p.id).length > 0)
  return {
    projects: kept,
    workspacesOf: (id) => {
      const p = projects.find((x) => x.id === id)
      return p && matches(needle, p.name) ? of(id) : hits(id)
    }
  }
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name)

function activityOf(w: Workspace): number {
  const t = Date.parse(w.lastActivityAt ?? w.statusAt)
  return Number.isNaN(t) ? 0 : t
}

/** Workspaces sort by what the sidebar shows: the title, else the name. */
const byLabel = (a: Workspace, b: Workspace): number =>
  (a.title ?? a.name).localeCompare(b.title ?? b.name)

export function sortWorkspaces(workspaces: Workspace[], sort: SidebarSort): Workspace[] {
  const out = [...workspaces]
  if (sort === 'name') return out.sort(byLabel)
  return out.sort((a, b) => activityOf(b) - activityOf(a) || byLabel(a, b))
}

export function sortProjects(
  projects: Project[],
  workspaces: Workspace[],
  sort: SidebarSort
): Project[] {
  const out = [...projects]
  if (sort === 'name') return out.sort(byName)
  const newest = (p: Project): number | null => {
    const own = workspaces.filter((w) => w.projectId === p.id).map(activityOf)
    return own.length === 0 ? null : Math.max(...own)
  }
  const at = new Map(out.map((p) => [p.id, newest(p)]))
  return out.sort((a, b) => {
    const x = at.get(a.id) ?? null
    const y = at.get(b.id) ?? null
    if (x === null && y !== null) return 1
    if (y === null && x !== null) return -1
    return (y ?? 0) - (x ?? 0) || byName(a, b)
  })
}
