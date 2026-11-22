# 08. 다음 방향 최종 판정 (Next Direction)

## Trigger (진입 조건)

- `06-result-review`와 `07-progress-review`의 독립 검수 결과를 HEAD가 모두 회수한 직후 진입한다.

## Inputs (입력)

- `P0_ID`, `PN_ID`, `RESULT_ID`.
- `06` 결과 검수 판정(`Verified Facts`, `Blockers`, `Verdict`).
- `07` 진행 점검 보고(`Drift or Bloat Findings`, `Remaining Gaps against P0`, `Recommendation`).

## Execution (수행 절차)

HEAD는 두 독립 리뷰 결과를 원래 사용자 합의(`P0`) 기준으로 종합해 아래 3개 경로 중 정확히 하나를 최종 결정한다.

1. **`DONE` (종료)**
   - 조건: `06`에서 차단 결함이 없고(`ACCEPT`), `07` 기준 `P0`의 모든 핵심 성공 기준이 실측 실행으로 충족됨.
   - 조치: HEAD가 최종 완료 요약(달성 결과, 실측 근거, 잔여 주의사항)을 작성하고 관련 `todo`를 `memory_update(status: "done")`으로 마감한다.
2. **`LOCAL_CORRECTION` (국소 보완)**
   - 조건: `PN` 계획과 `P0` 방향은 맞지만 `Rn` 구현·검증에 국소적 `Blockers`가 남아 있음.
   - 조치: `PN_ID`와 `06`의 `Blockers`를 근거로 `05-execution`으로 복귀해 수정한다. 수정 후에는 반드시 **새로운 독립 컨텍스트**로 `06-result-review`(및 필요 시 `07-progress-review`)를 다시 통과한다.
3. **`NEXT_CYCLE` (다음 사이클 진입)**
   - 조건: 이번 `Rn` 산출물은 `PN` 기준으로 수용(`ACCEPT`)되었으나, `P0` 최종 목적까지 남은 핵심 간극이 존재함.
   - 조치: HEAD가 현재 달성 상태와 남은 간극·확정 제약을 담은 새 `SEED` 기준선을 저장하고 `01-ideation`으로 루프한다.

## Output (`memory_save` 기준선 계약)

- `NEXT_CYCLE` 선택 시 HEAD가 새 `SEED` 기준선을 저장한다:
  - `memory_save`:
    - `type: "baseline"`, `session: "<세션명>"`, `branch: "SEED"`
    - `derived_from: ["<PN_ID>", "<RESULT_ID>"]`
    - `title`, `summary`, `content`(이번 사이클 확정 성과, `P0` 대비 잔여 간극, 다음 사이클 제약)
- `DONE` 선택 시 최종 `worklog` 또는 `decision` 정본을 `memory_save`로 남기고 `P0` 세션을 마무리한다.

## Next Step (다음 단계)

- `DONE` → 사용자에게 최종 결과와 1차 실행 근거 보고 후 종료.
- `LOCAL_CORRECTION` → `cortex_prompt(kind: "skill", name: "plan-run/steps/05-execution")`.
- `NEXT_CYCLE` → 새 `SEED_ID`를 들고 `cortex_prompt(kind: "skill", name: "plan-run/steps/01-ideation")`.
