# 회원 1,500명 동시 채팅 부하 시나리오

금지어 300건, FAQ 유사도 미달 300건, 공식 FAQ 캐시 450건, LLM 답변 성공 450건을 검증한다. 운영 애플리케이션·인증·DB 스키마는 수정하지 않고 기존 HTTP API와 로그를 사용한다. 이 도구를 설치하거나 테스트를 돌리는 것만으로 실제 서비스에 요청하지는 않는다. 모든 네트워크 명령은 `--base-url`로 지정한 대상에 실행된다.

## 준비 조건

- 부하 발생기: Node.js 22 이상, k6 2.2 이상. 추가 npm 패키지는 없다.
- 서버: 현재 비동기 API(`POST /chat/questions`, `GET /chat/jobs/{jobId}`)와 기존 처리 출처 로그를 제공하는 버전.
- 일반 회원의 가입·로그인을 허용하는 환경. 회원당 새 대화의 질문 한 건을 보낸다.
- API 주소는 프론트 주소와 구분한다. 저장소 Nginx 설정에서는 `https://u-bot.cloud/api`가 API 경로지만 실제 배포 경로를 확인하고 지정한다.
- `FAQ_CACHE_ENABLED=true`, 캐시 대상 FAQ의 `cacheable=true`·`GENERAL`, 현재 임베딩 프로필·버전의 벡터가 준비되어 있어야 한다. 기본 설정은 캐시 OFF다. 도구가 서버 설정이나 FAQ 승인 상태를 자동으로 바꾸지는 않는다.

기본 판정은 FAQ 검색 유사도 `0.75`, 캐시 유사도 `0.95`·1/2위 점수 차이 `0.15`다. 실제 배포 설정이 우선이다. 캐시는 Redis에 LLM 답변을 미리 넣는 방식이 아니라 승인된 공식 FAQ 답변을 직접 반환하는 기존 기능이다.

## 질문 집합과 소량 검증

`questions.example.json`은 형식 예시이며 현재 운영 DB에서 네 경로를 통과한다고 보장하지 않는다. 질문을 실제 금지어·FAQ에 맞춰 수정하고 **10건 파일럿 결과를 먼저 검증**한다. 같은 질문은 여러 회원이 반복할 수 있지만, 다양한 질문을 보려면 각 배열에 여러 문장을 넣는다. 배열이 여러 개면 파일럿에서 모두 다뤄졌는지도 확인한다.

| 그룹 | 목표 | 실제 집계 조건 |
|---|---:|---|
| `forbidden` | 300 | 질문 POST가 `400 FW-003`으로 거절됨 |
| `threshold` | 300 | 최종 `FAILED / CHAT-013`, 답변 출처 없음, 최종 하위 질문의 실제 유사도 미달 로그 확인 |
| `cache` | 450 | 최종 `SUCCEEDED`와 `source=OFFICIAL_FAQ` 로그 확인 |
| `llm` | 450 | 최종 `SUCCEEDED`와 `source=LLM` 로그 확인 |

`CHAT-012`(후보 없음), 문장 근거 부족만으로 발생한 `CHAT-013`, 접수 429/5xx, 타임아웃·취소·미완료는 목표 그룹에 포함하지 않는다. 질문의 **예상 그룹**과 실제 결과가 다르면 보고서를 FAIL로 남긴다. 결과를 원하는 건수로 강제하거나 서버에서 테스트 전용 분기를 만들지 않는다.

캐시 질문은 승인된 GENERAL FAQ가 1위이고 점수·점수 차이를 모두 통과하도록 고른다. LLM 질문은 캐시가 승인되지 않으면서 FAQ 유사도와 답변 문장 검사를 통과하도록 고른다. 임계값 미달 질문은 검색 후보가 있으나 판정·재검색 후에도 기준을 넘지 못해야 한다. 금지어는 해당 서버의 활성 목록으로 확인한다.

