---
name: plan-run
description: 다단계 자율 기획·독립 검수·실행·진행 점검 8단계 파이프라인. 호스트에 종속되지 않고 baseline 문서와 derived_from 그래프로 P0 및 사이클별 C{k}-* 계보를 영속화한다.
---

# 다단계 자율 운영 파이프라인 (plan-run)

여러 사이클에 걸쳐 기획, 최소성 검수, 독립 수용, 실행, 결과 검수, 전체 방향 점검을 반복해야 하는 중대형 작업을 수행할 때 사용한다.

## 호스트 중립 아키텍처

- 특정 CLI의 세션 포크나 중첩 실행에 의존하지 않고, 각 단계의 기준선을 `memory_save(type: "baseline")` 문서와 `derived_from` 엣지 체인으로 영속화한다.
- Claude Code의 네이티브 서브에이전트, Antigravity CLI의 서브에이전트, 또는 Herdr 격리 탭(`relay_tabs` + `relay_send`) 어느 환경에서도 동일한 8단계 흐름으로 동작한다.
- 정본 기준선 쓰기(`memory_save`/`memory_update`)는 항상 HEAD만 수행하며, 모든 검수 단계(`03`, `04`, `06`, `07`)는 작성·실행 맥락과 분리된 **새 독립 컨텍스트**에서 실행한다.

## 기준선 계보 및 사이클 브랜치 명명 (`type: "baseline"`)

다사이클 실행 시 브랜치 충돌을 막기 위해 최초 목표는 `P0`로 고정하고, 매 사이클 `k` (`k = 1, 2, ...`)마다 `C{k}-IDEATION`, `C{k}-PLAN`, `C{k}-PN`, `C{k}-R{k}`, `C{k}-SEED` 명명을 사용한다(예: `C1-PLAN`, `C1-PN`, `C1-R1`, `C1-SEED`, `C2-PLAN`).

```text
P0 (최초 사용자 목적, branch: "P0")
 └─ C1-IDEATION (1사이클 단기 목표, branch: "C1-IDEATION", derived_from: [P0_ID])
     └─ C1-PLAN (구체 실행 규격, branch: "C1-PLAN", derived_from: [IDEATION_ID])
         └─ C1-PN (독립 수용 완료 기준선, branch: "C1-PN", derived_from: [SEED_ID, PLAN_ID])
             └─ C1-R1 (실행 결과 + 실측 근거, branch: "C1-R1", derived_from: [PN_ID])
                 └─ C1-SEED (다음 사이클 시드, branch: "C1-SEED", derived_from: [PN_ID, RESULT_ID])
                     └─ C2-IDEATION → C2-PLAN → C2-PN → C2-R2 → ...
```

- 1사이클에서는 `SEED_ID = P0_ID`로 시작하며, 활성 `P0` 기준선은 `memory_overview` 예산 축약 시에도 우선 보호된다.
- `memory_graph(target: "<기준선_ID>", depth: 8, direction: "both")` (또는 `RESULT_ID`에서 `direction: "out"`, `P0_ID`에서 `direction: "in"`)로 다사이클 전체 계보와 역방향 파생 내역을 추적한다.

## 8단계 실행 라우터

각 단계에 진입할 때 `cortex_prompt(kind: "skill", name: "plan-run/steps/<단계명>")`로 해당 단계 지침을 로드해 수행한다.

| 순서 | 단계 파일 (`cortex_prompt` 이름) | 실행 컨텍스트 | 핵심 역할 |
| :---: | :--- | :--- | :--- |
| 01 | `plan-run/steps/01-ideation` | HEAD (또는 조사 포크) | `P0` 확정 및 이번 사이클 단기 목표(`C{k}-IDEATION`) 도출 |
| 02 | `plan-run/steps/02-execution-planning` | HEAD (또는 설계 워커) | 단기 목표를 구체 실행 규격(`C{k}-PLAN`)으로 전환 |
| 03 | `plan-run/steps/03-minimum-plan-review` | **새 독립 컨텍스트 (`reviewer`)** | `P0` 기준 최소성·과잉설계·수단화 여부 검수 |
| 04 | `plan-run/steps/04-plan-acceptance` | **새 독립 컨텍스트 (`reviewer`)** | `SEED` 기준 계획 적합성 독립 수용 → HEAD가 `C{k}-PN` 저장 |
| 05 | `plan-run/steps/05-execution` | 경계 워커(`delegate`) / 격리 탭 | `C{k}-PN`에 따라 구현·실측 증명 → `C{k}-R{k}` 저장 |
| 06 | `plan-run/steps/06-result-review` | **새 독립 컨텍스트 (`independent-review`)** | `C{k}-PN` 기준 `C{k}-R{k}` 산출물·실측 출력 독립 검수 |
| 07 | `plan-run/steps/07-progress-review` | **새 독립 컨텍스트 (`reviewer`)** | `P0` 기준 다사이클 전체 궤적·표류·비대화 여부 점검 |
| 08 | `plan-run/steps/08-next-direction` | HEAD 최종 판정 | `DONE`(중간 기준선 아카이브) / `LOCAL_CORRECTION` / `NEXT_CYCLE`(`C{k}-SEED`) 결정 |

## 중단 및 에스컬레이션 규칙

- `03`·`04`·`06`·`07`에서 원래 `P0` 목적 자체의 변경이나 사용자 의사결정이 필요한 모순이 발견되면 자율 진행을 멈추고 HEAD가 사용자에게 1차 근거와 선택지를 보고한다.
- 동일 단계 보완(`LOCAL_CORRECTION` 등) 시 컴팩션·재시작 이후에도 횟수를 추적할 수 있도록 작업 기록/기준선 요약에 `attempt: N/2`를 명시한다. 2회(`attempt: 2/2`)를 초과해 반복되면 세부를 덧대지 않고 HEAD가 `P0` 기준선으로 올라가 접근 전략을 재설계한다.
