# 벡터 검색·미응답 저장 벤치마크

현재 `develop`에는 검색 자체와 미응답 후처리를 측정하는 두 도구가 있습니다. 각 결과의 시간 범위와 입력을 구분합니다.

## 벡터 검색

[`run-vector-search-benchmark.ps1`](run-vector-search-benchmark.ps1)은 Windows Gradle wrapper로 `VectorSearchBenchmarkTest`를 지정 실행합니다. `RUN_VECTOR_SEARCH_BENCHMARK=true`를 임시 설정하고 종료 시 기존 값을 복구합니다.

```powershell
# UBot-BE 루트, JDK·Docker 필요
.\tools\perf\run-vector-search-benchmark.ps1
```

`--rerun-tasks`로 이전 테스트 결과 재사용을 막습니다. 결과는 기본 `build/vector-search-benchmark/summary.json`이며 테스트가 지원하는 `VECTOR_BENCHMARK_OUTPUT`으로 바꿀 수 있습니다. DB 벡터 검색 비교이므로 실제 LLM 답변 완료 시간을 나타내지 않습니다.

## 미응답·Outbox 저장 지연

[`unanswered_outbox_perf.py`](unanswered_outbox_perf.py)는 기존 계정으로 로그인한 뒤 고정 질문을 **순차 전송**하고 작업이 종료될 때까지 조회합니다. DB를 직접 읽어 답변 완료 시각과 미응답 저장 시각을 비교합니다.

```powershell
python -X utf8 tools/perf/unanswered_outbox_perf.py local-outbox --email <테스트계정이메일> --base-url http://localhost:8080 --container <로컬PostgreSQL컨테이너> --db ubot --rounds 2 --wait 10
```

| 입력 | 기본값·동작 |
|---|---|
| `label` | 필수 위치 인자. 출력에 표시할 실험 이름 |
| `--email` | 필수. 비밀번호는 `UBOT_ADMIN_PASSWORD` 또는 대화형 입력 |
| `--base-url` | `http://localhost:8080` |
| `--container`, `--db` | `ubot-be-postgres-1`, `ubot`. SQL 사용자명은 코드에 `ubot`으로 고정 |
| `--rounds` | 2. 준비 질문 1건 이후 고정 질문 20개 × 반복 수 |
| `--wait` | 10초. 모든 질문 후 미응답 저장을 기다리는 시간 |

HTTP 요청 한 번의 제한은 120초이고 작업 폴링 간격은 50ms입니다. 전체 폴링 반복에 별도 마감 시각이 없으므로 장기 장애용 도구로 사용하지 않습니다. 대상 API에는 실제 질문·작업·대화·미응답 데이터가 생성되며 자동 삭제하지 않습니다.

출력은 사용자 관측 중앙값, DB 작업 시간, 미응답 저장 수, 답변 완료→미응답 저장 지연, Outbox 잔여 행입니다. DB 조회는 실행 시작 시각 이후 전체 작업을 대상으로 하므로 다른 테스트가 함께 실행되면 섞일 수 있습니다. 시각과 DB를 분리한 실험 환경에서 읽습니다. 표준 출력만 제공하므로 새 결과를 보관할 때는 별도 로그 파일로 남깁니다.

측정 결과는 코드 commit, 데이터, 모델, 하드웨어, 동시성 조건과 함께 별도 결과 보관 위치에 기록합니다.

[부하·장애 명령어](README.md) · [집계 도구](fault-suite/README.md)
