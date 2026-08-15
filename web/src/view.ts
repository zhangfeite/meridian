import type { Claim, DerivedNumber, EvidenceRef, Memo, MeridianLang } from '@meridian/agent'
import type { UploadedDocument } from './upload-source.ts'

export const DISCLAIMER = '分析不是投资建议 · 分析不是投資建議 · Analysis is not investment advice.'

export interface HistoryItem {
  id: string
  question: string
  createdAt: string
  gatePassed: boolean
}

interface Labels {
  product: string
  strapline: string
  upload: string
  uploadHelp: string
  question: string
  questionPlaceholder: string
  language: string
  submit: string
  history: string
  noHistory: string
  back: string
  gatePassed: string
  gateRejected: string
  gateExplanation: string
  sources: string
  appendix: string
  derivations: string
  audit: string
  openQuestions: string
  evidence: string
  sourcePosition: string
}

const LABELS: Record<MeridianLang, Labels> = {
  'zh-CN': {
    product: 'Meridian 研究台',
    strapline: '把公告变成可核验的研究 memo',
    upload: '上传公告',
    uploadHelp: '拖放或选择多个 .txt、.md、.pdf 文件；每个文件不超过 10MB。文件只在本进程内处理。',
    question: '你想查清什么？',
    questionPlaceholder: '例如：法院目前是否已受理重整申请？请列出关键事实与风险。',
    language: 'memo 语言',
    submit: '生成 memo',
    history: '本次会话历史',
    noHistory: '还没有生成 memo。',
    back: '返回新建 memo',
    gatePassed: '验证通过',
    gateRejected: '验证拒绝',
    gateExplanation: '以下内容未通过发布 gate；拒绝原因和审计记录完整保留，不能视为已验证结论。',
    sources: '上传文档与原文位置',
    appendix: '数据附录',
    derivations: '派生链',
    audit: '审计记录',
    openQuestions: '待核问题',
    evidence: '出处原文',
    sourcePosition: '跳到上传文档对应段落',
  },
  'zh-TW': {
    product: 'Meridian 研究台',
    strapline: '把公告變成可核驗的研究 memo',
    upload: '上傳公告',
    uploadHelp: '拖放或選擇多個 .txt、.md、.pdf 檔案；每個檔案不超過 10MB。檔案只在本程序內處理。',
    question: '你想查清什麼？',
    questionPlaceholder: '例如：法院目前是否已受理重整申請？請列出關鍵事實與風險。',
    language: 'memo 語言',
    submit: '生成 memo',
    history: '本次工作階段記錄',
    noHistory: '尚未生成 memo。',
    back: '返回新增 memo',
    gatePassed: '驗證通過',
    gateRejected: '驗證拒絕',
    gateExplanation: '以下內容未通過發布 gate；拒絕原因與稽核記錄完整保留，不能視為已驗證結論。',
    sources: '上傳文件與原文位置',
    appendix: '數據附錄',
    derivations: '派生鏈',
    audit: '稽核記錄',
    openQuestions: '待核問題',
    evidence: '出處原文',
    sourcePosition: '跳到上傳文件對應段落',
  },
  en: {
    product: 'Meridian Research Desk',
    strapline: 'Turn disclosures into verifiable research memos',
    upload: 'Upload disclosures',
    uploadHelp: 'Drop or choose multiple .txt, .md, or .pdf files, up to 10MB each. Files stay in this process.',
    question: 'What do you need to establish?',
    questionPlaceholder: 'For example: Has the court accepted the petition? List the key facts and risks.',
    language: 'Memo language',
    submit: 'Generate memo',
    history: 'This session',
    noHistory: 'No memos yet.',
    back: 'Create another memo',
    gatePassed: 'Verification passed',
    gateRejected: 'Verification rejected',
    gateExplanation: 'This result did not pass the publication gate. Reasons and audit records remain visible; do not treat it as verified.',
    sources: 'Uploaded documents and source locations',
    appendix: 'Data appendix',
    derivations: 'Derivation chain',
    audit: 'Audit record',
    openQuestions: 'Open questions',
    evidence: 'Source passage',
    sourcePosition: 'Go to the matching passage in the upload',
  },
}

