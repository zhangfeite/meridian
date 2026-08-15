/**
 * Skills: declarative analysis recipes for the seven-step pipeline.
 *
 * A skill is **not** a plugin. It runs no code and cannot reach the model — it
 * is a JSON recipe that constrains and enriches what the pipeline already does:
 * which sub-questions must be asked, which figures must be computed rather than
 * quoted, which risks must land somewhere in the memo, and which phrasings the
 * compliance gate must additionally refuse for this kind of filing.
 *
 * That boundary is the point. A skill can make the pipeline ask more and check
 * more; it can never make it assert more. Everything a skill contributes still
 * goes through quote location, number binding, counter-evidence, and the gate.
 *
 * **The red line** (CONTRIBUTING, honest-benchmark clause): a skill is a
 * *generic recipe*. It must not contain anything that points at a specific
 * benchmark task's answer — no gold figures, no verbatim gold phrasing.
 * `test/skills.test.ts` enforces both mechanically: skill content carries no
 * digits at all, and shares no long run of text with any `gold.json`.
 *
 * @module @meridian/agent/skills/types
 */

import type { MeridianLang } from '../contract.ts'

import { writtenNumerals } from '../verify/numbers.ts'

/** How a skill decides a question and a set of filings are its business. */
export interface SkillMatch {
  /** Terms expected in the documents themselves. */
  doc_keywords?: string[]
  /** Terms expected in the user's question. */
  question_keywords?: string[]
}

/** A figure this skill expects the pipeline to compute rather than quote. */
export interface RequiredDerivation {
  name: string
  /** Plain-language shape of the calculation, e.g. `回购总金额 / 回购总数量`. */
  formula_hint: string
}

/** One analysis recipe. */
export interface Skill {
  id: string
  version: string
  /** The catch-all recipe, used when nothing else matches. Exactly one may set it. */
  fallback?: boolean
  match: SkillMatch
  /**
   * Sub-questions the research plan must cover.
   *
   * Neutral phrasing is a hard rule, learned the expensive way: a question that
   * names one outcome ("是否已受理") biases extraction toward it, and the
   * question text is published as the memo's own section heading, where a
   * presumed state reads as an assertion.
   */
  sub_questions: string[]
  /**
   * The same sub-questions in every output language.
   *
   * A recipe is data, and a recipe that exists in one language only is data the
   * pipeline has to guess at. When the questions arrived in 简体 and the run was
   * English, the model produced its own English versions and the pipeline —
   * comparing lexically — could not see that they were the same questions, so it
   * added the Chinese ones back: one memo, every question asked twice, and after
   * WP-M9-RGAP every residual sentence printed twice too.
   *
   * Translating at runtime would work as well, but it puts a model call between
   * the recipe file and what the memo asks, and a recipe you cannot read off the
   * page is no longer auditable. Three lists in the file, checked at load.
   */
  sub_questions_by_lang: Record<MeridianLang, string[]>
  required_derivations: RequiredDerivation[]
  /** Each item must land somewhere in the memo, or be recorded as unmet. */
  risk_checklist: string[]
  /** Inference topics whose counter-evidence the memo should actively seek. */
  counterevidence_slots: string[]
  /** Statement kinds this filing type routinely presents as fact. */
  attribution_flags: string[]
  /** Extra forbidden phrases, added to the global compliance rules. */
  forbidden_reinforce: string[]
}

/** One problem found while validating a skill file. */
export interface SkillValidationError {
  skillId: string
  field: string
  message: string
}

/**
 * Phrasings that presume an outcome.
 *
 * A sub-question is a question. 「是否已受理」 has already decided which answer
 * is the interesting one; 「目前处于哪个阶段」 has not.
 *
 * Narrow on purpose: the harmful form is the yes/no about one named outcome,
 * not any mention of completion. 「已经完成哪些程序」 enumerates and presumes
 * nothing — an earlier, broader version of this pattern rejected it, which is
 * how the rule got calibrated.
 */
const PRESUMPTIVE =
  /(是否(已|將|将|会|會)?(受理|进入|進入|完成|获批|獲批|批准|通过|通過|确定|確定)|是否已|將會|将会|必然|肯定会|肯定會|注定)/

/**
 * Scale limits.
 *
 * A recipe is a page of guidance. Anything larger is either a mistake or an
 * attempt to push bulk text through a channel that ends up in a model prompt.
 */
export const SKILL_LIMITS = {
  fileBytes: 64 * 1024,
  itemsPerField: 40,
  charsPerItem: 400,
  keywordsPerField: 40,
} as const

/** Fields whose text must stay free of digits and of benchmark phrasing. */
const CONTENT_FIELDS = [
  'sub_questions',
  'risk_checklist',
  'counterevidence_slots',
  'attribution_flags',
  'forbidden_reinforce',
] as const

/**
 * Validate one parsed skill file.
 *
 * @param value - parsed JSON.
 * @param source - path or id used in error messages.
 * @returns the skill when valid, plus every problem found.
 */
