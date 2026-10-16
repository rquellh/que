import { describe, expect, it } from 'vitest'
import { titleOf } from './brief'

describe('titleOf', () => {
  it("is the brief's first non-empty line, trimmed", () => {
    expect(titleOf('\n  Add retry logic to the uploader  \nUse exponential backoff.')).toBe(
      'Add retry logic to the uploader'
    )
  })

  it('is cut to 80 characters', () => {
    const title = titleOf(`Refactor ${'the upload queue '.repeat(10)}`)

    expect(title).toHaveLength(80)
    expect(title.endsWith('…')).toBe(true)
  })

  it('is empty for a blank brief', () => {
    expect(titleOf('  \n\n ')).toBe('')
  })
})