export function renderHomePage(history: HistoryItem[] = [], lang: MeridianLang = 'zh-CN'): string {
  const labels = LABELS[lang]
  const historyHtml = history.length
    ? `<ol class="history-list">${history
        .map(
          (item) =>
            `<li><a href="/memo/${encodeURIComponent(item.id)}">${escapeHtml(item.question)}</a><span class="history-meta ${
              item.gatePassed ? 'pass-text' : 'reject-text'
            }">${item.gatePassed ? labels.gatePassed : labels.gateRejected} · ${escapeHtml(formatDate(item.createdAt, lang))}</span></li>`,
        )
        .join('')}</ol>`
    : `<p class="muted">${labels.noHistory}</p>`

  return documentShell(
    labels.product,
    `<main class="home-shell">
      <header class="hero">
        <a class="wordmark" href="/" aria-label="Meridian home">MERIDIAN <span>/ LOCAL</span></a>
        <p class="eyebrow">EVIDENCE-FIRST RESEARCH</p>
        <h1>${labels.strapline}</h1>
        <p class="lead">上传 → 提问 → 阅读每一句都能回到原文的结论。</p>
      </header>
      <section class="ask-card" aria-labelledby="upload-title">
        <form action="/ask" method="post" enctype="multipart/form-data" id="ask-form">
          <div class="step-row"><span>01</span><div><h2 id="upload-title">${labels.upload}</h2><p>${labels.uploadHelp}</p></div></div>
          <label class="drop-zone" id="drop-zone">
            <input id="files" name="files" type="file" accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf" multiple required>
            <span class="drop-title">拖入公告文件</span><span class="drop-subtitle">或点击选择文件</span>
          </label>
          <ul id="file-list" class="file-list" aria-live="polite"></ul>
          <div class="step-row question-step"><span>02</span><div><label for="question"><h2>${labels.question}</h2></label></div></div>
          <textarea id="question" name="question" rows="5" maxlength="4000" placeholder="${escapeHtml(labels.questionPlaceholder)}" required></textarea>
          <div class="form-footer">
            <label for="lang">${labels.language}
              <select id="lang" name="lang">
                <option value="zh-CN"${lang === 'zh-CN' ? ' selected' : ''}>简体中文</option>
                <option value="zh-TW"${lang === 'zh-TW' ? ' selected' : ''}>繁體中文</option>
                <option value="en"${lang === 'en' ? ' selected' : ''}>English</option>
              </select>
            </label>
            <button type="submit" id="submit-button">${labels.submit}<span aria-hidden="true">→</span></button>
          </div>
          <p class="working" id="working" hidden>正在逐步检索、核验与组装 memo，请勿关闭页面…</p>
        </form>
      </section>
      <section class="history" aria-labelledby="history-title"><h2 id="history-title">${labels.history}</h2>${historyHtml}</section>
    </main>`,
    lang,
  )
}

export function renderMemoPage(memo: Memo, documents: readonly UploadedDocument[], memoId: string): string {
  const labels = LABELS[memo.lang]
  const claimById = new Map(memo.claims.map((claim) => [claim.id, claim]))
  const evidenceById = new Map(memo.evidence.map((evidence) => [evidence.id, evidence]))
  const sourceNames = new Map(documents.map((document) => [document.id, document.filename]))
  const narrative = memo.narrative
    .map((block) => {
      const paragraphs = block.paragraphs
        .map((paragraph) => {
          const evidenceIds = unique(
            paragraph.claimIds.flatMap((claimId) => claimById.get(claimId)?.evidenceIds ?? []),
          )
          return `<article class="narrative-paragraph"><p>${escapeHtml(paragraph.text)}</p>${renderEvidenceGroup(
            evidenceIds,
            evidenceById,
            sourceNames,
            labels,
          )}</article>`
        })
        .join('')
      return `<section class="memo-section ${block.kind}" aria-labelledby="block-${escapeAttribute(block.kind)}"><p class="section-kicker">${escapeHtml(
        block.kind.toUpperCase(),
      )}</p><h2 id="block-${escapeAttribute(block.kind)}">${escapeHtml(block.heading)}</h2>${paragraphs || '<p class="muted">—</p>'}</section>`
    })
    .join('')

  const gate = renderGate(memo, labels)
  const openQuestions = memo.openQuestions.length
    ? `<section class="memo-section"><h2>${labels.openQuestions}</h2><ul>${memo.openQuestions
        .map((question) => `<li>${escapeHtml(question)}</li>`)
        .join('')}</ul></section>`
    : ''
  const claims = memo.sections
    .map((section) => {
      const items = section.claimIds
        .map((claimId) => claimById.get(claimId))
        .filter((claim): claim is Claim => Boolean(claim))
        .map((claim) => renderClaim(claim, evidenceById, sourceNames, labels))
        .join('')
      return items ? `<section class="claim-group"><h3>${escapeHtml(section.heading)}</h3>${items}</section>` : ''
    })
    .join('')
  const unsectioned = memo.claims
    .filter((claim) => !memo.sections.some((section) => section.claimIds.includes(claim.id)))
    .map((claim) => renderClaim(claim, evidenceById, sourceNames, labels))
    .join('')
  const derivations = memo.derived.length
    ? `<section class="appendix-section"><h3>${labels.derivations}</h3>${memo.derived
        .map((item) => renderDerivation(item, new Map(memo.derived.map((entry) => [entry.id, entry])), evidenceById, new Set()))
        .join('')}</section>`
    : ''
  const sources = renderSourcePassages(documents, memo.evidence, labels)
  const audit = `<section class="appendix-section"><h3>${labels.audit}</h3>${
    memo.audit.length
      ? `<ol class="audit-list">${memo.audit
          .map(
            (record) =>
              `<li><code>${escapeHtml(record.step)} / ${escapeHtml(record.action)}</code><p>${escapeHtml(record.detail)}</p></li>`,
          )
          .join('')}</ol>`
      : '<p class="muted">No interventions recorded.</p>'
  }</section>`

  return documentShell(
    `${memo.entity.name} — Meridian`,
    `<main class="memo-shell">
      <nav class="memo-nav"><a class="wordmark" href="/">MERIDIAN <span>/ LOCAL</span></a><a class="back-link" href="/">← ${labels.back}</a></nav>
      <header class="memo-header"><p class="eyebrow">VERIFIED RESEARCH MEMO</p><h1>${escapeHtml(memo.entity.name)}</h1><p class="memo-question">${escapeHtml(
        memo.question,
      )}</p><div class="memo-meta"><span>${escapeHtml(formatDate(memo.generatedAt, memo.lang))}</span><span>${escapeHtml(
        memo.provenance.model,
      )}</span><span>ID ${escapeHtml(memoId)}</span></div></header>
      ${gate}
      <div class="memo-grid"><div class="memo-main">${narrative || '<section class="memo-section"><p class="muted">没有形成可发布的正文。</p></section>'}${openQuestions}</div>
      <aside class="memo-aside"><p>TRACE</p><dl><dt>Pipeline</dt><dd>${escapeHtml(memo.provenance.pipeline)}</dd><dt>Data</dt><dd>${escapeHtml(
        memo.provenance.dataSource,
      )}</dd><dt>Gate</dt><dd class="${memo.gate.passed ? 'pass-text' : 'reject-text'}">${
        memo.gate.passed ? labels.gatePassed : labels.gateRejected
      }</dd></dl></aside></div>
      <section class="appendix"><p class="section-kicker">TRACEABLE DATA</p><h2>${labels.appendix}</h2>${derivations}<section class="appendix-section"><h3>Claims</h3>${
        claims + unsectioned || '<p class="muted">No claims survived verification.</p>'
      }</section>${sources}${audit}</section>
    </main>`,
    memo.lang,
  )
}

export function renderErrorPage(title: string, message: string, status: number, lang: MeridianLang = 'zh-CN'): string {
  return documentShell(
    `${title} — Meridian`,
    `<main class="error-shell"><a class="wordmark" href="/">MERIDIAN <span>/ LOCAL</span></a><p class="error-code">${status}</p><h1>${escapeHtml(
      title,
    )}</h1><p>${escapeHtml(message)}</p><a class="button-link" href="/">← 返回重新尝试</a></main>`,
    lang,
  )
}

function renderGate(memo: Memo, labels: Labels): string {
  if (memo.gate.passed) {
    return `<section class="gate-banner gate-pass"><span class="gate-dot"></span><div><strong>${labels.gatePassed}</strong><p>引用、数字与内容契约均通过发布检查。</p></div></section>`
  }
  const reasons = [
    ...memo.gate.contractViolations.map((item) => `${item.code}: ${item.message}`),
    ...memo.gate.complianceHits.map((item) => `${item.rule}: ${item.match}`),
    ...memo.gate.numberViolations.map((item) => `${item.display}: ${item.reason}`),
  ]
  return `<section class="gate-banner gate-reject"><span class="gate-dot"></span><div><strong>${labels.gateRejected}</strong><p>${labels.gateExplanation}</p>${
    reasons.length ? `<ul>${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>` : ''
  }</div></section>`
}

function renderClaim(
  claim: Claim,
  evidenceById: Map<string, EvidenceRef>,
  sourceNames: Map<string, string>,
  labels: Labels,
): string {
  const qualifiers: string[] = [`type: ${claim.type}`]
  if (claim.type === 'model_inference') {
    qualifiers.push(`confidence: ${claim.confidence}`, `period: ${claim.timeRange}`)
    qualifiers.push(`assumptions: ${claim.assumptions.join(' · ')}`)
    qualifiers.push(`counter-evidence: ${claim.counterEvidence.note}`)
  } else if (claim.type === 'scenario') {
    qualifiers.push(`triggers: ${claim.triggers.join(' · ')}`)
  } else if (claim.type === 'attributed_opinion') {
    qualifiers.push(`attribution: ${claim.attribution}`)
  } else if (claim.unverifiable) {
    qualifiers.push('unverifiable')
  }
  return `<article class="claim" id="claim-${escapeAttribute(claim.id)}"><div class="claim-id">${escapeHtml(
    claim.id,
  )}</div><div><p>${escapeHtml(claim.text)}</p><p class="claim-meta">${qualifiers.map(escapeHtml).join(' · ')}</p>${renderEvidenceGroup(
    claim.evidenceIds,
    evidenceById,
    sourceNames,
    labels,
  )}</div></article>`
}

function renderEvidenceGroup(
  evidenceIds: string[],
  evidenceById: Map<string, EvidenceRef>,
  sourceNames: Map<string, string>,
  labels: Labels,
): string {
  return evidenceIds
    .map((id) => evidenceById.get(id))
    .filter((evidence): evidence is EvidenceRef => Boolean(evidence))
    .map(
      (evidence) => `<details class="citation"><summary>${labels.evidence} <b>[${escapeHtml(evidence.id)}]</b> · ${escapeHtml(
        sourceNames.get(evidence.documentId) ?? evidence.sourceLabel,
      )}</summary><blockquote>${escapeHtml(evidence.quote)}</blockquote><a href="#evidence-location-${escapeAttribute(
        evidence.id,
      )}">${labels.sourcePosition} ↘</a></details>`,
    )
    .join('')
}

