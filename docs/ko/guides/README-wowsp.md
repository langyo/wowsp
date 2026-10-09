<h1 align="center">WoWSP</h1>

<p align="center"><strong>월드 오브 워십을 위한 무료 오픈소스 전투 패널 — 리플레이 리뷰, 인게임 오버레이, 실시간 전투 정보, 완전한 전적 조회 (Windows 및 Android).</strong></p>

<div align="center">

[![License](https://img.shields.io/badge/license-SySL--1.0-blue.svg)](https://github.com/langyo/wowsp/blob/master/LICENSE)
[![Release](https://img.shields.io/github/v/release/langyo/wowsp)](https://github.com/langyo/wowsp/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/langyo/wowsp/total)](https://github.com/langyo/wowsp/releases)

</div>

<div align="center">

[English](../../en/guides/README-wowsp.md) ·
[简体中文](../../zh-CN/guides/README-wowsp.md) ·
[繁體中文](../../zh-TW/guides/README-wowsp.md) ·
[日本語](../../ja/guides/README-wowsp.md) ·
**한국어** ·
[Français](../../fr/guides/README-wowsp.md) ·
[Español](../../es/guides/README-wowsp.md) ·
[Русский](../../ru/guides/README-wowsp.md) ·
[العربية](../../ar/guides/README-wowsp.md)

</div>

![WoWSP 대시보드](../screenshots/dashboard.webp)

> [!IMPORTANT]
> **WoWSP는 완전히 무료인 오픈소스로, 공식 [GitHub Releases](https://github.com/langyo/wowsp/releases)를 통해서만 배포된다. 이 프로그램에 돈을 요구하는 사람은 작성자가 아니다 — 결제하지 말고, 이미 결제했다면 환불을 요청하고 판매자를 신고하기 바란다.**

WoWSP는 Windows용 **월드 오브 워십** 데스크톱 패널로, Android 컴패니언 앱을 함께 제공한다. 게임 설치본(Wargaming Game Center, Steam, Lesta, 360)을 자동으로 감지하며, 전투가 끝난 뒤 복기하는 것부터 실시간 관전, 대전 중 승산 파악까지 전체 흐름을 함께한다.

## 주요 기능

- **리플레이 리뷰** — 아무 `.wowsreplay` 파일이나 열어 홀로그램 3D 맵 위에서 전투를 다시 본다: 모든 함선의 항적, 포탄, 어뢰, 항공 편대는 물론 사거리 링, 사이클론 기상, 거점 존 시뮬레이션까지 재현된다. 자유 궤도 카메라, 원본 녹화 카메라, 함선 추적 카메라를 제공하고, 맵 라벨은 항상 읽기 쉽게 스스로 조정되며, 맵 옆에는 플레이어별 전투 결과(리본, 업적, 피해 구성)가 표시된다. 모든 패널은 닉네임을 가릴 수 있는 공유용 스크린샷을 내보내며, 라이브러리는 모드·날짜·보관 상태로 필터링할 수 있다.
- **인게임 오버레이** — 전투 중 `Tab`을 누르고 있으면 양 팀의 명단과 전적이 전투 화면 위에 겹쳐 표시되며, 키를 누를 때마다 위치를 다시 고정한다. 개인 레이팅(PR) 구간과 승률 색상, 도장(스탬프), 격침 행 음영, 팀 요약, Tab을 누르고 있는 동안 표시되는 소모품 정보를 제공한다. 전적은 감지된 표 위의 투명 창으로 렌더링되거나, 번들로 제공되는 자체 플러그인을 통해 게임 안에 직접 렌더링되며, 행 매칭은 클라이언트별(Wargaming, Lesta, CN 클라이언트)로 조정되어 있다.
- **실시간 전투 모니터** — 로딩 화면부터 결과 화면까지 전투가 펼쳐지는 과정을 지켜본다: PR 구간과 클랜 태그가 포함된 전체 명단, 티어 가중 팀 승률, 전투 카드, 그리고 자신의 피해량·업적·격침 귀속을 실시간으로 추적하는 개인 전투 리포트.
- **전적 대시보드 및 플레이타임** — 나만의 워터미터(water meter): 기간 설정이 가능한 개인 레이팅(PR)·승률·평균 피해량 카드, 함선 분포 차트(티어 히스토그램, 함종·국가 도넛), 랭크 시즌 기록, 다중 계정 전환. 전용 플레이타임 뷰는 리플레이 파일을 연도를 전환할 수 있는 전투 캘린더 히트맵으로 바꿔준다.
- **플레이어·클랜 전적 조회** — 모든 플레이어와 클랜을 검색하고(병음 인식 지원), 공유용 스크린샷과 함께 커리어 카드와 클랜 명단을 확인하며, 서버가 다른 클랜전(Clan Battles) 명단을 교차 대조할 수 있다.
- **함선 백과사전 및 빌드 플래너** — Wargaming/Lesta 분기 전환이 가능한 전체 기술 트리, 제원과 장갑 뷰, 함선별 서버 트렌드, 함선·항공기 3D 모델 스테이지, 그리고 함장 스킬, 지휘관, 신호기, 업그레이드를 크레딧/XP 비용 계산과 함께 최종 제원으로 전개해 주는 빌드 플래너.
- **모드 허브** — 기능·텍스처·음성(함선 스킨, 미리듣기가 지원되는 Wwise 음성 팩) 분야의 커뮤니티 모드를 엄선한 마켓플레이스. 설치 프리셋, 원클릭 세이프 모드, 충돌 경고, 구버전 모드 마이그레이션, 텍스처 오버라이드 분석, 일괄 업데이트를 제공한다.
- **전술 보드** *(개발 중)* — 번들로 제공되는 전투 맵 컬렉션 위에서 작동하는 전술 플랜 편집기: 20분 플래닝 시계, 유닛 트랙, 행동 타임라인, 공유 가능한 플랜 세트.
- **Android 컴패니언** — Wi-Fi로(자동 검색) 휴대폰을 페어링하거나, 내장 릴레이를 거치는 6자리 페어링 코드로 어디서든 페어링하여 데스크톱에서 리플레이를 바로 가져오고, 이동 중에도 리플레이를 리뷰할 수 있다.

내부적으로도 네이티브 앱다움을 유지한다: 여러 미러를 동시에 경쟁시키는 자동 업데이트(포터블 설치 지원), 트레이 패널, 온보딩 마법사, 앱 내 공지, 로그 내보내기가 가능한 피드백 폼; 테마, 배경화면, UI 불투명도, 글자 크기, DPI 설정; 아홉 개의 UI 언어; 끌 수 있는 최소한의 익명 텔레메트리; 그리고 WebView2가 없는 환경에서도 무리 없이 대체 동작하는 번들 WebView2.

## 다운로드

Windows 10/11 — [GitHub Releases](https://github.com/langyo/wowsp/releases/latest)에서 최신 `WoWSP_<version>_x64-installer-webview2.exe`를 내려받는다(WebView2 포함). GitHub 접속이 느린 환경에서는 미러를 지원하는 [다운로드 페이지](https://wowsp.langyo.xyz/download)를 이용한다. Android 버전은 소스에서 직접 빌드한다 — [빌드 가이드](building.md) 참고.

모든 화면의 스크린샷은 UI 언어별로 [웹사이트 갤러리](https://wowsp.langyo.xyz/#gallery)에서 볼 수 있다.

## 문서

아키텍처, 설계 노트, 가이드는 [`docs/`](../../)에 아홉 개 언어로 정리되어 있다(영어와 简体中文은 완역). 문서는 [lagrange](https://github.com/celestia-island/lagrange)로 빌드했다. WoWSP는 최소한의 익명 사용 텔레메트리를 전송한다 — 수집 항목(및 수집하지 않는 항목)의 자세한 내용은 [텔레메트리 안내](../license/usage-telemetry.md)를 참고하라.

## 피드백 및 크레딧

버그 및 테스트 피드백: QQ 그룹 **[1125770228](https://qm.qq.com/cgi-bin/qm/qr?k=b6kMIecv3d390ecZVWNQNWMFfLRVgcQ9&jump_from=webapi&authKey=NhNLVnIcIlmfnnDUCjpsra4C/zfciS1sYNjm5SV7x2RPhdP1CzOM91ObP9y9MMQV)**, 또는 [웹사이트](https://wowsp.langyo.xyz)의 피드백 폼. 리플레이 파싱과 게임 감지 원리는 [ApeRadar (海猴雷达)](https://github.com/zylalx1/ApeRadar)에서, 프론트엔드 셸과 빌드 인프라는 [shittim-chest](https://github.com/celestia-island/shittim-chest)에서 가져와 적용했다.

## 라이선스

WoWSP는 **Synthetic Source License 1.0**([전문](https://github.com/langyo/wowsp/blob/master/LICENSE)) 하에 배포된다 — 상당 부분 AI가 생성한 코드베이스에 Apache-2.0과 동등한 권리를 부여하며, 유일한 추가 의무는 모든 복제본과 파생물에 AI 생성 고지 문구를 유지하는 것이다. 벤더링한 [wows-toolkit](https://github.com/langyo/wowsp/tree/master/packages/tools/wowsunpack-vendor) 스냅샷은 업스트림 **MIT** 라이선스를 그대로 유지하며, 이 저장소의 그 외 모든 것 — 독립 실행형 [pairing-relay](https://github.com/langyo/wowsp/tree/master/packages/pairing-relay) 워커를 포함해 — 는 SySL-1.0이 적용된다.

## 후원

WoWSP는 앞으로도 계속 무료다. 그 가치가 있다고 느껴 도움을 주고 싶다면 작성자의 afdian 페이지 **[afdian.com/a/langyo](https://afdian.com/a/langyo)**를 방문하기 바란다 — **모든 후원금은 WoWSP 개발에 필요한 AI 비용(모델 호출 및 코드 생성 도구)에 전액 사용된다.**

책임 범위를 분명히 하기 위해:

- 후원은 완전히 자발적이며 결코 필수가 아니다 — 모든 기능은 무료이며, 후원해야 사용할 수 있는 기능은 앱 본체에 결코 포함되지 않는다.
- 후원은 자발적인 증정이다: 고용·위탁을 비롯한 그 외 어떠한 법적 관계도 성립시키지 않으며, 특정 기능·제공 시기·환불에 대한 어떠한 권리도 발생하지 않는다.
- 이 프로젝트는 위 라이선스에 따라 후원 여부와 관계없이 모든 사람에게 오픈소스로 유지된다.
- WoWSP는 독립적인 비공식 프로젝트로, Wargaming·Lesta·360과 직접적인 관계가 없다.
