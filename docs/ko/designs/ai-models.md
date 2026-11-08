# AI 모델 배포: Hugging Face 채널과 다중 공급자 미러 (설계 계약)

> 상태: 초안(DRAFT) — `feat/ai-models` 웨이브의 구현 계약.
> 범위: 내장 결정/점수 모델(ONNX 가중치, 함선 속성 라우팅 테이블, 맵별
> 지형-LOS 래스터)과 그 훈련/배포 스크립트를 공개 Hugging Face 모델
> 저장소에 게시하고, 새로운 서명형 `ai` 리소스 채널을 통해 파일별 다운로드로
> 클라이언트에 제공하며, GitHub 전용 미러 래더를 모든 다운로드 가능
> 리소스가 공유하는 공급자 인식 미러 컨텍스트로 일반화한다.
>
> 범위 밖: 동결된 앱 업데이트 채널, `res-latest` 리소스 팩(GitHub Releases에
> 유지됨), 훈련 파이프라인 자체, 리플레이 데이터셋 게시.

## 1. 문제와 목표

내장 결정 모델(ONNX 발사/이동 점수 헤드, 속성 라우팅 조언 모델, 선택적
어뢰 모델, 라우팅 테이블, 맵별 지형 가시선 래스터)에는 **배포 채널이 전혀
없다**. 이들은 `scripts/experiments/out/` 아래의 gitignore된 훈련 산출물로
존재하며, 설치된 `<cache>/decisions` 팩은 앱이 목록화하고 비울 수만 있는
손으로 복사한 디렉터리다. 게시 스크립트도, 매니페스트도, 다이제스트도,
다운로더도, 버전 스탬프도, 커버리지 보장도 없다 — 오늘날 알려진 맵 id 96개
중 35개만 LOS 래스터를 가지며, 설치된 두 모델은 더 오래되었고 현재 fp32
내보내기의 대략 절반 크기이며, 조언/어뢰 슬롯은 그냥 비어 있다.

동시에 앱은 이미 더 풍부한 팩을 제공하는 방법을 알고 있다: `res-latest`
리소스 팩은 이 저장소에서 게시되고, 중국 본토 네트워크를 위해 ghproxy 스타일
래더로 미러링되며, 공식 sha256 다이제스트에 대해 검증되고 원자적으로
적용된다. 결정 모델 채널은 1.3 GB 리소스 팩의 제약을 물려받지 않으면서 같은
엔지니어링 표준에 도달해야 한다.

목표:

1. **하나의 공개적이고 재현 가능한 산출물.** 모든 모델 릴리스는 이름이
   지정된 저장소 커밋에서 체크인된 스크립트로 생성되며, 훈련 및 배포
   스크립트와 함께 공개 Hugging Face 모델 저장소에 게시된다.
2. **앱 릴리스와 독립적인 업데이트 — 단, 피처 계약 내에서.** 재훈련된
   모델은 입력/피처 스키마가 실행 중인 피처라이저와 일치하는 한 새 앱 빌드
   없이도 설치된 클라이언트에 도달할 수 있다; 스키마 변경은 정의상 앱
   릴리스다.
3. **실행 전 무결성.** 모델 파일은 ONNX Runtime에 의해 파싱되고 실행되므로
   채널은 페일 클로즈다: 서명된 매니페스트가 모든 파일의 sha256과 Hugging
   Face 커밋을 고정하며, 서명이 없거나 일치하지 않는 페이로드는 절대
   설치되지 않는다.
4. **중국 본토 도달성.** 런타임 래더는 (메인테이너 네트워크에서 검증된
   대로) `huggingface.co`에 도달할 수 없는 곳에서도 단일 서드파티 미러를
   하드코딩하지 않고 동작해야 한다.
5. **하나의 미러 프레임워크.** GitHub, Hugging Face 및 (나중에) ModelScope는
   ghproxy 접두사 목록의 다섯 사본 대신, 후보 재작성·프로빙·헬스/스티키
   선택·드리프트 검사된 엔드포인트 목록을 아우르는 하나의 공급자 인식
   컨텍스트를 공유한다.
6. **트리에 비밀 정보 없음.** Hugging Face 자격 증명은 환경이나 사용자 토큰
   저장소에 산다; 추적되는 파일에는 절대 두지 않는다.

### 1.1 측정된 입력

| 산출물 | 출처(개발 체크아웃) | 크기 |
| --- | --- | --- |
| 발사 모델(fp32, v2 ablate NONE) | `scripts/experiments/out/fire_model/v2plain_std/fp32.onnx` | 2,592,543 B |
| 이동 모델(fp32, 17클래스, ablate E11) | `scripts/experiments/out/move_model/node3/main/fp32.onnx` | 2,652,542 B |
| 조언 발사 모델(fp32, E24 속성 라우팅) | `scripts/experiments/out/fire_model/e24_attrs/fp32.onnx` | 2,595,135 B |
| 어뢰 모델(fp32; int8 선택 사항) | `scripts/experiments/out/torpedo_model/final/fp32.onnx` | 492,411 B (int8 136,214 B) |
| 함선 속성 라우팅 테이블 | `scripts/experiments/ship_attributes.json` | 261,507 B |
| 지형-LOS 래스터 | `bake_terrain_los.py` 출력, 맵당 `terrain_los.npz` 하나 | 각 5,986-221,638 B (35개 맵 설치됨) |

모든 파일은 Hugging Face가 git-xet 추적을 권장하는 기준선인 10 MB보다 훨씬
아래이므로, 릴리스는 일반 Git으로 유지된다: `/resolve/`가 직접 200을
응답하고 LFS/Xet 클라이언트가 필요 없다(7.8절 참고).

## 2. 현재 상태

