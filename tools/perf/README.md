# 부하·장애 검증 명령어

이 문서는 기존 BE 작업 폴더에서 쓰던 명령을 보존한 것입니다. 최신 AWS 3,000명·300초 실행은 [별도 안내](../../chat-e2e/README.md)를 사용합니다. 아래 장애 실행 명령은 BE 루트에서 `node ../UBot-ServerTest/tools/perf/...`로 실행하며, 필요하면 `UBOT_BACKEND_ROOT`로 BE 경로를 지정합니다. 결과와 JAR은 BE의 `build` 아래에 둡니다.

PowerShell에서 저장소 루트를 작업 디렉터리로 사용한다.

## 실행 위치

| 실행 위치 | 필요한 도구와 역할 |
|---|---|
| 외부 PC 또는 별도 부하 발생기 | Node.js·k6로 회원 생성·JWT 발급·질문 전송·결과 집계 |
| 운영 서버 | 기존 API·Worker·모델을 실행하고 로그·지표 제공. 이 검증을 위한 Node.js·k6·Python 설치는 필요 없음 |
| 로컬 장애 재현 환경 | Java·Docker·Node.js로 테스트 API·Worker를 띄우고 로컬 컨테이너 장애 주입 |

스크립트는 Git 저장소에서 관리한다. 현재 Dockerfile은 운영 이미지에 애플리케이션 JAR와 Kiwi 모델을 복사하며 부하 도구를 복사하지 않는다. 아래 원격 실행은 부하 발생기에서 수행하고, 로컬 장애 실행과 구분한다.

## u-bot.cloud 원격 부하

외부 PC에서 GitHub의 도구를 받아 기존 CLI의 `--base-url`에 운영 API 주소를 지정한다. 저장소 Nginx 설정 기준 주소는 `https://u-bot.cloud/api`이며, 실제 배포에서 다른 경로를 사용하는 경우 그 주소로 맞춘다. 외부 부하 발생기에는 Node.js 22 이상·k6 2.2 이상만 필요하고, BE를 빌드하거나 로컬 모델·DB를 띄울 필요는 없다.

AWS Nginx는 외부 `/api/actuator/**` 요청을 차단하므로 아래 원격 명령은 `--warm-connections false`로 health 기반 연결 준비를 생략합니다. 접수 시간에 TCP/TLS 연결 수립이 포함될 수 있으므로 연결 준비를 사용한 실행과 구분합니다.


### 외부 PC의 변수·질문 파일 준비

```powershell
$RepoRoot = 'C:\path\to\UBot-BE'
Set-Location -LiteralPath $RepoRoot

$CloudTool = 'tools/perf/chat-burst/cli.mjs'
$CloudApi = 'https://u-bot.cloud/api'
$CloudStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$CloudQuestions = 'build/chat-burst-cloud-questions.json'
$CloudPilot = "build/chat-burst/cloud-pilot-$CloudStamp"
$CloudDir = "build/chat-burst/cloud-$CloudStamp"

node --version
k6 version
New-Item -ItemType Directory -Path build -Force | Out-Null
if (-not (Test-Path -LiteralPath $CloudQuestions)) {
    Copy-Item -LiteralPath tools/perf/chat-burst/questions.example.json -Destination $CloudQuestions
}
```

운영의 활성 금지어·FAQ·임베딩·캐시 승인 상태에 맞춰 질문 파일을 편집한다. 운영에서 `FAQ_CACHE_ENABLED=true`이고 캐시/비캐시 FAQ가 준비되어 있어야 300/300/450/450을 판정할 수 있다. 로컬에서 통과한 질문도 운영 DB에서 같은 경로가 나온다고 가정하지 않는다.

### 운영 데이터로 파일럿 10건

`prepare`는 대상 운영 API로 실제 합성 회원을 생성하고 로그인한다. 실행별 `load+실행이름.번호@example.test` 회원을 사용한다.

```powershell
node $CloudTool prepare --dir $CloudPilot --run-id "cloud-pilot-$CloudStamp" --base-url $CloudApi --questions $CloudQuestions --total 10
node $CloudTool run --dir $CloudPilot --warm-connections false
node $CloudTool collect --dir $CloudPilot --rps 15 --max-wait-seconds 1800
```

아래 로그 수집 절차로 파일럿의 API·Worker 로그를 외부 PC에 가져와 `report`한다. 목표 2/2/3/3과 PASS를 확인한 뒤 본 부하로 진행한다.

