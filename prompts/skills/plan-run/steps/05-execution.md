# 05. 경계 실행 및 실측 증명 (Execution — Rn)

## Trigger (진입 조건)

- `04-plan-acceptance`에서 실행 기준선 `PN_ID`가 저장된 직후, 또는 `08-next-direction`에서 `LOCAL_CORRECTION` 판정을 받아 국소 보완을 수행할 때 진입한다.

## Inputs (입력)

- `PN_ID` (`memory_read`로 확인한 확정 규격·파일 경계·대표 검증 명령).
- 국소 보완 복귀 시: `06-result-review`의 `Blockers`와 직전 `RESULT_ID`.
- 위임 규약: `cortex_prompt(kind: "skill", name: "delegate")` (필요 시 `start-job` 참조).

## Execution (수행 절차)

1. HEAD는 `PN`의 작업 단위에 따라 `delegate` 규약으로 Entry Contract 5요소를 작성해 워커(`developer` 또는 `coder`)에 위임한다.
   - 독립 파일 소유권이 완전히 분리된 작업들은 병렬 워커 또는 Herdr 격리 탭(`relay_tabs` → `relay_send(to_terminal_id, message, context_docs: [PN_ID], wake: "auto")`)으로 실행할 수 있다.
2. 워커는 변경 경계 안에서만 구현하며, 명세 모호성이나 계약 충돌을 발견하면 임의 수정 없이 즉시 `contract_conflict`를 HEAD에 반환한다.
3. 완료 보고 전 반드시 실제 환경에서 대표 경로(실제 입력 → 실제 출력)와 계획된 테스트를 실행해 정확한 명령과 관측 출력을 확보한다.
4. HEAD는 워커의 패키징된 산출물(변경 파일, 실행 명령과 실제 출력, 제약·예외·불확실성)을 회수해 `PN` 대비 누락이 없는지 확인한다.

## Output (`memory_save` 기준선 계약)

HEAD가 실행 결과 기준선 `RESULT`를 저장한다.

- `memory_save`:
  - `type: "baseline"`, `session: "<세션명>"`, `branch: "Rn"`
  - `derived_from: ["<PN_ID>"]`
  - `supersedes: "<이전_RESULT_ID>"` (`LOCAL_CORRECTION` 재실행 시 지정)
  - `files`: 실제 생성·수정된 상대 경로 목록
  - `title`, `summary`, `content`(변경 요약, 실제 실행 명령 및 관측 결과, 잔여 제약·예외)

## Next Step (다음 단계)

- `RESULT_ID` 저장 완료 시 → `cortex_prompt(kind: "skill", name: "plan-run/steps/06-result-review")`.
- 워커가 `contract_conflict`를 반환해 `PN` 자체 수정이 필요하면 `02-execution-planning`으로 복귀한다.