| 영역 | 현재 | 결과 |
| --- | --- | --- |
| 모델 게시 | 없음 | 모델은 수동 복사 외에는 사용자에게 도달할 수 없다 |
| 설치된 팩 | `<LOCALAPPDATA>/WoWSP/decisions`, 손으로 복사 | 스테일/부분적; 스탬프 없음; 잘못된 세대의 모델을 감지할 수 없다 |
| 모델 로딩 | `decision_serve` 래더: 환경 -> 팩 슬롯 -> 개발 산출물; `ship_attrs`는 컴파일 타임 `include_str!` 테이블 사용 | 라우팅 테이블 변경에 앱 릴리스가 필요하다; "팩이 내장 테이블을 오버라이드한다"는 주석은 구현되지 않았다 |
| 리소스 팩 | GitHub `res-latest` + 델타 체인 + 릴레이 서명 다이제스트 | 성숙함; 그대로 유지 |
| 미러 래더 | ghproxy 접두사 연결을 사용하는 GitHub 전용 호스트 목록; Rust, Cargo 메타데이터, Python, 웹사이트, webui 목업, 릴레이 CSP에 사본 존재 | `huggingface.co`를 앞단에 둘 수 없다; 드리프트는 사본 하나에 대해서만 테스트된다 |
| 모바일 | ONNX Runtime이 기본 피처이므로 Android/iOS 빌드는 ONNX를 포함한다; decisions 팩은 번들되지 않는다 | 모바일도 같은 채널의 혜택을 받을 수 있다 |
| 레지스트리 행 | `decisions-pack`, 채널 비어 있음, 트리거 `manual` | 확인/다운로드 버튼 없음, 최신성 원장 항목 없음 |

따라서 이번 웨이브는 채널을 **새로 만든다**; 기존 채널을 마이그레이션하지
않는다.

## 3. 아키텍처 개요

세 계층, 각 계층에 하나의 역할:

```text
  GitHub repo (source of truth)
      |  python scripts/publish_ai_models.py  (hash -> sign -> upload)
      v
  Hugging Face model repo  wowsp-ai  (generated release artifact + scripts snapshot)
      |  signed manifest.json + per-file resolve/<commit-sha>/<path>
      v
  client  commands/ai_pack.rs  --->  commands/mirror/ (MirrorContext)
      |      per-file download via download_hub        GitHub | Hugging Face | ModelScope
      v
  <cache>/decisions  (fire/move/advice/torpedo + attrs + <map>/terrain_los.npz)
```

| 결정 | 선택 | 이유 |
| --- | --- | --- |
| 다운로드 소스 | v1에서는 Hugging Face만(내장 `hf-mirror.com` 포함); GitHub Release 폴백과 ModelScope는 나중 공급자 | 검증할 게시 경로가 하나뿐이다; 미러 컨텍스트 덕에 공급자 추가가 저렴하다 |
| 매니페스트 신뢰 앵커 | 기존 고정 Ed25519 키와 `seq` 래칫을 사용하는 자체 서명 매니페스트 | Hugging Face는 자산별 공식 다이제스트를 노출하지 않는다; 릴레이 다이제스트 채널은 추가 보증 없이 모델 릴리스마다 배포 단계를 늘릴 뿐이다 |
| 전송 단위 | 산출물당 파일 하나, 원자적 스테이징 설치 | 모든 파일이 < 10 MB; 증분 업데이트; 허브가 이미 세그먼트별 진행률, sha256, 상한, 재개, 취소를 지원한다 |
| 미러 선택 | 콜드 스타트 헤징, 패스별 스티키 엔드포인트, 헬스 쿨다운을 갖춘 공급자 인식 래더 | 사용자 일부에게는 공식 호스트에 도달할 수 없다; 사용자가 나열한 순서의 결정성은 보존되어야 한다 |
| 리소스 팩 | 변경 없음, GitHub 전용 | 5.7k 파일, 델타 체인, GitHub 자산 다이제스트가 여전히 더 잘 맞는다 |

## 4. Hugging Face 저장소

### 4.1 레이아웃

```text
wowsp-ai/                          public model repository (owner/repo TBD, see 11)
  README.md                        model card: purpose, provenance, metrics, file table, licence
  LICENSE                          Synthetic Source License 1.0 (same as the app repo)
  manifest.json                    signed runtime manifest (section 5)
  NOTICE.md                        game-data provenance and redistribution note (section 4.5)
  onnx/fire_model.onnx
  onnx/move_model.onnx
  onnx/advice_fire_model.onnx
  onnx/torpedo_model.onnx
  onnx-int8/                       optional quantized variants, never installed by default
  attrs/ship_attributes.json
  los/<mapId>/terrain_los.npz
  training/                        generated snapshot: scripts/experiments training/deployment scripts
  SOURCE.json                      {"repo","commit","generatedAt","tool":"scripts/publish_ai_models.py"}
```

`manifest.json`은 앱이 채널 진입점으로 취급하는 유일한 파일이다. 개별
파일 역시 사람과 모델 카드의 파일 테이블을 통해 개별 다운로드할 수 있다.

### 4.2 파일 크기 규칙

각 저장소 파일은 **10 MB 미만**으로 유지되어 일반 Git 블롭으로 저장된다
(`/resolve/`가 바이트와 함께 200을 반환하며, 서명된 CDN 리다이렉트도, xet
재구성도 없다). LOS 래스터는 현재 맵당 파일 하나이며(모두 한도 훨씬 아래),
미래의 팩이 파일별 한도를 초과하게 되면 LOS를 각각 한도 아래로 유지되는
번호 붙은 번들로 나눈다. 게시 스크립트는 10 MB를 초과하는 스테이징 파일을
거부하고 문제가 되는 경로를 출력한다.

### 4.3 리비전 모델

Hugging Face 리비전은 커밋이다; 브랜치/태그는 움직일 수 있지만 커밋 SHA는
움직이지 않는다. 따라서 게시는 두 커밋을 사용한다:

1. 산출물 파일(가중치, attrs, LOS, 스크립트 스냅샷)을 업로드 -> 커밋 `A`;
2. 매니페스트 안에 `"revision": "A"`를 담아 `manifest.json`, `README.md`,
   `LICENSE`, `NOTICE.md`, `SOURCE.json`을 업로드 -> 커밋 `B`.

