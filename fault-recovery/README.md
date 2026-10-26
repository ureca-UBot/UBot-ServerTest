# 장애 복구 시험

2026-10-23 로컬에서 실제 Qwen3-4B·BGE-M3와 별도 API/Worker를 사용해 네 종류의 장애를 주입했습니다. 각 실행에 새 작업 100건을 접수한 뒤 Worker·Redis·PostgreSQL·vLLM 중 하나만 중단하고 복구했습니다.

| 장애 | 최종 성공 | 유실·중복 저장·실패·타임아웃 | 원래 100건 완료 시간 |
|---|---:|---|---:|
| Worker 종료 | 100/100 | 모두 0 | 85.44초 |
| Redis 강제 종료 | 100/100 | 모두 0 | 66.94초 |
| PostgreSQL 강제 종료 | 100/100 | 모두 0 | 82.55초 |
| vLLM 강제 종료 | 100/100 | 모두 0 | 131.55초 |

[당시 조건·복구 타이밍·독립 SQL 감사](results/20261023-local/summary.md) · [통합 JSON과 증거 해시](results/20261023-local/fault-suite/results/20261023-latest-code.json)

Worker heartbeat 회수, Redis 재발행, PostgreSQL WAL 복구, 모델 준비 후 자동 재시도를 확인했습니다. 사용자 재시도 API는 호출하지 않았습니다. 중복 0은 저장 답변 기준이며 외부 모델 계산이 단 한 번이었다는 뜻은 아닙니다. 각 시나리오를 한 번 실행한 로컬 결과이므로 AWS 장기 장애·동시 다중 장애 성능으로 확대하지 않습니다.

## 사용 도구

- [Worker 실행기](../tools/perf/worker-crash/README.md)
- [Redis 실행기·집계](../tools/perf/redis-crash/README.md)
- [PostgreSQL 실행기·조회 제한 비교](../tools/perf/postgres-crash/README.md)
- [vLLM 실행기·재시도 비교](../tools/perf/vllm-crash/README.md)
- [통합 집계](../tools/perf/fault-suite/README.md)

공통 실행기는 `UBOT_BACKEND_ROOT`의 BE JAR·Compose를 사용합니다. 기본 경로는 이 저장소와 나란한 `UBot-BE`입니다. `UBOT_JAVA` 또는 `JAVA_HOME`으로 Java 21을 지정할 수 있습니다. 기존 실행기는 Windows 로컬 전용 PostgreSQL·Redis 컨테이너를 대상으로 하며 운영 환경을 대상으로 실행하지 않습니다.

`results/20261023-local`에는 원래 집계와 비교 결과를 보존했습니다. `evidence/final-suite-20261023`에는 당시의 작업·DB·독립 감사·중단/정리 이벤트를 선별 보관했습니다. 인증 파일과 로그 원문은 포함하지 않았습니다.
