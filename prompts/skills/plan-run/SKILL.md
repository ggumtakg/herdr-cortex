---
name: plan-run
description: 다단계 자율 기획·독립 검수·실행·진행 점검 8단계 파이프라인. 호스트에 종속되지 않고 baseline 문서와 derived_from 그래프로 P0/SEED/PLAN/PN/Rn 계보를 영속화한다.
---

# 다단계 자율 운영 파이프라인 (plan-run)

여러 사이클에 걸쳐 기획, 최소성 검수, 독립 수용, 실행, 결과 검수, 전체 방향 점검을 반복해야 하는 중대형 작업을 수행할 때 사용한다.

## 호스트 중립 아키텍처

- 특정 CLI의 세션 포크나 중첩 실행에 의존하지 않고, 각 단계의 기준선을 `memory_save(type: "baseline")` 문서와 `derived_from` 엣지 체인으로 영속화한다.
- Claude Code의 네이티브 서브에이전트, Antigravity CLI의 서브에이전트, 또는 Herdr 격리 탭(`relay_tabs` + `relay_send`) 어느 환경에서도 동일한 8단계 흐름으로 동작한다.
- 정본 기준선 쓰기(`memory_save`/`memory_update`)는 항상 HEAD만 수행하며, 모든 검수 단계(`03`, `04`, `06`, `07`)는 작성·실행 맥락과 분리된 **새 독립 컨텍스트**에서 실행한다.

## 기준선 계보 (`type: "baseline"`)

```text
P0 (최초 사용자 목적, branch: "P0")
 └─ IDEATION (이번 사이클 단기 목표, branch: "IDEATION", derived_from: [SEED_ID])
     └─ PLAN (구체 실행 규격, branch: "PLAN", derived_from: [IDEATION_ID])
         └─ PN (독립 수용 완료 기준선, branch: "PN", derived_from: [SEED_ID, PLAN_ID])
             └─ RESULT (Rn 실행 결과 + 실측 근거, branch: "Rn", derived_from: [PN_ID])
                 └─ SEED (다음 사이클 시드, branch: "SEED", derived_from: [PN_ID, RESULT_ID])
```

- 1사이클에서는 `SEED_ID = P0_ID`로 시작한다.
- `memory_graph(target: "<기준선_ID>", depth: 3, direction: "both")`로 언제든 전체 계보와 역방향 파생 내역을 추적한다.

## 8단계 실행 라우터

각 단계에 진입할 때 `cortex_prompt(kind: "skill", name: "plan-run/steps/<단계명>")`로 해당 단계 지침을 로드해 수행한다.

| 순서 | 단계 파일 (`cortex_prompt` 이름) | 실행 컨텍스트 | 핵심 역할 |
| :---: | :--- | :--- | :--- |
| 01 | `plan-run/steps/01-ideation` | HEAD (또는 조사 포크) | `P0` 확정 및 이번 사이클 단기 목표(`IDEATION`) 도출 |
| 02 | `plan-run/steps/02-execution-planning` | HEAD (또는 설계 워커) | 단기 목표를 구체 실행 규격(`PLAN`)으로 전환 |
| 03 | `plan-run/steps/03-minimum-plan-review` | **새 독립 컨텍스트 (`reviewer`)** | `P0` 기준 최소성·과잉설계·수단화 여부 검수 |
| 04 | `plan-run/steps/04-plan-acceptance` | **새 독립 컨텍스트 (`reviewer`)** | `SEED` 기준 계획 적합성 수용 → HEAD가 `PN` 저장 |
| 05 | `plan-run/steps/05-execution` | 경계 워커(`delegate`) / 격리 탭 | `PN`에 따라 `Rn` 구현 및 실제 실행 증명 → `RESULT` 저장 |
| 06 | `plan-run/steps/06-result-review` | **새 독립 컨텍스트 (`independent-review`)** | `PN` 기준 `Rn` 산출물·실측 출력 독립 검수 |
| 07 | `plan-run/steps/07-progress-review` | **새 독립 컨텍스트 (`reviewer`)** | `P0` 기준 전체 궤적·표류·비대화 여부 점검 |
| 08 | `plan-run/steps/08-next-direction` | HEAD 최종 판정 | `DONE` / `LOCAL_CORRECTION` / `NEXT_CYCLE` 결정 |

## 중단 및 에스컬레이션 규칙

- `03`·`04`·`06`·`07`에서 원래 `P0` 목적 자체의 변경이나 사용자 의사결정이 필요한 모순이 발견되면 자율 진행을 멈추고 HEAD가 사용자에게 1차 근거와 선택지를 보고한다.
- 동일 단계에서 보완이 2회 이상 반복되면 세부를 덧대지 않고 HEAD가 `P0` 기준선으로 올라가 접근 전략을 재설계한다.