앱은 브랜치 헤드(`main`)에서 `manifest.json`을 가져와 서명을 검증한 뒤,
`/{repo}/resolve/{A}/{path}`에서 모든 파일을 다운로드한다 — 불변 고정이다.
오래된 매니페스트를 캐시한 클라이언트는 `main`이 전진한 뒤에도 계속 더
오래된 커밋을 사용한다. 주석(`models-<seq>` 태그)은 사람 전용이다.

### 4.4 게시 워크플로와 운영

`scripts/publish_ai_models.py` (`scripts/release_models.py`를 모델로 삼음):

1. 입력 수집(가중치, `ship_attributes.json`, 베이크된 LOS 디렉터리, 이름이
   지정된 커밋의 `git archive`로 만든 스크립트 스냅샷);
2. 모든 파일 해시, 서명된 매니페스트 구성(5절), 트리 해시 계산;
3. 산출물 업로드(커밋 A), 이어서 매니페스트와 문서 업로드(커밋 B, A에 고정);
4. 릴리스 요약 출력(seq, 매니페스트 sha256, HF 커밋, 파일 테이블).
   `--dry-run`은 업로드 없이 모든 로컬 단계를 수행한다.

**계정, 토큰 및 저장소 생성.** Hugging Face에는 익명 쓰기 경로가 없다:
게시에는 계정과 쓰기 토큰이 필요하다. 토큰은 웹 UI(Settings -> Access
Tokens, 가급적 이 저장소의 쓰기 범위로 제한된 세분화된 토큰)에서 생성하며
`HF_TOKEN` 또는 표준 사용자 토큰 저장소(`~/.cache/huggingface/token`)를 통해
공급된다. 저장소 자체는 스크립트가 `huggingface_hub.create_repo`(REST
`POST /api/repos/create`)로 만들거나, 웹 UI로 만들거나, 선택적 `hf repo
create` CLI로 만들 수 있다 — 세 가지 모두 동등하다; **CLI는 전제 조건이
아니다**. 게시 스크립트는 `huggingface_hub` Python API를 사용하며, 이는
공식 `huggingface/hub-sync` GitHub Action이 감싸는 것이기도 하다; CI 레인이
나중에 `HF_TOKEN`을 저장소 시크릿으로 하여(절대 추적되지 않음) 같은
스크립트를 실행할 수 있다.

**네트워크 현실.** 쓰기를 받는 곳은 `huggingface.co`뿐이다. 중국 본토에서
그 호스트는 직접 도달할 수 없으므로(검증됨: 연결 타임아웃), 로컬 게시
실행에는 메인테이너의 HTTP(S) 프록시(`HTTPS_PROXY`)가 필요하거나 게시가
CI에서 실행된다. 미러는 읽기 전용 프록시다: 런타임 읽기에는 프록시가 필요
없지만 쓰기에는 필요하다. 업로드 후 검증은 미러를 통해 수행할 수
있다(7.8절).

**버전 관리.** `seq`는 `manifest.json`에 저장되는 엄격히 증가하는 게시
카운터다(게시 스크립트는 값이 현재 게시된 매니페스트의 값보다 크지 않으면
경고한다). `version`은 UTC 게시 타임스탬프이고, 콘텐츠 아이덴티티는
`treeSha256`이다(5.4절).

### 4.5 문서와 출처

- `README.md`는 모델 카드다: 각 모델이 하는 일, 피처라이저 계약,
  `scripts/experiments/README.md`의 평가 수치(해당되는 경우
  auPRC/AUC/ECE/십분위 리프트), 입력/출력 텐서 형태, 재현 방법, 정확한
  GitHub 커밋 링크, 라이선스.
- `SOURCE.json`은 저장소, 커밋, 생성 시각, 정확한 트리 해시를 기록하여
  릴리스된 산출물을 코드로 추적할 수 있게 한다.
- `training/`은 `scripts/experiments/`의 **생성된 스냅샷**이다(스크립트, 빌드
  헬퍼, 연구 로그). 모델 카드는 권위 있는 출처가 기록된 커밋의 GitHub
  저장소이며 스냅샷은 Hugging Face에서 편집해서는 안 된다고 명시한다.
- 원본 리플레이 코퍼스는 절대 게시되지 않는다: 사용자가 기여한 세션
  데이터다. 모델 카드는 코퍼스 형태와 필터링/동의 근거를 집계 수준으로만
  설명한다.
- `NOTICE.md`는 LOS 래스터가 게시된 맵 지오메트리에서 베이크되었고 속성
  테이블이 게임 데이터에서 파생되었음을 기록하며, Synthetic Source License
  공개 요구 사항을 다시 명시한다. 가중치는 리플레이에서 파생된 피처로
  훈련된다. 이것은 공개 `res-latest` 채널이 이미 배포하는 것과 같은 데이터
  클래스다; 두 번째 공개 호스트에 게시하는 것은 라이선스를 바꾸지 않지만
  가시성을 바꾸므로 명시적으로 언급한다(11절, 결정 2).

### 4.6 동기화 정책

GitHub이 유일한 진실 공급원이다. Hugging Face는 생성된 릴리스 산출물이다:
수동 편집도, 두 번째 개발 브랜치도, 역동기화도 없다. 모델 변경은 이
저장소에서 시작되고(훈련 스크립트 + 게시 스크립트의 입력으로 커밋된
산출물), 그다음 메인테이너가 게시 스크립트를 실행한다. 따라서 두 호스트
간의 차이는 병렬 유지 보수가 아니라 커밋 출처로 설명된다.

## 5. 서명된 매니페스트

### 5.1 예시