```powershell
$CloudPilotLog = 'build/chat-burst-cloud-pilot-server.log'
node $CloudTool report --dir $CloudPilot --log $CloudPilotLog
```

### 운영 대상 1,500건

```powershell
node $CloudTool prepare --dir $CloudDir --run-id "cloud-$CloudStamp" --base-url $CloudApi --questions $CloudQuestions --total 1500

# 회원 준비 후 오래 기다렸을 때만 JWT를 재발급한다.
node $CloudTool tokens --dir $CloudDir

node $CloudTool run --dir $CloudDir --warm-connections false
node $CloudTool collect --dir $CloudDir --rps 15 --max-wait-seconds 1800
```

실제 전송은 `https://u-bot.cloud/api/chat/questions`, 상태 조회는 `/api/chat/jobs/{jobId}`로 간다. 질문 POST는 공통 시각에 한 번씩 전송하고, 상태 조회는 질문 전송 이후 초당 15회로 제한한다. 기존 SSH·로컬 Nginx는 회원 상태 조회에도 IP별 20회/초 제한을 적용한다. AWS Nginx는 회원 access token별·게스트 IP별로 제한한다. 수집기는 기존 15회/초 설정을 유지하고 한 개만 실행한다.

### 서버 로그 수집·외부 PC 집계

외부 PC의 해당 실행 `run.json`에서 `startedAt`을 확인한다.

```powershell
(Get-Content -LiteralPath (Join-Path $CloudDir 'run.json') -Raw | ConvertFrom-Json).startedAt
```

운영 서버에서는 기존 Docker 명령으로 해당 시각 이후 API·모든 Worker 로그를 확보한다. 실제 배포 Compose 디렉터리에서 실행하고, 아래 시각은 방금 확인한 값으로 바꾼다. 이 단계에는 k6·Node.js·Python이 필요하지 않다.

```bash
docker compose -f docker-compose.yml -f docker-compose.deploy.yml logs --no-color --since '실행 startedAt ISO 시각' backend ai-worker > chat-burst-server.log
```

로그 파일을 SSH/SFTP 등 기존 접속 방법으로 외부 PC에 가져온 후 실행한다. 파일럿은 `$CloudPilot`의 시작 시각과 로그로 같은 절차를 수행한다.

```powershell
$CloudServerLog = 'build/chat-burst-cloud-server.log'
node $CloudTool report --dir $CloudDir --log $CloudServerLog
Get-Content -LiteralPath (Join-Path $CloudDir 'report.md')
```

선택적으로 `evidence.sql`을 운영 DB에서 읽기 전용으로 실행해 얻은 JSON을 `report --db-evidence DB결과파일`로 넘긴다. 서버 처리 완료 시간은 DB 증거로 확인하고, 클라이언트의 폴링 관측 시간과 구분한다. 외부 부하 실행기는 DB에 직접 접속하거나 모델을 직접 호출하지 않는다.

## 로컬 재현 준비

```powershell
$RepoRoot = 'C:\path\to\UBot-BE'
Set-Location -LiteralPath $RepoRoot

node --version
k6 version
java -version
.\gradlew.bat bootJar --console=plain
```

- 부하 발생기는 Node.js 22 이상·k6 2.2 이상, 애플리케이션은 Java 21을 사용한다. 별도 npm 설치는 없다.
- 실제 모델 검증에는 chat vLLM(8000, 모델명 `ubot-chat`)과 embedding vLLM(8001, 모델명 `ubot-embedding`)이 준비되어 있어야 한다.
- 네 부하 경로를 검증하려면 활성 금지어, 검색·임베딩 데이터, 캐시 승인 FAQ와 비캐시 FAQ, `FAQ_CACHE_ENABLED=true`가 필요하다. 질문 파일 예시만 복사해도 목표 분포가 나오는 것은 아니다.
- 기존 로컬 전용 인프라를 다시 켜는 명령은 아래와 같다. 이 Compose 파일과 테스트 데이터는 Git 제외 경로에 있는 기존 검증 자산이다. 새 clone에서 이 명령만으로 같은 환경이 만들어지지는 않는다.

```powershell
docker compose -p ubot-chat-burst-live -f build/chat-burst-live/compose.yml up -d --wait
```

## 1,500건 동시 부하

