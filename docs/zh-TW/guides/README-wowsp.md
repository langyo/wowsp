<h1 align="center">WoWSP</h1>

<p align="center"><strong>免費開源的《戰艦世界》戰況面板 — 重播回顧、遊戲內覆蓋層、即時戰況情報與完整戰績，適用於 Windows 與 Android。</strong></p>

<div align="center">

[![License](https://img.shields.io/badge/license-SySL--1.0-blue.svg)](https://github.com/langyo/wowsp/blob/master/LICENSE)
[![Release](https://img.shields.io/github/v/release/langyo/wowsp)](https://github.com/langyo/wowsp/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/langyo/wowsp/total)](https://github.com/langyo/wowsp/releases)

</div>

<div align="center">

[English](../../en/guides/README-wowsp.md) ·
[简体中文](../../zh-CN/guides/README-wowsp.md) ·
**繁體中文** ·
[日本語](../../ja/guides/README-wowsp.md) ·
[한국어](../../ko/guides/README-wowsp.md) ·
[Français](../../fr/guides/README-wowsp.md) ·
[Español](../../es/guides/README-wowsp.md) ·
[Русский](../../ru/guides/README-wowsp.md) ·
[العربية](../../ar/guides/README-wowsp.md)

</div>

![WoWSP 儀表板](../screenshots/dashboard.webp)

> [!IMPORTANT]
> **WoWSP 完全免費開源，僅透過官方 [GitHub Releases](https://github.com/langyo/wowsp/releases) 發布。任何對它收費的人都不是作者 — 請勿付款；若您已付款，請申請退款並檢舉賣家。**

WoWSP 是 Windows 上的《戰艦世界》桌面面板，並提供 Android 隨行版。它會自動偵測您的遊戲安裝來源（Wargaming Game Center、Steam、Lesta 或 360 版），並陪伴您走完整個流程：賽後回顧對戰、即時觀戰，以及對局中掌握勝負情勢。

## 功能總覽

- **重播回顧** — 開啟任意 `.wowsreplay` 重播檔，在全像 3D 地圖上重溫整場對戰：每艘艦艇的航跡、砲彈、魚雷與飛機中隊，還有射程環、颱風天氣與佔領區域模擬。自由環繞、原始錄製與跟隨單艦三種鏡頭；地圖標籤會自動保持清晰可讀；地圖旁還可查看每位玩家的戰鬥結果（勳帶、成就、傷害構成）。每個面板都能匯出可遮蔽暱稱的分享圖，重播庫可依對戰模式、日期與封存狀態篩選。
- **遊戲內覆蓋層** — 戰鬥中按住 `Tab`，即可在對戰畫面上疊加顯示兩隊的名單與戰績；覆蓋層會在每次按下時重新錨定位置。支援個人評分（PR）分級與勝率配色、印章、被擊沉列著色、隊伍彙整，以及按住 `Tab` 顯示消耗品情報。戰績可呈現在偵測到的表格上方的透明視窗中，或透過內建的第一方外掛程式直接顯示在遊戲內，列匹配已針對各客戶端（Wargaming、Lesta 與中國大陸客戶端）調校。
- **即時戰況監視器** — 從載入畫面到結算畫面，全程觀察對戰發展：含 PR 分級與軍團標籤的完整名單、依艦階加權的隊伍勝率、戰鬥卡片，以及即時追蹤自身傷害、成就與擊殺歸屬的個人戰報。
- **戰績儀表板與遊玩時數** — 您自己的「水表」：個人評分、勝率與平均傷害卡片（可選日期範圍）、艦艇分佈圖表（艦階直方圖、艦種與國家環圈圖）、排位賽季歷史，以及多帳號切換。專屬的遊玩時數檢視可將您的重播檔轉換為戰鬥日曆熱力圖，並可切換年份。
- **玩家與軍團查詢** — 搜尋任意玩家或軍團（支援拼音搜尋），查看生涯戰績卡與軍團成員名單並可匯出分享圖，還能跨伺服器比對軍團戰名單。
- **艦艇百科與配裝規劃器** — 完整科技樹（可切換 Wargaming/Lesta 分支）、規格數據與裝甲檢視、各艦的伺服器趨勢、艦艇與飛機的 3D 模型展示台，以及配裝規劃器——可將艦長技能、指揮官、訊號旗與改裝投射為最終規格，並計算銀幣／經驗成本。
- **模組中心** — 精選的社群模組市集，涵蓋功能、材質與語音（艦艇皮膚、可試聽的 Wwise 語音包），提供安裝預設組、一鍵安全模式、衝突警告、過期模組遷移、材質覆蓋分析與批次更新。
- **戰術板**（開發中）— 基於內建戰鬥地圖目錄的戰術規劃編輯器：20 分鐘規劃時鐘、單位軌跡、行動時間軸，以及可分享的方案集。
- **Android 隨行版** — 透過 Wi-Fi 與手機配對（自動探索），或經由內建中繼服務以六位數配對碼從任何地方連線，直接從電腦端擷取重播檔，隨時隨地回顧戰局。

在底層，它始終保持原生應用的本色：鏡像競速自動更新（支援可攜式安裝）、系統匣面板、新手引導精靈、應用程式內公告，以及可匯出記錄檔的回饋表單；佈景主題、桌布、UI 不透明度、字型大小與 DPI 調整；九種 UI 語言；可關閉的最少量匿名遙測；以及內建的 WebView2（缺少時也能優雅降級）。

## 下載

Windows 10/11 — 前往 [GitHub Releases](https://github.com/langyo/wowsp/releases/latest) 取得最新的 `WoWSP_<version>_x64-installer-webview2.exe`（已內建 WebView2）；若您所在地連往 GitHub 速度緩慢，可改用可自動選擇鏡像的[下載頁面](https://wowsp.langyo.xyz/download)。Android 版由原始碼建置 — 詳見[建置指南](building.md)。

各檢視畫面、各 UI 語言的截圖均收錄於[網站圖庫](https://wowsp.langyo.xyz/#gallery)。

## 文件

架構、設計筆記與各類指南收錄於 [`docs/`](../../)，提供九種語言版本（英文與簡體中文已完整翻譯），以 [lagrange](https://github.com/celestia-island/lagrange) 建置。WoWSP 會回報極少量的匿名使用遙測——具體收集（與絕不收集）哪些內容，見[遙測說明](../license/usage-telemetry.md)。

## 回饋與致謝

Bug 回報與測試回饋：QQ 群 **[1125770228](https://qm.qq.com/cgi-bin/qm/qr?k=b6kMIecv3d390ecZVWNQNWMFfLRVgcQ9&jump_from=webapi&authKey=NhNLVnIcIlmfnnDUCjpsra4C/zfciS1sYNjm5SV7x2RPhdP1CzOM91ObP9y9MMQV)**，或使用[網站](https://wowsp.langyo.xyz)上的回饋表單。重播解析與遊戲偵測原理改編自 [ApeRadar（海猴雷达）](https://github.com/zylalx1/ApeRadar)；前端外殼與建置基礎設施改編自 [shittim-chest](https://github.com/celestia-island/shittim-chest)。

## 授權條款

WoWSP 採用 **Synthetic Source License 1.0** 授權（[全文](https://github.com/langyo/wowsp/blob/master/LICENSE)）— 針對實質上由 AI 生成的程式碼庫，給予等同 Apache-2.0 的授權，唯一額外義務是在每份副本與衍生作品中保留 AI 生成揭露聲明。內嵌（vendored）的 [wows-toolkit](https://github.com/langyo/wowsp/tree/master/packages/tools/wowsunpack-vendor) 快照仍保留其上游的 **MIT** 授權；本儲存庫中的其他所有內容——包括獨立運作的 [pairing-relay](https://github.com/langyo/wowsp/tree/master/packages/pairing-relay) worker——均涵蓋於 SySL-1.0。

## 贊助作者

WoWSP 是且將一直是免費軟體。如果它對您有所幫助，而您也想支持作者，作者的愛發電頁面為 **[afdian.com/a/langyo](https://afdian.com/a/langyo)** — **所有贊助將全部用於開發 WoWSP 的 AI 開銷**（模型呼叫與程式碼生成工具）。

為了明確彼此的權責：

- 贊助完全自願、絕非必需——所有功能免費，軟體本體絕不會內嵌需要贊助才能使用的功能。
- 贊助是自願餽贈：不構成僱傭、委託或其他任何法律關係，也不附帶對特定功能、交付時程或退款的任何訴求。
- 專案在上述授權條款下對所有人保持開源——贊助者與未贊助者一視同仁。
- WoWSP 是獨立的非官方專案，與 Wargaming、Lesta、360 沒有直接關係。
