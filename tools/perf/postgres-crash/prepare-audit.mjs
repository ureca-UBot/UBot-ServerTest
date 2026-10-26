import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const directory = resolve(process.argv[2]);
assert.ok(directory.startsWith(resolve('build') + '\\'), '전용 build 결과 폴더만 사용합니다.');
const read = async name => JSON.parse((await readFile(join(directory, name), 'utf8')).replace(/^\uFEFF/, ''));
const submissions = await read('submissions.json');
const answers = await read('api-final.json');
const report = await read('report.json');
assert.equal(submissions.length, 100); assert.equal(answers.length, 100);
const values = submissions.map(s => {
  const answer = answers.find(a => a.jobId === s.jobId);
  assert.ok(Number.isSafeInteger(s.jobId) && Number.isSafeInteger(s.userId));
  assert.equal(answer.httpStatus, 200); assert.ok(answer.answer);
  return `(${s.jobId},${s.userId},'${createHash('md5').update(answer.answer, 'utf8').digest('hex')}')`;
});
assert.ok(report.queuedAtKillIds.length && report.queuedAtKillIds.every(Number.isSafeInteger));
const query = `BEGIN READ ONLY;
SET LOCAL statement_timeout='10s';
WITH expected(job_id,user_id,answer_md5) AS (VALUES ${values.join(',\n')}), checked AS (
 SELECT e.job_id AS expected_job_id, e.user_id AS expected_user_id, e.answer_md5,
   j.*, a.user_id, a.conversation_id, a.status AS attempt_status, a.attempt_count,
   q.id AS saved_turn_id, q.llm_question AS answer,
   (SELECT count(*) FROM question_log z WHERE z.attempt_id=j.attempt_id AND z.sub_question_index=1) AS turn_count,
   (SELECT count(*) FROM (SELECT sub_question_index FROM question_log z WHERE z.attempt_id=j.attempt_id
     GROUP BY sub_question_index HAVING count(*)>1) d) AS duplicate_sub_questions
 FROM expected e LEFT JOIN chat_jobs j ON j.job_id=e.job_id
 LEFT JOIN answer_attempts_history a ON a.attempt_id=j.attempt_id
 LEFT JOIN question_log q ON q.attempt_id=j.attempt_id AND q.sub_question_index=1
)
SELECT json_build_object(
 'expectedJobs', count(*), 'savedJobs', count(job_id), 'uniqueJobs', count(DISTINCT job_id),
 'uniqueAttempts', count(DISTINCT attempt_id), 'uniqueMembers', count(DISTINCT user_id),
 'uniqueConversations', count(DISTINCT conversation_id),
 'succeededJobs', count(*) FILTER (WHERE execution_status='SUCCEEDED'),
 'succeededAttempts', count(*) FILTER (WHERE attempt_status='SUCCESS'),
 'oneAttemptOnly', count(*) FILTER (WHERE attempt_count=1),
 'storedTurns', count(saved_turn_id), 'ownershipMismatches', count(*) FILTER (WHERE user_id IS DISTINCT FROM expected_user_id),
 'answerMismatches', count(*) FILTER (WHERE answer IS NULL OR md5(answer)<>answer_md5),
 'duplicateTurns', count(*) FILTER (WHERE turn_count<>1 OR duplicate_sub_questions<>0),
 'resultReferencesMatch', count(*) FILTER (WHERE (result_payload->>'questionLogId')::bigint=saved_turn_id),
 'clearedRequestContexts', count(*) FILTER (WHERE request_context IS NULL),
 'missingOrUnfinished', count(*) FILTER (WHERE job_id IS NULL OR finished_at IS NULL),
 'globalOutstanding', (SELECT count(*) FROM chat_jobs WHERE execution_status IN ('QUEUED','RUNNING')),
 'firstQueuedStartAtMs', min(extract(epoch FROM started_at AT TIME ZONE 'Asia/Seoul')*1000)
   FILTER (WHERE job_id IN (${report.queuedAtKillIds.join(',')})),
 'allAnswersFinishedAtMs', max(extract(epoch FROM finished_at AT TIME ZONE 'Asia/Seoul')*1000)
) FROM checked;
COMMIT;
`;
await writeFile(join(directory, 'independent-audit.sql'), query);
console.log(JSON.stringify({ expectedJobs: 100, questionPosts: 100 }));
