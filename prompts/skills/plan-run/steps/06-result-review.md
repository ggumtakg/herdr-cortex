# 06. 결과 독립 검수 (Result Review)

## Trigger (진입 조건)

- `05-execution`에서 실행 결과 기준선 `RESULT_ID`가 저장된 직후 진입한다(`LOCAL_CORRECTION` 재실행 후에도 반드시 다시 거친다).

## Inputs (입력)

- `PN_ID`, `RESULT_ID`, 실제 변경 파일 및 diff, 실제 실행·테스트 관측 출력.
- 검수 절차 및 역할: `cortex_prompt(kind: "skill", name: "independent-review")`, `cortex_prompt(kind: "agent", name: "reviewer")`, `cortex_prompt(kind: "standard", name: "DEVELOPMENT_STANDARD")`.

## Execution (수행 절차)

1. HEAD는 구현 워커 및 직전 리뷰와 완전히 단절된 **새 독립 컨텍스트 에이전트**를 기동한다.
2. `independent-review` 규약에 따라 작성자의 변명·합리화 없이 1차 근거(`PN_ID`, `RESULT_ID`, 실제 변경 파일/diff, 실측 실행 로그)만 공급한다.
3. 리뷰어는 코드를 수정하지 않고 아래 항목을 직접 확인한다.
   - `PN`의 모든 요구사항과 변경 경계가 실제 파일에 충실히 반영되었는가.
   - 대표 실행 증명이 실제 환경의 실제 입력→출력으로 성립하며 실패·누락이 없는가.
   - `DEVELOPMENT_STANDARD` 기준(불필요한 추가, 경계 검증, 영속 상태 소유권, 테스트 과잉/누락)에 어긋나지 않는가.
4. 리뷰어는 `Verified Facts (확인된 사실)` / `Open Facts (미결 사실)` / `Blockers (필수 수정)` / `Minor Notes (참고 사항)` / `Verdict (판정: ACCEPT | NEEDS_FIX)` 5개 구획으로 구조화해 반환한다.

## Output (`memory_save` 기준선 계약)

- HEAD가 `06` 결과 검수 판정(`Verdict`, 핵심 `Verified Facts`, 미결 `Open Facts`, `Blockers`)을 정리해 `memory_update(id: RESULT_ID, append_content: "...")`로 1차 검수 기록을 남긴다.

## Next Step (다음 단계)

- `06` 판정 요약을 들고 `cortex_prompt(kind: "skill", name: "plan-run/steps/07-progress-review")`로 이동한다.
- 단, 명백한 빌드·테스트 실패 등 즉각적인 `Blockers`가 확정되어 전체 진행 점검을 할 실익이 없다면 HEAD 판단으로 `08-next-direction`의 `LOCAL_CORRECTION` 경로로 단축 전이할 수 있다.
