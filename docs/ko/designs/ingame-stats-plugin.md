# 게임 내 전적 플러그인 — 정밀 텔레메트리 설계

> **상태**: 실험 종료(2026-09-28); 구현 준비 완료.
> 오버레이의 동반 문서: 표시 계층은 투명 창 그대로 유지되며, 이 플러그인은
> 독점 전체 화면을 포함한 모든 환경에서 오버레이의 생존/침몰 상태를 정확하게
> 유지하는 게임 내 데이터 소스다. TAB 행 순서는 프로브가 게임 자체의 순서를
> 엔진 안에서 읽어낼 수 있을 때까지 클라이언트별로 보정된 추론에 머문다 —
> 아래의 정렬 규칙을 참고.

## 배경 및 목표

현재의 실시간 전투 오버레이는 화면 캡처(`overlay/capture.rs`,
`overlay_detect.rs`)로 TAB 팀 표의 지오메트리를 추정하고
`GetAsyncKeyState(VK_TAB)`를 30 ms 간격으로 폴링한다. 이 방식은 동작하지만:

- 화면 캡처는 가장 취약한 계층이다(DRM/캡처 제외, HDR, 멀티 DPI, 창 모드와
  전체 화면의 차이).
- 키 폴링은 "Tab을 누르고 있는 것"과 "전투 채팅에 Tab을 입력하는 것"을
  구분하지 못한다.
- 행 순서는 정적 명단과 침몰 휴리스틱으로 추정한다.

Wargaming 공식 **Mods API**(PnFMods 채널, 인젝션 없음, 메모리 쓰기 없음)
위에서 동작하는 게임 내 모드는 클라이언트 내부에서 전투 상태를 관찰해 파일
브리지를 통해 WoWSP에 넘길 수 있다. 이 모드는 아무것도 렌더링하지 않는다 —
표시는 투명 오버레이가 계속 담당한다 — 따라서 이 접근 방식은 과거 "게임 내
렌더링" 아이디어들을 무산시킨 게임 버전별 UI 유지 보수 비용을 전혀 떠안지
않는다.

목표: `overlay_config.toml`의 새 roster 모드 `"plugin"`을 키로 삼아 오버레이
데이터의 우선순위 체인을 "모드 텔레메트리 > 화면 캡처 추론 > 정적 순서"로
만든다.

## 실험이 입증한 것

Steam-ASIA 15.8.0(build 13187581)과 360-CN 15.8.1(build 13243917)에서
검증했으며 각 서버에서 몇 판씩 진행했다. 프로브 산출물은
`packages/ingame-plugin/src/Main.py`에 있다(자체 버전 표기는 영원히
`0.1.0`, 이터레이션은 git 히스토리에만 존재):

| 기능 | 메커니즘 | 지연 시간 / 비고 |
| --- | --- | --- |
| 양쪽 서버에서 모드 로드 | `res_mods/<bin>/PnFModsLoader.py`(0바이트 마커) + `PnFMods/<Mod>/Main.py`, `API_VERSION = 'API_v1.0'` | Aslain 모드와 공존 |
| 주입된 API 모듈 | `events, ui, utils, battle, callbacks, dataHub, constants`는 로더가 주입하는 전역 객체다; 이들을 `import`하면 실패한다(허용 목록), 절대 섀도잉하지 말 것 | builtins도 마찬가지로 화이트리스트다: `globals()`/`eval` 없음 |
| 명단 + 신원 | `battle.getPlayersInfo()` → name / accountDBID / shipParamsId / isBot / realm | 레코드는 `SafeClass`다: 첨자 접근은 동작하지만 dict 프로토콜은 동작하지 않는다; 로드 초기의 순회는 방어적으로 할 것(컨테이너가 잠시 dict가 아니다) |
| 침몰 귀속 | `isAlive` 반전, 1 s 간격 폴링 | 게임 자체의 `typeDeath` 로그 라인과 1:1 대조 검증, 지연 ≤1 s, 4판에 걸쳐 확인 |
| 실시간 체력 및 발견 | `dataHub.getEntityCollections('avatar')` → `entity[CC.health]`(`.value/.max/.isAlive`), `entity[CC.relation]` | 적 체력은 발견되기 전까지 0/0이다 — 게임 자체 표와 같은 전쟁의 안개; 0→값 점프 자체가 발견 이벤트다 |
| TAB 화면 상태 | SFM 이벤트 `input.tabModeIn` / `input.tabModeOut` | 키 입력 후 ≤3 ms에 발생; 채팅 중 Tab에는 발생하지 않는다 — 오탐 유형을 원천 해결 |
| 명단 변동 | `events.onPlayersListUpdated` | 한 판에 이벤트 14회 |
| 전투 라이프사이클 | `sfm.battleLoadingStarted`, `request.showBattle`, `onBattleStart`, `up.exitBattle`, `window.hide(Battle)` | tempArenaInfo 파일의 등장/제거보다 세분화됨 |

