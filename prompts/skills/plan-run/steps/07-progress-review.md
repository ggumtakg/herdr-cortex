# 07. 전체 진행 방향 점검 (Progress Review)

## Trigger (진입 조건)

- `06-result-review`가 완료되어 `RESULT_ID`와 결과 검수 판정이 확보된 직후 진입한다.

## Inputs (입력)

- `P0_ID`, `PN_ID`, `RESULT_ID`, `06` 검수 요약.
- 다사이클 계보 그래프: `memory_graph(target: RESULT_ID, depth: 8, direction: "out")` (및 필요 시 `memory_graph(target: P0_ID, depth: 8, direction: "in")`).
- 역할 코어: `cortex_prompt(kind: "agent", name: "reviewer")`.

## Execution (수행 절차)

1. HEAD는 `05` 실행 및 `06` 세부 검수 맥락과 분리된 **새 독립 컨텍스트 에이전트**를 기동한다.
2. 리뷰어는 `P0` 기준선과 `memory_graph`로 연결된 다사이클 전체 계보(`P0` → `C{k}-IDEATION` → `C{k}-PLAN` → `C{k}-PN` → `C{k}-R{k}` 및 이전 `C{k-1}-SEED`)를 저·중해상도 관점에서 점검한다.
   - **방향 정합성**: 지금까지의 누적 산출물이 원래 `P0` 사용자 목적을 향해 직선으로 가까워지고 있는가, 아니면 표류(drift)하고 있는가.
   - **비대화 점검**: 사이클이 반복되면서 불필요한 구조·규칙·부채가 누적되고 있지 않은가.
   - **잔여 간극**: `P0`의 최종 성공 기준 대비 아직 남아 있는 핵심 간극이 무엇인가(또는 이미 모두 충족되었는가).
3. 리뷰어는 수정 없이 `Verified Facts (확인된 사실)` / `Open Facts (미결 사실)` / `Drift or Bloat Findings` / `Remaining Gaps against P0` / `Recommendation`(`DONE` / `LOCAL_CORRECTION` / `NEXT_CYCLE`)을 반환한다.

## Output (`memory_save` 기준선 계약)

- 별도 문서를 난립시키지 않고, HEAD가 `07` 진행 점검 요약을 `08-next-direction`의 최종 판정 입력으로 통합한다.

## Next Step (다음 단계)

- `06`과 `07` 결과를 함께 들고 `cortex_prompt(kind: "skill", name: "plan-run/steps/08-next-direction")`으로 이동한다.