```powershell
# 저장소 루트에서 실행. 질문 예시는 배포 데이터에 맞게 편집한다.
$burstTool = 'tools/perf/chat-burst/cli.mjs'
$questionFile = 'build/chat-burst-questions.json'
New-Item -ItemType Directory -Path build -Force | Out-Null
Copy-Item tools/perf/chat-burst/questions.example.json $questionFile

# 파일럿: 별도 회원 10명, 목표 2/2/3/3. 아래 생성·실행 명령은 지정한 서버를 변경/호출한다.
node $burstTool prepare --dir build/chat-burst/pilot-20261022 --run-id pilot-20261022 --base-url https://u-bot.cloud/api --questions $questionFile --total 10
node $burstTool run --dir build/chat-burst/pilot-20261022 --warm-connections false
node $burstTool collect --dir build/chat-burst/pilot-20261022
```

파일럿 로그를 확보해 아래 `report`까지 PASS인 것을 확인한 후 같은 질문 집합으로 본 부하를 준비한다. LLM은 비결정적이고 부하 시 대기 만료도 발생할 수 있어, 파일럿 성공이 본 부하의 성공을 보장하지는 않는다.

## 1. 더미 회원 생성·JWT 사전 발급

```powershell
$burstDir = 'build/chat-burst/burst-20261022'
node $burstTool prepare --dir $burstDir --run-id burst-20261022 --base-url https://u-bot.cloud/api --questions $questionFile
```

- 기본 1,500명. `load+실행이름.0001@example.test` 형태로 기존 `/auth/signup`에 등록한다. 가입·로그인은 기본 동시 실행 4개이며 `--concurrency 1~16`으로 조정한다.
- 계정 생성 후 `/auth/login`으로 JWT를 발급한다. JWT 서명 키를 읽거나 토큰을 직접 서명하지 않는다. `USER` 역할·회원별 고유 ID·토큰 만료를 점검한다.
- 비밀번호는 실행별 난수로 생성한다. 필요하면 `UBOT_LOAD_PASSWORD` 환경변수로 8~20바이트 값을 전달한다. 명령행에 비밀번호를 넣지 않는다.
- 새 출력 폴더는 비어 있어야 한다. 준비 중 실패하면 같은 명령으로 재개할 수 있다. 같은 이메일이 이미 있더라도 정상 로그인으로 소유권을 확인한다. 준비 완료 후 질문 집합이나 대상 주소를 바꾸려면 새 run-id와 폴더를 사용한다.
- 등록·로그인 요청은 채팅 부하의 1,500건에 포함하지 않는다. 준비와 결과 파일은 출력 디렉터리의 `.gitignore`로 제외하고 가능한 OS에서 파일 권한을 제한한다. Windows에서는 출력 폴더 ACL도 관리한다.

준비 후 오래 기다렸다면 다음 명령으로 JWT를 다시 발급한다. 실행 직전 최소 2분의 유효 시간이 없으면 본 부하를 시작하지 않는다.

```powershell
node $burstTool tokens --dir $burstDir
```

회원 생성은 실제 서버의 사용자 데이터를 만든다. run-id별 전용 회원을 재사용하거나 기존 회원과 섞지 않는다. 시험 후에는 운영팀의 사용자 데이터·로그 보존 정책에 따라 이 이메일 접두사에 해당하는 더미 데이터를 정리한다.

## 2. 동시 전송

```powershell
node $burstTool run --dir $burstDir --warm-connections false
```

하나의 `per-vu-iterations` 시나리오에서 가상 사용자 1,500명이 각각 한 번 실행한다. 네 그룹은 고정 시드로 섞으며, 모두 같은 시작 시각에 질문 POST를 보낸다. `http.batch()`나 순차 1,500회 반복을 사용하지 않는다. 실제 시작 시각의 최대·최소 차이를 기록하고 기본 1,000ms 범위를 넘으면 FAIL이다. 네트워크·서버 도착까지 정확히 같은 순간이라는 보장은 하지 않는다.

기본 시작 대기는 15초다. VU 준비가 오래 걸리면 `--start-delay-seconds 30` 등으로 늘린다. 실행이 이미 시작된 디렉터리는 다시 전송하지 않는다. 첫 질문 POST에는 클라이언트 멱등키 계약이 없어 응답을 잃은 요청도 자동 재전송하지 않는다.