**사용 불가**(필요하지도 않음): 플레이어별 score/XP 컴포넌트는 avatar
엔티티에 존재하지 않고, unbound 쪽의
`$datahub.getCollection().getChildByPath('team.ally.sortedAlive')` 경로에는
Python 측 대응물이 없다(주입된 dataHub에는 `getCollection`이 없다).

**정렬 규칙 — 불안정, 클라이언트별 지식. 진실은 반드시 게임 내부에서
나와야 한다.** TAB 표의 행 순서는 각 클라이언트의 HUD가 렌더링하는 그대로이며,
벤더들 사이에서 실제로 갈라졌다(초기의 "아레나 차량 순서 + 침몰자를 끝에 다시
붙이기" 모델은 어디까지나 WG 계열의 근사였다 — 그것이 해결하지 못한 동순위
그룹이 바로 #604의 점 칩이 덮어둔 것이다). 서버별로 실제 Tab 캡처에 대조해
보정하고, 클라이언트 업데이트가 있으면 움직일 것임을 전제하며, 스크립트
디컴파일은 뒷받침 증거로만 다룰 것 — 결코 증명으로 취급하지 않는다.
2026-10-09 매트릭스(이 머신의 설치본들을 wowsdeob으로 디컴파일한 결과,
`ShipSystem.add` / `AvatarSystem.__sortKeyAlive`):

- **WG 계열**(eu/na/asia는 하나의 빌드를 공유): 생존 플래그, 함종 순위
  (CV < BB < CA < DD < SS < 보조), 티어 내림차순, `NATION.SORT_ORDER` 순위,
  현지화된 함선 축약명, `[TAG]닉네임` — 하나로 이어 붙인 문자열. 라이브
  15.8.0은 2026-09-27 Tab 캡처 기준 6/6 검증됐고, 다음 빌드(13357625,
  2026-10-06 다운로드)도 같은 국가 순위 우선 공식으로 디컴파일된다 — WG는
  움직이지 않았다.
- **360-CN**: 자체 Python(빌드 13243917과 현재 13357822 모두)은 여전히 WG의
  국가 순위 키를 계산하지만, 클라이언트가 **렌더링**하는 것은 현지화 함선명
  순서다(2026-10-07 캡처, 9/9 pinyin) — 갈라짐은 HUD/뷰 계층에 있다. 따라서
  스크립트 디컴파일로는 이 클라이언트를 끝내 정할 수 없고, 렌더링된 캡처만이
  근거가 된다.
- **Lesta**(ru): 이쪽도 현지화 함선명 순서로 렌더링한다(2026-10-09 캡처:
  Bogatyr가 St. Louis 두 행을 `usa < russia`와 어긋나게 앞세움); 현재 빌드
  (8867689)는 디컴파일러가 아직 열지 못하는 변경된 `.pyc` 컨테이너를 싣고
  나온다.

앱은 이것을 오프라인 정렬 키 위의 서버별 게이트로 구현한다(utils/realms의
`realmUsesShipNameOrder`; 키 자체와 CN 정적 레이아웃은 utils/shipClass가
가진다). 그리고 추론을 게임 내 진실로 내보내는 것을 거부한다: 플러그인이
연결돼 있어도 /live 패널 헤드에서는 여전히 "완전히 동작하지 않음"으로
평가된다(경고 필 + tooltip, `features/replay/telemetryGrade.ts`). 텔레메트리
페이로드에는 생존/침몰 상태가 담기지만 행 순서는 담기지 **않기** 때문이다.
최종 목표는 프로브가 게임 자체의 순서를 엔진 안에서 읽는 것이다 — TAB이
렌더링하는 컬렉션(`team.ally.sortedAlive`)이 자연스러운 원천이지만, 주입된
dataHub에는 `getCollection`이 없다. 훗날의 페이로드 계약
(`order: {ally: [...], enemy: [...]}`, 게임 내 실제 값만)이 필을 다시
"정확"으로 되돌린다. 그때까지 추론은 보정된 폴백일 뿐, 그 이상도 이하도
아니다.

## 샌드박스 제약 (고생 끝에 얻은 것, 모드의 스타일 가이드에 유지할 것)

- Python은 **2.7**이다; 문법은 보수적으로 유지한다(f-string 금지; 기존
  프로브는 의도적으로 2/3 호환이다).
- `open()`에는 **추가 모드가 없다**('a'는 예외를 던지는 대신 None을
  반환한다): 파일은 메모리 버퍼에서 통째로 다시 쓴다.
- 파일이 없으면 예외를 일으키기 전에 엔진 쪽에 오류 라인이 하나 기록된다:
  폴링하는 모든 메일박스를 로드 시 한 번씩 시드한다(`manual_refresh.flag`
  시드 참조).
- 콜백을 빠져나간 예외는 모드를 소리 없이 죽인다: 전부 감싸고, 반복 오류는
  중복 제거 후 로깅한다.
- 주입된 모듈에 대한 `dir()`은 `[]`를 반환한다(SafeClass 래퍼): API 표면은
  위의 검증된 이름 목록이 전부다.
- 로더 채널은 두 가지다: 우리가 쓰는 고전적인 무서명 PnFMods 1.0 경로와, WG
  서명 검증이 딸린 "ModsAPI 2.0"(ModStation급 서명 모드). 무서명 커뮤니티
  모드는 문제없이 공존한다; 서드파티 팩의 서명 실패는 우리 관심사가 아니다.

## 아키텍처

```
┌─ game client (Mods API sandbox, no network) ─────────────┐
│ PnFMods/WoWSPStats/Main.py                               │
│  · roster poll (1 s, stable-confirm) → request.json      │
│  · entity walk → telemetry (hp/relation/alive)           │
│  · SFM events → tabMode marks, lifecycle marks           │
│  · heartbeat.json (phase port/battle, 1–2 s)             │
└──────────────┬────────────────────────────────────────────┘
               │ flat JSON files in the mod's own directory
┌──────────────┴────────────────────────────────────────────┐
│ WoWSP app (Rust, existing processes)                      │
│  · bridge reader/writer (replaces the experiment probe's │
│    companion role; same request/response protocol the    │
│    third-party reference plugin established)             │
│  · ordering engine: arena order + dead-sinking           │
│  · roster mode "plugin" in overlay_config                │
│  · health check: parse profile/python.log for the mod's  │
│    load/self-check lines (api[load] dh=True …)           │
└───────────────────────────────────────────────────────────┘
```

브리지 파일(프로토콜 v1, 모두 모드 디렉터리 안에 위치):

```jsonc
// request.json — 명단이 안정되면 모드가 작성한다(수동 새로고침 시에도
// 재작성). 컴패니언이 전적 행으로 응답한다.
{ "version": 1, "created": 1690000000.0, "session": "1690000000000",
  "manual": false,
  "players": [ { "name": "...", "account_id": 0, "avatar_id": 0,
                 "ship_id": 0 } ] }

// response.json — WoWSP가 작성한다; revision은 세션별로 단조 증가해야
// 한다; 빈 파일(끝에 줄바꿈 없음)은 "대기 중"을 뜻한다.
{ "version": 1, "session": "1690000000000", "revision": 3, "busy": false,
  "rows": [ { "name": "...", "wr": 52.3, "pr": 1450, "state": "ok",
              "bf": { "battles": 8213, "ishidden": false } } ],
  "labels": { "wr": "WR", "pr": "PR", "ally": "Allies", "enemy": "Enemies" } }

// heartbeat.json — 1–2 s마다 재작성; 오래되면 = 모드 사망 또는 게임 종료.
{ "v": "0.1.0", "t": 1690000000000, "phase": "port" | "battle",
  "players": 17, "revision": 3 }

// 텔레메트리 저널 — 전투별로 한정된 링 버퍼의 파일 전체 재작성;
// 모든 개별 상태와 이벤트 표시를 하나의 타임라인에 기록:
{ "t": 1690000000000, "players": { "<avatarId>": { /* projection */ } },
  "states": { "<name>": { "hp": "43150.0/43150.0", "relation": "2",
                          "alive": "True" } } }
{ "t": 1690000001000, "ev": "input.tabModeIn" }
{ "t": 1690000004000, "ev": "playersListUpdated" }

// manual_refresh.flag — WoWSP가 재조회를 트리거하려고 새 epoch-seconds
// 타임스탬프를 기록한다; 모드는 10 s 창 안에서 소비한다.
```

## 제품 통합

1. **토글 시 자동 설치**: 설정에서 게임 내 정렬 소스를 켜면 기존
   `mod_install.rs` / `mod_templates` 경로로 모드를 작성한다
   (`PnFModsLoader.py` 마커는 없을 때만 생성; 자기 파일만 건드림;
   스냅샷 + 롤백; 게임 종료 가드). 끄면 제거된다. 이것이 소유자가 지정한
   "특별한" 등록 동작이다: 플러그인은 수동 설치 단계로 결코 등장하지 않는다.
2. **자체 저장소 Discussions 등록**: `langyo/wowsp/discussions`에 템플릿
   기반 리소스 스레드를 게시하고 `mod-index.json` 항목(`category`,
   `discussion`, `versions[].game` 호환성)에서 참조한다. 그러면 Mod Hub도
   다른 모드처럼 이를 나열/검증할 수 있다 — 퍼스트파티 출처, 동일한
   카탈로그 메커니즘(mod-hub.md 갭 G8 동의 모델).
3. **폴백 체인**: 텔레메트리가 누락/만료되면(하트비트가 N s보다 오래됨,
   `api[load] dh=False`, 게임 업데이트로 모드가 망가짐) → 현재 추론
   파이프라인으로 조용히 폴백한다. 오버레이는 기능하기 위해 이 모드에
   의존하는 일이 없다.

## 리스크 및 유지 보수

- **WG API 드리프트**가 이제 유일한 결합점이다(unbound 없음, 게임 기본
  요소 복사 없음). Mods API v1.0 표면은 13.x→15.8에 걸쳐 안정적이었다;
  프로브의 자체 점검 라인 덕분에 깨짐이 명확히 드러나고 진단할 수 있다.
- **CN 클라이언트**: 동작 검증 완료; 360 클라이언트는 같은 Mods API 로더를
  구동한다(로그가 `PnFModsLoader.py`를 자체적으로 스캔한다). 메이저 버전마다
  CN 안티치트 정책 변화를 주시할 것.
- **성능**: `getPlayersInfo` 1 s 폴링 + 엔티티 순회는 예산 안에 여유가 있다
  (TeamHP류 모드는 프레임마다 엔티티를 순회한다); 이 용도에는 절대
  `callbacks.perTick`을 쓰지 않는다.
- **저널 증가**: 전투별 제한 링 버퍼; 전투 후 분석에 유용하다면 리플레이와
  함께 세그먼트를 배포한다.

## Rust 통합 맵 (정확한 접점)

| 관심사 | 파일 (별도 표시 없으면 기존) | 변경 사항 |
| --- | --- | --- |
| 브리지 파일 감시자 | `commands/arena_info.rs`의 형제 파일: 신규 `commands/ingame_bridge.rs` | 모드 디렉터리를 `notify`로 감시; 하트비트/요청/저널 파싱; Tauri 이벤트 `wowsp://ingame-*` 노출 |
| 정렬 엔진 | 신규 모듈 `overlay/order_source.rs` | 브리지 이벤트로 구동되는 arena 순서 + 사망 침몰 리듀서; 오버레이가 렌더링하는 최종 행 순서를 내보낸다 |
| 설정 스키마 | `commands/overlay_config.rs` + `packages/webui/src/stores/overlayConfig.ts` | `roster`에 `"plugin"` 추가(우선순위 체인 `plugin > inferred > ocr > off`) |
| 오버레이 키 게이팅 | `overlay/placement.rs`(`tab_key_down`) | 브리지가 살아 있을 때는 `GetAsyncKeyState` 폴링 대신 `input.tabModeIn/Out` 표시로 보이기/숨기기를 구동한다 |
| 설치 / 제거 | `commands/mod_install.rs` + `packages/ingame-plugin/`(신규 서브패키지) | 템플릿이 이 서브패키지의 `Main.py`가 된다; 스냅샷 + 롤백; 게임 종료 가드; 레거시 프로브 정리 |
| 상태 점검 | `commands/ingame_bridge.rs` | `profile/python.log`에서 모드의 `probe … loaded` / `api[load] dh=True` 자체 점검 라인을 파싱; 설정 UI에 상태 노출 |
| 전적 행 | 기존 `wg_api.rs` / `wg_api_cn.rs` | 변경 없음 — 컴패니언이 오버레이가 현재 쓰는 것과 같은 배치 조회로 `response.json`을 작성한다 |

## 테스트 계획

- **샌드박스 적합성**: 배포되는 모든 `Main.py` 변경을 제약 목록(py2.7
  파싱, 차단된 builtins 없음, 추가 모드 open 없음, 가드된 콜백)과
  `python -m py_compile`로 검증한다.
- **항구 전용 스모크 테스트**(전투 없음): 게임을 실행해 항구에 약 15 s
  머물렀다가 종료한다; `injected names=[…]`, `api[load] dh=True`,
  `python.log`의 새 하트비트를 확인한다. 이것이 실험을 정직하게 유지해 준
  값싼 프로토콜이다 — 설치용 인수 테스트로 유지할 것.
- **전투 픽스처**: 서버당 협동전 1판; 저널에 명단 스냅샷, 침몰이 유발한
  `alive` 반전 1회 이상, tabMode 표시가 담겨 있는지, 그리고 `python.log`의
  `typeDeath` 라인이 그 반전과 1:1로 일치하는지 확인한다.
- **폴백 훈련**: 앱을 중지한다(컴패니언 없음); 모드의 180 s busy 타임아웃이
  복구되고 다음 전투에서도 여전히 요청하는지 확인한다; 모드 디렉터리를
  손상시키면 오버레이가 조용히 추론으로 폴백하는지 확인한다.

## 배포 계획

- **M1** — 제품화: 프로브의 탐지 테스트 배터리를 디버그 플래그 뒤로 뺀다;
  브리지 프로토콜을 동결한다; Rust 브리지 + 정렬 엔진 + 오버레이 스토어에
  연결되는 `roster = "plugin"` 모드.
- **M2** — 설정 토글, 자동 설치/제거, python.log 상태 점검, 만료 폴백
  로직.
- **M3** — Discussions 등록, 카탈로그 항목, 업데이트 채널(템플릿 갱신은 앱
  릴리스를 따라간다; 모드 파일 자체는 거의 바뀌지 않는다).
