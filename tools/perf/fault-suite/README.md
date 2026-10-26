# 장애 결과 집계와 증거 파일

[`collect.mjs`](collect.mjs)는 워커·Redis·PostgreSQL·vLLM 실험의 증거를 읽어 통합 보고서를 만듭니다. **장애를 주입하거나 네 시나리오를 실행하는 도구는 아닙니다.** 개별 실행은 [명령 가이드](../README.md#실제-llm-100건-장애-테스트)를 사용합니다.

## 입력 디렉터리

| 위치 | 요구하는 파일·내용 |
|---|---|
| 루트 | `metadata-before.json`, `metadata-after.json`: JAR·운영 소스 manifest·인프라 상태 |
| 루트 | `aggregation-tests.json`: 집계 테스트 결과 |
| `worker/`, `redis/`, `postgres/`, `vllm/` | `report.json`, `environment.json`, `submissions.json`, `api-final.json`, `db-final.json` |
| 각 시나리오 | `independent-audit.json`, `events.json`, `cleanup.json`, `immediately-before-kill.json`, `api-health.json` |
| Redis·PostgreSQL | `outage-job-reads.json` |
| vLLM | `api-job-reads.json`, `db-snapshots.json` |

네 실행기만 돌려서는 독립 SQL 대조·전후 manifest 등 모든 입력이 생기지 않습니다. 원본 증거를 준비한 뒤 같은 JAR·소스·환경의 결과인지 대조해야 합니다. 입력 폴더는 현재 Windows 구현에서 저장소 `build/` 아래로 제한합니다.

## 집계에서 검사하는 것

실제 LLM 사용, 동시 실행 4, 실행 제한 180초, 장애 직전 RUNNING 4·QUEUED 96, 최종 성공 100, 독립 SQL의 소유권·중복·누락 여부, 자신이 만든 프로세스 종료 여부 등을 검사합니다. vLLM은 재시도 중 시작 시각·마감 시각이 유지되고 heartbeat가 진행되는지도 확인합니다.

HTTP 응답과 최종 답변 성공을 구분하고, 지연을 관측하지 않은 경우 수치를 추정하지 않습니다. 중복은 저장 답변을 기준으로 집계합니다.

## 출력과 과거 결과 보존

현재 출력 경로는 원본 `tools/perf/fault-suite/results/20261023-latest-code.json` 및 `.md`로 고정되어 있습니다. 다른 날짜 실험을 입력하면 기존 결과를 덮어쓸 수 있으므로 범용 보고서 발행 명령으로 사용하지 않습니다. 기존 원본 증거를 동일 조건으로 재집계하는 경우의 형식은 다음과 같습니다.

```powershell
node tools/perf/fault-suite/collect.mjs build/chat-burst-live/final-suite-20261023
```

현재 환경에 해당 증거가 모두 있을 때만 가능합니다. 저장된 과거 보고서는 별도 보관하며 각 실행의 날짜·JAR·실행 횟수를 섞지 않습니다.

`postgres-crash`와 `vllm-crash`의 `prepare-audit.mjs`는 독립 검사용 SQL을 준비하고, `compare-*.mjs`·`archive.mjs`는 기존 비교·공개 결과 정리를 담당합니다. 이 도구들의 경로·날짜·증거 형식은 해당 [PostgreSQL 안내](../postgres-crash/README.md)와 [vLLM 안내](../vllm-crash/README.md)를 따릅니다. 새 실험 결과를 기존 기록에 덮어쓰지 않습니다.

## 저장된 기준 자료의 위치

기존 결과는 저장소 밖으로 옮겼습니다. 날짜가 고정된 `compare-*.mjs`·`archive.mjs`는 저장소 안의 과거 결과 JSON을 입력으로 읽으므로 현재 체크아웃만으로 과거 비교를 다시 생성할 수 없습니다. 해당 입력과 실행 당시 증거를 별도로 준비해야 합니다. 실행기와 도구 자체 테스트는 유지했으며 일부 집계기의 고정 출력 경로는 변경하지 않았습니다. 새 결과는 실행 뒤 별도 보관 위치로 옮깁니다.