function renderDerivation(
  item: DerivedNumber,
  byId: Map<string, DerivedNumber>,
  evidenceById: Map<string, EvidenceRef>,
  parents: Set<string>,
): string {
  if (parents.has(item.id)) return `<p class="reject-text">Cycle detected at ${escapeHtml(item.id)}</p>`
  const nextParents = new Set(parents).add(item.id)
  const inputs = item.inputs
    .map((input) => {
      if (input.derivedId) {
        const dependency = byId.get(input.derivedId)
        return `<li><span>${escapeHtml(input.display)}</span>${dependency ? renderDerivation(dependency, byId, evidenceById, nextParents) : ''}</li>`
      }
      const evidence = input.evidenceId ? evidenceById.get(input.evidenceId) : undefined
      return `<li><span>${escapeHtml(input.display)}${evidence ? ` ← <a href="#evidence-location-${escapeAttribute(evidence.id)}">[${escapeHtml(evidence.id)}]</a>` : ''}</span></li>`
    })
    .join('')
  return `<details class="derivation" open><summary><b>[${escapeHtml(item.id)}] ${escapeHtml(item.label)}</b> = ${escapeHtml(
    item.display,
  )}</summary><div><code>${escapeHtml(item.formula)}</code><p>op: ${escapeHtml(item.op)} · unit: ${escapeHtml(
    item.unit,
  )} · tolerance: ${escapeHtml(item.tolerance)} · uncertainty: ${escapeHtml(item.uncertainty)}</p><ol>${inputs}</ol></div></details>`
}

