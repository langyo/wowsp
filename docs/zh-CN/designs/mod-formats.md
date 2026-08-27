# WoWSP 插件包格式实地调研

> **状态**：调研完成（2026-08-27）。本文是对 `mod-hub.md`（Mod Hub 设计）的格式侧补充，
> 样本取自 `D:\绿色软件\游戏工具\WOWS` 下 22 个真实分发包（约 1.7GB），逐包核实。

所有客户端模组的统一挂载点为 `World_of_Warships\bin\<最大数字目录>\res_mods\`
（多份 readme 原文确认）。游戏每次更新生成新的数字目录，旧 `res_mods` 全部失效——
这正是 Mod Hub 版本迁移引擎要解决的核心痛点。

## 一、分类学：识别规则与安装映射

统一安装根 `R = <WoWS根>/bin/<bin 下数值最大的目录>/res_mods/`。

| 类型 | 识别规则（特征） | 安装动作 |
| --- | --- | --- |
| **audio-banks-pack** | 存在 `banks/mods/*/mod.xml`，XML root = `AudioModification` | 整个 `banks/` 树复制到 `R\banks\mods\<BankName>\`；同名 bank 冲突提示（战斗配音同栈只能选一个） |
| **audio-bare-pack** | 顶层一个 `mod.xml`(AudioModification) + 若干 `.wem`，无 banks 外壳 | 自动包装为 `R\banks\mods\<包名或 XML Name>\{mod.xml,wem}` |
| **pnf-skin-mod** | `PnFMods/<Name>/Main.py` 含 `contentSdk.registerShipMod`；可能伴随 `content/` | 复制 `PnFMods\`、`content\` 至 `R\`；若 `R\PnFModsLoader.py` 不存在则创建**空文件**（引擎探测标记） |
| **texture-override** | `content/gameplay/**/*.dds` 且无 PnF 部分 | 复制到 `R\content\...`；常与 pnf 类共存同一分发单元 |
| **gui-icon-pack** | `ribbons/ribbon_*.png`(+`subribbons`) 或 `gui/BFGC/BattleWave/*.png` | 复制到 `R\gui\ribbons\`、`R\gui\BFGC\BattleWave\`；后者需标注"依赖前置战斗波类插件" |
| **config-patch** | 顶层数据文件如 `ime_config.xml` | 按相对路径落到 `R\<文件>` |
| **merge-pack** | 同一层混有两类以上特征（如 banks+gui+xml） | 本质是整树覆盖 `R\`，递归分发 |
| **archive** | `.zip/.7z` | 解包到暂存区 → 对内容重跑类型判定（警惕假扩展名目录与 GBK 中文文件名） |
| **standalone-tool** | 根有 `.exe`+`.dll`（如 ApeRadar） | 不写入游戏目录；登记运行库依赖与 exe 路径 |
| **sdk-tutorial** | 工具链 exe/pdf/txt + 仅含 `extractSources` 的 Main.py | 开发素材，禁止一键安装 |
| **raw-assets** | 纯编号序列图 `1.png…N.png` 无 manifest | 素材库，仅供浏览 |

### 关键机制结论

- **banks 音频**：`mod.xml` 的 `<Name>` 就是游戏内「设置→声音→战斗配音」下拉框的选项名，
  由音频系统枚举 `banks/mods/*` 实现，无需 loader。安装前解析该字段可作展示名。
- **PNF 船模涂装**：入口唯一模式
  `API_VERSION = 'API_v1.0'` + `contentSdk.registerShipMod('<ShipID>')`
  （制作期模板用 `extractSources('<别名>','<ShipID>')`）。**冲突面即 ShipID 参数**：
  同船两个涂装互斥，可用于冲突检测。
- `PnFModsLoader.py` 两处样本均为 **0 字节空文件**——它是引擎探测占位符，不是代码；
  缺它整个 PNF 包不生效（改模包就缺这一层，管理器应自动补齐）。
- **WWise 音频全部以散装 `.wem` + `AudioModification.xml` 出现**，没有整包 `.bnk` 覆盖。
  音频事件路径带状态机分支（`StateList/State: Module_Type_Engine` 等），直接信任即可。
- 材质后缀语义：`_a`=albedo、`_mg`=metallicGloss（发光 mask）、`_n`=normal、
  `default_ao.dds`=环境光遮蔽；`.wem` 可能带 `.mp3.`/`.wav.` 中缀标注来源格式。
- 常见辅助物：`compile.info`（`<content_info>` 压缩 blob）、
  `SEA_common_path_fix_py3.py` / `SEA_fx_path_fix_py3.py`（mfm 材质路径修复脚本）、
  BigWorld 引擎资产三件套 `.model/.visual/.geometry` 与 `.mfm` 材质定义。
- mfm 关键结构（发光调参即改 `_mg` 贴图对 + `emissivePower` property）：

```xml
<RSC011_Pr_66_Moskva_1948.mfm>
  <fx>shaders/std_effects/PBS_ship_emissive.fx</fx>
  <property>diffuseMap<Texture>PnFMods/Hina_Moskva/RSC110.../ship/X.dds</Texture></property>
  <property>metallicGlossMap<Texture>…_mg.dds</Texture></property>
  <property>normalMap<Texture>…_n.dds</Texture></property>
</RSC011_Pr_66_Moskva_1948.mfm>
```

## 二、样本逐包速览

| 分发单元 | 类型 | 要点 |
| --- | --- | --- |
| Misono Mika | audio-bare-pack | 51 个序号 wem + silent.wem 占位；缺 banks 外壳需包装 |
| yuuka | audio-bare-pack | 约 250 个语义命名 wem（文件名即事件名） |
| Voice_李云龙.zip | audio-bare-pack (zip) | 扁平结构，解压后包装进 banks |
| Miyako_soundmod | audio-banks-pack | 标准 `banks/mods/Miyako/`，96 wem，带 readme |
| 星野语音包 | audio-banks-pack | `banks/mods/Hoshino/`，102 个 `<ID>.mp3.wem`，附使用说明 |
| 爱丽丝语音包2.0 | audio-banks-pack | `Aris_(maid)/`，131 wem；说明含 B 站作者署名 |
| OTTO语音 | audio-banks-pack | 注意大写 `banks/Mods/OTTO Ver1.0/` —— 目录大小写不归一，识别时需大小写不敏感匹配 |
| MyGO睦子语音包 | audio-banks-pack | `Wakaba Mutsumi/`，139 wem |
| 川建国语音包 | audio-banks-pack (zip 即装) | zip 内已是完整 banks 树，多一层 `SFX/<事件类别>/` 分组 |
| mod 改模包(.7z 同源) | pnf-skin-mod + texture-override | 双船涂装（威尼斯/伍斯特）；**缺 PnFModsLoader.py 需补** |
| 莫斯科日奈换色版 | pnf-skin-mod + texture-override | 自带空 loader；外层有命名外壳「莫斯科日奈/」需剥壳 |
| 【2023更新】PNF涂装教程 | sdk-tutorial | ModsSDK 提取流程教程 + 工具链（wowsunpack/Blender 导出器/gmConverter）；15 步 PNF 步骤文档 |
| 快速整合 | merge-pack | 六角色 banks 合并 + gui ribbons/BFGC 图标 + ime_config.xml 三类并存 |
| 输入法 23.3.26 | config-patch | 单文件 `ime_config.xml`：OS 输入法名 → Scaleform GFxIME Tag 映射表（百余条，中日韩繁简），落 `R\ime_config.xml`；这就是官方小补丁（IME 修复）的样本形态 |
| 正弦线的勋带 | gui-icon-pack (+raw-assets) | 多主题成品 ribbons 包 + BattleWave 点亮图标（前置 Aslain 战斗波插件）+ 原始素材图集 |
| 海猴雷达 ApeRadar | standalone-tool | C#/WPF 外部工具，只调用 WG 公开 API，源码在树内；要求 .NET 6 runtime |

## 三、对 Mod Hub 设计的落地修订建议

1. **manifest `category` 枚举**按本文分类学收敛：
   `voice`（audio-*）、`skins`（pnf/texture）、`gui`（icon packs）、`patches`（ime_config 等）、
   `tools`（standalone-tool）；sdk/raw-assets 不入索引。
2. **类型自动识别器**必须大小写不敏感匹配 `mods/Mods`、处理单层命名外壳、
   GBK 文件名 zip、以及「直落型 vs 裸包型」两种 banks 形态（bare → 自动包装）。
3. **PNF 冲突检测**用 `registerShipMod(ShipID)` 解析结果做互斥图，粒度精确到单船。
4. **BattleWave 点亮图标**这类「插件的前置皮肤」需要轻量依赖声明（manifest 可选字段
   `[dependencies] requires = ["battlewave"]`），否则用户单独安装不生效。
5. 官方第一方补丁以 `输入法 23.3.26` 为基准样本：单 config 文件 + CC0，随安装器内置分发。
6. `wowsunpack-vendor`（仓库已有 vendor）正是教程工具链里的官方 pkg 解包器同款，
   Mod Hub 后续可用它做「提取预览」（贴图缩略图、音频试听转码）的技术底座。
