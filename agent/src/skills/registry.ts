/**
 * Loading and matching analysis skills.
 *
 * Matching is deliberately dumb: keyword scoring over the question and the
 * retrieved documents, with a declared fallback when nothing scores. A cleverer
 * matcher would be a second model call to decide which prompt to use, which is
 * both slower and less predictable than the recipe it selects — and a memo whose
 * method changes for reasons the reader cannot see is worse than one that always
 * uses the general recipe.
 *
 * @module @meridian/agent/skills/registry
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SKILL_LIMITS, validateSkill, type Skill, type SkillValidationError } from './types.ts'

/** Why a skill was selected. */
export type SkillSelection = 'explicit' | 'matched' | 'fallback'

/** The chosen recipe and how it was chosen. */
export interface SkillChoice {
  skill: Skill
  selection: SkillSelection
  /** Keyword score at selection time; 0 for a fallback. */
  score: number
}

/** Thrown when a caller names a skill that is not installed. */
export class UnknownSkillError extends Error {
  readonly skillId: string
  readonly available: string[]

  constructor(skillId: string, available: string[]) {
    super(
      `unknown skill '${skillId}'. Installed: ${available.join(', ') || '(none)'}`,
    )
    this.name = 'UnknownSkillError'
    this.skillId = skillId
    this.available = available
  }
}

/** A loaded set of skills. */
export class SkillRegistry {
  readonly skills: Skill[]
  readonly errors: SkillValidationError[]

  constructor(skills: Skill[], errors: SkillValidationError[] = []) {
    this.skills = skills
    this.errors = errors
  }

  /**
   * Load every `<dir>/<id>/skill.json`.
   *
   * Invalid files are collected rather than thrown: one malformed recipe should
   * not take the whole pipeline down, and the errors are reported.
   *
   * @param directory - the `meridian/skills` root.
   * @returns the registry, empty when the directory does not exist.
   */
  static load(directory: string): SkillRegistry {
    let entries: string[]
    try {
      entries = readdirSync(directory).sort()
    } catch {
      return new SkillRegistry([])
    }
    const skills: Skill[] = []
    const errors: SkillValidationError[] = []
    for (const entry of entries) {
      const file = join(directory, entry, 'skill.json')
      let size: number
      try {
        const stat = statSync(file)
        if (!stat.isFile()) continue
        size = stat.size
      } catch {
        continue
      }
      // Read the size before the bytes: a recipe is a page of guidance, and
      // anything larger is either a mistake or bulk text aimed at a prompt.
      if (size > SKILL_LIMITS.fileBytes) {
        errors.push({
          skillId: entry,
          field: '.',
          message: `skill file is ${size} bytes, over the limit of ${SKILL_LIMITS.fileBytes}`,
        })
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
      } catch (error) {
        errors.push({
          skillId: entry,
          field: '.',
          message: `unreadable skill file: ${error instanceof Error ? error.message : String(error)}`,
        })
        continue
      }
      const result = validateSkill(parsed, entry)
      errors.push(...result.errors)
      if (!result.skill) continue
      if (skills.some((skill) => skill.id === result.skill?.id)) {
        errors.push({ skillId: entry, field: 'id', message: `duplicate skill id '${result.skill.id}'` })
        continue
      }
      if (result.skill.fallback && skills.some((skill) => skill.fallback)) {
        errors.push({
          skillId: entry,
          field: 'fallback',
          message: 'a second catch-all recipe: matching would have no defined behaviour on a miss',
        })
        continue
      }
      skills.push(result.skill)
    }
    return new SkillRegistry(skills, errors)
  }

  /** The declared catch-all recipe, if the registry has one. */
  get fallback(): Skill | undefined {
    return this.skills.find((skill) => skill.fallback)
  }

  /** Look one up by id. */
  find(id: string): Skill | undefined {
    return this.skills.find((skill) => skill.id === id)
  }

  /**
   * Choose the recipe for a run.
   *
   * @param question - the user's question.
   * @param documentText - the retrieved documents' text, concatenated.
   * @param explicitId - a caller-specified skill id, which always wins.
   * @returns the choice, or `undefined` when the registry is empty.
   */
  select(question: string, documentText: string, explicitId?: string): SkillChoice | undefined {
    if (explicitId) {
      const skill = this.find(explicitId)
      if (!skill) throw new UnknownSkillError(explicitId, this.skills.map((item) => item.id))
      return { skill, selection: 'explicit', score: 0 }
    }
    let best: SkillChoice | undefined
    for (const skill of this.skills) {
      if (skill.fallback) continue
      // A question keyword is worth more than a document keyword: the filing may
      // mention buybacks in passing, but the reader asking about one is decisive.
      const questionHits = (skill.match.question_keywords ?? []).filter((word) =>
        question.includes(word),
      ).length
      const documentHits = (skill.match.doc_keywords ?? []).filter((word) =>
        documentText.includes(word),
      ).length
      // The question decides. Document titles are untrusted input — a filing can
      // say anything, including words that would steer analysis of it — so a
      // title alone may raise a recipe's score but never select it.
      if (questionHits === 0) continue
      const score = questionHits * 2 + documentHits
      if (!best || score > best.score) {
        best = { skill, selection: 'matched', score }
      }
    }
    if (best) return best
    const fallback = this.fallback
    return fallback ? { skill: fallback, selection: 'fallback', score: 0 } : undefined
  }
}
