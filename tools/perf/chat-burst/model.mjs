// Node 준비·집계 도구와 테스트가 공유하는 순수 데이터 규칙. 서버 코드는 변경하지 않음
export const GROUPS = Object.freeze({ forbidden: 0.2, threshold: 0.2, cache: 0.3, llm: 0.3 });
export const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

export function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function normalizeBase(value) {
  const url = new URL(value);
  requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
    && !url.search && !url.hash, 'base-url에는 HTTP(S) API 주소만 지정하세요.');
  return url.href.replace(/\/+$/, '');
}

export function expectedCounts(total) {
  requireValue(Number.isInteger(total) && total >= 10 && total <= 1500 && total % 10 === 0,
    'total은 10~1500 사이의 10의 배수여야 합니다. 기본값은 1500입니다.');
  return Object.fromEntries(Object.entries(GROUPS).map(([group, ratio]) => [group, Math.round(total * ratio)]));
}

export function makePlan({ runId, baseUrl, questions, total = 1500 }) {
  requireValue(/^[a-z0-9][a-z0-9-]{2,35}$/.test(runId), 'run-id는 소문자·숫자·하이픈 3~36자로 지정하세요.');
  const expected = expectedCounts(total);
  const cases = [];
  for (const [group, count] of Object.entries(expected)) {
    const pool = questions[group];
    requireValue(Array.isArray(pool) && pool.length > 0, `${group} 질문이 필요합니다.`);
    requireValue(pool.every(q => typeof q === 'string' && q.trim().length > 0 && q.length <= 4000),
      `${group} 질문은 1~4000자 문자열이어야 합니다.`);
    for (let index = 0; index < count; index++) {
      cases.push({ group, question: pool[index % pool.length].trim() });
    }
  }
  // 특정 그룹이 대기열 앞을 독점하지 않도록 실행별로 재현 가능한 순서를 만듦
  let seed = [...runId].reduce((n, c) => (Math.imul(n, 31) + c.charCodeAt(0)) >>> 0, 17);
  for (let i = cases.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [cases[i], cases[j]] = [cases[j], cases[i]];
  }
  return { version: 1, runId, baseUrl: normalizeBase(baseUrl), expected, total,
    cases: cases.map((item, i) => ({ caseId: i + 1, ...item })) };
}

export function validatePlan(plan) {
  requireValue(plan.version === 1 && normalizeBase(plan.baseUrl) === plan.baseUrl, '지원하지 않는 plan입니다.');
  requireValue(/^[a-z0-9][a-z0-9-]{2,35}$/.test(plan.runId), '잘못된 run-id입니다.');
  const expected = expectedCounts(plan.total);
  requireValue(JSON.stringify(plan.expected) === JSON.stringify(expected), '예상 분포가 변경되었습니다.');
  requireValue(plan.cases.length === plan.total, 'plan의 요청 수가 일치하지 않습니다.');
  for (let i = 0; i < plan.cases.length; i++) {
    const item = plan.cases[i];
    requireValue(item.caseId === i + 1 && Object.hasOwn(expected, item.group)
      && typeof item.question === 'string' && item.question.trim().length > 0 && item.question.length <= 4000,
    'case 순서·그룹·질문이 올바르지 않습니다.');
  }
  for (const [group, count] of Object.entries(expected)) {
    requireValue(plan.cases.filter(c => c.group === group).length === count, `${group} 분포가 일치하지 않습니다.`);
  }
  return plan;
}

// 서명 검증을 대신하지 않음. 정상 로그인 응답의 USER 역할·소유자·만료 시각 점검용임
export function tokenClaims(token) {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    requireValue(claims.role === 'USER' && /^\d+$/.test(claims.sub)
      && Number.isSafeInteger(Number(claims.sub)) && Number(claims.sub) > 0
      && Number.isFinite(claims.exp), 'USER JWT가 아닙니다.');
    return { userId: Number(claims.sub), expiresAt: claims.exp * 1000 };
  } catch { throw new Error('로그인 응답에 올바른 USER JWT가 없습니다.'); }
}