같은 폴더의 동시 실행도 실행 기록을 배타적으로 생성해 차단한다. 개인 k6 설정 파일·`K6_*` 환경변수는 실행에 섞지 않아 VU 수 변경이나 HTTP 디버그 로그의 JWT 노출을 방지한다.

기본값 `--warm-connections true`는 시작 시각 전에 VU별 health GET을 시간차로 보내 TCP/TLS 연결을 준비한다. 이 **1,500개의 준비 GET은 질문 1,500건과 별개**이며, 보고서의 채팅 접수 지연·건수에는 포함하지 않는다. k6 기본 HTTP 전체 지표에는 포함되므로 채팅만 볼 때는 `burst_requests`·`results.csv`를 사용한다. 새 연결부터 몰리는 조건은 새 실행에서 `--warm-connections false`로 측정한다. 서버가 유휴 연결을 닫으면 준비한 연결도 다시 열릴 수 있다.

외부에 `/api/actuator/health`를 공개하지 않는 배포에서는 위 예시처럼 `--warm-connections false`를 지정한다. health의 404만으로 다른 API도 차단됐다고 판정하지 않는다. 연결 준비를 생략한 실행은 TCP/TLS 수립 비용을 포함할 수 있으므로 연결 준비를 사용한 결과와 구분한다.

질문 전송이 끝날 때까지 결과 폴링을 하지 않는다. `run` 성공은 올바른 접수/금지어 응답과 동시 시작을 확인한 것이며, 최종 300/300/450/450 판정은 `report`에서 수행한다.

## 3. 최종 상태 수집

```powershell
node $burstTool collect --dir $burstDir --rps 15 --max-wait-seconds 1800
```

- 기존 SSH·로컬 Nginx는 상태 조회를 회원·게스트 모두 IP별 20회/초로 제한한다. AWS Nginx는 회원 access token별·게스트 IP별로 제한한다. 단일 수집기의 전체 조회는 기존 기본 15회/초·최대 18회/초를 유지한다. 여러 수집기를 동시에 실행하지 않는다.
- 토큰이 만료되기 전 `/auth/refresh`로 회전시키고 새 refreshToken을 즉시 저장한다. 401·429·네트워크 실패를 기록하고 백오프한다.
- `jobs.json`을 주기적으로 저장한다. 중단 후 같은 명령으로 수집을 재개할 수 있으며 완료한 작업은 다시 조회하지 않는다. 미완료 작업을 성공으로 간주하지 않는다.
- 기본 30분 수집 제한과 서버 대기/실행 제한은 별개다. 기본 워커 동시 실행 수는 4, 대기 제한은 10분, 실행 제한은 180초이므로 450건의 답변 생성이 모두 성공할지는 실제 처리량에 달렸다.

## 4. 처리 출처 로그 연결·결과 집계

서버에서 시험 시간에 해당하는 **API와 모든 ai-worker 인스턴스 로그**를 파일로 확보한다. 기존 INFO 수준의 다음 로그를 사용한다.

```text
답변 작업을 접수했습니다: 작업ID=..., 시도ID=...
CHAT route: attemptId=..., source=OFFICIAL_FAQ 또는 LLM
FAQ 유사도 검색을 완료했습니다: 시도ID=..., 하위질문순번=...
FAQ 유사도가 기준값 미만입니다: 시도ID=..., 하위질문순번=..., 최고유사도=..., 기준값=...
```

예를 들어 EC2의 해당 Compose 프로젝트에서 실행한다. `--since`에는 부하 발생기 `run.json`의 `startedAt`을 사용하고, 종료 후 로그까지 포함한다. 로그 회전으로 기록이 사라지지 않도록 시험 전에 수집을 준비한다.

```bash
docker compose -f docker-compose.yml -f docker-compose.deploy.yml logs --no-color --since '시험 시작 ISO 시각' backend ai-worker > chat-burst-server.log
```