```json
{
  "format": 1,
  "seq": 7,
  "version": "2026-11-08T14:22:03Z",
  "revision": "0123456789abcdef0123456789abcdef01234567",
  "source": { "repo": "langyo/wowsp", "commit": "89abcdef0123456789abcdef0123456789abcdef" },
  "resTreeSha256": "3f2a...",
  "files": [
    { "path": "fire_model.onnx", "sha256": "8ba9...", "size": 2592543,
      "kind": "fire-two-head", "featureSet": "fire-v2", "quant": "fp32" },
    { "path": "move_model.onnx", "sha256": "bc91...", "size": 2652542,
      "kind": "move-sectors-17", "featureSet": "move-v2", "quant": "fp32" },
    { "path": "advice_fire_model.onnx", "sha256": "b98f...", "size": 2595135,
      "kind": "advice-fire-attrs", "featureSet": "advice-e24", "quant": "fp32" },
    { "path": "torpedo_model.onnx", "sha256": "a7e3...", "size": 492411,
      "kind": "torpedo-three-head", "featureSet": "torpedo-e26d", "quant": "fp32" },
    { "path": "ship_attributes.json", "sha256": "2bbd...", "size": 261507 },
    { "path": "50_Gold_harbor/terrain_los.npz", "sha256": "9c1d...", "size": 172432 }
  ],
  "treeSha256": "d41d...",
  "metrics": { "fire": { "auprc": 0.32, "auc": 0.72 } },
  "key_id": "main",
  "sig": "MEUCIQ..."
}
```

### 5.2 필드

| 필드 | 의미 |
| --- | --- |
| `format` | 매니페스트 스키마 버전(1) |
| `seq` | 엄격히 증가하는 게시 카운터; 앱은 마지막으로 설치한 값보다 낮은 값을 거부한다 |
| `version` | UTC 게시 타임스탬프, 표시 전용 |
| `revision` | 나열된 파일들을 정확히 담고 있는 Hugging Face 커밋 SHA |
| `source` | 릴리스가 생성된 GitHub 저장소 + 커밋 |
| `resTreeSha256` | LOS 래스터가 베이크된 기준 리소스 팩의 트리 해시(선택 사항; LOS가 포함되지 않으면 없음) |
| `files[].path` | `<cache>/decisions` 내부의 대상 경로; 일반 상대 경로, 세그먼트 검증됨(`[A-Za-z0-9._-]`, `..` 없음, 세그먼트 내부 구분자 없음) |
| `files[].sha256` | 정확한 바이트의 소문자 sha256 |
| `files[].size` | 바이트 크기, 전송 하한/상한으로 사용됨 |
| `files[].kind`, `featureSet`, `quant` | 모델 계약 메타데이터; `.onnx` 항목에 필수, 데이터 파일에는 없음 |
| `treeSha256` | 콘텐츠 아이덴티티: 정렬된 `path\0sha256\n` 라인들에 대한 sha256(리소스 팩과 동일한 공식이므로 같은 도구로 둘 다 해시할 수 있다) |
| `metrics` | 훈련 보고서에서 복사한 표시 메타데이터 |
| `key_id`, `sig` | Ed25519 서명 계층 |

### 5.3 서명과 롤백 방지

서명은 **`sig` 멤버를 제외한** 매니페스트의 정규 JSON을 대상으로 한다 — 키
정렬, 압축 구분자, UTF-8 — 이는 `scripts/catalog_signing.py`가 이미 구현했고
앱이 컴파일 타임 고정 공개 키(`packages/app/tauri/res/keys/*.pub`)에 대해
검증하는 것과 같은 정규 형식이다. 서명은 기존 릴리스 다이제스트 키
세리모니를 재사용하며, 새 키 쌍은 도입되지 않는다.

앱은 필드를 파싱하기 전에 서명을 검증한 뒤 `seq` 래칫을 적용한다: seq가
로컬에 저장된 값보다 낮은 인증된 매니페스트는 거부된다(리플레이/다운그레이드
가드). 따라서 미러는 최악의 경우 오래된 서명 매니페스트를 재제공할 수 있을
뿐, 위조할 수는 없다. 매니페스트 가져오기 실패나 유효하지 않은 서명은 이
확인에서 하드 실패다 — 채널은 의도적으로 "검증되지 않은 미러 매니페스트
수용" 폴백이 **없다**. 페이로드가 실행 가능한 모델 콘텐츠이기 때문이다.

### 5.4 최신성과 스테일 처리

`manifest.json`은 Hugging Face 브랜치 헤드에서 가져온다. 미러 캐시는 짧은
구간 동안 스테일한 사본을 제공할 수 있다; 스테일 매니페스트는 진본이지만
오래된 것이므로, 확인은 오래된 seq로 "최신"을 보고하거나 다음 확인을
기다린다. 게시 스크립트의 업로드 순서(산출물 먼저, 매니페스트 마지막)는
매니페스트가 고정된 리비전에서 아직 확인 불가능한 파일을 절대 명시하지
않도록 보장한다. 캐시된 파일은 sha256이 매니페스트와 일치할 때만 수용된다.

## 6. 런타임 채널 (`ai`)

### 6.1 레지스트리와 RPC 표면

| 항목 | 변경 |
| --- | --- |
| `resources.rs` 레지스트리 행 | `decisions-pack`이 채널 `ai`, 트리거 `boot`(조용한 확인) + 수동, 진행 종류 `ai-models`가 된다 |
| 상태 원장 | `<data>/resources/decisions-pack.json`이 설치/확인 타임스탬프를 기록하도록 `decisions-pack`을 `STAMPED_ROWS`에 추가 |
| 새 커맨드 | `ai_pack_status`, `ai_pack_check`, `ai_pack_download`, `ai_pack_cancel`; 비우기는 `clear_decisions_pack`을 재사용(스탬프 제거까지 확장) |
| 진행률 | `wowsp://download-progress`, 종류 `ai-models`, 패스당 작업 하나, `detail`에 파일별 세그먼트 |
| webui | Settings -> 리소스 카드(6.8절), api 모듈, `rpc.ts`, webMock, 패리티 테스트 |

### 6.2 확인 순서

1. 미러 컨텍스트를 통해 매니페스트 URL을 확인하고 `manifest.json`을
   가져온다(작은 파일; 콜드 스타트 헤징, 이후 스티키 엔드포인트).
2. Ed25519 서명과 정규 형식을 검증하고, 파싱하고, seq 래칫을 적용한다.
3. `seq` / `treeSha256`을 `<cache>/.ai-version.json`과 비교한다(스탬프는
   `decisions/` 안이 아니라 옆에 있어 트리 해시가 순수하게 유지된다). 차이가
   없으면 -> 현재 상태를 보고한다.
