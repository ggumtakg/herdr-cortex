---
name: delegate
description: 경계가 확정된 단일 작업을 워커(coder/developer/reviewer)에게 1회성으로 위임하고 패키징된 결과를 회수·재통합하는 프로토콜.
---

# 경계 위임 프로토콜 (delegate)

고해상도 조사·구현·번역·검수를 HEAD 맥락에서 분리해 수행할 때 사용한다.

## 핵심 규칙: 한 번에 한 종류의 작업

- 하나의 위임에는 **단일 작업 유형**만 배정한다(조사, 설계, 구현, 리뷰를 한 워커에 섞지 않는다).
- 작업이 여러 단계에 걸쳐 이어지면 위임을 쪼개거나 `plan-run`으로 전환한다.
- 서브에이전트는 기억 저장소에 대해 **읽기 전용**이며(`memory_save`/`memory_update` 차단), 정본 기록은 항상 결과 회수 후 HEAD가 수행한다.

## 1단계: 워커 역할 선택 및 명시 로드

작업 성격에 맞는 역할 코어를 `cortex_prompt`로 명시 로드해 위임 지시에 포함한다.

| 워커 역할 | `cortex_prompt` 호출 | 적합한 작업 |
| :--- | :--- | :--- |
| **`coder`** | `kind: "agent", name: "coder"` | 설계·인터페이스·동작 명세가 완전히 확정된 코드 번역(자율 설계 권한 없음) |
| **`developer`** | `kind: "agent", name: "developer"` + `kind: "standard", name: "DEVELOPMENT_STANDARD"` | 경계 내 로컬 진단 → 구현 → 대표 경로 E2E 실행 증명이 필요한 개발 작업 |
| **`reviewer`** | `kind: "agent", name: "reviewer"` (+ 필요 시 `DEVELOPMENT_STANDARD`) | 수정 권한 없이 1차 근거로 결정·계획·결과를 비판적 검증 (`independent-review`와 결합) |

## 2단계: Entry Contract 5요소 작성

위임 프롬프트에는 반드시 아래 5요소를 명시한다. 하나라도 비어 있으면 위임 전 HEAD가 먼저 확정한다.

1. **소비자 (Consumer)**: 이 결과물을 누가, 다음 어떤 판단·단계에서 사용하는가.
2. **관측 산출물 (Observable Deliverable)**: 생성·수정할 파일, 반환할 구조화 요약, 확인 가능한 출력 형식.
3. **권위 입력 (Authoritative Inputs)**: 기준선 문서 ID(`memory_read` 대상), 확정 결정, 직접 읽어야 할 파일 경로. HEAD의 장황한 해석 대신 1차 근거를 제공한다.
4. **변경 경계 (Mutation Boundary)**: 수정 허용 파일/디렉터리, 건드리지 말아야 할 소유 영역, 유지해야 할 외부 계약.
5. **대표 증명 (Representative Proof)**: 완료 전 실제 환경에서 실행해야 할 대표 명령과 통과 기준(실제 입력 → 실제 출력).

## 3단계: 실행 격리 및 `contract_conflict` Fail-Closed 처리

- 호스트 네이티브 서브에이전트/포크로 실행하거나, 장기·격리 실행이 필요하면 `relay_tabs`로 유휴 Herdr 탭을 조회한 뒤 `relay_send(to_terminal_id, message, context_docs, wake)`로 전달한다.
- 워커가 착수 중 **명세 모호성, 기존 계약 충돌, 소유 경계 침범, 정책 불일치**를 발견하면 코드를 임의로 추측 수정하지 않고 즉시 **`contract_conflict`** 상태로 중단해 충돌 근거와 누락 결정을 HEAD에 반환한다.
- HEAD는 `contract_conflict`를 받으면 저·중해상도 관점에서 원래 문제와 계약을 재정렬하고, 필요 시 사용자 확인을 거친 뒤 수정된 Entry Contract로 새 위임을 발행한다.

## 4단계: HEAD 결과 재통합

워커로부터 패키징된 결과(변경 파일, 정확한 검증 명령과 실제 출력, 상위 결정을 바꿀 제약·예외·불확실성)를 회수하면 HEAD가 아래를 수행한다.

1. 대표 실행 증명이 실제로 통과했는지 관측 출력으로 확인한다.
2. 산출물 영향이 크거나 계약·로직 변경이 포함되면 `independent-review`를 새 컨텍스트로 실행해 편향 없이 검증한다.
3. 수용이 확정되면 HEAD가 `memory_save` 또는 `memory_update`로 작업 기록·결정·기준선 변경(변경 시 `supersedes`)을 정본에 반영한다.
