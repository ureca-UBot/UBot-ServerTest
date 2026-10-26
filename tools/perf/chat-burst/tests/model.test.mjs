import test from 'node:test';
import assert from 'node:assert/strict';
import { makePlan, validatePlan, tokenClaims, validateCredentials, newEvidence, addLogLine,
  addDatabaseEvidence, classify, aggregate } from '../model.mjs';

const questions = { forbidden: ['금지어'], threshold: ['기준 미달'], cache: ['캐시'], llm: ['LLM'] };
const plan = () => makePlan({ runId: 'unit-test', baseUrl: 'http://localhost:8080/api/', questions });
const jwt = claims => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

test('1500건을 정확히 300/300/450/450으로 만들고 실행 순서를 재현한다', () => {
  const first = plan();
  assert.deepEqual(first.expected, { forbidden: 300, threshold: 300, cache: 450, llm: 450 });
  assert.deepEqual(first, plan());
  assert.equal(new Set(first.cases.map(c => c.caseId)).size, 1500);
  assert.ok(new Set(first.cases.slice(0, 20).map(c => c.group)).size > 1);
  assert.equal(first.baseUrl, 'http://localhost:8080/api');
  validatePlan(first);
});

test('틀린 분포·질문·URL·실행 이름을 요청 전에 거절한다', () => {
  const first = plan();
  first.cases[0].group = 'other';
  assert.throws(() => validatePlan(first));
  assert.throws(() => makePlan({ runId: 'bad_%', baseUrl: 'https://example.com', questions }));
  assert.throws(() => makePlan({ runId: 'valid-test', baseUrl: 'https://user:password@example.com', questions }));
  assert.throws(() => makePlan({ runId: 'valid-test', baseUrl: 'https://example.com', questions: { ...questions, cache: [] } }));
  assert.throws(() => makePlan({ runId: 'valid-test', baseUrl: 'https://example.com', questions, total: 1499 }));
});

test('회원마다 다른 USER JWT를 요구하고 만료된 토큰을 거절한다', () => {
  const first = makePlan({ runId: 'unit-test', baseUrl: 'http://localhost', questions, total: 10 });
  const credentials = { runId: first.runId, baseUrl: first.baseUrl, accounts: first.cases.map(c => ({
    caseId: c.caseId, userId: c.caseId, accessToken: jwt({ sub: String(c.caseId), role: 'USER', exp: 2000 }),
  })) };
  validateCredentials(first, credentials, 1000);
  assert.throws(() => validateCredentials(first, credentials, 2000001));
  credentials.accounts[1] = { ...credentials.accounts[0], caseId: 2 };
  assert.throws(() => validateCredentials(first, credentials));
  assert.throws(() => tokenClaims(jwt({ sub: '1', role: 'ADMIN', exp: 9999 })));
  assert.throws(() => tokenClaims('not-a-jwt'));
});

function mapped() {
  const evidence = newEvidence();
  addLogLine(evidence, 'backend | 답변 작업을 접수했습니다: 작업ID=10, 시도ID=20, 재시도횟수=1');
  return evidence;
}
const accepted = { httpStatus: 202, jobId: 10, code: 'SUCCESS' };

test('성공 응답만으로 캐시 또는 LLM이라고 추정하지 않는다', () => {
  const evidence = mapped();
  const job = { status: 'SUCCEEDED' };
  assert.equal(classify(accepted, job, evidence), 'unverified_success');
  addLogLine(evidence, 'worker | CHAT route: attemptId=20, source=OFFICIAL_FAQ, faqIds=[1]');
  assert.equal(classify(accepted, job, evidence), 'cache');
  addLogLine(evidence, 'worker | CHAT route: attemptId=20, source=LLM, faqIds=[1]');
  assert.equal(classify(accepted, job, evidence), 'ambiguous_evidence');
});

test('CHAT-013도 실제 기준 미달 판정이 있어야 threshold로 집계한다', () => {
  const evidence = mapped();
  const job = { status: 'FAILED', errorCode: 'CHAT-013' };
  assert.equal(classify(accepted, job, evidence), 'unverified_threshold');
  addLogLine(evidence, 'FAQ 유사도가 기준값 미만입니다: 시도ID=20, 하위질문순번=1, 최고유사도=0.3, 기준값=0.75');
  assert.equal(classify(accepted, job, evidence), 'threshold');
  // 재판정 후 같은 하위 질문의 검색이 다시 실행되면 이전 실패 로그만 보고 통과시키지 않음
  addLogLine(evidence, 'FAQ 유사도 검색을 완료했습니다: 시도ID=20, 하위질문순번=1, 최고유사도=0.9');
  assert.equal(classify(accepted, job, evidence), 'unverified_threshold');
  assert.equal(classify(accepted, { status: 'FAILED', errorCode: 'CHAT-012' }, evidence), 'no_faq');
  assert.equal(classify(accepted, { status: 'FAILED', errorCode: 'CHAT-016' }, evidence), 'processing_error');
});