서버 로그를 부하 발생기로 가져온 뒤 집계한다. `--log`는 여러 번 지정할 수 있다.

```powershell
node $burstTool report --dir $burstDir --log build/chat-burst-server.log
```

성공 응답·답변 문장·예상 질문 그룹만 보고 캐시/LLM을 추정하지 않는다. 실행별 jobId에 로그의 attemptId를 연결한다. 출처가 없거나 여러 출처가 충돌하면 미확인으로 기록한다. FAQ 부족 응답도 실제 모든 최종 검색이 유사도 기준에 못 미쳤다는 로그가 있어야 threshold로 센다.

선택적으로 생성된 `evidence.sql`을 해당 DB에서 읽기 전용으로 실행하면 job/attempt 매핑과 실제 서버 시간을 확보할 수 있다. 비밀번호를 명령행에 쓰지 않고 기존 DB 접속 방법을 사용한다.

```bash
psql -qAt -f evidence.sql > db-evidence.json
```

```powershell
node $burstTool report --dir $burstDir --log build/chat-burst-server.log --db-evidence build/db-evidence.json
```

SQL은 준비한 회원 ID와 실행별 이메일 접두사에 한정하며 데이터를 수정하지 않는다. DB 증거가 있어도 출처·유사도 판정 로그는 필요하다. 클라이언트 완료 관측 시간에는 수집 시작 지연과 조회 주기가 포함되므로 서버 처리 시간으로 해석하지 않는다.

| 결과 파일 | 내용 |
|---|---|
| `plan.json` | 실행 ID·대상·질문·예상 분포 |
| `credentials.private.json` | 비밀번호·회원별 access/refreshToken. 공유 금지 |
| `auth-summary.json` | 회원 수·발급/최초 만료 시각. 토큰 없음 |
| `submissions.ndjson`, `run.json`, `k6-summary.json` | 질문별 접수 결과·시작 범위·k6 종료 상태 |
| `jobs.json` | 답변 본문을 제외한 최종 상태·조회 오류·갱신 횟수 |
| `report.json`, `report.md`, `results.csv` | 기대/실제 분포·case별 일치·미완료/오류·지연 |

최종 PASS는 **누락·중복 0건, 시작 범위 충족, k6 성공, 1,500개 case 각각의 기대/실제 경로 일치**가 모두 성립할 때만 나온다. 로그가 없으면 금지어 이외의 그룹을 검증 완료로 표시하지 않는다. 450건은 LLM **답변 성공 건수**다. 임계값 미달 질문의 판정 LLM·재실행까지 포함한 모델 호출 수는 기존 `llm_requests_seconds_count{kind="answer"|"judgment"}`를 별도로 확인한다.

## 테스트

```powershell
node --test tools/perf/chat-burst/tests/model.test.mjs tools/perf/chat-burst/tests/pipeline.test.mjs
```

외부 서비스가 아닌 loopback 모의 서버에서 실제 k6로 회원 1,500명을 준비·전송·조회하고 300/300/450/450을 집계한다. 준비 재개, JWT 만료/중복/역할 검사, refresh 회전, 429 백오프, 로그 미확인·모순·다른 실행 데이터도 검증한다. 약 2분이 걸리며 로컬 모의 서버의 처리 성능은 운영 성능 측정값이 아니다.

실제 BE HTTP 계약·PostgreSQL·Redis·워커를 연결하는 10건 통합 검증은 opt-in이다. 외부 검색 결과와 LLM 통신만 모의하며 개발 DB·실제 모델은 사용하지 않는다.

```powershell
$previousBurstSmoke = $env:RUN_CHAT_BURST_SMOKE
$env:RUN_CHAT_BURST_SMOKE = 'true'
try {
    .\gradlew.bat test --tests com.ubot.chat.controller.ChatBurstToolsIntegrationTest --console=plain
} finally {
    $env:RUN_CHAT_BURST_SMOKE = $previousBurstSmoke
}
```

일반 Gradle 테스트에는 Node/k6가 필요하지 않다. opt-in 테스트는 `NODE_BINARY`로 Node 실행 경로를 바꿀 수 있다.
