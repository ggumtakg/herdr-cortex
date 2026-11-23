# `test/` — 자동화 테스트 스위트 (5개 파일 · 47개 테스트)

> [← 루트 README](../README.md)

외부 테스트 프레임워크 의존성 없이 Node.js 내장 테스트 러너(`node:test`, `node:assert/strict`)로 실행됩니다. 모든 테스트는 임시 디렉터리(`os.tmpdir()`)에서 격리 실행되므로 사용자의 실제 `~/.herdr-cortex/`나 프로젝트 `.memory/`를 건드리지 않습니다.

---

## 실행 방법

```powershell
# 전체 스위트 실행 (47개 테스트)
npm test

# 개별 스위트 실행 예
node --no-warnings --test test/store-and-db.test.mjs
node --no-warnings --test test/hooks-and-budget.test.mjs
```

---

## 테스트 스위트 구성

| 파일 | 테스트 수 | 주요 검증 범위 |
| :--- | :---: | :--- |
| **`store-and-db.test.mjs`** | 16 | ID/경로 탈출 검증, Frontmatter 왕복·멀티라인 `---`, CRUD·`supersedes` 전이·경고, 마크다운 100% DB 재구축·손상 자동 복구, WAL 동시성, 6홉 BFS 그래프·`file:` 영향도, `FIT_STEPS` 예산, `.memory/config.json` 화이트리스트, 지연 읽기·제외 프로젝트 차단, `doc_chunks_vec` `< 1MB` 용량 검증, Windows `unlinkDbFiles` 안전성, `P0` 기준선 보호 |
| **`hooks-and-budget.test.mjs`** | 10 | `revive/tracker` 서브에이전트 차단·세션 이력·ID 검증, Claude/Antigravity JSONL 2MB tail 읽기·노이즈 앵커링·`User has answered` 보존, Claude 4종 훅(9,000자 예산·`/clear` 폴백·`PreToolUse` 차단), Antigravity 16KB 롤 프로브·`unknown` 지연·`CHECKPOINT` 1회 복원, `P0` 단독 기준선 훅 렌더링, `installer.mjs` 멱등 설치/제거 왕복, 프로젝트 스코핑 |
| **`search-rrf.test.mjs`** | 9 | 정형·FTS5·한국어 1~2자 `LIKE` 폴백·문장부호/조사 보조 토큰, SQL 필터 푸시다운, `sqlite-vec` 코사인 KNN·거리 컷오프(`0.65`)·크로스티어 글로벌 RRF, 지연 쿼리 임베딩, 임베딩 큐(`content_hash` 보존·재시도 상한·401/403 서킷브레이커·stale hash guard·`drain`), Gemini 헤더/서브배치/재시도, Ollama `nomic-embed` 접두어, `embeddings/cli.mjs` 제외 스킵·배치 루프 |
| **`relay-inbox.test.mjs`** | 7 | `hc.mjs` 탭 상태 판별(`idle`/`busy`/`blocked`/`error`/`done`/`isBareShell`)·`foreground.cwd`·`--if idle`, 인박스 원자 claim·크래시 복구·`.broken/` 격리·예산 우선 부분 `ack`, `relay_tabs`/`relay_send`/`relay_inbox` E2E 및 서브에이전트 차단, MCP `server.mjs` JSON-RPC 2.0·`PROJECT_EXCLUDED`·`-32603` 예외 처리 |
| **`orchestration-prompts.test.mjs`** | 5 | `cortex_prompt` 전체 자산 로드·경로 탈출 차단, `P0 -> PLAN -> PN -> RESULT` 양방향 계보, 5구획 검수 포맷 통일 및 `04-plan-acceptance` 격리, 다사이클 5홉 계보 및 `DONE` 기준선 아카이브, **저장소 청정도(purity) 검사**(개인 경로·OS 사용자명·민감 정보 0건 검증) |
