# 08. 다음 방향 최종 판정 (Next Direction)

## Trigger (진입 조건)

- **표준 경로**: `06-result-review`와 `07-progress-review`의 독립 검수 결과를 HEAD가 모두 회수한 직후 진입한다.
- **단축 경로 (`06` 빠른 실패)**: `06-result-review`에서 명백한 빌드·테스트 실패 등 즉각적인 `Blockers`가 확정되어 HEAD가 `07`을 생략하고 `LOCAL_CORRECTION` 단축 전이를 선택한 직후 진입한다.

## Inputs (입력)

- `P0_ID`, `PN_ID`, `RESULT_ID`.
- `06` 결과 검수 판정(`Verified Facts`, `Open Facts`, `Blockers`, `Verdict`).
- `07` 진행 점검 보고(`Drift or Bloat Findings`, `Remaining Gaps against P0`, `Recommendation`) — 표준 경로 시 필수(`06` 단축 전이 시 생략 가능).

## Execution (수행 절차)

HEAD는 회수된 독립 리뷰 결과를 원래 사용자 합의(`P0`) 기준으로 종합해 아래 3개 경로 중 정확히 하나를 최종 결정한다.

1. **`DONE` (종료)**
   - 조건: `06`에서 차단 결함이 없고(`ACCEPT`), `07` 기준 `P0`의 모든 핵심 성공 기준이 실측 실행으로 충족됨.
   - 조치: 최종 완료 요약(달성 결과, 실측 근거, 잔여 주의사항)을 작성하고, 관련 `todo`를 `memory_update(status: "done")`으로 마감하며, **중간 `baseline` 문서(`C{k}-IDEATION`, `C{k}-PLAN`, `C{k}-PN`, `C{k}-R{k}`, `C{k}-SEED` 및 완료된 `P0`)도 `memory_update(status: "archived")` 또는 `"done"`으로 정리**해 `memory_overview`를 깔끔하게 유지한다.
2. **`LOCAL_CORRECTION` (국소 보완)**
   - 조건: `C{k}-PN` 계획과 `P0` 방향은 맞지만 `C{k}-R{k}` 구현·검증에 국소적 `Blockers`가 남아 있음(`06` 단축 전이 포함).
   - 조치: 컴팩션·재시작 이후에도 2회 재시도 에스컬레이션 규칙이 유지되도록 보완 `worklog` 또는 `RESULT`/`PN` 기준선 요약에 **`attempt: N/2`**(예: `attempt: 1/2`, `attempt: 2/2`)를 명시 기록한다. `attempt: 2/2`를 초과해 동일 결함이 반복되면 세부를 덧대지 않고 `P0` 기준선으로 복귀해 접근 전략을 재설계한다. 보완 후에는 반드시 **새로운 독립 컨텍스트**로 `06-result-review`(및 표준 완료 시 `07-progress-review`)를 다시 통과한다.
3. **`NEXT_CYCLE` (다음 사이클 진입)**
   - 조건: 이번 `C{k}-R{k}` 산출물은 `C{k}-PN` 기준으로 수용(`ACCEPT`)되었으나, `P0` 최종 목적까지 남은 핵심 간극이 존재함.
   - 조치: HEAD가 현재 달성 상태와 남은 간극·확정 제약을 담은 새 `C{k}-SEED` 기준선을 저장하고 다음 사이클 `k+1`의 `01-ideation`으로 루프한다.

## Output (`memory_save` / `memory_update` 기준선 계약)

- `NEXT_CYCLE` 선택 시 HEAD가 새 `C{k}-SEED` 기준선을 저장한다:
  - `memory_save`:
    - `type: "baseline"`, `session: "<세션명>"`, `branch: "C{k}-SEED"` (예: `C1-SEED`, `C2-SEED`)
    - `derived_from: ["<PN_ID>", "<RESULT_ID>"]`
    - `title`, `summary`, `content`(이번 사이클 확정 성과, `P0` 대비 잔여 간극, 다음 사이클 제약)
- `LOCAL_CORRECTION` 선택 시 보완 `worklog` 또는 `RESULT` 기준선 요약에 `attempt: N/2`와 대상 `Blockers`를 남긴다.
- `DONE` 선택 시 최종 `worklog` 또는 `decision` 정본을 `memory_save`로 남기고, 세션의 중간 `baseline` 문서를 `memory_update(status: "archived")` 또는 `"done"`으로, 관련 `todo`를 `memory_update(status: "done")`으로 마감한다.

## Next Step (다음 단계)

- `DONE` → 사용자에게 최종 결과와 1차 실행 근거 보고 후 종료.
- `LOCAL_CORRECTION` → `cortex_prompt(kind: "skill", name: "plan-run/steps/05-execution")`.
- `NEXT_CYCLE` → 새 `SEED_ID`를 들고 `cortex_prompt(kind: "skill", name: "plan-run/steps/01-ideation")`.
