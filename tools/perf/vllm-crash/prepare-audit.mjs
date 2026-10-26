import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const directory = resolve(process.argv[2]); assert.ok(directory.startsWith(resolve('build') + '\\'));
const read = async name => JSON.parse((await readFile(join(directory, name), 'utf8')).replace(/^\uFEFF/, ''));
const submissions = await read('submissions.json'), responses = await read('api-original-final.json');
const probe = await read('recovery-probe.json');
assert.equal(submissions.length, 100); assert.equal(responses.length, 100);
function tuple(kind, jobId, userId, response) {
  assert.ok(Number.isSafeInteger(jobId) && Number.isSafeInteger(userId));
  assert.ok(['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(response.status));
  assert.ok(!response.errorCode || /^[A-Z]+-[0-9]{3}$/.test(response.errorCode));
  const error = response.errorCode ? `'${response.errorCode}'` : 'NULL';
  const answer = response.answer ? `'${createHash('md5').update(response.answer, 'utf8').digest('hex')}'` : 'NULL';
  return `('${kind}',${jobId},${userId},'${response.status}',${error},${answer})`;
}
const values = submissions.map(s => {
  const response = responses.find(r => r.jobId === s.jobId); assert.equal(response.httpStatus, 200);
  return tuple('original', s.jobId, s.userId, response);
});
values.push(tuple('probe', probe.submission.jobId, probe.userId, probe.response));
assert.ok(Number.isSafeInteger(probe.originalJobId));
const query = `BEGIN READ ONLY;
SET LOCAL statement_timeout='10s';
WITH expected(kind,job_id,expected_user_id,expected_status,expected_error,answer_md5) AS (VALUES ${values.join(',\n')}),
checked AS (
 SELECT e.*, j.attempt_id, j.execution_status, j.finished_at, j.result_payload, j.request_context,
   a.user_id, a.conversation_id, a.status AS attempt_status, a.error_code, a.attempt_count,
   q.id AS saved_turn_id, q.llm_question AS answer,
   (SELECT count(*) FROM question_log z WHERE z.attempt_id=j.attempt_id AND z.sub_question_index=1) AS turn_count,
   (SELECT count(*) FROM (SELECT sub_question_index FROM question_log z WHERE z.attempt_id=j.attempt_id
     GROUP BY sub_question_index HAVING count(*)>1) d) AS duplicate_sub_questions
 FROM expected e LEFT JOIN chat_jobs j ON j.job_id=e.job_id
 LEFT JOIN answer_attempts_history a ON a.attempt_id=j.attempt_id
 LEFT JOIN question_log q ON q.attempt_id=j.attempt_id AND q.sub_question_index=1
), grouped AS (
 SELECT kind, json_build_object('expectedJobs',count(*), 'savedJobs',count(attempt_id),
  'uniqueJobs',count(DISTINCT job_id),'uniqueMembers',count(DISTINCT user_id),
  'succeeded',count(*) FILTER (WHERE execution_status='SUCCEEDED'),
  'failed',count(*) FILTER (WHERE execution_status='FAILED'),
  'timeouts',count(*) FILTER (WHERE error_code IN ('LLM-004','CHAT-016')),
  'storedAnswers',count(saved_turn_id),
  'statusMismatches',count(*) FILTER (WHERE execution_status IS DISTINCT FROM expected_status),
  'errorMismatches',count(*) FILTER (WHERE error_code IS DISTINCT FROM expected_error),
  'ownershipMismatches',count(*) FILTER (WHERE user_id IS DISTINCT FROM expected_user_id),
  'answerMismatches',count(*) FILTER (WHERE (expected_status='SUCCEEDED' AND (answer IS NULL OR md5(answer)<>answer_md5))
    OR (expected_status<>'SUCCEEDED' AND saved_turn_id IS NOT NULL)),
  'duplicateTurns',count(*) FILTER (WHERE turn_count>1 OR duplicate_sub_questions>0),
  'resultReferenceMismatches',count(*) FILTER (WHERE (expected_status='SUCCEEDED' AND
      (result_payload->>'questionLogId')::bigint IS DISTINCT FROM saved_turn_id)
    OR (expected_status<>'SUCCEEDED' AND result_payload IS NOT NULL)),
  'attemptCountMismatches',count(*) FILTER (WHERE attempt_count<>(CASE kind WHEN 'original' THEN 1 ELSE 2 END)),
  'clearedContexts',count(*) FILTER (WHERE request_context IS NULL),
  'missingOrUnfinished',count(*) FILTER (WHERE attempt_id IS NULL OR finished_at IS NULL),
  'allFinishedAtMs',max(extract(epoch FROM finished_at AT TIME ZONE 'Asia/Seoul')*1000)) AS result
 FROM checked GROUP BY kind
)
SELECT json_build_object('original',(SELECT result FROM grouped WHERE kind='original'),
 'probe',(SELECT result FROM grouped WHERE kind='probe'),
 'sameConversationAndKey',(SELECT p.conversation_id=o.conversation_id AND p.idempotency_key=o.idempotency_key
   FROM chat_jobs pj JOIN answer_attempts_history p ON p.attempt_id=pj.attempt_id
   CROSS JOIN chat_jobs oj JOIN answer_attempts_history o ON o.attempt_id=oj.attempt_id
   WHERE pj.job_id=${probe.submission.jobId} AND oj.job_id=${probe.originalJobId}),
 'globalOutstanding',(SELECT count(*) FROM chat_jobs WHERE execution_status IN ('QUEUED','RUNNING')));
COMMIT;
`;
await writeFile(join(directory, 'independent-audit.sql'), query);
console.log(JSON.stringify({ original: 100, separateRecoveryProbe: 1, readOnly: true }));
