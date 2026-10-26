import assert from 'node:assert/strict';

export function summarize(rows, submissions, responses) {
  assert.equal(new Set(submissions.map(s => s.jobId)).size, submissions.length);
  const ids = new Set(submissions.map(s => s.jobId));
  assert.equal(new Set(rows.map(r => r.jobId)).size, rows.length);
  assert.ok(rows.every(r => ids.has(r.jobId)));
  const failed = rows.filter(r => r.status === 'FAILED');
  const timeouts = failed.filter(r => ['LLM-004', 'CHAT-016'].includes(r.errorCode));
  const success = rows.filter(r => r.status === 'SUCCEEDED');
  const mismatches = responses.filter(response => {
    const row = rows.find(r => r.jobId === response.jobId);
    return !row || response.httpStatus !== 200 || response.status !== row.status ||
      (row.status === 'FAILED' && response.errorCode !== row.errorCode) ||
      (row.status === 'SUCCEEDED' && !response.answer?.trim());
  });
  return { accepted: submissions.length, savedJobs: rows.length, missingJobs: submissions.length - rows.length,
    succeeded: success.length, failed: failed.length, failedExcludingTimeouts: failed.length - timeouts.length,
    timeouts: timeouts.length, cancelled: rows.filter(r => r.status === 'CANCELLED').length,
    unfinished: rows.filter(r => !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(r.status) || !r.finishedAtMs).length,
    savedAnswers: rows.reduce((n, r) => n + r.turnRows, 0),
    duplicateAnswers: rows.filter(r => r.turnRows > 1 || r.duplicateSubQuestions > 0).length,
    failedWithAnswer: failed.filter(r => r.turnRows > 0).length,
    successWithoutAnswer: success.filter(r => r.turnRows !== 1).length,
    ownershipMismatches: rows.filter(r => r.userId !== submissions.find(s => s.jobId === r.jobId).userId).length,
    apiMismatches: mismatches.length, apiMissing: submissions.length - responses.length,
    errors: failed.reduce((counts, r) => ({ ...counts, [r.errorCode]: (counts[r.errorCode] ?? 0) + 1 }), {}),
    allOriginalJobsSucceeded: success.length === submissions.length };
}

export function latency(rows) {
  const sorted = rows.map(r => r.elapsedMs).sort((a, b) => a - b);
  const p = q => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? null;
  return { count: rows.length, statuses: rows.reduce((a, r) => ({ ...a, [r.httpStatus]: (a[r.httpStatus] ?? 0) + 1 }), {}),
    jobStatuses: rows.filter(r => r.jobStatus).reduce((a, r) => ({ ...a, [r.jobStatus]: (a[r.jobStatus] ?? 0) + 1 }), {}),
    clientFailures: rows.filter(r => r.httpStatus === 0).length, p50Ms: p(.5), p95Ms: p(.95), maxMs: p(1) };
}
