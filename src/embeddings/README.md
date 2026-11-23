# `src/embeddings/` — 임베딩 프로바이더, 문서 대기열, 장애 대응, 일괄 처리 CLI

> [← 루트 README](../../README.md)

임베딩은 글을 숫자 벡터로 바꿔서 낱말이 달라도 뜻이 비슷한 문서를 찾을 수 있게 하는 처리입니다. 이 폴더는 마크다운 기억 문서를 제목과 섹션을 아는 조각(청크)으로 나누고, 프로바이더(벡터를 만들어 주는 외부 서비스 또는 이 PC의 모델)에 보내 받은 벡터를 각 계층의 SQLite 색인에 있는 `doc_chunks_vec` 테이블에 넣습니다. 계층은 기억이 저장되는 두 곳, 곧 프로젝트 기억(`<프로젝트>/.memory/`)과 모든 프로젝트가 함께 쓰는 전역 기억(기본 위치 `%USERPROFILE%\.herdr-cortex\`)을 말합니다. 임베딩은 기본적으로 꺼져 있으며(`provider: "none"`), 사용자가 프로바이더를 고르기 전에는 어떤 글도 이 PC 밖으로 나가지 않습니다. 켜져 있을 때도 저장 도구는 임베딩을 기다리지 않고 바로 답하며, 뒤에서 도는 대기열이 문서를 처리합니다. 서비스가 응답하지 않으면 검색은 키워드와 그래프 결과로 계속 동작하고, 서비스가 돌아오면 밀린 문서를 스스로 처리합니다.

---

## 파일 구성

| 파일 | 역할 | Export |
| :--- | :--- | :--- |
| **`index.mjs`** | 문서를 청크로 나누기, 대기 중인 문서를 한 번 처리하기, 백그라운드 대기열. 이 폴더의 공개 함수를 한곳에서 다시 내보내는 진입점이기도 합니다. | 직접 정의: `buildDocChunks`, `processPendingEmbeddings`, `createEmbeddingQueue`<br>`breaker.mjs`에서 다시 내보냄: `classifyEmbeddingError`, `createEmbeddingBreaker`, `getSharedEmbeddingBreaker`<br>`failed.mjs`에서 다시 내보냄: `GIVEN_UP_REASONS`, `MAX_EMBED_ATTEMPTS`, `MAX_EMBED_SERVICE_FAILURES`, `listFailedEmbeddings`, `retryFailedEmbeddings`<br>`resolve.mjs`에서 다시 내보냄: `describeEmbeddingStatus`, `embeddingSelectionKey`, `formatEmbeddingStatus`, `resolveEmbeddingProvider`, `resolveTierEmbeddingProviders` |
| **`resolve.mjs`** | 설정에서 프로바이더를 고르기(`none`, `auto`, 이름 지정), 계층별 프로바이더 정하기, "지금 어디로 보내는가"를 설명하는 상태 함수 | `resolveEmbeddingProvider`, `resolveTierEmbeddingProviders`, `embeddingSelectionKey`, `describeEmbeddingStatus`, `formatEmbeddingStatus` |
| **`breaker.mjs`** | 실패 분류(서비스 / 문서 / 인증)와 차단기(서비스가 실패한 뒤 일정 시간 임베딩 시도를 쉬게 하는 장치) | `DEFAULT_CIRCUIT_BREAK_MS`, `classifyEmbeddingError`, `createEmbeddingBreaker`, `getSharedEmbeddingBreaker`, `isEmbeddingTimeoutError`, `markEmbeddingFailure` |
| **`failed.mjs`** | 재시도 상한과, 대기열이 포기한 문서의 목록 조회 및 되살리기 | `MAX_EMBED_ATTEMPTS`, `MAX_EMBED_SERVICE_FAILURES`, `GIVEN_UP_REASONS`, `listFailedEmbeddings`, `retryFailedEmbeddings` |
| **`gemini.mjs`** | Google Gemini 임베딩 프로바이더 | `GEMINI_DEFAULT_MODEL`, `GEMINI_DEFAULT_BASE_URL`, `GEMINI_KEY_ENV_NAMES`, `createGeminiProvider` |
| **`openai.mjs`** | OpenAI 및 같은 형식의 API를 쓰는 서비스용 프로바이더 | `OPENAI_DEFAULT_MODEL`, `OPENAI_DEFAULT_BASE_URL`, `OPENAI_KEY_ENV_NAMES`, `createOpenAIProvider` |
| **`ollama.mjs`** | Ollama 서버용 프로바이더 | `OLLAMA_DEFAULT_MODEL`, `OLLAMA_DEFAULT_BASE_URL`, `resolveOllamaBaseUrl`, `createOllamaProvider` |
| **`onnx.mjs`** | 이 프로세스 안에서 도는 ONNX 모델 프로바이더(네트워크 요청을 코드가 직접 하지 않음) | `ONNX_DEFAULT_MODEL`, `createOnnxProvider` |
| **`provider-util.mjs`** | 프로바이더들이 함께 쓰는 도우미: API 키 찾기, 호출 한 번의 제한 시간과 재시도 횟수 정하기 | `resolveApiKey`, `resolveCallLimits` |
| **`cli.mjs`** | `npm run embed`의 진입점. 대기 중인 문서를 남김없이 처리하고 요약을 JSON으로 출력합니다. | `EMBED_CLI_SCOPES`, `runEmbedCli` |

프로바이더 객체는 모두 같은 모양입니다: `{ name, model, dimensions, embed(texts, { taskType, timeoutMs, maxRetries }) }`. `embed`는 글 배열을 받아 같은 개수의 `Float32Array` 배열을 돌려주며, `taskType`은 `"document"`(기본값) 또는 `"query"`입니다.

---

## 설정

### 기본값과 형태

임베딩 설정은 전역 저장소의 `config.json`(기본 위치 `%USERPROFILE%\.herdr-cortex\config.json`)에 있는 `embedding` 항목입니다. 코드에 들어 있는 기본값(`src/core/config.mjs`의 `DEFAULT_CONFIG.embedding`)은 다음과 같습니다.

```json
"embedding": {
  "provider": "none",
  "chunkMaxChars": 800,
  "chunkOverlap": 100,
  "timeoutMs": 15000,
  "queryTimeoutMs": 3000,
  "circuitBreakMs": 300000,
  "gemini": { "model": "", "dimensions": 0, "apiKeyEnv": "", "apiKey": "", "baseUrl": "" },
  "openai": { "model": "", "dimensions": 0, "apiKeyEnv": "", "apiKey": "", "baseUrl": "" },
  "ollama": { "baseUrl": "", "model": "", "dimensions": 0 },
  "onnx": { "enabled": false, "model": "" }
}
```

모든 프로바이더가 함께 쓰는 키는 다음 여섯 개입니다.

| 키 | 기본값 | 뜻 |
| :--- | :--- | :--- |
| `provider` | `"none"` | `none`, `auto`, `gemini`, `openai`, `ollama`, `onnx` 가운데 하나 |
| `chunkMaxChars` | `800` (글자) | 청크 하나의 최대 길이. 64보다 작은 값은 64로 올립니다. |
| `chunkOverlap` | `100` (글자) | 긴 섹션을 나눌 때 앞 조각과 겹치는 길이. 0 이상입니다. |
| `timeoutMs` | `15000` (ms) | 문서를 임베딩할 때 HTTP 요청 한 번의 제한 시간. `gemini`, `openai`, `ollama`에 적용되고 `onnx`는 쓰지 않습니다. |
| `queryTimeoutMs` | `3000` (ms) | 검색어 하나를 임베딩할 때 기다리는 시간. 0 이하이거나 숫자가 아니면 3000을 씁니다. |
| `circuitBreakMs` | `300000` (ms, 5분) | 서비스 쪽 실패가 난 뒤 임베딩 시도를 쉬는 시간. `0`이면 쉬지 않습니다. |

프로바이더마다 자기 이름의 묶음을 하나씩 가지며, 각 프로바이더는 자기 묶음과 위의 공용 키만 읽습니다. 예를 들어 `embedding.ollama.baseUrl`이나 `embedding.ollama.model`은 어떤 경우에도 Gemini나 OpenAI 요청에 쓰이지 않습니다. 빈 문자열과 `0`은 "그 프로바이더의 기본값을 쓴다"는 뜻입니다.

| 묶음 | 키 | 뜻 |
| :--- | :--- | :--- |
| `embedding.gemini`, `embedding.openai` | `model` | 모델 이름 |
| | `dimensions` | 벡터 차원 수(아래 프로바이더 표 참고) |
| | `apiKeyEnv` | API 키가 들어 있는 환경변수의 이름 |
| | `apiKey` | 설정 파일에 직접 적은 API 키. 있으면 환경변수보다 먼저 쓰입니다. |
| | `baseUrl` | 요청을 보낼 주소(프록시나 호환 서비스를 쓸 때) |
| `embedding.ollama` | `baseUrl`, `model`, `dimensions` | Ollama 서버 주소, 모델 이름, 벡터 차원 수 |
| `embedding.onnx` | `enabled` | `auto`가 ONNX를 고를 수 있게 하는 스위치 |
| | `model` | 모델 이름 |
| | `dimensions`, `dtype` | 기본값 객체에는 없지만 코드가 읽는 키입니다. `dtype`의 기본값은 `"q8"`입니다. |

### `provider` 값의 해석

- 값이 없거나, 빈 문자열이거나, `none` / `off` / `disabled`(대소문자 무시)이면 임베딩을 하지 않습니다.
- `auto` 또는 네 프로바이더 이름 가운데 하나이면 그대로 따릅니다.
- 그 밖의 값(오타 포함)은 설정 오류입니다. `auto`로 넘어가지 않고 아무것도 임베딩하지 않으며, 표준 오류에 한 번 경고합니다: `Unknown embedding.provider "<값>": embedding is off until it is corrected. Valid values: none, auto, gemini, openai, ollama, onnx.`
- `gemini`나 `openai`를 이름으로 골랐는데 키를 찾지 못하면 역시 임베딩하지 않고 경고합니다: `embedding.provider is "gemini" but no API key was found (looked in embedding.gemini.apiKey and the environment variables GEMINI_API_KEY, GOOGLE_API_KEY): embedding is off.`
- `ollama`를 이름으로 고르면 주소 설정이 없어도 기본 주소로 동작하고, `onnx`를 이름으로 고르면 `embedding.onnx.enabled`가 `false`여도 동작합니다. 이 두 조건은 `auto`가 후보를 고를 때만 봅니다.

### 옛 형식의 키

`embedding` 바로 아래에 놓인 `baseUrl`, `model`, `dimensions`, `apiKey`, `apiKeyEnv`, `onnxEnabled`(`LEGACY_EMBEDDING_KEYS`)는 프로바이더별 묶음을 쓰지 않는 옛 형식의 키입니다. 이 키들은 전역 설정의 `embedding`, `projects[...]`의 `embedding`, 코드가 `loadConfig`에 넘긴 덮어쓰기 값(`overrides`) 어디에 있든 읽지 않습니다. 발견하면 그 값을 버리고, 프로세스마다 한 번 표준 오류에 경고하며, 상태 함수의 `problems`에 `legacy_embedding_keys`로 올립니다. 경고 문구는 다음과 같습니다.

```
[herdr-cortex] Warning: embedding.baseUrl, embedding.model are from the old config format and ignored. Move provider settings into embedding.<provider> (for example embedding.ollama.baseUrl, embedding.gemini.model, embedding.openai.apiKeyEnv, embedding.onnx.enabled). (in "<config.json 경로>")
```

### 프로젝트별 설정과 계층

프로젝트마다 다른 프로바이더를 쓰려면 전역 `config.json`의 `projects` 항목에 프로젝트 경로를 키로 적습니다. 이 항목에서 읽는 것은 `embedding`뿐입니다.

```json
{
  "embedding": { "provider": "none" },
  "projects": {
    "C:\\work\\proj-a": { "embedding": { "provider": "ollama", "ollama": { "model": "bge-m3" } } }
  }
}
```

- 키는 절대 경로여야 하고, 프로젝트 루트와 정확히 같은 폴더일 때만 적용됩니다. 정션과 심볼릭 링크를 푼 실제 경로로 비교하며 Windows에서는 대소문자를 구분하지 않습니다. 상위 폴더나 하위 폴더, 이름만 같은 폴더에는 적용되지 않습니다.
- 프로바이더 묶음은 키 단위로 합쳐집니다. 위 예에서 전역 설정에 `ollama.baseUrl`이 있으면 프로젝트는 그 주소를 물려받고 `model`만 바꿉니다.
- 프로젝트 안의 `.memory/config.json`에 `embedding`을 적어도 적용되지 않습니다. 그 파일은 저장소 안에 있어서 저장소를 만든 사람이 내용을 정하므로, 문서가 어디로 전송될지를 정할 수 없게 되어 있습니다(`sanitizeProjectConfig`는 `headCoreEnabled`, `hookBudget`, `enabled: false`만 남깁니다). 승인된 프로젝트에서 그런 `embedding`이 발견되면 경고가 나오고 `problems`에 `project_embedding_ignored`로 올라갑니다.
- 전역 계층은 항상 전역 설정만 따릅니다(`resolveTierEmbeddingProviders`). 프로젝트 계층은 "전역 설정 + 그 프로젝트의 `projects[...]` 항목"으로, 전역 계층은 그 항목을 뺀 전역 설정으로 임베딩합니다. 전역 기억은 모든 프로젝트가 함께 쓰므로, 프로젝트마다 모델이 달라도 전역 색인이 번갈아 다시 만들어지지 않습니다. 두 계층의 선택이 같으면 프로바이더 객체 하나가 두 계층을 함께 맡습니다.
- 청크 크기(`chunkMaxChars`, `chunkOverlap`)도 계층별 설정을 따릅니다. `queryTimeoutMs`는 검색을 실행한 저장소의 프로젝트 쪽 설정에서, `circuitBreakMs`는 MCP 서버가 시작된 프로젝트의 설정에서 한 번 읽습니다.

---

## 프로바이더

| | `gemini` | `openai` | `ollama` | `onnx` |
| :--- | :--- | :--- | :--- | :--- |
| 기본 모델 | `gemini-embedding-001` | `text-embedding-3-small` | `nomic-embed-text` | `Xenova/multilingual-e5-small` |
| 기본 주소 | `https://generativelanguage.googleapis.com/v1beta` | `https://api.openai.com/v1` | `http://127.0.0.1:11434` | 없음(프로세스 안에서 실행) |
| 요청 | `POST <주소>/models/<모델>:batchEmbedContents` | `POST <주소>/embeddings` | `POST <주소>/api/embed` | `@huggingface/transformers`의 `pipeline('feature-extraction', <모델>)` |
| 키를 보내는 방법 | `x-goog-api-key` 헤더 | `Authorization: Bearer` 헤더 | 키 없음 | 키 없음 |
| 키를 찾는 환경변수 | `GEMINI_API_KEY`, 다음으로 `GOOGLE_API_KEY` | `OPENAI_API_KEY` | 해당 없음 | 해당 없음 |
| `dimensions`가 `0`일 때 | 768을 요청(`outputDimensionality`) | 요청에 넣지 않고 응답에서 알아냄 | 응답에서 알아냄 | 응답에서 알아냄 |
| 요청 한 번에 보내는 글의 수 | 최대 100개 | 최대 100개 | 최대 64개 | 한 번에 1개씩 |
| 글 앞에 붙이는 말 | 없음(대신 `taskType`을 `RETRIEVAL_DOCUMENT` / `RETRIEVAL_QUERY`로 보냄) | 없음 | 모델 이름에 `nomic-embed`가 들어 있으면 문서에 `search_document: `, 검색어에 `search_query: ` | 모델 이름에 `e5`가 들어 있으면 문서에 `passage: `, 검색어에 `query: ` |

**API 키를 찾는 순서**(`resolveApiKey`): 묶음의 `apiKey` → `apiKeyEnv`가 가리키는 환경변수 → 위 표의 환경변수. 키가 없으면 `createGeminiProvider`와 `createOpenAIProvider`는 `null`을 돌려줍니다. 상태 출력은 키가 어디에서 왔는지(환경변수 이름 또는 설정 파일)만 알려 주고 키 값은 내보내지 않습니다.

**Ollama 주소**(`resolveOllamaBaseUrl`): `embedding.ollama.baseUrl` → 환경변수 `OLLAMA_HOST` → `http://127.0.0.1:11434`. `http://`나 `https://`로 시작하지 않으면 `http://`를 붙이고 끝의 `/`는 뗍니다.

**차원 수**: `dimensions`를 `0`보다 크게 적으면 Gemini는 `outputDimensionality`로, OpenAI는 `dimensions`로 그 값을 요청합니다. Ollama와 ONNX는 요청에 넣지 않습니다. 어느 프로바이더든 실제로 돌아온 벡터의 길이가 기준이며, 설정한 값과 다르면 돌아온 길이로 벡터 테이블을 만듭니다. 테이블이 받는 차원은 1 이상 8192 이하입니다.

**제한 시간과 재시도**(`gemini`, `openai`, `ollama` 공통): 요청 한 번의 제한 시간은 `embedding.timeoutMs`(기본 15,000ms)입니다. 네트워크 오류, 시간 초과, HTTP 429, HTTP 5xx는 250ms, 500ms를 기다리며 최대 2번 다시 시도하므로 요청 묶음 하나에 최대 3번 요청합니다. 그 밖의 HTTP 오류는 다시 시도하지 않고 `Gemini embedding failed (<상태 코드>): <응답 앞 200자>` 형식의 오류를 냅니다(이름은 프로바이더에 따라 `OpenAI`, `Ollama`). 응답을 JSON으로 읽을 수 없거나 벡터 개수가 보낸 글의 개수와 다르면 다시 시도하지 않고 서비스 쪽 실패로 표시합니다.

**호출별 제한**(`resolveCallLimits`): `embed`를 부르는 쪽이 `timeoutMs`(0보다 큰 수)와 `maxRetries`(0 이상의 정수)를 넘기면 그 호출에만 적용됩니다. 검색은 `{ taskType: 'query', timeoutMs: <queryTimeoutMs>, maxRetries: 0 }`으로 부릅니다.

**ONNX**: `createOnnxProvider`는 `@huggingface/transformers`를 동적으로 불러오며, 설치되어 있지 않으면 `null`을 돌려줍니다. 이 패키지는 `package.json`의 의존성에 들어 있지 않으므로 ONNX를 쓰려면 따로 설치해야 합니다. 모델은 프로바이더를 만들 때가 아니라 `embed`가 처음 불릴 때 읽으며, 읽기에 실패하면 서비스 쪽 실패로 표시하고 다음 호출에서 다시 읽습니다. `timeoutMs`와 `maxRetries`를 쓰지 않으므로 검색어 임베딩의 시간 제한은 검색 쪽의 타이머가 맡습니다. 제약이 두 가지 있습니다. 첫째, 상태 함수는 패키지 설치 여부를 확인하지 않으므로 패키지가 없어도 `onnx`가 선택된 것으로 표시되며, 실제로는 아무것도 임베딩되지 않습니다(`npm run embed`의 요약은 `provider: null`, `reason: "no_provider"`이고 종료 코드는 0). 둘째, 라이브러리가 모델을 처음 쓸 때 내려받는지는 이 저장소에서 확인하지 않았습니다.

### `auto`가 고르는 순서

`auto`는 네트워크에 물어보지 않고 설정과 환경변수만 보고 정합니다. `gemini` → `openai` → `ollama` → `onnx` 순서(`EMBEDDING_PROVIDER_NAMES`)로 살펴 조건이 맞는 첫 후보를 씁니다.

1. `gemini`: 키가 있을 때(`embedding.gemini.apiKey`, `embedding.gemini.apiKeyEnv`가 가리키는 환경변수, `GEMINI_API_KEY`, `GOOGLE_API_KEY`)
2. `openai`: 키가 있을 때(`embedding.openai.apiKey`, `embedding.openai.apiKeyEnv`가 가리키는 환경변수, `OPENAI_API_KEY`)
3. `ollama`: 환경변수 `OLLAMA_HOST`가 있거나 `embedding.ollama.baseUrl`이 적혀 있을 때
4. `onnx`: `embedding.onnx.enabled`가 `true`일 때
5. 맞는 후보가 없으면 임베딩하지 않습니다.

후보는 자기 묶음과 자기 환경변수만으로 판정하고, 고른 프로바이더에는 그 묶음의 값과 기본값만 넘어갑니다. `auto`는 환경변수에 키가 있으면 외부 서비스를 고르므로 기본값이 아니며 사용자가 직접 골라야 합니다.

### 무엇이 어디로 나가는가

- **문서**: 청크의 글이 나갑니다. 청크는 `[문서 제목 > 섹션 제목]` 한 줄과 본문 조각으로 이루어지고, 문서의 첫 청크에는 요약(`summary`)이 앞에 붙습니다. 본문이 없는 문서는 요약(없으면 제목)만으로 청크 하나를 만듭니다. 태그, 문서 ID, 파일 경로 같은 머리말의 다른 값은 본문에 적혀 있지 않은 한 보내지 않습니다. `superseded`와 `archived` 상태의 문서는 보내지 않습니다.
- **검색어**: 검색 도구에 넣은 검색어가 그대로 나갑니다. 검색하는 계층에 벡터가 하나도 없거나, 그 계층의 벡터가 지금 프로바이더와 다른 모델로 만들어졌거나, 차단기가 열려 있으면 보내지 않습니다.
- **받는 곳**: 프로젝트 계층의 글은 프로젝트 쪽 프로바이더의 주소로, 전역 계층의 글은 전역 쪽 프로바이더의 주소로 갑니다. 주소가 `localhost`, `127.0.0.1`, `::1`이면 이 PC 안에서 끝나고, `onnx`는 프로세스 안에서 계산합니다.
- **이 PC에 남는 것**: `doc_chunks_vec` 행마다 문서 ID, 상태, 유형, 벡터, 청크 번호, 섹션 제목, 청크 글의 앞 240자를 저장합니다.

---

## 상태 표시: 지금 어디로 보내는가

`describeEmbeddingStatus(config, { env, breaker, store, globalConfig })`는 설정이 실제로 무엇을 하게 되는지를 객체로 돌려줍니다. 네트워크 요청을 하지 않고 키 값을 담지 않습니다.

| 필드 | 내용 |
| :--- | :--- |
| `setting` | 설정에 적힌 `provider` 값(`none`, `auto`, 프로바이더 이름, 또는 알 수 없는 글자 그대로) |
| `provider`, `enabled` | 실제로 쓰일 프로바이더(없으면 `null`)와 그 유무 |
| `model` | 쓰일 모델 이름(꺼져 있으면 빈 문자열) |
| `host` | 문서와 검색어가 전송되는 `호스트[:포트]`. 꺼져 있거나 `onnx`이면 `null` |
| `local` | 글이 이 PC를 떠나지 않으면 `true`(꺼짐, `onnx`, 또는 루프백 주소) |
| `apiKeySource`, `apiKeyEnv` | 키의 출처(`"env"`, `"config"`, `null`)와 환경변수 이름 |
| `breaker` | 이 프로세스의 차단기 상태 `{ open, remainingMs, cooldownMs, openedAt, lastError }` |
| `problems` | `[{ code, message, ... }]`. `code`는 `unknown_provider`, `missing_api_key`, `invalid_base_url`, `legacy_embedding_keys`, `project_embedding_ignored` |
| `globalTier` | 전역 계층이 프로젝트 계층과 다른 설정으로 임베딩될 때만 있습니다. 같은 필드(`breaker` 제외)로 전역 쪽을 설명하며, 이때 위쪽 필드는 프로젝트 계층만 가리킵니다. |
| `failedDocuments` | `store`를 넘겼을 때만 있습니다. 계층별 포기 문서 목록(`listFailedEmbeddings`의 결과) |

`formatEmbeddingStatus(status)`는 이 객체를 사람이 읽는 줄로 바꿉니다. `npm run embed`, 설치기(`src/hooks/installer.mjs`), `cortex-status`(`scripts/cortex-status.mjs`)가 이 줄을 씁니다. 실제 출력 형식은 다음과 같습니다.

```
embedding: off (provider is "none"); nothing is sent anywhere.
embedding: off (provider is "auto" and no provider is configured); nothing is sent anywhere.
embedding: off (provider "gemni" is not usable); nothing is sent anywhere.
embedding: gemini (chosen by "auto"), model gemini-embedding-001; sends documents and search queries to generativelanguage.googleapis.com; API key from environment variable GEMINI_API_KEY.
embedding: openai, model text-embedding-3-small; sends documents and search queries to proxy.example; API key from embedding.openai.apiKey in config.json.
embedding: ollama, model nomic-embed-text; sends documents and search queries to 127.0.0.1:11434 (this machine).
embedding: onnx, model Xenova/multilingual-e5-small; runs in this process; documents stay on this machine.
```

두 계층의 설정이 다르면 첫 줄이 둘로 나뉩니다.

```
embedding (this project's memory): ollama, model nomic-embed-text; sends documents and search queries to 127.0.0.1:11434 (this machine).
embedding (global memory, shared by all projects): off (provider is "none"); nothing is sent anywhere.
```

그 뒤에 해당하는 것이 있을 때만 다음 줄이 붙습니다.

```
embedding paused for 300s after a service failure: <마지막 오류>
embedding gave up on 2 project document(s) after repeated failures: <ID>, <ID> (retry with: npm run embed -- --retry-failed)
  1 of them because the embedding service failed 10 times on the same document (timeout, network or server error): <ID>
embedding config problem: <문제 설명>
embedding config problem (global memory): <문제 설명>
```

포기 문서 줄은 ID를 10개까지 보여 주고, 더 있으면 `, ...`을 붙입니다.

`embedding paused` 줄에는 한계가 있습니다. 차단기는 프로세스마다 따로 있고, `breaker`를 넘기지 않으면 상태 함수는 자기 프로세스의 차단기를 봅니다. `cortex-status`와 설치기는 MCP 서버와 다른 프로세스이고, `npm run embed`는 일을 시작하기 전에 상태 줄을 출력하므로, 이 세 곳의 출력에는 실행 중인 MCP 서버가 쉬고 있다는 사실이 나오지 않습니다. MCP 서버가 쉬는 중인지는 검색 결과의 `vectorSkipped: "circuit_open"`으로 알 수 있습니다.

---

## 문서 대기열

### 한 번의 처리: `processPendingEmbeddings`

`processPendingEmbeddings(store, { scope, provider, providers, maxDocs, chunkMaxChars, chunkOverlap, breaker })`는 다음 순서로 동작하며, 2번부터는 계층마다 되풀이합니다. `scope`의 기본값은 `"all"`(프로젝트 다음 전역), `maxDocs`의 기본값은 계층당 100건입니다.

1. 차단기가 열려 있으면 아무것도 하지 않고 `reason: "circuit_open"`으로 돌아옵니다. 쓸 프로바이더가 하나도 없으면 `reason: "no_provider"`입니다.
2. 계층의 색인을 디스크의 마크다운과 맞춥니다(`syncFromDiskShared`). 이 동기화는 파일 하나를 색인할 때마다 이벤트 루프에 차례를 넘기고, 같은 DB 연결에서 이미 돌고 있는 동기화가 있으면 새로 시작하지 않고 그것에 합류합니다. 그래서 처리 중에 들어온 도구 호출은 파일 하나만큼만 기다립니다. 파일 하나는 통째로 색인하므로 아주 큰 문서라면 그 문서만큼은 기다립니다.
3. 대상 문서를 고릅니다. 상태가 `superseded`나 `archived`가 아니고, 포기되지 않았으며(아래 "실패를 세는 규칙"), `embed_status`가 `pending`이거나 `error`이거나, `ready`이지만 `embed_model`이 지금 모델과 다른 문서입니다. 아직 실패한 적 없는 문서가 먼저, 그다음은 서비스 실패 횟수가 적은 문서, 그다음은 최근에 고친 문서 순입니다.
4. 문서를 청크로 나누어 `embed(..., { taskType: 'document' })`를 부릅니다. 청크가 하나도 나오지 않는 문서(제목, 요약, 본문이 모두 빈 문서)는 `embed_status = 'skipped'`가 됩니다.
5. 돌아온 벡터의 개수가 청크 수와 같고 길이가 모두 같은지 확인한 뒤, 트랜잭션 하나에서 그 문서의 이전 벡터를 지우고 새 벡터를 넣고 `embed_status = 'ready'`, `embed_model = <모델>`로 바꾸며 실패 횟수를 0으로 되돌립니다.

**처리 중에 문서가 바뀐 경우**: 트랜잭션은 먼저 문서의 파일 해시(`docs.hash`)가 임베딩을 시작할 때와 같은지 확인합니다. 그사이 문서가 바뀌었거나 지워졌으면 받은 벡터를 버리고 아무것도 쓰지 않으며, 바뀐 문서는 다음 실행에서 처리됩니다.

**본문이 그대로인 문서**: 색인 갱신(`src/core/db.mjs`)은 `content_hash`(제목, 요약, 본문으로 계산한 해시)가 이전과 같으면 벡터와 `embed_status`를 그대로 둡니다. 상태나 태그처럼 머리말만 바뀐 문서는 다시 임베딩되지 않고, 벡터 행의 상태와 유형만 고쳐집니다. `content_hash`가 달라지면 그 문서의 벡터를 지우고 `embed_status`를 `pending`으로, 실패 횟수를 0으로 되돌립니다.

결과 객체는 `{ provider, model, dimensions, tiers, processed, chunksIndexed, rebuiltTiers, errors, circuitBroken, more, reason? }`입니다. `tiers`는 계층별 `{ provider, model, dimensions, processed, chunksIndexed, errors }`이고, `more`는 어느 계층이 `maxDocs`를 꽉 채워서 더 처리할 문서가 남았을 수 있다는 뜻입니다. `reason`은 `no_provider`, `circuit_open`, `service_unavailable`, `auth_failed` 가운데 하나이며, 실행이 중단되거나 건너뛰어지면 `circuitBroken`이 `true`입니다. 벡터 확장(`sqlite-vec`)을 불러오지 못한 연결에서는 그 계층을 오류 없이 건너뜁니다.

### 청크: `buildDocChunks`

`buildDocChunks(doc, { maxChars = 800, overlap = 100 })`는 본문을 제목 줄(heading) 단위로 나눈 뒤 각 조각 앞에 `[문서 제목 > 섹션 제목]` 줄을 붙입니다. 섹션 제목이 없거나 문서 제목과 같으면 `[문서 제목]`만 붙습니다. 이 줄을 포함한 청크 전체가 `maxChars`를 넘지 않도록 맞추며, 넘는 조각은 `overlap`만큼 겹치게 다시 나눕니다. 붙이는 줄이 `maxChars`의 40%(최소 16자)보다 길면 잘라 냅니다.

### 대기열: `createEmbeddingQueue`

`createEmbeddingQueue(store, { provider, getProvider, getProviders, debounceMs = 150, breaker, maxDocs = 100, recoverScope = 'all', openProjectStore, getProviderFor })`는 `{ schedule, flush, cancel, drain, hasPending, whenIdle }`를 돌려줍니다. `schedule(scope)`는 예약만 하고 바로 돌아오며, `debounceMs` 뒤에 `processPendingEmbeddings`가 한 번 돕니다. 실행 중에 생긴 오류는 밖으로 던지지 않고, 처리하지 못한 문서는 `pending`이나 `error`로 남아 다음 실행을 기다립니다.

MCP 서버(`src/mcp/server.mjs`의 `createServerRuntime`)는 대기열을 하나 만들어(`debounceMs` 200ms, 검색과 함께 쓰는 차단기를 넘김) 다음 때에 예약합니다.

- **서버가 시작될 때**: `schedule('all')`. 이전 세션이나 장애 때문에 남은 문서를 다음 저장을 기다리지 않고 처리합니다.
- **`memory_save`, `memory_update`가 문서를 쓴 뒤**: 그 문서의 계층을 예약합니다. `project_dir`로 다른 프로젝트에 저장했으면 `schedule('project', { projectDir })`로 그 프로젝트를 예약하고, 대기열은 그 프로젝트의 저장소를 실행하는 동안만 열었다가 닫으며 그 프로젝트의 설정으로 임베딩합니다.
- **뒤에서 도는 색인 따라잡기가 새 문서나 바뀐 문서를 색인했을 때**: 훅이나 도구 호출이 시간 제한 때문에 미뤄 둔 문서가 색인되면 그 계층을 예약합니다. 따라잡기는 서버 시작 250ms 뒤에 처음 돕니다.
- **한 번의 실행이 `maxDocs`를 꽉 채웠을 때**: 한 건이라도 처리했으면 같은 범위를 다시 예약합니다.
- **차단기가 닫혔을 때**: 아래 "복구 뒤 따라잡기"를 보십시오.

승인되지 않았거나 설정으로 제외된 프로젝트의 프로젝트 계층은 열리지 않으므로 대기열도 건너뜁니다.

**종료**: `drain(timeoutMs = 3000)`은 새 예약을 받지 않게 하고, 예약된 타이머와 대기 목록을 지우고, 진행 중인 실행이 끝나기를 `timeoutMs`까지 기다립니다. MCP 서버는 종료할 때 색인 따라잡기를 멈춘 뒤 `drain(3000)`을 부르고 나서 저장소를 닫습니다. 실행이 3초 안에 끝나지 않으면 더 기다리지 않으며, 그때까지 벡터를 기록하지 못한 문서는 대기 상태 그대로 남아 다음 시작 때 처리됩니다.

### 모델이 바뀌면: 벡터 테이블 재구축

계층의 색인은 `index_meta` 테이블에 벡터를 만든 프로바이더, 모델, 차원 수(`embedProvider`, `embedModel`, `dimensions`)를 기록합니다. 대기열과 CLI는 `ensureVectorTable`(`src/core/db.mjs`)로 이 기록을 지금 프로바이더와 견줍니다. 차원 수가 정해진 프로바이더는 문서를 처리하기 전에, 차원 수를 응답에서 알아내는 프로바이더는 첫 응답을 받은 뒤에 견주며, 모델 이름이나 차원 수가 다르면 트랜잭션 하나에서 `doc_chunks_vec`를 지우고 새 차원으로 다시 만들고, 그 계층의 모든 문서를 `embed_status = 'pending'`으로(실패 횟수도 0으로) 되돌리고, `index_meta`를 고칩니다. 그 뒤 문서들이 새 모델로 다시 임베딩됩니다. 재구축된 계층은 결과의 `rebuiltTiers`에 나옵니다.

벡터는 마크다운 파일에 들어 있지 않으므로 다시 만들려면 프로바이더를 다시 불러야 합니다. 재구축이 끝나기 전에는 아직 임베딩되지 않은 문서가 벡터 검색에 잡히지 않습니다. 또 검색은 계층의 `embedModel`이 지금 프로바이더의 모델과 다르면 그 계층에 벡터 검색을 하지 않습니다.

`embeddingSelectionKey(config)`는 두 설정이 같은 프로바이더를 같은 값으로 고르는지 견주는 문자열입니다(프로바이더가 없으면 빈 문자열). 두 계층이 프로바이더 객체 하나를 함께 쓸지 정할 때와 MCP 서버가 프로바이더 객체를 선택별로 하나씩만 만들 때 씁니다. 설정 파일에 적은 키가 들어갈 수 있으므로 메모리 안에서 비교하는 데만 쓰고 출력하거나 저장하지 않습니다.

---

## 장애 대응

### 검색어 임베딩

검색(`src/core/search.mjs`)은 검색어를 임베딩할 때 `embedding.queryTimeoutMs`(기본 3,000ms)만 기다리고 다시 시도하지 않습니다. 프로바이더가 제한 시간을 지키지 않더라도(모델을 읽는 중인 ONNX 등) 검색 쪽 타이머가 같은 시간에 기다림을 끝냅니다. 임베딩하지 못하면 키워드와 그래프 결과로 답하고 결과에 `vectorUsed: false`와 함께 이유를 `vectorSkipped`로 알립니다.

| `vectorSkipped` | 뜻 |
| :--- | :--- |
| `circuit_open` | 차단기가 열려 있어 서비스에 묻지 않았습니다. |
| `embedding_timeout` | `queryTimeoutMs` 안에 답이 오지 않았습니다. |
| `embedding_error` | 프로바이더가 실패했거나 쓸 수 있는 벡터를 주지 않았습니다. |

두 계층의 프로바이더가 다르면 검색어를 프로바이더마다 한 번씩 동시에 임베딩하므로, 기다리는 시간은 최대 `queryTimeoutMs` 한 번입니다.

### 차단기

차단기(`createEmbeddingBreaker({ cooldownMs, now })`)는 서비스 쪽 실패가 한 번 나면 `cooldownMs` 동안 "열림" 상태가 되어, 그동안 검색어 임베딩과 문서 대기열이 서비스를 부르지 않게 합니다. 기본 시간은 `DEFAULT_CIRCUIT_BREAK_MS = 300000`(5분)이고 MCP 서버는 `embedding.circuitBreakMs` 값을 씁니다.

- **여는 것**: 서비스 쪽으로 분류된 실패(아래 표)뿐입니다. 검색어 임베딩과 문서 임베딩 어느 쪽에서 나든 같습니다. 열려 있는 동안 또 실패가 기록되면 쉬는 시간이 그때부터 다시 시작됩니다.
- **닫는 것**: 쓸 수 있는 벡터를 받은 성공 한 번입니다. 쉬는 시간이 지나면 다음 호출이 서비스를 다시 불러 보고, 실패하면 다시 열리고 성공하면 닫힙니다. 제한 시간을 넘겨 포기한 검색어 임베딩의 답이 나중에 도착해도 성공으로 치고 닫습니다. 닫힐 때 `onRecover`에 등록한 함수들을 부릅니다.
- **인증 오류(HTTP 401, 403)**: 차단기를 열지 않습니다. 대기열은 그 실행을 `reason: "auth_failed"`로 멈추고 어떤 문서의 횟수에도 세지 않으며, 다음 예약 때 다시 시도합니다. 검색은 `vectorSkipped: "embedding_error"`와 함께 키워드 결과로 답하고, 검색할 때마다 서비스를 다시 부릅니다. 키를 고치기 전에는 같은 결과가 반복됩니다.
- **`cooldownMs`가 0이면** 실패를 기록만 하고 쉬지 않습니다. 음수이거나 숫자가 아니면 기본값을 씁니다.
- **프로세스당 하나**: `getSharedEmbeddingBreaker()`가 프로세스에 하나뿐인 차단기를 돌려주고, MCP 서버는 이것을 검색과 대기열에 함께 넘깁니다. 프로젝트 계층과 전역 계층이 서로 다른 프로바이더를 쓰더라도 차단기는 하나이므로, 한쪽 서비스의 실패가 다른 쪽의 임베딩도 쉬게 하고, 한쪽의 성공이 차단기를 닫아 실패한 쪽도 다시 불리게 됩니다.
- `npm run embed`는 자기 프로세스에서 새 차단기를 만들어 쓰므로 MCP 서버의 차단기 상태를 보지도 바꾸지도 않습니다.

### 실패를 세는 규칙

`classifyEmbeddingError(err)`는 실패를 세 가지로 나눕니다.

| 종류 | 해당하는 실패 | 대기열의 처리 |
| :--- | :--- | :--- |
| `service` | 시간 초과(`TimeoutError`, `AbortError`), 네트워크 오류(`ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT` 등과 `UND_ERR_`로 시작하는 코드, `fetch failed`), HTTP 408, 429, 5xx, 쓸 수 없는 응답(JSON이 아니거나 벡터 개수가 보낸 글의 수와 다름), ONNX 모델을 읽지 못함 | 실행을 멈추고(`reason: "service_unavailable"`) 차단기를 엽니다. 그때 임베딩하던 문서의 `embed_service_failures`만 1 올립니다. `embed_attempts`에는 세지 않습니다. |
| `auth` | HTTP 401, 403 | 실행을 멈춥니다(`reason: "auth_failed"`). 횟수를 세지 않습니다. |
| `document` | 그 밖의 HTTP 4xx, 위 두 종류로 분류되지 않는 실패, 대기열의 검사에 걸린 벡터(빈 벡터, 길이가 서로 다른 벡터), 벡터를 DB에 쓰지 못함 | 그 문서의 `embed_attempts`를 1 올리고 다음 문서로 넘어갑니다. |

어느 경우든 문서는 `embed_status = 'error'`가 되고 오류 글의 앞 200자가 `embed_error`에 남습니다. 대기열이 문서를 더 시도하지 않는(포기하는) 경우는 둘입니다.

- `MAX_EMBED_ATTEMPTS = 3`: 문서 자체의 실패가 3번 쌓였을 때. 포기 이유는 `document_errors`입니다.
- `MAX_EMBED_SERVICE_FAILURES = 10`: 같은 문서를 임베딩하는 중에 서비스 쪽 실패가 10번 났을 때. 포기 이유는 `service_failures`입니다. 서비스 장애는 문서의 잘못이 아니어서 3번 상한에는 세지 않지만, 같은 문서에서만 되풀이되면 그 문서가 원인일 가능성이 커서 따로 셉니다.

두 이유의 이름은 `GIVEN_UP_REASONS`(`{ document: 'document_errors', service: 'service_failures' }`)에 있습니다. 서비스 실패 한 번은 문서 하나에만 기록되고, 다음 실행은 서비스 실패 횟수가 가장 적은 문서부터 시작하므로, 긴 장애의 횟수는 기다리는 문서들에 고르게 나뉩니다.

**장애가 얼마나 이어져야 문서가 포기되는가**: 기다리는 문서가 하나뿐이고 서비스가 계속 실패하면, 대기열은 차단기가 쉬는 시간(300,000ms)에 25ms를 더한 간격으로 그 문서를 다시 시도하고 그때마다 1번이 쌓입니다. 10번째 실패는 첫 실패로부터 9번의 간격 뒤이므로, 실패가 곧바로 나는 장애(연결 거부 등, 시도 한 번에 재시도 대기 750ms)에서는 9 × 300,775ms로 약 45분, 요청마다 제한 시간을 다 쓰는 장애(시도 한 번에 15,000 + 250 + 15,000 + 500 + 15,000 = 45,750ms)에서는 9 × 345,775ms로 약 52분입니다. 기다리는 문서가 N개이면 횟수가 나뉘므로 약 N배가 걸립니다. 장애 중에 MCP 서버를 다시 시작하거나 `npm run embed`를 실행하면 그때마다 시도가 한 번 더 일어나 횟수가 더 빨리 쌓입니다.

### 복구 뒤 따라잡기

- 차단기가 열린 동안 대기열은 예약된 일을 버리지 않고, 쉬는 시간이 끝난 25ms 뒤로 실행을 미룹니다. 그때 다시 실패하면 같은 방식으로 또 미룹니다.
- 차단기가 닫히면(검색어 임베딩이 성공했거나 대기열의 임베딩이 성공했을 때) 대기열은 `onRecover`를 통해 `schedule('all')`을 예약합니다. 그래서 새 저장이 없어도 밀린 문서가 처리됩니다.
- MCP 서버가 시작될 때도 전체를 한 번 예약합니다.

### 포기한 문서

- `listFailedEmbeddings(store, { scope = 'all', maxIds = 50 })`는 계층별로 `{ count, ids, documents, byReason }`을 돌려줍니다. `count`는 포기한 문서 전체 수, `ids`와 `documents`(`{ id, reason, error }`)는 최근에 고친 순서로 `maxIds`개까지, `byReason`은 `{ document_errors: n, service_failures: n }`입니다. `superseded`와 `archived` 문서는 어차피 임베딩하지 않으므로 세지 않습니다.
- `retryFailedEmbeddings(store, { scope = 'all' })`는 포기한 문서를 이유와 상관없이 `embed_status = 'pending'`으로 되돌리고 두 횟수를 0으로, `embed_error`를 빈 값으로 만든 뒤, 계층별로 되돌린 문서 수 `{ project: n, global: n }`을 돌려줍니다. 다음 대기열 실행이 그 문서들을 다시 시도합니다.
- 포기한 문서는 `cortex-status`의 임베딩 줄과 `npm run embed` 요약의 `failedDocuments`에 나오며, `npm run embed -- --retry-failed`로 되살립니다.
- 포기한 문서의 본문을 고치면(`content_hash`가 달라지면) 횟수가 0으로 돌아가 다시 시도됩니다. 모델이 바뀌어 벡터 테이블이 재구축될 때도 마찬가지입니다.

---

## CLI: `npm run embed`

`npm run embed`는 `node --no-warnings src/embeddings/cli.mjs`를 실행합니다. MCP 서버가 떠 있지 않아도 대기 중인 문서를 한꺼번에 처리할 때, 프로바이더를 처음 켠 뒤 기존 문서를 임베딩할 때, 포기한 문서를 되살릴 때 씁니다.

```powershell
npm run embed
npm run embed -- --scope global
npm run embed -- --provider ollama --model bge-m3
npm run embed -- --retry-failed
npm run embed -- --project <프로젝트 폴더> --global <전역 저장소 폴더> --max-docs 50
```

| 스위치 | 기본값 | 뜻 |
| :--- | :--- | :--- |
| `--project <폴더>` | 현재 폴더 | 프로젝트 루트 |
| `--global <폴더>` | 전역 저장소의 기본 위치 | 전역 저장소 폴더 |
| `--scope <project\|global\|all>` | `all` | 처리할 계층. 허용 값은 `EMBED_CLI_SCOPES`(`project`, `global`, `all`)이고 대소문자를 구분합니다. 다른 값은 인자 오류입니다. |
| `--provider <이름>` | 설정 값 | 이번 실행에서만 `embedding.provider`를 이 값으로 바꿉니다. 두 계층 모두에 적용됩니다. |
| `--model <이름>` | 설정 값 | 이번 실행에서만 모델을 바꿉니다. `--provider`로 이름을 준 프로바이더의 묶음에, 없으면 설정이 고른 프로바이더의 묶음에 들어갑니다. 쓰이는 프로바이더가 없으면 인자 오류입니다. |
| `--max-docs <수>` | `200` | 한 묶음에서 계층당 처리하는 문서 수. 전체 상한이 아니라 묶음의 크기입니다. 숫자로만 된 1 이상의 정수여야 하며, 그 밖의 값(`abc`, `0`, `-3`, `2.5`)은 인자 오류입니다. |
| `--retry-failed` | 꺼짐 | 처리하기 전에 포기한 문서를 되살립니다(처리 대상 계층에 한함). |

**인자 오류**: 쓸 수 없는 값은 일을 시작하기 전에 걸러 냅니다. `--scope`의 허용되지 않은 값, `--max-docs`의 양의 정수가 아닌 값, 값이 필요한 스위치(`--project`, `--global`, `--scope`, `--provider`, `--model`, `--max-docs`) 뒤에 값이 없거나 빈 문자열인 경우입니다. 이때는 설정도 저장소도 읽지 않고(`--retry-failed`도 실행되지 않음), 표준 오류에 `[herdr-cortex] <설명>` 한 줄을 쓰고, 표준 출력에 아래 모양의 요약을 낸 뒤 종료 코드 1로 끝납니다. 문제가 여럿이면 명령줄에 나온 순서대로 `error`에 이어 붙입니다.

```json
{
  "provider": null,
  "dimensions": 0,
  "processed": 0,
  "chunksIndexed": 0,
  "rebuiltTiers": [],
  "errors": 0,
  "circuitBroken": false,
  "reason": "invalid_arguments",
  "error": "--scope must be one of project, global, all (got \"bogus\")."
}
```

설명 문구는 `--scope must be one of project, global, all (got "<값>").`, `--max-docs must be a positive whole number (got "<값>").`, `<스위치> needs a value (<받는 값>).`의 세 가지입니다. 프로바이더 이름(`--provider`)은 여기서 검사하지 않고 설정의 이름과 함께 아래 5단계에서 검사합니다(`invalid_provider`). 모르는 스위치는 검사하지 않고 무시합니다.

**실행 순서**

1. 명령줄을 해석합니다. 위의 인자 오류가 있으면 요약을 내고 여기서 끝납니다. 없으면 설정을 읽습니다. 프로젝트 계층은 "전역 설정 + `projects[...]` 항목", 전역 계층은 전역 설정만 쓰고, `--provider`와 `--model`은 양쪽에 덮어씁니다.
2. 표준 오류에 상태 줄을 출력합니다. `formatEmbeddingStatus`의 각 줄 앞에 `[herdr-cortex] `가 붙으며, 어떤 프로바이더가 쓰이고 문서가 어디로 전송되는지와 설정 문제가 일을 시작하기 전에 나옵니다.
3. 프로젝트가 설정으로 제외되었는지(`excludedProjects`, `opt-in` 모드, `enabled: false`), 사용자가 승인한 폴더인지 확인합니다. 둘 중 하나라도 걸리면 그 프로젝트의 `.memory/`는 읽지 않습니다. 둘 다 해당하면 제외로 보고합니다. `--scope project`이면 `skipped: true`와 `reason: "project_disabled"` 또는 `"project_not_approved"`를 담은 짧은 요약을 출력하고 끝납니다(종료 코드 0, `--retry-failed`도 실행되지 않음). `--scope all`이면 전역 계층만 처리하고 요약에 `skippedProject: true`(미승인이면 `projectNotApproved: true`도)를 넣습니다. 미승인이고 `--scope`가 `global`이 아니면 승인 방법을 알리는 줄이 표준 오류에 나옵니다.
4. `--retry-failed`가 있으면 포기한 문서를 되살립니다. 다음 단계에서 임베딩을 시작하지 못하게 되는 경우에도 이 단계는 실행됩니다.
5. 프로바이더 없이 `--model`을 주었거나, 이번 실행의 계층에 알 수 없는 프로바이더 이름이나 키 없는 프로바이더가 있으면 임베딩을 시작하지 않습니다(`reason`은 차례로 `"invalid_arguments"`, `"invalid_provider"`, `"no_provider"`이고 `error`에 설명, 종료 코드 1).
6. `processPendingEmbeddings`를 되풀이해 부릅니다. 한 묶음에서 처리한 문서가 0건이거나, 프로바이더가 없거나, 서비스 실패 또는 인증 실패로 실행이 멈추면 끝냅니다. 되풀이는 최대 1,000번입니다. 서비스가 실패하면 기다렸다가 다시 시도하지 않고 바로 끝납니다.
7. 표준 출력에 요약을 JSON(들여쓰기 2칸)으로 출력합니다.

**요약의 필드**

| 필드 | 내용 |
| :--- | :--- |
| `provider`, `model` | 쓰인 프로바이더와 모델. 프로바이더가 없으면 `provider: null`이고 `model`은 없습니다. |
| `sendsTo` | 문서를 보낸 `호스트[:포트]`(`onnx`이거나 프로바이더가 없으면 없음) |
| `tiers` | 두 계층이 다른 설정으로 임베딩될 때만 있습니다. 계층별 `{ provider, model, dimensions, processed, chunksIndexed, errors, sendsTo }` |
| `dimensions` | 벡터 차원 수 |
| `processed`, `chunksIndexed` | 임베딩한 문서 수와 청크 수 |
| `rebuiltTiers` | 벡터 테이블이 재구축된 계층 |
| `errors` | 임베딩이나 기록에 실패한 문서 처리 횟수 |
| `circuitBroken` | 서비스 실패나 인증 실패로 중단되었는지 |
| `skippedProject`, `projectNotApproved` | 프로젝트 계층을 건너뛴 경우 |
| `reason` | `no_provider`, `invalid_provider`, `invalid_arguments`, `service_unavailable`, `auth_failed`, `circuit_open`. 프로젝트를 건너뛴 짧은 요약에서는 `project_disabled`, `project_not_approved` |
| `error` | 실행을 시작하지 못한 이유의 설명 |
| `failedDocuments` | 처리 대상 계층의 포기 문서(`listFailedEmbeddings`의 결과). 스위치 값의 인자 오류로 끝난 요약에는 없습니다 |
| `retryReset` | `--retry-failed`를 썼을 때 계층별로 되살린 문서 수 |
| `configProblems` | 설정 문제의 설명 목록(전역 쪽 문제에는 `global memory: `가 앞에 붙음) |

프로바이더가 `none`일 때 `npm run embed -- --scope global`의 실제 출력은 다음과 같습니다.

```
[herdr-cortex] embedding: off (provider is "none"); nothing is sent anywhere.
```

```json
{
  "provider": null,
  "dimensions": 0,
  "processed": 0,
  "chunksIndexed": 0,
  "rebuiltTiers": [],
  "errors": 0,
  "circuitBroken": false,
  "reason": "no_provider",
  "failedDocuments": {
    "global": {
      "count": 0,
      "ids": [],
      "documents": [],
      "byReason": {
        "document_errors": 0,
        "service_failures": 0
      }
    }
  }
}
```

**종료 코드**: 문서 처리가 한 번이라도 실패했거나(`errors > 0`), 요약에 `error`가 있거나(쓸 수 없는 스위치 값, 알 수 없는 프로바이더 이름, 키 없는 프로바이더, 프로바이더 없이 준 `--model`), 예외가 나면(`embed cli error: ...`가 표준 오류에 출력됨) 1입니다. 그 밖에는 0입니다. 프로바이더가 `none`이어서 할 일이 없는 경우, `auto`가 아무것도 고르지 못한 경우, 프로젝트를 건너뛴 경우도 0입니다.

`--model`을 프로바이더 없이 주었을 때의 문구는 `--model was given but no embedding provider is in effect; add --provider <gemini|openai|ollama|onnx> or set embedding.provider in config.json.`이고 요약의 `reason`은 `invalid_arguments`입니다.

---

## 관련 테스트

이 폴더의 모듈을 직접 불러 쓰는 테스트 파일은 다음과 같습니다.

* [`test/config-and-embeddings.test.mjs`](../../test/config-and-embeddings.test.mjs): 기본값 `none`, 알 수 없는 프로바이더 이름, CLI의 인자 오류(`--scope`, `--max-docs`, 값 없는 스위치), 프로바이더별 묶음과 `auto`, 옛 형식 키 경고, 프로젝트별 설정과 전역 계층, 상태 함수, 검색어 임베딩의 제한 시간, 차단기, 실패를 세는 규칙(3번과 10번), 복구 뒤 따라잡기, 서버 시작 시 처리, 포기한 문서와 `--retry-failed`, `project_dir` 저장의 임베딩 예약
* [`test/search-rrf.test.mjs`](../../test/search-rrf.test.mjs): 벡터 색인과 모델 변경 시 재구축, 머리말만 바뀐 문서의 벡터 보존, 문서 실패 3번 상한, 401에서 실행 중단, 처리 중 바뀐 문서의 결과 폐기, `drain`, Gemini의 헤더·묶음·재시도, Ollama의 접두어, `buildDocChunks`, 벡터가 없을 때 검색어를 임베딩하지 않는 것, CLI의 제외 프로젝트 처리·되풀이·종료 코드
* [`test/store-and-db.test.mjs`](../../test/store-and-db.test.mjs): `processPendingEmbeddings`로 채운 `doc_chunks_vec`의 디스크 크기와 `index_meta`
* [`test/project-trust.test.mjs`](../../test/project-trust.test.mjs): 승인되지 않은 프로젝트를 `npm run embed`와 서버 대기열이 건너뛰는 것
* [`test/cortex-status.test.mjs`](../../test/cortex-status.test.mjs): `cortex-status`가 계층별 임베딩 상태와 포기한 문서를 보여 주는 것(`MAX_EMBED_ATTEMPTS` 사용)

직접 불러 쓰지는 않지만 이 폴더의 동작을 거치는 테스트도 있습니다.

* [`test/background-indexing.test.mjs`](../../test/background-indexing.test.mjs): 프로바이더가 설정된 서버에서 대기열이 색인을 파일 하나씩 맞추는 동안 도구 호출이 먼저 답을 받는 것
* [`test/core-robustness.test.mjs`](../../test/core-robustness.test.mjs): 정션을 거친 경로로 `cli.mjs`를 실행해도 진입점으로 동작하는 것
* [`test/installer.test.mjs`](../../test/installer.test.mjs): 설치기가 출력하는 임베딩 상태 줄과 옛 형식 설정의 처리
* [`test/powershell-scripts.test.mjs`](../../test/powershell-scripts.test.mjs): `install.ps1`의 출력에 임베딩 상태 줄이 나오는 것