4. 매니페스트가 실행 중인 빌드가 로드할 수 없는 모델을 선언하면(6.6절 참고),
   다운로드하는 대신 릴리스를 호환 불가로 표시한다.

확인은 24시간 TTL을 두고 부팅 시 조용히 수행되며 카드에서 항상 사용할 수
있다. 절대 다운로드하지 않는다; 다운로드는 사용자 행동으로 남는다.

### 6.3 파일별 다운로드

모든 파일은 `kind = "ai-models"`로 `download_hub::transfer`를 탄다:

- 후보는 미러 컨텍스트에서 온다(Hugging Face 공급자, 매니페스트의 고정
  리비전), 미러 접두사 부여는 절대 적용되지 않는다;
- `expected_sha256` = 매니페스트 해시, `min_bytes = max_bytes = size`,
  `total_hint = size`, 파일별 파트 이름과 함께 `resume = true`;
- 한 파일이 실패하면 그 파일에 대해서만 다음 엔드포인트로 폴백한다; 패스는
  이미 검증된 바이트를 스테이징 트리에 보존한다;
- 진행률은 패스 전체의 집계 바이트(`base_received`/`base_total`)와
  `detail: {file, index, files}`를 보고한다; 취소는 허브의 표준 범위를
  따른다;
- 파일은 `<cache>/.ai-staging/<path>` 아래에 쓰인다; 모든 파일이 존재하고
  검증되기 전까지 활성 팩에는 아무것도 닿지 않는다.

### 6.4 설치 전 검증

스왑 전에 블로킹 작업에서:

1. 스테이징된 파일들에 대해 `treeSha256`을 다시 계산하고 매니페스트와
   비교한다(추가/누락 파일이 있으면 패스 실패);
2. 각 `.onnx` 파일에 대해 기존 ONNX Runtime 래퍼로 로드하고 분류한다: 종류,
   입력 폭, 출력 헤드가 선언된 `kind`/`featureSet`과 일치해야 한다(발사:
   24 x `ENTITY_DIM_V2` x `GLOBAL_DIM_V2`; 이동: 17 클래스; 조언: 속성
   라우팅 헤드; 어뢰: `TORP_GLOBAL_DIM_V2` 전역 블록);
3. 필수 모델이 실패하면 패스를 거부한다; 선택적 모델(조언, 어뢰)은
   매니페스트가 선택 사항으로 표시한 경우에만 경고와 함께 드롭할 수 있다.
   프로세스에 이미 캐시된 로드된 모델은 재시작할 때까지 계속 서비스한다.

이것은 현재의 수동 팩이 감지할 수 없는 "잘못된 세대 팩" 실패 모드를
제거하며, 그 대가로 스왑 전에 몇 메가바이트를 파싱한다.

### 6.5 설치, 스탬프 및 롤백

1. `decisions` -> `.decisions-backup` 이름 변경, 스테이징 -> `decisions`;
2. `{schema, seq, version, revision, treeSha256, manifestSha256, keyId,
   installedAt}`로 `<cache>/.ai-version.json` 기록;
3. 최신성 원장 행 기록; 성공 시 백업 삭제;
4. 어떤 실패든(스왑, 스탬프, 원장) 백업을 복원하고 커맨드를 실패시킨다;
   취소된 패스는 이전 팩을 건드리지 않은 채로 둔다.

따라서 실패한 검증, 크래시된 패스, 사용자 취소는 항상 마지막 정상 팩으로
폴백한다. 카드는 `decisions`가 존재하면 "비우기"를 제공한다; 로드된 세션은
재시작까지 유지된다(기존 동작).

### 6.6 피처 계약

모델 파일은 Python 훈련 스크립트를 미러링하는 Rust 피처라이저와 결합되어
있다. 매니페스트의 `featureSet` 값이 계약이다:

| 모델 | 종류 | 피처 세트(v1) | 필수 |
| --- | --- | --- | --- |
| fire_model.onnx | 발사 2-헤드(24-엔티티 딥 세트) | `fire-v2` | 예 |
| move_model.onnx | 17-클래스 이동 섹터 | `move-v2` | 예 |
| advice_fire_model.onnx | 속성 라우팅 조언 헤드 | `advice-e24` | 아니오 |
| torpedo_model.onnx | 3-헤드 어뢰 모델 | `torpedo-e26d` | 아니오 |

앱은 모든 필수 모델의 피처 세트가 지원 세트에 있고 모든 선택적 모델의
세트가 지원되거나 부재일 때만 릴리스를 수용한다. 피처라이저 변경은 Rust
피처라이저를 변경하는 같은 PR에서 세트 이름을 올리므로, 오래된 앱이 새
가중치에 잘못된 텐서를 먹이는 일은 결코 없다.

### 6.7 LOS 래스터와 리소스 팩

LOS 래스터는 리소스 팩의 맵 지오메트리에서 베이크된다. 팩의 맵 GLB가
바뀌면(게임 버전 업), 오래된 래스터는 오래된 지형을 기술한다. 매니페스트의
선택적 `resTreeSha256`은 래스터가 베이크된 기준 팩 트리를 기록한다; 앱은
이를 설치된 팩의 스탬프와 비교하고, 불일치 시 모델은 설치하되 LOS 파일은
건너뛰며(기존 맵별 조회는 이미 누락된 래스터를 용인한다) 사용자에게 리소스
팩을 먼저 업데이트하라고 알린다. 게시 스크립트는 팩 게시 후 LOS를 베이크하고
동일한 트리 해시를 기록한다.

### 6.8 UI, i18n 및 모바일

- Settings -> 리소스 카드에 추가된다: 현재 버전(게시 시각과 트리 해시
  접미사), 존재 여부/크기/sha 접두사를 포함한 모델별 행, LOS
  커버리지(`x/known maps`), 전체 크기, 확인/다운로드/취소 버튼, 재시작 안내,
  미러 래더 그룹(7.6절).