function renderSourcePassages(
  documents: readonly UploadedDocument[],
  evidence: EvidenceRef[],
  labels: Labels,
): string {
  const documentById = new Map(documents.map((document) => [document.id, document]))
  const passages = evidence
    .map((item) => {
      const document = documentById.get(item.documentId)
      const paragraph = document ? locateParagraph(document.text, item) : item.quote
      return `<article class="source-passage" id="evidence-location-${escapeAttribute(item.id)}"><div class="source-label"><b>[${escapeHtml(
        item.id,
      )}]</b><span>${escapeHtml(document?.filename ?? item.sourceLabel)}</span><span>char ${escapeHtml(String(item.charStart))}</span></div><p>${highlightQuote(
        paragraph,
        item.quote,
      )}</p></article>`
    })
    .join('')
  return `<section class="appendix-section source-section"><h3>${labels.sources}</h3>${
    passages || '<p class="muted">No cited passages.</p>'
  }</section>`
}

function locateParagraph(text: string, evidence: EvidenceRef): string {
  const start = evidence.charStart >= 0 ? evidence.charStart : text.indexOf(evidence.quote)
  if (start < 0) return evidence.quote
  const leftBreak = Math.max(text.lastIndexOf('\n', start - 1), start - 500)
  const quoteEnd = start + evidence.quote.length
  const nextBreak = text.indexOf('\n', quoteEnd)
  const rightBreak = Math.min(nextBreak < 0 ? text.length : nextBreak, quoteEnd + 500)
  return text.slice(Math.max(0, leftBreak + 1), rightBreak).trim()
}

function highlightQuote(paragraph: string, quote: string): string {
  const index = paragraph.indexOf(quote)
  if (index < 0) return escapeHtml(paragraph)
  return `${escapeHtml(paragraph.slice(0, index))}<mark>${escapeHtml(quote)}</mark>${escapeHtml(
    paragraph.slice(index + quote.length),
  )}`
}

function documentShell(title: string, body: string, lang: MeridianLang): string {
  return `<!doctype html><html lang="${escapeAttribute(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(
    title,
  )}</title><link rel="stylesheet" href="/assets/app.css"></head><body>${body}<footer class="legal-footer">${DISCLAIMER}</footer><script src="/assets/app.js" defer></script></body></html>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
    return entities[character] ?? character
  })
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/[^a-zA-Z0-9_.:-]/g, '-')
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function formatDate(value: string, lang: MeridianLang): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