이 도구는 **이미 실행 중인 BE**를 호출한다. API·Worker를 먼저 실행하고 `$Api`를 실제 API 주소로 맞춘다. 아래는 로컬 주소 예시다. 서버의 워커 동시 실행 수와 LLM 호출 상한도 실행 전에 설정해야 한다.

### 변수·질문 준비

```powershell
$BurstTool = 'tools/perf/chat-burst/cli.mjs'
$Api = 'http://127.0.0.1:18080'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$QuestionFile = 'build/chat-burst-questions.json'
$PilotDir = "build/chat-burst/pilot-$Stamp"
$BurstDir = "build/chat-burst/burst-$Stamp"

New-Item -ItemType Directory -Path build -Force | Out-Null
if (-not (Test-Path -LiteralPath $QuestionFile)) {
    Copy-Item -LiteralPath tools/perf/chat-burst/questions.example.json -Destination $QuestionFile
}
```

질문 파일의 `forbidden`, `threshold`, `cache`, `llm` 배열을 대상 DB에 맞춰 편집한다. 현재 로컬 검증의 같은 FAQ fixture를 사용하는 경우에는 `$QuestionFile = 'build/chat-burst-live/questions.json'`으로 기존 질문 집합을 재사용할 수 있다.

### 파일럿 10건

```powershell
node $BurstTool prepare --dir $PilotDir --run-id "pilot-$Stamp" --base-url $Api --questions $QuestionFile --total 10
node $BurstTool run --dir $PilotDir
node $BurstTool collect --dir $PilotDir --rps 15 --max-wait-seconds 1800
```

API와 모든 Worker의 해당 실행 로그를 확보한 뒤 집계한다. 아래 `$ServerLog`는 확보한 실제 로그 파일로 맞춘다. 하나의 BE가 API·Worker 역할을 모두 실행한다면 두 역할의 로그가 함께 든 파일 하나를 사용할 수 있다.

```powershell
$ServerLog = 'build/chat-burst-server.log'
node $BurstTool report --dir $PilotDir --log $ServerLog
```

파일럿의 목표는 `2 / 2 / 3 / 3`이다. 접수뿐 아니라 최종 `report`가 PASS인지 확인한 후 본 부하를 실행한다.

### 회원 1,500명 생성·JWT 사전 발급

```powershell
node $BurstTool prepare --dir $BurstDir --run-id "burst-$Stamp" --base-url $Api --questions $QuestionFile --total 1500
```

기존 가입·로그인 API로 회원과 JWT를 준비한다. 준비 후 오래 지났다면 실행 전에 재로그인한다.

```powershell
node $BurstTool tokens --dir $BurstDir
```

### 동시 전송 → 최종 상태 수집 → 경로 집계

```powershell
node $BurstTool run --dir $BurstDir
node $BurstTool collect --dir $BurstDir --rps 15 --max-wait-seconds 1800
node $BurstTool report --dir $BurstDir --log $ServerLog

Get-Content -LiteralPath (Join-Path $BurstDir 'report.md')
```

`run`은 k6 가상 사용자 1,500명이 공통 시각에 질문을 한 번씩 보내게 한다. `burst.js`를 직접 실행하지 않고 CLI를 사용한다. 기본값은 연결 준비 GET 사용·시작 대기 15초이며, 필요한 경우 다음처럼 실행한다. 같은 출력 폴더에 대해 `run`을 두 번 실행하지 않는다.

```powershell
# 위의 기본 run 대신 선택하는 명령이다.
node $BurstTool run --dir $BurstDir --start-delay-seconds 30 --warm-connections false
```

- `report`: 금지어 300·임계값 미달 300·캐시 450·LLM 답변 성공 450을 실제 로그와 연결한다. 로그가 없으면 처리 출처를 추측하지 않는다.
- 여러 서버 로그는 `--log API로그 --log Worker로그`처럼 반복 지정한다. `$ServerLog`에는 파일럿 이후 본 부하의 로그도 포함되어 있어야 한다.
- 선택적으로 생성된 `evidence.sql`을 대상 DB에서 읽기 전용으로 실행하고, JSON 출력을 확보해 `report --db-evidence DB결과파일`로 넘긴다. DB 증거가 있어야 폴링 관측 시각과 구분한 서버 처리 시간을 집계할 수 있다.
- 결과: `report.md`, `report.json`, `results.csv`. 회원 비밀번호·JWT가 있는 `credentials.private.json`은 공유하지 않는다.
- `prepare --concurrency`는 가입·로그인 병렬 수다. Worker 수를 바꾸는 옵션이 아니다. 4·16·32·64·128 비교는 서버 설정을 변경해 재기동한 뒤 각기 다른 출력 폴더로 실행한다.