- i18n: 기존 13개의 `settings.resourcesDecisions*` 키가 8개 설정
  로케일(en-US, zh-CN, zh-TW, ja-JP, ko-KR, fr-FR, es-ES, ru-RU)에 걸쳐
  확인/다운로드/진행률/버전/LOS 커버리지 문자열로 확장된다; 정확성 판정
  기준은 `scripts/check_i18n.py`다.
- 모바일은 같은 채널을 사용한다(ONNX Runtime은 이미 기본 피처다). 슬림
  APK는 필요 시 모델을 다운로드한다; 설치 프로그램/APK에 기준 모델을
  번들하는 것은 나중 옵션이다(10절, PR4).
- `ai` 피처가 없는 빌드(포터블 플레이버)는 ONNX Runtime을 링크하지 않는다:
  채널은 숨겨지거나 사용 불가로 표시되며, 로드할 수 없는 모델을 절대
  다운로드하지 않는다.

### 6.9 실패 모드

| 실패 | 동작 |
| --- | --- |
| 도달 가능한 미러 없음 / 매니페스트 4xx-5xx | 확인 실패, 현재 팩은 계속 서비스, 사유가 기록되어 카드에 표시됨 |
| 서명 무효 / seq 역행 | 하드 실패; 설치 없음, 검증되지 않은 콘텐츠로의 폴백 없음 |
| 파일 sha 불일치 | 해당 후보 폐기; 다음 엔드포인트 시도; 모두 실패하면 패스 실패 |
| 모델 로드/종류/폭 불일치 | 스왑 전에 패스 거부; 이전 팩 복원 |
| LOS가 다른 리소스 팩 트리에 매핑됨 | 모델 설치, LOS는 설명이 포함된 경고와 함께 건너뜀 |
| 디스크 가득 참 / 취소 | 스테이징 정리 또는 재개를 위해 보존; 활성 팩은 그대로 |
| 앱 업데이트, 피처 세트 상향 | 이전 모델은 설치된 채로 남지만 호환 릴리스가 설치될 때까지 새 빌드가 로드하지 않음 |

## 7. 미러 컨텍스트

### 7.1 현재의 고통

`github_mirror.rs`는 `github.com`/`api.github.com`만 알고
`{prefix}/{full-url}`로 재작성한다. Hugging Face 미러는 대신 엔드포인트
베이스를 치환하고 경로를 유지한다; ModelScope는 다른 경로 템플릿을 가진다.
내장 목록은 앱, `Cargo.toml`의 shun 메타데이터, `scripts/fetch_models.py`,
웹사이트 다운로드 페이지, webui 목업, 릴레이 CSP에 중복되어 있으며 드리프트
테스트는 Cargo 사본에만 적용된다. 여섯 소비자(`update`, `model_pack`,
`data_pack`, `mod_catalog`, `changelog`, `media`)가 각자 자신의 루프를 돈다.

### 7.2 공급자 모델

새 모듈 `packages/app/tauri/src/commands/mirror/`:

```rust
pub enum ProviderId { GitHub, HuggingFace, ModelScope }

pub enum Rewrite {
    UrlPrefix,                                  // GitHub: {prefix}/{official_url}
    Endpoint { template: &'static str },        // HF: {base}/{repo}/resolve/{rev}/{path}
                                                // MS: {base}/models/{repo}/resolve/{rev}/{path}
}

pub struct HfResource<'a> {
    pub repo: &'a str,      // "owner/name"
    pub revision: &'a str,  // pinned commit sha (validated as a plain segment)
    pub path: &'a str,      // repository-relative file path (validated segment by segment)
}

pub struct MirrorContext { /* config snapshot, provider ladders, health/last-good cache */ }

impl MirrorContext {
    pub fn candidates(&self, target: Target<'_>) -> Vec<Candidate>;
    pub fn probe(&self, provider: ProviderId) -> Vec<ProbeRow>;
    pub fn sticky(&self, provider: ProviderId) -> Option<Endpoint>;
}
```

다운로드 허브는 계속 `Vec<String>` 소스를 받는다: 공급자 해석은
(config, target)의 순수 함수다. 다이제스트/서명 정책은 각 채널에 남아, 미러
URL은 전송 수단일 뿐 콘텐츠 아이덴티티가 아니라는 불변 조건을 보존한다.

### 7.3 URL 매트릭스

| 공급자 | 공식 | 미러 재작성 | 프로브 |
| --- | --- | --- | --- |
| GitHub | `https://github.com/langyo/wowsp/releases/download/<tag>/<asset>` | `{ghproxy-prefix}/{official-url}` | 저장소 `releases/latest` 페이지(기존) |
| Hugging Face | `https://huggingface.co/{repo}/resolve/{rev}/{path}` | `{endpoint}/{repo}/resolve/{rev}/{path}` (예: `https://hf-mirror.com/...`) | 작은 파일 고정: `{endpoint}/{repo}/resolve/{rev}/manifest.json`, HEAD 또는 `Range: bytes=0-1023`, 200/206 수용 |
| ModelScope(나중) | `https://www.modelscope.cn/models/{repo}/resolve/{rev}/{path}` | 엔드포인트 치환, 동일 템플릿 | HEAD `resolve/{rev}/manifest.json` |

Hugging Face API 엔드포인트(`/api/models/...`)는 다운로드 경로에 절대
등장하지 않는다; 프로브가 메타데이터를 원하면 고정 파일을 사용한다. 익명
API 버킷이 리졸버 버킷보다 훨씬 빡빡하기 때문이다.

### 7.4 선택, 헬스 및 헤징

- 후보 순서는 공급자별 정책이다: GitHub은 기존의 사용자 엔드포인트 ->
  공식 라우트 -> 내장 엔드포인트 순서를 유지하고, Hugging Face는 사용자
  엔드포인트 -> 내장 엔드포인트 -> 공식 라우트 순서(중국 본토 우선)를
  사용한다. 설정 패널은 오늘날 GitHub 래더와 같은 형태로 공식, 내장,
  사용자 행을 표시한다.
