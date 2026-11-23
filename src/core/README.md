# `src/core/` — 코어 기억 저장소 · 검색 · 그래프 · 예산 엔진

> [← 루트 README](../../README.md)

`herdr-cortex`의 1계층 핵심 엔진입니다. 마크다운 정본 파일(프로젝트 `.memory/` + 전역 `~/.herdr-cortex/`)을 파싱·저장하고, 로컬 `node:sqlite` (`WAL`) 4테이블 + `index_meta` 캐시를 증분 동기화하며, 한국어 안전 RRF 하이브리드 검색 · 1~10홉 BFS 그래프 탐색 · 무절단 예산 축약(`FIT_STEPS`) · 설정 보안 화이트리스트를 제공합니다.

---

## 파일 구성

| 파일 | 역할 | 주요 Export |
| :--- | :--- | :--- |
| **`config.mjs`** | 경로 해석, 전역/프로젝트 설정 병합, 보안 화이트리스트, ID/경로 검증, 원자적 파일 쓰기 | `REPO_ROOT`, `DEFAULT_CONFIG`, `getGlobalDir`, `getProjectMemoryDir`, `getTierPaths`, `ensureTierDirs`, `sanitizeProjectConfig`, `loadConfig`, `isProjectEnabled`, `isValidId`, `validateDocId`, `assertInsideDir`, `atomicWriteText`, `atomicWriteJson`, `normalizeRelPath`, `sanitizeRelFilePath`, `formatIsoTimestamp`, `generateDocId` |
| **`frontmatter.mjs`** | YAML Frontmatter 왕복 파싱/직렬화, 위키링크·파일 참조 추출, 헤딩 기반 마크다운 청킹 | `parseMarkdownDoc`, `serializeMarkdownDoc`, `extractReferences`, `splitLongText`, `chunkMarkdown` |
| **`db.mjs`** | SQLite WAL DB 오픈/자동 복구, 4테이블 + `index_meta` 스키마 관리, 증분 동기화, Windows 안전 삭제 | `SCHEMA_VERSION`, `computeContentHash`, `withTransaction`, `readIndexMeta`, `writeIndexMeta`, `hasVectorTable`, `ensureVectorTable`, `unlinkDbFiles`, `openTierDb`, `syncSingleFile`, `syncFromDisk` |
| **`store.mjs`** | 2계층(프로젝트/전역) 정본 CRUD, 지연 읽기, `supersedes` 원자 전이, `overview` 생성 | `VALID_TYPES`, `VALID_STATUSES`, `CortexStore` |
| **`search.mjs`** | 한국어 안전 토큰화, 정형 SQL 푸시다운, FTS5/LIKE + 벡터 KNN + 1홉 그래프 RRF 2단계 검색 | `tokenizeQuery`, `searchMemory` |
| **`graph.mjs`** | `edges` 테이블 기반 1홉 이웃 조회 및 1~10홉 JS BFS 계보/파일 영향도 탐색 | `normalizeGraphTarget`, `getNeighbors`, `exploreGraph` |
| **`budget.mjs`** | 훅/개요 출력용 `FIT_STEPS` 단계별 무절단 축약 엔진 (`P0` 브랜치 기준선 보호 포함) | `FIT_STEPS`, `fitOverviewToBudget` |

---

## 핵심 설계 보장

### 1. 지연 읽기(Lazy Read-Only) & 설정 샌드박스 (`config.mjs`, `store.mjs`)
* `CortexStore.getTierIfExists()`를 통해 읽기·검색·개요 조회만 수행할 때는 미초기화 프로젝트에 `.memory/` 폴더와 DB를 생성하지 않습니다.
* 프로젝트 `.memory/config.json`은 `sanitizeProjectConfig()` 화이트리스트를 거치며, `headCoreEnabled`, `hookBudget`, `enabled: false`, `embedding.{provider, model, dimensions, chunkMaxChars, chunkOverlap, timeoutMs}`만 허용합니다. `embedding.{baseUrl, apiKey, apiKeyEnv, onnxEnabled}`, `mode`, `enabledProjects`, `excludedProjects`, `enabled: true`는 차단됩니다.
* `files` 필드에 프로젝트 내부 절대경로가 전달되면 자동으로 상대경로로 정규화하며, 프로젝트 밖 경로 탈출(`..`)은 거부합니다.

### 2. SQLite 4테이블 + `index_meta` & Windows 동시성 안전성 (`db.mjs`)
* `PRAGMA journal_mode = WAL`, `PRAGMA busy_timeout = 5000`, `BEGIN IMMEDIATE` 트랜잭션으로 다중 탭 동시 접근 충돌을 방지합니다.
* `doc_chunks_vec`는 `PARTITION KEY` 없이 `chunk_size=64` 콤팩트 블록으로 구성되어 50문서(768차원) 기준 1MB 미만 디스크만 사용하며, 본문 `content_hash`가 동일하면 메타데이터 수정 시 기존 벡터를 유지합니다.
* Windows `unlinkDbFiles()`는 `.sqlite` 본체 삭제가 잠금(`EBUSY`)으로 막히면 즉시 중단해 `-wal`/`-shm`만 선삭제되는 손상을 예방합니다.

### 3. 한국어 하이브리드 RRF 검색 & 1~10홉 BFS 그래프 (`search.mjs`, `graph.mjs`)
* FTS5 `trigram` 검색과 `JOIN docs` SQL 메타데이터 필터 푸시다운을 결합하고, 한국어 1~2자 토큰은 `LIKE` 폴백과 문장부호 제거·보수적 조사 어간 보조 토큰으로 보완합니다.
* 벡터 인덱스가 0건이면 쿼리 임베딩 API를 호출하지 않으며(지연 임베딩), 벡터 KNN 결과는 코사인 거리 `<= 0.65` 컷오프 및 정본 `docs` 테이블 `WHERE` 교차 검증을 거칩니다.
* `exploreGraph()`는 순환 안전한 JS BFS로 `depth <= 10`까지 양방향 계보와 `file:<상대경로>` 영향도를 추적합니다.

### 4. `FIT_STEPS` 무절단 축약 & `P0` 기준선 보호 (`budget.mjs`, `store.mjs`)
* `getOverview()`는 `branch = 'P0'` 활성 기준선을 별도 전용 쿼리(`p0Baselines`)로 추출해 최신 작업이 많아져도 원래 목표가 밀려나지 않게 보호합니다.
* `fitOverviewToBudget()`은 문장 중간 절단 없이 **6단계(`FIT_STEPS`: `full` → `standard` → `focused` → `compact` → `minimal` → `essential`)**에 걸쳐 항목 수·세부 필드를 점진 축약하며, 초소형 예산에서는 온전한 줄 단위로 줄이는 `line-budgeted` 폴백을 적용합니다.

---

## 관련 테스트
* [`test/store-and-db.test.mjs`](../../test/store-and-db.test.mjs)
* [`test/search-rrf.test.mjs`](../../test/search-rrf.test.mjs)