자세한 로그 수집·증거 SQL·판정 조건은 [부하 도구 README](chat-burst/README.md)를 참고한다.

## 실제 LLM 100건 장애 테스트

### 기존 로컬 장애 실행기의 고정 전제

| 대상 | 현재 도구가 사용하는 값 |
|---|---|
| API / Worker | 18080 / 18081, 도구가 각각 별도 JVM으로 시작 |
| 전용 PostgreSQL | `ubot-chat-burst-live-postgres-1`, 포트 25432 |
| 전용 Redis | `ubot-chat-burst-live-redis-1`, 포트 26379 |
| chat / embedding | 8000 / 8001 |
| vLLM 종료 대상 | `run.mjs`에 고정된 `ubot-feat-200-vllm-1` |
| Java 실행 파일 | `C:\Program Files\Eclipse Adoptium\jdk-21.0.11.10-hotspot\bin\java.exe` |
| 기존 회원 파일 | `build/chat-burst-live/burst-1500/credentials.private.json`의 첫 100명 |

네 장애 실행기는 특정 Windows 로컬 환경에 맞춘 재현 도구다. 위 경로·컨테이너·기존 테스트 DB와 비캐시 FAQ가 준비되어 있어야 하며 새 clone에서 fixture나 컨테이너를 자동 생성하지 않는다. 특히 vLLM 컨테이너 이름과 Java 경로는 실행기에 고정돼 있으므로 값이 다르면 실행하지 말고 먼저 실행기를 매개변수화해야 한다.

**부하용 BE를 먼저 종료해 18080·18081을 비운다.** 아래 실행기가 API·Worker를 직접 시작하고 자신이 만든 JVM을 정리한다. 네 시나리오는 같은 포트·모델·DB를 사용하므로 하나씩 실행하고, 실패 시 결과를 확인한 후 다음 시나리오로 진행한다. 미완료 작업이 남아 있으면 다음 실행은 시작을 거절한다.

### 새 실행 설정 생성

같은 빌드 JAR로 비교하려면 네 실행 사이에 애플리케이션을 다시 빌드하거나 설정을 바꾸지 않는다. 결과 디렉터리는 매번 새 경로를 사용한다.

```powershell
$FaultStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$FaultRoot = "build/chat-burst-live/fault-$FaultStamp"
$MemberFile = 'build/chat-burst-live/burst-1500/credentials.private.json'
New-Item -ItemType Directory -Path $FaultRoot -ErrorAction Stop | Out-Null

foreach ($Scenario in @('worker', 'redis', 'postgres', 'vllm')) {
    $Config = [ordered]@{
        directory = "$FaultRoot/$Scenario"
        credentials = $MemberFile
    }
    if ($Scenario -eq 'redis') {
        $Config.requireOutageReadSuccess = $true
        $Config.watchQueuedJob = $true
    }
    if ($Scenario -eq 'postgres') {
        $Config.requireFastUnavailable = $true
    }
    $Config | ConvertTo-Json | Set-Content -LiteralPath "$FaultRoot/$Scenario-config.json" -Encoding utf8
}
```

새로 만든 회원을 쓰려면 `$MemberFile`을 해당 `prepare` 실행의 `credentials.private.json` 경로로 바꾼다. 이 회원들이 같은 전용 테스트 DB에 있어야 한다. 장애 실행기는 회원 100명을 다시 로그인시키므로 저장된 JWT의 만료 여부와 무관하게 새 토큰을 발급받는다.

### 시나리오별 실행

```powershell
# 워커 강제 종료 → 새 워커 기동 → heartbeat 회수
node tools/perf/worker-crash/run.mjs --config "$FaultRoot/worker-config.json"
```

```powershell
# 전용 Redis 강제 종료 → 재기동 → DB 기반 자동 재발행
node tools/perf/redis-crash/run.mjs --config "$FaultRoot/redis-config.json"
```

```powershell
# 전용 PostgreSQL 강제 종료 → 같은 볼륨으로 재기동 → 작업·조회 복구
node tools/perf/postgres-crash/run.mjs --config "$FaultRoot/postgres-config.json"
```