export function validateCredentials(plan, credentials, minExpiry = 0) {
  requireValue(credentials.runId === plan.runId && credentials.baseUrl === plan.baseUrl
    && credentials.accounts.length === plan.total, '회원 정보가 plan과 일치하지 않습니다.');
  const owners = new Set();
  for (let i = 0; i < credentials.accounts.length; i++) {
    const account = credentials.accounts[i];
    const claims = tokenClaims(account.accessToken);
    requireValue(account.caseId === i + 1 && account.userId === claims.userId
      && !owners.has(claims.userId), '회원·토큰이 중복되거나 case와 일치하지 않습니다.');
    requireValue(claims.expiresAt >= minExpiry, 'JWT 유효 시간이 부족합니다. tokens 명령으로 다시 발급하세요.');
    owners.add(claims.userId);
  }
}

export function newEvidence() {
  return { attempts: new Map(), routes: new Map(), gates: new Map(), conflicts: new Set() };
}

export function addLogLine(evidence, line) {
  const mapping = line.match(/답변 작업을 접수했습니다: 작업ID=(\d+), 시도ID=(\d+)/);
  if (mapping) {
    const [, jobId, attemptId] = mapping;
    const old = evidence.attempts.get(jobId);
    if (old && old !== attemptId) evidence.conflicts.add(jobId);
    evidence.attempts.set(jobId, attemptId);
  }
  const route = line.match(/CHAT route: attemptId=(\d+), source=(OFFICIAL_FAQ|LLM)\b/);
  if (route) {
    const set = evidence.routes.get(route[1]) ?? new Set();
    set.add(route[2]);
    evidence.routes.set(route[1], set);
  }
  const search = line.match(/FAQ 유사도 검색을 완료했습니다: 시도ID=(\d+), 하위질문순번=(\d+)/);
  const rejected = line.match(/FAQ 유사도가 기준값 미만입니다: 시도ID=(\d+), 하위질문순번=(\d+), 최고유사도=([^,]+), 기준값=([^\s,]+)/);
  const match = rejected ?? search;
  if (match) {
    const gates = evidence.gates.get(match[1]) ?? new Map();
    gates.set(match[2], rejected
      ? { below: Number(match[3]) < Number(match[4]), score: Number(match[3]), minimum: Number(match[4]) }
      : { below: false });
    evidence.gates.set(match[1], gates);
  }
}

export function addDatabaseEvidence(evidence, rows) {
  requireValue(Array.isArray(rows), 'DB 증거는 JSON 배열이어야 합니다.');
  for (const row of rows) {
    requireValue(Number.isSafeInteger(row.jobId) && Number.isSafeInteger(row.attemptId), 'DB job/attempt ID가 올바르지 않습니다.');
    const jobId = String(row.jobId), attemptId = String(row.attemptId);
    if (evidence.attempts.has(jobId) && evidence.attempts.get(jobId) !== attemptId) evidence.conflicts.add(jobId);
    evidence.attempts.set(jobId, attemptId);
  }
}

export function classify(submission, job, evidence) {
  if (!submission) return 'not_sent';
  if (submission.httpStatus === 400 && submission.code === 'FW-003' && !submission.jobId) return 'forbidden';
  if (submission.httpStatus !== 202 || !Number.isSafeInteger(submission.jobId)) return 'submission_error';
  if (!job || !TERMINAL.has(job.status)) return 'unfinished';
  if (evidence.conflicts.has(String(submission.jobId))) return 'ambiguous_evidence';
  const attempt = evidence.attempts.get(String(submission.jobId));
  const routes = evidence.routes.get(attempt) ?? new Set();
  if (routes.size > 1) return 'ambiguous_evidence';
  if (job.status === 'SUCCEEDED') {
    if (routes.has('OFFICIAL_FAQ')) return 'cache';
    if (routes.has('LLM')) return 'llm';
    return 'unverified_success';
  }
  if (job.status === 'CANCELLED' || job.errorCode === 'CHAT-024') return 'cancelled';
  if (job.errorCode === 'CHAT-012') return 'no_faq';
  if (job.errorCode === 'CHAT-013' && routes.size === 0) {
    const gates = evidence.gates.get(attempt);
    if (gates?.size && [...gates.values()].every(g => g.below)) return 'threshold';
    return 'unverified_threshold';
  }
  return 'processing_error';
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * p) - 1];
}

