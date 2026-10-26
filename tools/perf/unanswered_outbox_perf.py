import argparse
import getpass
import json
import os
import statistics
import subprocess
import time
import urllib.error
import urllib.request

QUESTIONS = [
    '화성 탐사선이랑 통신하려면 어떤 요금제를 써야 하나요',
    '반려견 목줄에 유심을 넣을 수 있나요',
    '남극 기지에서 쓸 수 있는 데이터 쿠폰 있어요',
    '잠수함 안에서 5G 속도 보장되나요',
    '전화기로 김치 숙성도를 확인하는 서비스 있나요',
    '드론 배달 받을 때 통신비 할인되나요',
    '우주정거장 로밍 신청 방법 알려줘',
    '꿈속에서 통화한 기록 조회할 수 있어요',
    '고양이 전용 요금제 가입 조건이 뭐예요',
    '타임머신 여행 중 요금은 어떻게 청구돼요',
    '해저터널 안에서 문자 보내면 추가 요금 있나요',
    '로봇청소기 회선 개통하려면 서류 뭐 필요해요',
    '열기구 탈 때 데이터 무제한 적용돼요',
    '외계인 번호로 전화 걸면 국제전화 요금 나오나요',
    '빙하 위 캠핑장에서 와이파이 설치 가능해요',
    '지하 벙커용 회선 약정 기간 알려줘',
    '사막 횡단할 때 위성 데이터 쿠폰 살 수 있어요',
    '앵무새가 대신 통화해도 본인 인증되나요',
    '달 기지 이사 가면 주소 변경 어떻게 해요',
    '유령이 쓰던 번호 다시 받을 수 있나요',
]
WARMUP = '토성 고리에서 통화 품질 어때요'
TERMINAL = ('SUCCEEDED', 'FAILED', 'CANCELLED')


def call(base, method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(base + path, data=data, method=method,
                                     headers={'Content-Type': 'application/json'})
    if token:
        request.add_header('Authorization', 'Bearer ' + token)
    try:
        return json.load(urllib.request.urlopen(request, timeout=120))['data']
    except urllib.error.HTTPError as error:
        raise SystemExit(f'{method} {path} -> {error.code} {error.read().decode()[:300]}')


def ask(base, token, question):
    started = time.perf_counter()
    job_id = call(base, 'POST', '/chat/questions', {'question': question}, token)['jobId']
    while True:
        job = call(base, 'GET', f'/chat/jobs/{job_id}', token=token)
        if job.get('status') in TERMINAL:
            return job, round((time.perf_counter() - started) * 1000)
        time.sleep(0.05)


def psql(container, db, sql):
    result = subprocess.run(
        ['docker', 'exec', container, 'psql', '-U', 'ubot', '-d', db, '-At', '-F', '|', '-c', sql],
        capture_output=True, text=True, encoding='utf-8')
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip())
    return [line.split('|') for line in result.stdout.strip().splitlines() if line]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('label')
    parser.add_argument('--db', default='ubot')
    parser.add_argument('--container', default='ubot-be-postgres-1')
    parser.add_argument('--email', required=True)
    parser.add_argument('--rounds', type=int, default=2)
    parser.add_argument('--base-url', default='http://localhost:8080')
    parser.add_argument('--wait', type=int, default=10)
    args = parser.parse_args()

    password = os.environ.get('UBOT_ADMIN_PASSWORD') or getpass.getpass('Admin password: ')
    token = call(args.base_url, 'POST', '/auth/login', {'email': args.email, 'password': password})['accessToken']
    ask(args.base_url, token, WARMUP)
    since = psql(args.container, args.db, 'SELECT now()::timestamp')[0][0]

    client = []
    for round_number in range(args.rounds):
        for question in QUESTIONS:
            job, elapsed = ask(args.base_url, token, question)
            client.append(elapsed)
            print(f'[{round_number + 1}] {elapsed:>5}ms {job.get("status"):<9} {job.get("errorCode") or "-":<9} {question}')
    time.sleep(args.wait)

    window = f"'{since}'"
    jobs = psql(args.container, args.db, f"""
        SELECT a.status,
               count(*),
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM j.finished_at - j.started_at) * 1000)),
               round(avg(extract(epoch FROM j.finished_at - j.started_at) * 1000))
        FROM chat_jobs j JOIN answer_attempts_history a ON a.attempt_id = j.attempt_id
        WHERE j.created_at >= {window}
        GROUP BY a.status ORDER BY a.status""")
    saved = psql(args.container, args.db, f"""
        SELECT u.reason, count(*)
        FROM unanswered_questions u JOIN answer_attempts_history a ON a.attempt_id = u.attempt_id
        WHERE a.created_at >= {window}
        GROUP BY u.reason ORDER BY u.reason""")
    delay = psql(args.container, args.db, f"""
        SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM u.created_at - j.finished_at) * 1000)),
               round(max(extract(epoch FROM u.created_at - j.finished_at) * 1000))
        FROM unanswered_questions u JOIN chat_jobs j ON j.attempt_id = u.attempt_id
        WHERE j.created_at >= {window}""")[0]
    has_outbox = psql(args.container, args.db, "SELECT to_regclass('outbox_events') IS NOT NULL")[0][0] == 't'
    pending = psql(args.container, args.db, "SELECT count(*), count(*) FILTER (WHERE retry_count >= 5) FROM outbox_events WHERE event_type = 'UNANSWERED_QUESTION'")[0] \
        if has_outbox else None

    print(f'\n== {args.label} ({len(client)}회)')
    print(f'사용자 체감 시간 중앙값: {statistics.median(client):.0f}ms')
    for status, count, median, average in jobs:
        print(f'서버 작업 시간 {status}: {count}건, 중앙값 {median}ms, 평균 {average}ms')
    print('미응답 저장: ' + ', '.join(f'{reason} {count}건' for reason, count in saved))
    print(f'답변 종료 → 미응답 저장 시간: 중앙값 {delay[0]}ms, 최대 {delay[1]}ms (음수면 답변이 끝나기 전에 저장)')
    if pending:
        print(f'대기열에 남은 행: {pending[0]}개, 재시도 횟수 소진: {pending[1]}개')


if __name__ == '__main__':
    main()
