# 04. 계획 독립 수용 (Plan Acceptance)

## Trigger (진입 조건)

- `03-minimum-plan-review`에서 HEAD가 최소성 통과(`ACCEPT`)를 확정한 직후 진입한다.

## Inputs (입력)

- `SEED_ID`(1사이클에서는 `P0_ID`), `PLAN_ID`, 관련 기존 코드 경로.
- 검수 기준: `cortex_prompt(kind: "agent", name: "reviewer")` + `cortex_prompt(kind: "standard", name: "DEVELOPMENT_STANDARD")`.

## Execution (수행 절차)

1. HEAD는 `02` 작성 맥락 및 `03` 리뷰 맥락과도 분리된 **새 독립 컨텍스트 에이전트**를 기동한다.
2. 새 컨텍스트에 `SEED_ID`와 `PLAN_ID`를 제공하고 `memory_read` 및 관련 실제 파일을 직접 확인하게 한다.
3. 리뷰어는 실행 착수 전 최종 수용 기준을 검증한다.
   - `SEED`의 목표와 확정 계약을 빠짐없이 충족하는가(누락 요구사항 여부).
   - 변경 경계, 파일 소유권, 실패/원자성 처리, 대표 실행 증명 기준이 모호함 없이 실행 가능한가.
   - 기존 코드·계약과의 숨은 충돌이 없는가.
4. 리뷰어가 `Verified Facts` / `Blockers` / `Minor Notes` / `Verdict`(`ACCEPT` 또는 `NEEDS_FIX`)를 반환하면 HEAD가 최종 수용을 판정한다.

## Output (`memory_save` 기준선 계약)

HEAD가 수용을 확정하면 실행 기준선 `PN`을 저장한다.

- `memory_save`:
  - `type: "baseline"`, `session: "<세션명>"`, `branch: "PN"`
  - `derived_from: ["<SEED_ID>", "<PLAN_ID>"]`
  - `files`: 확정된 수정 대상 상대 경로 목록
  - `title`, `summary`, `content`(최종 수용된 실행 규격, Entry Contract 경계, 대표 증명 기준)

## Next Step (다음 단계)

- `PN_ID` 저장 완료 시 → `cortex_prompt(kind: "skill", name: "plan-run/steps/05-execution")`.
- `NEEDS_FIX` 시 → `02-execution-planning`으로 복귀해 수정(범위·구조 변경이 크면 `03`부터, 국소 명세 보완이면 새 컨텍스트로 `04` 재수용).