- **콜드 스타트**: 시차 시작(공식 + 내장)으로 구성된 후보 전반에 작은 파일
  요청을 프로브/헤지하고, 첫 번째 검증된 응답이 이긴다; 진 쪽은 취소된다.
  이는 중국 본토 사용자가 그렇지 않으면 항상 치러야 할 현재의 "공식 먼저,
  8-15초 대기, 그다음 폴백" 동작을 피한다.
- **패스/공급자별 스티키 엔드포인트**: 후보가 응답하면 패스의 나머지(모든
  파일)가 그것을 먼저 사용한다; 실패는 커밋된 오프셋부터 래더 내에서
  페일오버한다(허브 동작).
- **헬스 캐시**: 엔드포인트별 마지막 결과, 지연 시간, 짧은 실패 쿨다운, 세션
  범위에 더해 공급자별로 영속화된 마지막 정상(last-good) 엔드포인트(앱데이터,
  사용자 대면 구성 아님). 사용자가 시작한 프로브는 쿨다운을 해제한다.
- 대용량 파일 전송은 허브의 기존 레이스/페일오버를 계속 사용한다;
  컨텍스트는 소스 순서만 정한다.

### 7.5 구성 및 IPC

`network-config.toml`에 가산적이고 선택적인 필드가 추가된다(나머지와 같은
camelCase):

```toml
githubMirrors = ["https://ghfast.top"]
huggingfaceMirrors = ["https://hf-mirror.com", "https://hf-mirror.example"]
```

- 베이스 엔드포인트만(스킴 필수, https 전용, 쿼리/프래그먼트 없음, 후행
  슬래시 제거, <= 8개 항목, 중복 제거); 공식 라우트는 암묵적이며 절대
  저장되지 않는다.
- `githubMirrors`의 의미는 그대로다; 레거시 단일 `githubMirror` 문자열은
  계속 그 목록의 선두로 합쳐진다.
- 미래의 `providerMirrors` 맵은 예전 표기를 깨뜨리지 않고 공급자별 필드를
  대체할 수 있다.
- IPC: `mirror_ladder(provider)`와 `mirror_probe(provider)`가 공급자 태그가
  붙은 DTO를 반환한다; 예전 GitHub 이름의 커맨드는 한 릴리스 동안 얇은
  래퍼로 남아 webui/api 패리티 테스트가 깔끔하게 전환된다.
- webui는 공급자별 `useMirrorLadder(provider)` 훅과 공유 래더/프로브
  컴포넌트를 추출한다; GitHub 그룹은 업데이트 페이지에 남고, Hugging Face
  그룹은 모델 카드 옆에 놓인다.

### 7.6 엔드포인트 카탈로그와 드리프트 검사

추적되는 단일 진실 공급원: `res/config/mirror-endpoints.json`(공급자 ->
공식 엔드포인트 + 내장 엔드포인트 목록 + 프로브 대상 종류). Rust는 이를
`include_str!`로 임베드한다; Python(`fetch_models.py`), 웹사이트, 릴레이 CSP
허용 목록은 CI와 `just lint`에 연결된 새 `scripts/check_mirror_endpoints.py`를
통해 이를 소비하거나 이에 대해 검사받는다 — 현재 Cargo shun 메타데이터만
테스트되는 상황을 대체한다. `res/config/upstream-endpoints.json`(전송 헬스
카탈로그)은 프록시/직접 폴백과 업스트림 헬스 페이지가 새 호스트를 알 수
있도록 새 호스트를 추가한다.

### 7.7 관측된 중국 동작 (2026-11-08, 메인테이너 네트워크)

| 대상 | 결과 |
| --- | --- |
| `https://huggingface.co/api/models/...` | 연결 타임아웃(직접 라우트 사용 불가) |
| `https://hf-mirror.com/api/models/...` | 200, 커밋 sha를 포함한 전체 Hub API JSON |
| `hf-mirror.com/<repo>/resolve/main/<file>` | 307 -> `/api/resolve-cache/models/<repo>/<sha>/<file>` -> 200, `Accept-Ranges: bytes` |
| 고정 커밋 resolve | 200 |
| 미러를 통한 LFS/Xet 파일 | 302 -> 서명된 `cas-bridge.xethub.hf.co` URL -> 200/206(미러는 블롭 바이트를 저장하지 않음) |
| `www.modelscope.cn/models/<repo>/resolve/master/<file>` | 200 JSON, 독립적인 CN CDN |

이것이 중국 본토 사용자를 위한 기본 Hugging Face 래더가 내장 미러 먼저,
공식 마지막인 이유이며, 런타임이 `huggingface.co` 도달 가능성에 결코
의존하지 않는 이유다.

### 7.8 미러 주의 사항

- 서드파티 미러는 공식 SLA나 약관이 없는 베스트 에포트 공개 서비스다
  (hf-mirror.com은 커뮤니티 프로젝트고, ModelScope의 재배포 약관과 할당량은
  검증되지 않았다). 이들은 전송 수단일 뿐이다: 모든 바이트는
  서명/sha256으로 검증되며, 엔드포인트는 사용자가 구성할 수 있다.
- 대용량 파일은 서명된 리다이렉트 후 Hugging Face의 CDN에서 제공될 수 있다;
  채널은 커밋을 고정하고 sha256을 검증하므로 스테일하거나 잘못된 파일은
  실패하며 결코 수용되지 않는다.
- 서명된 CDN URL은 (약 1시간 후) 만료된다; 다운로더는 이를 캐시하는 대신
  403/만료 시 다시 확인한다.
- 클라이언트에 토큰이 절대 내장되지 않는다: 공개 저장소 전용이다.

## 8. 호환성, 보안 및 불변 조건

- **동결된 앱 업데이트 채널 불변**: `v*` 업데이터, 그 shun 메타데이터,
  다이제스트 흐름은 이번 웨이브에서 수정되지 않는다.
- **리소스 팩 불변**: 여전히 델타와 서명 다이제스트를 갖춘 GitHub
  `res-latest`다; 미러 컨텍스트는 후보가 생성되는 방식만 바꾼다(GitHub의
  경우 동일한 순서와 URL).