test('금지어와 프록시 429·시간 초과·미완료를 구분한다', () => {
  const evidence = mapped();
  assert.equal(classify({ httpStatus: 400, code: 'FW-003', jobId: null }, null, evidence), 'forbidden');
  assert.equal(classify({ httpStatus: 429, code: 'RATE-001' }, null, evidence), 'submission_error');
  assert.equal(classify({ httpStatus: 0 }, null, evidence), 'submission_error');
  assert.equal(classify(accepted, { status: 'RUNNING' }, evidence), 'unfinished');
  assert.equal(classify(null, null, evidence), 'not_sent');
});

test('증거가 서로 모순되거나 DB ID가 잘못되면 성공 집계하지 않는다', () => {
  const evidence = mapped();
  addDatabaseEvidence(evidence, [{ jobId: 10, attemptId: 21 }]);
  assert.equal(classify(accepted, { status: 'SUCCEEDED' }, evidence), 'ambiguous_evidence');
  assert.throws(() => addDatabaseEvidence(evidence, [{ jobId: '10', attemptId: 21 }]));
});

test('누락·중복·다른 실행 이벤트와 느린 시작을 보고서에서 실패시킨다', () => {
  const first = plan();
  const event = { runId: first.runId, caseId: 1, httpStatus: 400, code: 'FW-003', startedAt: 1000, elapsedMs: 2 };
  const result = aggregate(first, [event, event, { ...event, runId: 'wrong-run' }], {}, newEvidence());
  assert.equal(result.passed, false);
  assert.deepEqual(result.duplicateCases, [1]);
  assert.equal(result.invalidEvents.length, 1);
  assert.equal(result.actual.not_sent, 1499);
});

test('전체 건수가 같아도 개별 경로가 다르거나 시작 범위가 넓으면 실패한다', () => {
  const first = makePlan({ runId: 'report-check', baseUrl: 'http://localhost', questions, total: 10 });
  const events = [], jobs = {}, evidence = newEvidence();
  for (const item of first.cases) {
    const id = item.caseId;
    events.push({ runId: first.runId, caseId: id, startedAt: 1000 + id, elapsedMs: 5,
      httpStatus: item.group === 'forbidden' ? 400 : 202,
      code: item.group === 'forbidden' ? 'FW-003' : 'SUCCESS', jobId: item.group === 'forbidden' ? null : id });
    if (item.group === 'forbidden') continue;
    addLogLine(evidence, `답변 작업을 접수했습니다: 작업ID=${id}, 시도ID=${id}`);
    jobs[id] = { status: item.group === 'threshold' ? 'FAILED' : 'SUCCEEDED',
      errorCode: item.group === 'threshold' ? 'CHAT-013' : null };
    if (item.group === 'threshold') addLogLine(evidence,
      `FAQ 유사도가 기준값 미만입니다: 시도ID=${id}, 하위질문순번=1, 최고유사도=0.3, 기준값=0.75`);
    else addLogLine(evidence, `CHAT route: attemptId=${id}, source=${item.group === 'cache' ? 'OFFICIAL_FAQ' : 'LLM'}`);
  }
  assert.equal(aggregate(first, events, jobs, evidence).passed, true);
  const delayed = events.map((e, index) => index === 9 ? { ...e, startedAt: 3000 } : e);
  const late = aggregate(first, delayed, jobs, evidence);
  assert.equal(late.mismatches, 0);
  assert.equal(late.passed, false);
  for (const item of first.cases.filter(c => ['cache', 'llm'].includes(c.group))) {
    evidence.routes.set(String(item.caseId), new Set([item.group === 'cache' ? 'LLM' : 'OFFICIAL_FAQ']));
  }
  const swapped = aggregate(first, events, jobs, evidence);
  assert.deepEqual(swapped.actual, first.expected);
  assert.equal(swapped.mismatches, 6);
  assert.equal(swapped.passed, false);
});
