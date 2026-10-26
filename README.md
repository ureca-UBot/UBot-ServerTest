# UBot ServerTest

U-Bot의 채팅 부하 시험, 장애 복구, 알림 수신, 관리자 화면 검증에 사용한 도구와 결과를 모았습니다.

| 구분 | 도구·결과 | 확인한 내용 |
|---|---|---|
| 채팅 E2E | [chat-e2e](chat-e2e/README.md) | 로컬 동시성 비교, AWS 반복 질문 시험, 서로 다른 질문 6,000건 재시험 |
| 장애 복구 | [fault-recovery](fault-recovery/README.md) | Worker·Redis·PostgreSQL·vLLM 중단 후 작업 회수·답변 저장 |
| Discord 알림 | [discord-alerts](discord-alerts/README.md) | 기존 FIRING·RESOLVED 수신 기록, 알림 설정 생성기·검증 결과 |
| 통신지도 | [telemap](telemap/README.md) | AWS 지도·지역 필터·급증 알림 상세, API·DB 대조와 화면 캡처 |
| 미응답 질문 클러스터링 | [unanswered-clustering](unanswered-clustering/README.md) | 미응답 저장·묶음 집계·상세 조회, API·DB 대조와 화면 캡처 |

2026-10-26 AWS 최종 재시험은 3,000건씩 두 번 실행했습니다. 총 6,000건을 모두 접수했고, 답변 5,666건·정상 거절 330건·시스템 오류 4건(LLM-005)이 나왔습니다. 연결 시간 초과·CHAT-016·LLM-003은 0건입니다. [상세 결과와 이전 실행 비교](chat-e2e/results/20261026-aws/README.md)

부하 요청은 `https://u-bot.cloud/api`의 FE Nginx를 거쳐 BE·Worker·모델·저장소까지 실행했습니다. 브라우저 3,000개로 React 화면을 조작한 시험과는 구분합니다. 통신지도와 미응답 관리 화면은 실제 FE에서 로그인해 확인했습니다.

`tools/perf`에는 기존 실행기를 보관했고, 3,000명·HTTP 300초 버전은 `chat-e2e/tools/k6`에 별도로 두었습니다. 비밀번호·JWT·Webhook·AWS 자격증명·Terraform state/plan은 포함하지 않았습니다. 복사한 원본의 출처와 해시는 [provenance](provenance/README.md)에 있습니다.