export function aggregate(plan, submissions, jobs, evidence, maxStartSpreadMs = 1000) {
  validatePlan(plan);
  const byCase = new Map(), duplicateCases = [], invalidEvents = [];
  const seenJobs = new Set();
  for (const event of submissions) {
    if (event.runId !== plan.runId || !Number.isInteger(event.caseId) || event.caseId < 1 || event.caseId > plan.total) {
      invalidEvents.push(event.caseId ?? null);
      continue;
    }
    if (byCase.has(event.caseId)) duplicateCases.push(event.caseId);
    if (event.jobId && seenJobs.has(event.jobId)) invalidEvents.push(event.caseId);
    if (event.jobId) seenJobs.add(event.jobId);
    byCase.set(event.caseId, event);
  }
  const actual = Object.fromEntries(Object.keys(GROUPS).map(g => [g, 0]));
  const errors = {}, httpStatuses = {}, transportErrors = {}, rows = [], matrix = {};
  for (const item of plan.cases) {
    const submission = byCase.get(item.caseId);
    const job = jobs[String(submission?.jobId)];
    const outcome = classify(submission, job, evidence);
    if (submission) httpStatuses[submission.httpStatus] = (httpStatuses[submission.httpStatus] ?? 0) + 1;
    if (submission?.httpStatus === 0 && submission.transportErrorCode) {
      transportErrors[submission.transportErrorCode] = (transportErrors[submission.transportErrorCode] ?? 0) + 1;
    }
    actual[outcome] = (actual[outcome] ?? 0) + 1;
    const code = job?.errorCode ?? submission?.code;
    if (code && code !== 'SUCCESS') errors[code] = (errors[code] ?? 0) + 1;
    matrix[item.group] ??= {};
    matrix[item.group][outcome] = (matrix[item.group][outcome] ?? 0) + 1;
    rows.push({ caseId: item.caseId, expected: item.group, actual: outcome, matched: item.group === outcome,
      httpStatus: submission?.httpStatus ?? null, jobId: submission?.jobId ?? null, errorCode: job?.errorCode ?? null,
      submissionMs: submission?.elapsedMs ?? null,
      observedCompletionMs: job?.observedAt && submission ? job.observedAt - submission.startedAt : null });
  }
  const timestamps = submissions.map(s => s.startedAt).filter(Number.isFinite);
  const startSpreadMs = timestamps.length ? Math.max(...timestamps) - Math.min(...timestamps) : null;
  const durations = rows.map(r => r.submissionMs).filter(Number.isFinite);
  const mismatches = rows.filter(r => !r.matched).length;
  const validTiming = timestamps.length === plan.total && startSpreadMs <= maxStartSpreadMs;
  return { version: 1, runId: plan.runId, baseUrl: plan.baseUrl, expected: plan.expected, actual, errors, httpStatuses, transportErrors, matrix,
    total: plan.total, recorded: byCase.size, mismatches, duplicateCases, invalidEvents, startSpreadMs, maxStartSpreadMs,
    submissionP50Ms: percentile(durations, .5), submissionP95Ms: percentile(durations, .95),
    passed: mismatches === 0 && !duplicateCases.length && !invalidEvents.length && validTiming,
    timingNote: 'observedCompletionMs includes collector start delay and rate-limited polling; it is not server processing time.', rows };
}
