# 03. 최소성 계획 검수 (Minimum Plan Review)

## Trigger (진입 조건)

- `02-execution-planning`에서 `PLAN_ID`가 저장(또는 보완 재작성)된 직후 진입한다.

## Inputs (입력)

- `P0_ID`와 `PLAN_ID` (작성 과정의 변명·설득 없이 1차 문서 ID만 전달).
- 검수 기준: `cortex_prompt(kind: "agent", name: "reviewer")` + `cortex_prompt(kind: "standard", name: "DEVELOPMENT_STANDARD")`.

## Execution (수행 절차)

1. HEAD는 계획 작성 맥락과 완전히 분리된 **새 독립 컨텍스트 에이전트**를 기동한다(포크 금지).
2. 새 컨텍스트에 `P0_ID`와 `PLAN_ID`만 제공하고 `memory_read`로 직접 읽게 한다.
3. 리뷰어는 아래 최소성 기준에 따라 `PLAN`을 비판적으로 점검한다.
   - **목적 정합성**: `PLAN`의 각 항목이 `P0` 달성에 직접 기여하는가.
   - **과잉 설계 배제**: 현재 요구가 없는 추상화·옵션·중간 계층·신규 영속 상태·불필요한 테스트가 섞이지 않았는가.
   - **수단화 경계**: 도구·리팩토링·형식 채우기가 본래 문제 해결보다 앞서고 있지 않은가.
4. 리뷰어는 `Verified Facts` / `Blockers` / `Minor Notes` / `Verdict`(`ACCEPT` 또는 `NEEDS_FIX`)를 반환한다. 불필요한 지적 없이 통과하면 `ACCEPT (Clean Evaluation)`을 정상 판정으로 본다.

## Output (`memory_save` 기준선 계약)

- 검수 결과는 별도 기준선을 남발하지 않고, HEAD가 `Verdict`와 핵심 `Blockers`만 요약해 다음 단계 전이 근거로 기록한다.
- 필요 시 `memory_update(id: PLAN_ID, append_content: "...")`로 `03` 최소성 검수 통과/보완 이력을 1~3줄 남긴다.

## Next Step (다음 단계)

- HEAD가 `ACCEPT` 판정 시 → `cortex_prompt(kind: "skill", name: "plan-run/steps/04-plan-acceptance")`.
- HEAD가 `NEEDS_FIX` 판정 시 → 불필요 항목을 제거해 `02-execution-planning`으로 복귀(수정 후 새 독립 컨텍스트로 `03` 재검수).
