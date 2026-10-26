import hashlib,json,re,sys
from pathlib import Path

root=Path(__file__).resolve().parent
sql_rows=[]
for run in ['retest-a3-20261026','retest-b-20261026']:
    rows=json.loads((root/'runtime'/run/'analysis-rows.json').read_text(encoding='utf-8'))
    for row in rows:
        if row['httpStatus']!=202 or row['jobId'] is None:
            continue
        answer_hash=hashlib.md5(row['answer'].encode('utf-8')).hexdigest() if row['status']=='SUCCEEDED' else None
        values=[run,row['caseId'],row['jobId'],row['status'],row['errorCode'],answer_hash]
        def literal(value):
            if value is None:return 'NULL'
            if isinstance(value,int):return str(value)
            return "'"+value.replace("'","''")+"'"
        sql_rows.append('('+','.join(map(literal,values))+')')
query="""BEGIN READ ONLY;
SET LOCAL statement_timeout='30s';
WITH expected(run,case_id,job_id,expected_status,expected_error,answer_md5) AS (VALUES
"""+',\n'.join(sql_rows)+"""
), actual AS (
SELECT e.*,j.job_id actual_job_id,j.execution_status,a.error_code,u.email,a.attempt_count,
       q.llm_question AS generated_answer
FROM expected e LEFT JOIN chat_jobs j ON j.job_id=e.job_id
LEFT JOIN answer_attempts_history a ON a.attempt_id=j.attempt_id
LEFT JOIN users u ON u.user_id=a.user_id
LEFT JOIN question_log q ON q.id=(j.result_payload->>'questionLogId')::bigint
)
SELECT json_build_object(
'expected',count(*),'matchedJobs',count(actual_job_id),'uniqueJobs',count(DISTINCT actual_job_id),
'ownerMismatches',count(*) FILTER(WHERE email IS DISTINCT FROM 'load+'||run||'.'||lpad(case_id::text,4,'0')||'@example.test'),
'statusMismatches',count(*) FILTER(WHERE execution_status IS DISTINCT FROM expected_status),
'errorCodeMismatches',count(*) FILTER(WHERE error_code IS DISTINCT FROM expected_error),
'successfulAnswers',count(*) FILTER(WHERE expected_status='SUCCEEDED'),
'answerHashMismatches',count(*) FILTER(WHERE answer_md5 IS NOT NULL AND md5(generated_answer) IS DISTINCT FROM answer_md5),
'nonFirstAttempts',count(*) FILTER(WHERE attempt_count IS DISTINCT FROM 1)
) FROM actual;
COMMIT;
"""
(root/'final-db-audit.sql').write_text(query,encoding='utf-8')
print(json.dumps({'expectedJobs':len(sql_rows),'sqlBytes':len(query.encode())}))