```powershell
# chat vLLM 강제 종료 → 재기동 → 원래 100건 자동 재시도
node tools/perf/vllm-crash/run.mjs --config "$FaultRoot/vllm-config.json" --mode auto-retry
```

vLLM 최신 검증은 `--mode auto-retry`를 사용한다. `--mode baseline`은 자동 재시도 수정 전 기준 실험과 별도 사용자 재시도 검증용이다.

worker·redis·postgres·vllm 장애 스크립트는 기동·로그인·접수·DB/Redis 조회 같은 공통 절차를 `lib/harness.mjs`에서 가져온다. 각 결과의 `harnessSha256`은 실행 스크립트와 이 공통 파일을 합친 해시다. 2026-10-23에 남긴 결과는 공통 파일로 정리하기 전 단일 스크립트 해시라서, 그 결과로 비교 보고서를 다시 만들 때는 커밋 `95af1d6`의 스크립트를 사용한다.

### 개별 결과 확인

```powershell
foreach ($Scenario in @('worker', 'redis', 'postgres', 'vllm')) {
    $Report = Get-Content -LiteralPath "$FaultRoot/$Scenario/report.json" -Raw | ConvertFrom-Json
    $Passed = if ($null -ne $Report.passed) { $Report.passed } else { $Report.verificationPassed }
    [pscustomobject]@{
        scenario = $Scenario
        passed = $Passed
        timings = $Report.timingsMs
    } | ConvertTo-Json -Depth 5
}
```

각 결과 폴더의 `report.json`, `api-final.json`, `db-final.json`, `events.json`, `cleanup.json`에 판정·답변·DB 상태·장애 시각·정리를 기록한다. vLLM은 성공 수 등을 `report.summary`에 기록한다. 성공·실패 모두 보존하며 실패를 숨기는 재접수는 하지 않는다.

독립 읽기 전용 SQL 대조 절차는 [PostgreSQL 장애 README](postgres-crash/README.md)와 [vLLM 장애 README](vllm-crash/README.md)를 참고한다. 실행기 내 검증과 추가 독립 SQL 대조를 구분한다.

### 기존 최신 증거의 통합 보고서 재생성

아래 명령은 **새 장애 실행이 아니라**, 현재 머신에 보존한 2026-10-23 네 실행의 증거를 다시 집계하는 명령이다.

```powershell
node tools/perf/fault-suite/collect.mjs build/chat-burst-live/final-suite-20261023
```

이 집계기는 개별 결과 외에 독립 SQL 대조 결과, 실행 전후 소스·JAR manifest, 집계 테스트 결과, 정리 기록을 요구한다. 위의 네 실행 명령만으로 이 추가 증거가 모두 자동 생성되는 것은 아니다. 원본은 Git 제외 경로에 있고, 저장된 공개 결과는 저장소 밖에 별도로 보관합니다. 현재 출력 파일명은 해당 날짜로 고정되어 있으므로 이 명령을 다른 실행의 범용 발행기로 사용하지 않는다.

### 검증용 DB·Redis 정지

모든 실행과 필요한 독립 SQL 대조를 마친 뒤 실행한다. 컨테이너를 정지하며 데이터·볼륨은 삭제하지 않는다.

```powershell
docker compose -p ubot-chat-burst-live -f build/chat-burst-live/compose.yml stop
```

## 도구 자체 테스트

다음은 모의 서버·고정 데이터로 도구의 판정·집계를 확인한다. 위의 실제 LLM 검증과 별개다.

```powershell
node --test tools/perf/chat-burst/tests/model.test.mjs tools/perf/chat-burst/tests/pipeline.test.mjs
node --test tools/perf/redis-crash/analysis.test.mjs tools/perf/vllm-crash/model.test.mjs
```

## 저장된 기준 자료의 위치

기존 결과는 저장소 밖으로 옮겼습니다. 날짜가 고정된 `compare-*.mjs`·`archive.mjs`는 저장소 안의 과거 결과 JSON을 입력으로 읽으므로 현재 체크아웃만으로 과거 비교를 다시 생성할 수 없습니다. 해당 입력과 실행 당시 증거를 별도로 준비해야 합니다. 실행기와 도구 자체 테스트는 유지했으며 일부 집계기의 고정 출력 경로는 변경하지 않았습니다. 새 결과는 실행 뒤 별도 보관 위치로 옮깁니다.
