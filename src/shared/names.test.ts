import { describe, expect, it } from 'vitest'
import { randomWorkspaceName, WORD_LISTS } from './names'
import { WORKSPACE_NAME_RE } from './slug'

/** A small deterministic rng (mulberry32) for seeded draws. */
function seeded(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('randomWorkspaceName', () => {
  it('is two different adjectives and a noun, a valid workspace name well under 48 characters', () => {
    const rng = seeded(1432)
    for (let i = 0; i < 500; i++) {
      const name = randomWorkspaceName(rng)
      const [a, b, noun] = name.split('-')

      expect(name).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/)
      expect(name).toMatch(WORKSPACE_NAME_RE)
      expect(name.length).toBeLessThanOrEqual(32)
      expect(WORD_LISTS.adjectives).toContain(a)
      expect(WORD_LISTS.adjectives).toContain(b)
      expect(a).not.toBe(b)
      expect(WORD_LISTS.nouns).toContain(noun)
    }
  })

  it('gives the same name for the same seed', () => {
    expect(randomWorkspaceName(seeded(7))).toBe(randomWorkspaceName(seeded(7)))
    expect(randomWorkspaceName(() => 0)).toBe('amber-bold-badger')
  })

  it('uses only lowercase letters in its word lists, without repeats', () => {
    for (const list of [WORD_LISTS.adjectives, WORD_LISTS.nouns]) {
      expect(list.length).toBeGreaterThanOrEqual(75)
      expect(new Set(list).size).toBe(list.length)
      for (const w of list) expect(w).toMatch(/^[a-z]+$/)
    }
  })
})
