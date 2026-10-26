import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarize, latency } from './model.mjs';

const submissions = [{ jobId: 1, userId: 7 }, { jobId: 2, userId: 8 }];
const row = (id, status, errorCode = null) => ({ jobId: id, userId: id + 6, status, errorCode,
  finishedAtMs: 100, turnRows: status === 'SUCCEEDED' ? 1 : 0, duplicateSubQuestions: 0 });
const response = r => ({ jobId: r.jobId, httpStatus: 200, status: r.status, errorCode: r.errorCode,
  answer: r.status === 'SUCCEEDED' ? '실제 응답 대조용 문자열' : null });
test('명시적 실패는 유실이나 답변 성공으로 집계하지 않는다', () => {
  const rows = [row(1, 'FAILED', 'LLM-003'), row(2, 'FAILED', 'LLM-003')];
  const result = summarize(rows, submissions, rows.map(response));
  assert.equal(result.failed, 2); assert.equal(result.missingJobs, 0); assert.equal(result.unfinished, 0);
  assert.equal(result.succeeded, 0); assert.equal(result.allOriginalJobsSucceeded, false);
  assert.equal(result.apiMismatches, 0); assert.equal(result.savedAnswers, 0);
});
test('타임아웃은 실패의 부분집합이며 성공·중복과 구분한다', () => {
  const rows = [row(1, 'FAILED', 'LLM-004'), row(2, 'SUCCEEDED')];
  const result = summarize(rows, submissions, rows.map(response));
  assert.equal(result.failed, 1); assert.equal(result.timeouts, 1); assert.equal(result.failedExcludingTimeouts, 0);
  assert.equal(result.succeeded, 1); assert.equal(result.duplicateAnswers, 0);
});
test('누락·미완료·중복·잘못된 HTTP 결과를 검출한다', () => {
  const missing = summarize([row(1, 'RUNNING')], submissions, []);
  assert.equal(missing.missingJobs, 1); assert.equal(missing.unfinished, 1); assert.equal(missing.apiMissing, 2);
  const rows = [{ ...row(1, 'SUCCEEDED'), turnRows: 2 }, { ...row(2, 'FAILED', 'LLM-003'), userId: 99, turnRows: 1 }];
  const result = summarize(rows, submissions, [{ ...response(rows[0]), status: 'FAILED' }, response(rows[1])]);
  assert.equal(result.duplicateAnswers, 1); assert.equal(result.failedWithAnswer, 1);
  assert.equal(result.ownershipMismatches, 1); assert.equal(result.apiMismatches, 1);
});
test('HTTP 200이어도 FAILED 상태는 그대로 기록하고 클라이언트 장애와 구분한다', () => {
  const result = latency([{ httpStatus: 200, jobStatus: 'FAILED', elapsedMs: 20 },
    { httpStatus: 0, elapsedMs: 2000 }, { httpStatus: 200, jobStatus: 'RUNNING', elapsedMs: 10 }]);
  assert.deepEqual(result.statuses, { 0: 1, 200: 2 }); assert.equal(result.jobStatuses.FAILED, 1);
  assert.equal(result.clientFailures, 1); assert.equal(result.p50Ms, 20); assert.equal(result.maxMs, 2000);
});