- **구버전 클라이언트는 영향받지 않음**: 기존 클라이언트 중 decisions 팩을
  다운로드하는 것은 없으므로 새 채널이 호환성 의무를 추가하지 않는다;
  리소스 팩 와이어 형식은 재포맷되지 않는다.
- **구성 호환성**: 새 TOML 필드는 선택 사항이며 구버전 빌드가 무시한다;
  구성을 복구하는 다운그레이드는 이들을 드롭하며(문서화됨), 앱은 다음
  업그레이드에서 기본값을 다시 추가한다.
- **보안 불변 조건**: 버전과 다이제스트에 대한 공식 전용 진실; 미러는 전송
  수단; 획득한 공식 앵커는 구속력을 가진다; 실행 가능한 페이로드는 페일
  클로즈; 트리에 비밀 정보 없음; ONNX 파일은 스왑 전에 (종류/폭) 검증된다.
- **위협 모델**: `docs/en/designs/threat-model.md`와 비교하라; 새 표면은
  모델 채널(전송 중에는 서명되지 않지만 서명으로 보호되는 공개 콘텐츠)과
  서드파티 미러 엔드포인트(읽기 전용 전송)다.

## 9. 위험과 완화

| 위험 | 완화 |
| --- | --- |
| 게임에서 파생된 LOS/속성 데이터의 공개 재배포(라이선싱) | 현재 공개 팩 선례 유지; `NOTICE.md` 출처; 11절 결정 2 |
| 서드파티 미러 소멸 또는 적대적 전환 | 서명 + sha256 검증; 사용자 구성 가능 엔드포인트; 공식 라우트는 여전히 후보 |
| Hugging Face 속도 제한/정책 변경 | 설치당 46-120 요청으로 익명 리졸버 예산 훨씬 아래; 매니페스트 우선 설계; 재시도는 `RateLimit`/`Retry-After`를 존중 |
| Hugging Face가 작은 파일을 Xet로 전환 | 다운로더는 리다이렉트와 Range/재개를 따른다; 그런 일이 생기면 내장 엔드포인트를 내보내기 전에 엔드투엔드로 검증 |
| 피처 드리프트(가중치 vs Rust 피처라이저) | 명시적 `featureSet` 계약; 앱 측 검증; 피처라이저 변경 시 세트 상향 |
| LOS/게임 버전 불일치 | `resTreeSha256` 비교; LOS를 건너뛰고 안내 |
| 스테일 미러 매니페스트 | 인증된 콘텐츠 + seq 래칫; 게시 스크립트 업로드 순서; 다음 확인에서 재시도 |
| 서명되지 않은/악성 매니페스트 | 페일 클로즈; 고정 Ed25519 키; 평문 폴백 없음 |
| 게시 중 실수로 토큰 유출 | `HF_TOKEN`은 환경/CI 시크릿에서만; 저장소 규칙에 따른 커밋 전 grep |

## 10. 롤아웃

각 단계는 저장소 워크플로에 따라 자체 워크트리 + PR이다; **설계 문서는 아홉
개 문서 로케일 전부에 배포된다**(en, zh-CN, zh-TW, ja, ko, fr, es, ru, ar).

1. **PR1 - 미러 컨텍스트(동작 중립적).** `commands/mirror/` 추출, 동일한
   의미론의 GitHub 공급자, 구성 필드 + 정규화 + IPC 래퍼, webui 범용 훅,
   엔드포인트 카탈로그와 드리프트 검사. 게이트: 기존 래더/구성/허브/업스트림
   테스트가 그린 유지; 와이어 변경 없음.
2. **PR2 - Hugging Face 공급자 + 게시 스크립트.** HF 공급자
   (재작성/헤징/프로브), `scripts/publish_ai_models.py`, 모델 카드 및
   라이선스 템플릿, `just publish-ai-models`. 게이트: 드라이런 매니페스트
   픽스처, 공급자 단위 테스트, 비공개 테스트 저장소에 대한 게시 리허설.
3. **PR3 - `ai` 채널.** `commands/ai_pack.rs`, 레지스트리/원장 행, 설치 시점
   ONNX 검증, `ship_attrs` 팩 오버라이드, Settings 카드 + i18n + RPC/webMock
   패리티, `docs/{en,zh-CN}/designs/resources.md` 업데이트(로케일이 파일을
   보유한 경우 번역된 행). 게이트: 엔드투엔드 리허설(오프라인 미러, 잘못된
   sha, 잘못된 ONNX, 취소, 롤백), 전체 lint/테스트 매트릭스.
4. **PR4 - 선택 사항.** ModelScope 공급자/게시, GitHub Release 폴백 소스,
   설치 프로그램/APK의 번들 기준 모델, 맵별 지연 로딩 LOS.

## 11. 미결 결정

1. **Hugging Face 소유자/저장소 이름**(제안: `langyo/wowsp-ai`, 공개). 계정과
   쓰기 토큰은 메인테이너 소유이며, 게시 스크립트가 저장소를 만들 수 있다.
2. **게임에서 파생된 LOS 래스터와 속성 테이블에 대한 재배포 성명**: 기존
   라이선스와 출처 고지 아래 가중치와 함께 게시하거나(권장, 공개 리소스
   팩과 일관됨), 공개 모델 저장소에서 제외하고 앱의 GitHub 팩을 통해서만
   제공한다.
3. **훈련 스크립트 스냅샷 범위**: 전체 `scripts/experiments/`(권장) 또는
   엄선된 하위 집합; 연구 로그 포함 여부.
4. **업데이트 정책**: 24시간 TTL 뒤의 조용한 부팅 확인 + 수동
   다운로드(권장) 대 ~12 MB 팩의 자동 다운로드; "모델 자동 업데이트" 스위치
   노출 여부.
5. **두 번째 공급자**: 일급 공급자로서의 ModelScope(계정, 키, 약관 검토
   필요) 및/또는 GitHub Release 폴백 소스.
6. **선택적 산출물**: `onnx-int8/` 변형과 `checkpoint.pt` 파일을 함께
   배포할지, 가중치만 배포할지(권장: int8 선택 사항, 체크포인트는 게시하지
   않음).
