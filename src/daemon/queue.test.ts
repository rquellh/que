import { describe, expect, it } from 'vitest'
import { detectWake } from './queue'

// The default task title (the brief's first line) is titleOf, tested in src/shared/brief.test.ts.

describe('detectWake', () => {
  it('sees a sleep when the wall clock ran more than two minutes ahead of the monotonic one', () => {
    const wall = Date.parse('2026-10-14T02:00:00.000Z')

    expect(detectWake(wall, 1_000, wall + 5_000, 6_000)).toBe(false)
    expect(detectWake(wall, 1_000, wall + 126_000, 6_000)).toBe(true)
    expect(detectWake(wall, 1_000, wall + 124_000, 5_000)).toBe(false)
  })
})
