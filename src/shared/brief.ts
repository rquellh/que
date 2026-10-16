// A brief is free text describing the work; its first line is the title. It is
// written verbatim to `<worktree>/.que/brief.md` and, by default, is the first
// prompt claude starts on.

/** The brief's first non-empty line, trimmed, at most 80 characters. */
export function titleOf(brief: string): string {
  const first = brief.split('\n').find((l) => l.trim() !== '') ?? ''
  const line = first.trim()
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line
}

/** Offered in Settings when the user turns on a start prompt instead of the brief. */
export const SUGGESTED_START_PROMPT =
  'Read .que/brief.md. Restate the goal, read the relevant code, and propose a plan before editing anything.'