export function validateSkill(
  value: unknown,
  source: string,
): { skill?: Skill; errors: SkillValidationError[] } {
  const errors: SkillValidationError[] = []
  const fail = (field: string, message: string): void => {
    errors.push({ skillId: source, field, message })
  }
  if (!value || typeof value !== 'object') {
    fail('.', 'skill file must contain a JSON object')
    return { errors }
  }
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id : ''
  const version = typeof raw.version === 'string' ? raw.version : ''
  if (!id.trim()) fail('id', 'skill needs an id')
  if (!version.trim()) fail('version', 'skill needs a version')

  const stringArray = (field: string): string[] => {
    const items = raw[field]
    if (items === undefined) return []
    if (!Array.isArray(items) || items.some((item) => typeof item !== 'string')) {
      fail(field, 'must be an array of strings')
      return []
    }
    if (items.length > SKILL_LIMITS.itemsPerField) {
      fail(field, `has ${items.length} entries, over the limit of ${SKILL_LIMITS.itemsPerField}`)
      return []
    }
    const values = (items as string[]).map((item) => item.trim()).filter(Boolean)
    for (const value of values) {
      if (value.length > SKILL_LIMITS.charsPerItem) {
        fail(field, `an entry is ${value.length} characters, over the limit of ${SKILL_LIMITS.charsPerItem}`)
      }
    }
    return values
  }

  const subQuestions = stringArray('sub_questions')
  if (subQuestions.length === 0) fail('sub_questions', 'a skill must contribute at least one sub-question')

  // Every locale, same questions, same count. A missing translation is not a
  // cosmetic gap: the run falls back to asking in the wrong language, which is
  // exactly the duplication this field exists to remove.
  const byLang: Record<MeridianLang, string[]> = {
    'zh-CN': subQuestions,
    'zh-TW': stringArray('sub_questions_zh_TW'),
    en: stringArray('sub_questions_en'),
  }
  for (const lang of ['zh-TW', 'en'] as const) {
    const field = lang === 'zh-TW' ? 'sub_questions_zh_TW' : 'sub_questions_en'
    if (byLang[lang].length === 0) {
      fail(field, `a skill must carry its sub-questions in every output language; ${lang} is missing`)
    } else if (byLang[lang].length !== subQuestions.length) {
      fail(
        field,
        `has ${byLang[lang].length} entries where sub_questions has ${subQuestions.length}; the lists must be the same questions`,
      )
    }
  }
  for (const [lang, questions] of Object.entries(byLang)) {
    for (const question of questions) {
      if (PRESUMPTIVE.test(question)) {
        fail(
          'sub_questions',
          `[${lang}] presumes an outcome, which biases extraction and reads as an assertion in the heading: ${question}`,
        )
      }
    }
  }

  const derivations: RequiredDerivation[] = []
  if (raw.required_derivations !== undefined) {
    if (!Array.isArray(raw.required_derivations)) {
      fail('required_derivations', 'must be an array')
    } else {
      for (const item of raw.required_derivations as unknown[]) {
        const entry = item as Record<string, unknown>
        if (typeof entry?.name !== 'string' || typeof entry?.formula_hint !== 'string') {
          fail('required_derivations', 'each entry needs name and formula_hint')
          continue
        }
        derivations.push({ name: entry.name.trim(), formula_hint: entry.formula_hint.trim() })
      }
    }
  }

  const matchValue = raw.match ?? {}
  if (typeof matchValue !== 'object' || matchValue === null || Array.isArray(matchValue)) {
    fail('match', 'must be an object with keyword arrays')
  }
  const match = (typeof matchValue === 'object' && matchValue !== null && !Array.isArray(matchValue)
    ? matchValue
    : {}) as Record<string, unknown>
  const keywords = (field: 'doc_keywords' | 'question_keywords'): string[] => {
    const items = match[field]
    if (items === undefined) return []
    if (!Array.isArray(items) || items.some((item) => typeof item !== 'string')) {
      fail(`match.${field}`, 'must be an array of strings')
      return []
    }
    if (items.length > SKILL_LIMITS.keywordsPerField) {
      fail(`match.${field}`, `has ${items.length} keywords, over the limit of ${SKILL_LIMITS.keywordsPerField}`)
      return []
    }
    return (items as string[]).map((item) => item.trim()).filter(Boolean)
  }

  // A number anywhere in the recipe is the tell that a specific filing's figures
  // have leaked into what is supposed to be a reusable method. Checked with the
  // shared detector, not `/\d/`: 「３６１」, 「一千零五十万元」 and 「百分之五」
  // all state quantities that an ASCII-digit scan waves through.
  const numeralCheck = (field: string, text: string): void => {
    const found = writtenNumerals(text)
    if (found.length > 0) {
      fail(field, `a recipe states no figures (found ${found.join(', ')}): ${text}`)
    }
  }
  for (const field of CONTENT_FIELDS) {
    for (const text of stringArray(field)) numeralCheck(field, text)
  }
  for (const entry of derivations) {
    numeralCheck('required_derivations', entry.name)
    numeralCheck('required_derivations', entry.formula_hint)
  }
  for (const field of ['doc_keywords', 'question_keywords'] as const) {
    for (const text of keywords(field)) numeralCheck(`match.${field}`, text)
  }

  if (errors.length > 0) return { errors }
  return {
    skill: {
      id,
      version,
      ...(raw.fallback === true ? { fallback: true } : {}),
      match: {
        ...(keywords('doc_keywords').length > 0 ? { doc_keywords: keywords('doc_keywords') } : {}),
        ...(keywords('question_keywords').length > 0
          ? { question_keywords: keywords('question_keywords') }
          : {}),
      },
      sub_questions: subQuestions,
      sub_questions_by_lang: byLang,
      required_derivations: derivations,
      risk_checklist: stringArray('risk_checklist'),
      counterevidence_slots: stringArray('counterevidence_slots'),
      attribution_flags: stringArray('attribution_flags'),
      forbidden_reinforce: stringArray('forbidden_reinforce'),
    },
    errors,
  }
}
