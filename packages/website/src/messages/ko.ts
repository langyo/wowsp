export default {
  nav: {
    "language": "언어",
    features: "기능",
    download: "다운로드",
    docs: "문서",
    github: "GitHub",
  },
  hero: {
    badge: "오픈소스 · Windows x64",
    tagline: "월드 오브 워쉽 리플레이 분석 및 게임 내 오버레이",
    lede: "게임을 실행하지 않고 홀로그래픽 3D 지도에서 .wowsreplay 리플레이를 감상하세요. 또는 Mod로 설치해 Tab을 누르는 동안 양 팀 명단을 표시하는 오버레이를 사용할 수 있습니다.",
    download: "Windows용 다운로드",
    docs: "문서 읽기",
    github: "GitHub 소스",
    version: "첫 정식 버전 곧 출시",
    ships: "1,200+ 척 함선 모델",
    maps: "3D 리플레이 분석",
    overlay: "전투 중 Tab 오버레이",
  },
  features: {
    title: "두 가지 모드, 하나의 패널",
    replay: {
      title: "독립 리플레이 분석",
      desc: "게임 설치 경로를 자동 감지하고 .wowsreplay를 파싱하여 모든 함선을 홀로그래픽 3D 지도에 렌더링합니다. 게임 실행이 필요 없습니다.",
    },
    overlay: {
      title: "게임 내 오버레이",
      desc: "게임과 함께 실행되는 Mod로 설치됩니다. 투명 오버레이가 양 팀을 표시하며 Tab을 누르는 동안에만 보입니다.",
    },
    stats: {
      title: "통계 및 인사이트",
      desc: "Wargaming 공개 API의 함선별 통계, 랭크 시즌, 플레이어 조회, 전적 트렌드.",
    },
    viewer: {
      title: "3D 함선 뷰어",
      desc: "로우폴리 홀로그램 모델로 모든 함선을 탐색하세요 — 회전, 확대/축소, 장갑 확인.",
    },
  },
  download: {
    title: "WoWSP 다운로드",
    lede: "Windows x64 · WebView2 런타임이 자동으로 설치됩니다.",
    install: "설치 프로그램 (NSIS)",
    portable: "포터블 / 그린 빌드",
    modesTitle: "세 가지 실행 방식",
    modeInstallTitle: "이 PC에 설치",
    modeInstallDesc: "시작 메뉴 바로가기와 자동 업데이트가 포함된 표준 사용자 설치. 권장.",
    modeUsbTitle: "USB 드라이브 (PC방 모드)",
    modeUsbDesc: "USB 메모리의 포터블 사본 — 레지스트리 항목 없음, 모든 데이터는 드라이브에 유지. 공용 PC에 적합.",
    modeGreenTitle: "직접 실행 (그린 소프트웨어)",
    modeGreenDesc: "아무 위치에 압축 풀어 독립 실행 — 본체 설치와 완전히 격리. 디버깅이나 샌드박스에 적합.",
    assets: "릴리스 자산",
    notes: "모든 자산은 GitHub Releases에서 제공됩니다.",
  },
  footer: {
    license: "SySL-1.0 라이선스",
    made: "Rust, Vue 3, Tauri 2, Three.js로 제작",
  },
} as const;
