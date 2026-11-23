# `src/embeddings/` — 플러거블 비동기 임베딩 & 일괄 처리 CLI

> [← 루트 README](../../README.md)

마크다운 정본 문서를 섹션 인식 청크로 분할해 벡터화하고 `doc_chunks_vec` 테이블에 색인하는 모듈입니다. 저장 경로(`memory_save`)의 지연 시간을 0ms로 유지하기 위해 백그라운드 비동기 큐와 수동 일괄 CLI를 분리했습니다.

---

## 파일 구성

| 파일 | 역할 | 주요 Export |
| :--- | :--- | :--- |
| **`index.mjs`** | 프로바이더 자동 해석(`auto`), `[title > heading]` 접두어 청크 빌더, 증분 배치 처리, 비동기 백그라운드 큐 | `resolveEmbeddingProvider`, `buildDocChunks`, `processPendingEmbeddings`, `createEmbeddingQueue` |
| **`gemini.mjs`** | Google Gemini 임베딩 (`gemini-embedding-001`, 768차원, `x-goog-api-key` 헤더, 100건 서브배치, 429/5xx 백오프) | `createGeminiProvider` |
| **`openai.mjs`** | OpenAI 호환 임베딩 (`text-embedding-3-small`, 커스텀 `baseUrl`/`apiKeyEnv` 지원) | `createOpenAIProvider` |
| **`ollama.mjs`** | 로컬 Ollama 임베딩 (기본 `nomic-embed-text`, 기본 URL `http://127.0.0.1:11434`, `nomic-embed-*` 접두어 자동 적용) | `createOllamaProvider` |
| **`onnx.mjs`** | 완전 오프라인 로컬 ONNX 임베딩 (`Xenova/multilingual-e5-small`, `@huggingface/transformers` 지연 동적 import) | `createOnnxProvider` |
| **`cli.mjs`** | `npm run embed` 진입점 — 제외 프로젝트 스킵, 남은 미임베딩 문서 0건까지 자동 루프 | `runEmbedCli` |

---

## 프로바이더 자동 선택 (`provider: "auto"`) 순서

네트워크 프로브로 시작을 지연시키지 않고 설정·환경변수 기준으로 즉시 선택합니다:
1. **`gemini`**: `GEMINI_API_KEY` 또는 `GOOGLE_API_KEY` 존재 시
2. **`openai`**: `OPENAI_API_KEY` 존재 시
3. **`ollama`**: `OLLAMA_HOST` 또는 `embedding.baseUrl` 설정 시
4. **`onnx`**: `embedding.onnxEnabled === true`이고 `@huggingface/transformers`가 설치된 경우
5. 위 조건 모두 미충족 시 `null` 반환 (정형 + 한국어 FTS5/LIKE + 그래프 검색만 무장애 동작)

---

## 안정성 및 비용 절감 메커니즘

* **모델 변경 자동 재구축**: SQLite `index_meta` 테이블에 `(provider, model, dimensions)`를 기록하며, 변경 감지 시 `doc_chunks_vec`만 마크다운 정본에서 안전하게 재구축합니다.
* **`content_hash` 변경분만 처리**: 본문이 바뀌지 않은 문서와 `superseded`/`archived` 상태 문서는 임베딩 대상에서 제외합니다.
* **실패 격리**: 문서별 최대 3회(`MAX_EMBED_ATTEMPTS = 3`) 재시도 후 `embed_error` 기록, 401/403 인증 오류 시 서킷브레이커로 즉시 중단, 비동기 처리 중 문서 해시가 바뀌면 구 임베딩 결과를 폐기(stale hash guard)합니다.
* **안전한 종료**: `createEmbeddingQueue().drain(3000)`으로 MCP 서버 종료 시 진행 중인 임베딩 작업을 최대 3초 대기합니다.

---

## CLI 사용법

```powershell
npm run embed
npm run embed -- --project <dir> --global <dir> --scope all|project|global --provider gemini --model gemini-embedding-001 --max-docs 200
```

* 제외된 프로젝트(`excludedProjects` / `opt-in` 미등록)에서는 `--scope project` 시 즉시 스킵하며, `--scope all` 시 글로벌 계층만 처리합니다.
* 처리 중 오류가 발생하면 요약 JSON을 출력하고 `process.exitCode = 1`을 설정합니다.

---

## 관련 테스트
* [`test/search-rrf.test.mjs`](../../test/search-rrf.test.mjs)
