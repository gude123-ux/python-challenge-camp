# Python闯关训练营（框架）

一个跑在 VS Code 里的 **Python 学习闯关系统**。每日自动派发任务、逐关解锁、AI 自动批改、进度可视化，全部状态存在本地工作区。

这个仓库是**框架**：代码、UI、测试、启动器都在，题库是一份 8 关的通用示例。把 `data/levels.json` 换成你自己的内容，它就是你自己的闯关系统。

> 核心逻辑全部在本地运行；只有你**主动点击「提交并批改」**时，才会把**当前这一个文件的代码片段**发给你自己配置的模型服务。

---

## 目录

- [功能一览](#功能一览)
- [安装](#安装)
- [快速开始](#快速开始)
- [配置 AI 批改](#配置-ai-批改)
- [接入你自己的题库](#接入你自己的题库)
- [日常使用](#日常使用)
- [命令与快捷键](#命令与快捷键)
- [设置项](#设置项)
- [数据与隐私](#数据与隐私)
- [项目结构](#项目结构)
- [开发与测试](#开发与测试)
- [常见问题](#常见问题)

---

## 功能一览

| 功能 | 说明 |
| --- | --- |
| 本地进度存储 | 进度写在 `<工作区>/.pythoncamp/progress.json`，纯本地、不上传 |
| 每日任务派发 | 每天自动派发 N 关（默认 3 关），跨天自动重置 |
| 闯关模式 | 每关 =【知识点简述】+【示例代码】+【本关练习】+【验收标准】 |
| 解锁机制 | 过关后解锁下一关；**今日任务里的关卡直接解锁**（否则每天只能打 1 关） |
| 代码复现 | 每关新建文件时，示例代码以注释形式写进模板，照着敲一遍再做题 |
| AI 自动批改 | 读当前 Python 文件 → 本地真跑一次 → 连同真实 traceback 交给大模型判分 |
| 打分维度 | 可运行性 / 正确性 / 代码质量 → 0~100 分，附总评、问题清单、改进建议、薄弱知识点 |
| 进度面板 | 侧边栏三个页签：今日任务、关卡地图、数据面板 |
| 学习时长 | VS Code 前台且有 Python 活动时自动计时 |
| 薄弱知识点 | 批改时反复被扣分的点自动累计排序 |
| 错题重刷 | 按错题重排今日任务，或一键跳到未过关的关卡 |
| 学习报告 | 一键导出 Markdown 报告（章节进度 / 成绩明细 / 薄弱点 / 时长） |
| 中文 UI | 全中文界面，浅色/深色主题自动适配 |

---

## 安装

### 前置条件

- VS Code 1.85 及以上
- 本机有 Python（`python --version` 能跑通）。找不到时可在设置里指定绝对路径。
- Node.js 18+（**只用于编译插件**；插件本身运行时不需要 Node）

### 方式一：开发模式

```bash
git clone <this-repo>
cd python-challenge-camp
npm install
npm run compile
```

然后用 VS Code 打开这个文件夹，按 `F5` 启动「扩展开发宿主」窗口。在新窗口里打开一个空文件夹作为你的学习工作区即可。

### 方式二：打包成 .vsix 安装

```bash
npm install
npm run package          # 产出 python-challenge-camp-1.0.0.vsix
code --install-extension python-challenge-camp-1.0.0.vsix
```

也可以在 VS Code 里 `Ctrl+Shift+P` → `Extensions: Install from VSIX...` 选择该文件。

### 方式三：一键启动（Windows）

项目自带一个启动器，它会自动装依赖 → 编译 → 找到 VS Code → 建工作区 → 启动：

```bash
node scripts/launch.js                  # 启动（开发宿主模式，始终用最新代码）
node scripts/launch.js --install        # 打包 vsix 并永久安装，再启动
node scripts/launch.js --check          # 只做环境诊断，不启动
node scripts/launch.js --dry-run        # 解析全部决策但不启动（自动化验证用）
node scripts/launch.js --workspace D:\py  # 指定学习工作区
```

也可以直接双击项目根目录的 `launch.cmd`。

**想在桌面放一个双击即用的入口：**

```bash
python scripts/make-desktop-launcher.py              # 生成到桌面
python scripts/make-desktop-launcher.py --dir D:\     # 生成到指定目录
python scripts/make-desktop-launcher.py --remove      # 从桌面删除
```

移动了项目文件夹？重跑一次上面的命令即可（它会把新路径写进去）。

生成器要保证三件容易踩坑的事，并在生成后自检：

| 要求 | 为什么 |
| --- | --- |
| 换行必须是 **CRLF** | LF-only 的批处理会让 `goto :label` 和多行 `if (...)` 块失效 |
| 内容必须是**纯 ASCII** | 中文版 Windows 的 cmd 默认代码页是 936(GBK)，写进去的中文会乱码。中文提示全部交给 Node 输出 |
| 不能有 **BOM** | 有 BOM 会让第一行 `@echo off` 失效 |

> 启动失败时窗口会停住并打印日志路径，日志同时写在 `%TEMP%\python-camp-launch.log`。

---

## 快速开始

1. **用 VS Code 打开一个空文件夹**（比如 `D:\learn-python`）。插件激活后会自动派发今日任务，并在左侧活动栏出现「Python闯关训练营」图标。

2. **点侧边栏的「开始今日任务」**。插件会：
   - 在 `<工作区>/python-camp/` 下创建本关的 `.py` 文件（文件名形如 `第01关_变量与基本类型.py`）；
   - 把示例代码和本关练习写进文件注释；
   - 在右侧打开「关卡详情」页，展示知识点与练习题。

3. **写代码 → `Ctrl+Alt+G` 提交批改**。插件会先本地运行一次，再把代码和运行结果交给 AI 打分。分数 ≥ 过关线（默认 60）即过关，下一关解锁。

> 没配 API Key 也能用：此时只做本地运行检查 + 启发式评分，不判断练习答案的正确性。

---

## 配置 AI 批改

`Ctrl+Shift+P` → `Python闯关训练营: 配置 API Key 与模型`，或直接改 `settings.json`：

```jsonc
{
  // DeepSeek（默认）
  "pythonCamp.apiKey": "sk-xxxxxxxxxxxxxxxx",
  "pythonCamp.apiBaseUrl": "https://api.deepseek.com/v1",
  "pythonCamp.model": "deepseek-chat",

  // OpenAI
  // "pythonCamp.apiBaseUrl": "https://api.openai.com/v1",
  // "pythonCamp.model": "gpt-4o-mini",

  // 本地/自建代理（one-api、vLLM、Ollama 等，只要兼容 OpenAI 协议）
  // "pythonCamp.apiBaseUrl": "http://127.0.0.1:11434/v1",
  // "pythonCamp.model": "qwen2.5:14b"
}
```

接口要求：`POST {apiBaseUrl}/chat/completions`，请求体为标准 OpenAI 格式。
地址写法很宽容 —— 填 `https://api.deepseek.com/v1`、`https://api.deepseek.com`、甚至完整的 `.../chat/completions` 都能识别。

**想关掉 AI？** 把 `pythonCamp.enableAI` 设为 `false`，插件退回纯本地模式。

---

## 接入你自己的题库

`data/levels.json` 就是全部内容。仓库里这份是**占位示例**（2 章 8 关，通用 Python 基础），把它换成你自己的即可，**不需要改任何代码**。

### 数据结构

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-01-01T00:00:00",
  "generator": "（可写你的生成脚本名）",
  "sourceDocs": [{ "file": "来源说明", "role": "用途" }],
  "chapters": [
    {
      "id": 1,
      "title": "Python 基础语法",
      "levelIds": ["L01", "L02", "L03", "L04"],
      "difficulty": 1,
      "totalMinutes": 300
    }
  ],
  "levels": [
    {
      "id": "L01",                  // 唯一，进度文件里存的就是它
      "day": 1,                     // 序号，必须严格递增
      "chapter": 1,                 // 对应 chapters[].id
      "chapterTitle": "Python 基础语法",
      "title": "变量与基本类型",
      "difficulty": 1,              // 1-5
      "estimatedMinutes": 60,
      "goal": "一句话说清这关要学会什么",
      "knowledge": ["知识点 1", "知识点 2"],
      "exercises": ["练习 1", "练习 2"],
      "accept": "验收标准",
      "transfer": "这个知识点还能用在哪",
      "manualExample": "print('参考示例代码')",
      "starterCode": "# 第 1 关：变量与基本类型\n# 今日目标：...\n...",
      "tags": ["变量", "类型"],
      "source": "出处标注"
    }
  ]
}
```

### 三条硬约束

1. **`id` 唯一，`day` 严格递增** —— 解锁顺序就是 `levels` 数组的顺序。
2. **每个 `chapter.levelIds` 里的 id 都必须在 `levels` 里存在**，且所有关卡恰好被收录一次。
3. **`starterCode` 里的注释要包含 `本关练习` 这个字样** —— 本地评分靠它识别「模板注释」和「学生自己写的注释」，避免模板白送分。

`starterCode` 是新建关卡文件时写进 `.py` 的模板。本仓库的示例模板长这样：

```python
# 第 1 关：变量与基本类型
# 今日目标：理解变量是「名字指向值」……
#
# ==========================================================
# 示例代码 —— 照着复现一遍，跑通、看懂每一行
# ==========================================================
# name = "Alice"
# age = 20
#
# ==========================================================
# 本关练习
# ==========================================================
#   1. ……
#
# 写完后按 Ctrl+Shift+P 运行「Python闯关训练营: 提交并批改当前文件」
```

### 生成方式

手写、用脚本生成、从 Markdown/PDF/表格里提取都可以 —— 只要产出上面这个 JSON 结构。改完重跑 `npm test` 确认结构合法即可。

---

## 日常使用

### 侧边栏「闯关进度」

- **今日任务**：今天的关卡卡片，每张带 `打开关卡` / `运行` / `提交批改` 三个按钮；下面是错题本，可一键「按错题重排今日任务」。
- **关卡地图**：按章折叠列表，每关显示状态徽章（已过关 N 分 / 可挑战 / 未过关 N 分 / 未解锁）与历史最好成绩。
- **数据面板**：总完成率进度条、已过关/已解锁/平均分/总学习时长四个指标、最近 14 天学习时长柱状图、薄弱知识点排行、题库来源。

### 关卡详情页

1. **今日目标** —— 一句话说清这一关要学会什么
2. **知识点简述**
3. **示例代码** —— 复现目标，先照着敲一遍跑通
4. **本关练习** —— 这才是真正要提交的东西
5. **验收标准** / **迁移视角**
6. **历史成绩** + **批改结果**（分数、逐题完成情况、问题清单、改进建议、薄弱知识点）

### 批改结果怎么看

```
   78  / 100 分 · 过关线 60 分 · AI 批改
   可运行：是    正确性：80    代码质量：72
```

分数构成：**正确性 50% + 代码质量 25% + 可运行性 25%**。
两条硬规则：代码跑不起来总分不超过 45；只把示例代码原样复制、没做练习，正确性不超过 40。

### 重刷与复习

- 错题本 → 「按错题重排今日任务」：把未过关的关卡优先排进今天
- 关卡地图 → 点任意已解锁关卡即可重打，成绩取历史最高分
- 想跳关学习：设置里打开 `pythonCamp.allowSkipLevels`

---

## 命令与快捷键

`Ctrl+Shift+P` 输入「Python闯关训练营」可看到全部命令：

| 命令 | 快捷键 | 说明 |
| --- | --- | --- |
| 开始今日任务 | | 派发今日任务并打开第一关 |
| 选择关卡（含手动切换） | | 按章节分组的快速选择器 |
| 提交并批改当前文件 | `Ctrl+Alt+G` | 读取当前 `.py` → 本地运行 → AI 判分 |
| 本地运行当前文件 | `Ctrl+Alt+R` | 只跑不判分，看输出和报错 |
| **AI 讲解本关（含参考答案）** | | 让 AI 逐题讲思路 + 给可运行参考代码，落盘成 Markdown |
| **测试 AI 连接** | | 逐项验证配置 / 端点 / 网络 / 能否解析 JSON |
| 重刷错题关卡 | | 按错题重排今日任务 |
| 重置今日任务 | | 重新派发一批 |
| 导出学习报告（Markdown） | | 写到 `.pythoncamp/report.md` 并打开 |
| 配置 API Key 与模型 | | 打开插件设置 |
| 重置全部进度（危险） | | 二次确认后清空 |
| 打开进度面板 | | 展开侧边栏 |

> 提交/运行时，插件靠**文件名里的「第N关」**识别这属于哪一关。所以请保留自动生成的文件名。认不出来时会提示你从面板里选关卡。

---

## 看参考答案

练习只有题目、没有答案，这是设计如此 —— 但你可以让 AI 现场讲一遍。

**三种打开方式**：

1. 关卡详情页 → **「AI 讲解 / 看参考答案」** 按钮
2. `Ctrl+Shift+P` → `AI 讲解本关（含参考答案）`
3. 打开某一关的 `.py` 文件后直接执行上面的命令（会按文件名里的「第N关」自动识别）

生成的内容会**落盘成 Markdown**：

```
<工作区>/python-camp/参考答案/第01关_参考答案.md
```

结构是固定的，方便对照：

```
# 第 1 关参考答案：变量与基本类型
## 一、这一关在练什么
## 二、逐题思路与参考答案      ← 每道题：考什么 → 思路 → 参考代码
## 三、完整可运行版本          ← 所有练习合并成一个能直接跑的脚本
## 四、易错点
## 五、怎么自己验证做对了
```

**为什么是文件而不是弹窗**：可以反复看、离线看、自己批注；而且**已经生成过就直接打开，不会重复烧 token**。想重新生成会二次确认。

> 提示词里明确要求「只能使用本关及之前教过的语法」，所以低难度的关卡不会甩给你一个看不懂的炫技写法。
>
> **建议先自己写完再看。** 直接抄答案的话，批改时的 `correctness` 会被压到 40 分以下 —— 评分提示词里专门防了这一点。

---

## 测试 AI 连接

配置完之后先跑一次这个，比直接去批改里踩错强：

`Ctrl+Shift+P` → `Python闯关训练营: 测试 AI 连接`

它会逐项验：

1. **配置完整性** —— 开关、Key、服务地址、模型名是否都填了
2. **端点解析** —— 你填的 `apiBaseUrl` 最终会被解析成哪个 URL
3. **网络与鉴权** —— 真实发一次最小请求，报 HTTP 状态与耗时
4. **能否解析出 JSON** —— 这一步是刻意加的：**HTTP 通了、模型也正常返回了，但返回内容解析不出 JSON**，只测连通性是发现不了的

结果同时输出到 **输出面板 → 「Python闯关训练营」** 通道，失败时给出针对性的下一步建议（例如「Key 可能填错/没额度」「地址要不要带 `/v1`」「推理模型太慢，把 `aiTimeoutSec` 调大」）。

---

## 设置项

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `pythonCamp.apiKey` | `""` | 模型 API Key，留空则只做本地检查 |
| `pythonCamp.apiBaseUrl` | `https://api.deepseek.com/v1` | 服务地址（OpenAI 兼容） |
| `pythonCamp.model` | `deepseek-chat` | 模型名称 |
| `pythonCamp.enableAI` | `true` | 总开关 |
| `pythonCamp.passScore` | `60` | 过关分数线 |
| `pythonCamp.dailyTaskCount` | `3` | 每天派发几关 |
| `pythonCamp.allowSkipLevels` | `false` | 允许跳关 |
| `pythonCamp.pythonPath` | `python` | 解释器路径，可填绝对路径 |
| `pythonCamp.autoRunBeforeGrade` | `true` | 批改前先本地运行（强烈建议保持开启） |
| `pythonCamp.runTimeoutSec` | `20` | 本地运行超时（秒） |
| `pythonCamp.trackStudyTime` | `true` | 统计学习时长 |
| `pythonCamp.strictMode` | `false` | 严格模式，代码质量权重要求更高 |
| `pythonCamp.maxTokens` | `4000` | 单次调用允许模型输出的最大 token 数。提示「输出被截断」时调大 |
| `pythonCamp.aiTimeoutSec` | `120` | 模型响应超时（秒）。推理模型建议 180~300 |

> **用推理模型（gpt-5.x、deepseek-reasoner、o 系列等）的话**，把 `aiTimeoutSec` 调到 180~300、`maxTokens` 调到 8000。
> 这类模型思考慢、思维链还会计入 token 预算，默认值容易超时或被截断。

---

## 数据与隐私

### 写在哪

```
<工作区>/
├── python-camp/                       ← 你写的代码，一关一个文件
│   ├── 第01关_变量与基本类型.py
│   ├── 第02关_字符串与 f-string.py
│   └── 参考答案/                      ← AI 生成的参考答案（Markdown）
│       └── 第01关_参考答案.md
└── .pythoncamp/                       ← 插件状态
    ├── progress.json                  ← 闯关进度档案
    ├── report.md                      ← 导出的学习报告
    └── tmp/                           ← 本地运行用的临时文件（用完即删）
```

### 隐私边界

- **不会**扫描、上传、索引工作区里的任何其他文件
- **不会**上传 `progress.json`、学习报告、参考答案或你的代码文件
- 点击「提交并批改」时，才会把**当前这一个文件的代码**、关卡信息、以及**本地运行的真实输出**发给你配置的模型服务
- 点击「AI 讲解本关」时，只发送**关卡本身的题目与知识点**（题库内容），**不发送你写的代码**
- 没有配置 API Key 时，全程零网络请求
- 关掉 `pythonCamp.enableAI` 即彻底断网运行

> 说明：为了拿到真实的报错信息，插件会**先保存当前文件再运行它** —— 和你在终端里敲 `python xxx.py` 是一样的行为。如果某个脚本有副作用（写文件、发请求），请自行注意。

---

## 项目结构

```
python-challenge-camp/
├── package.json                 插件清单（命令、配置项、侧边栏视图、快捷键）
├── tsconfig.json                TypeScript 配置（strict）
├── esbuild.js                   打包脚本
├── launch.cmd                   一键启动（批处理引导，纯 ASCII + CRLF）
├── README.md
├── CHANGELOG.md
├── LICENSE
├── data/
│   └── levels.json              题库（本仓库为 8 关占位示例，替换成自己的即可）
├── media/
│   ├── icon.svg                 活动栏图标
│   ├── icon.png                 插件图标
│   └── icon.ico                 桌面快捷方式图标
├── src/
│   ├── extension.ts             入口：命令注册与流程编排
│   ├── core/
│   │   ├── types.ts             全插件数据契约
│   │   ├── config.ts            设置读取
│   │   ├── store.ts             进度持久化（原子写 + 损坏自愈）
│   │   ├── curriculum.ts        题库加载、章节树、解锁判定
│   │   ├── scheduler.ts         每日任务派发与重置
│   │   ├── runner.ts            本地 Python 运行与报错识别
│   │   ├── timer.ts             学习时长统计
│   │   └── grader.ts            批改编排 + 本地启发式兜底
│   ├── ai/
│   │   ├── client.ts            OpenAI 兼容客户端（零依赖，用内置 fetch）
│   │   └── prompt.ts            批改提示词模板
│   ├── panels/
│   │   ├── html.ts              Webview 共享样式（走 VS Code 主题变量）
│   │   ├── viewModel.ts         状态 → UI 模型
│   │   ├── sidebar.ts           侧边栏三页签面板
│   │   └── levelPanel.ts        关卡详情页
│   └── util/
│       └── paths.ts             目录约定与日期工具
└── scripts/
    ├── launch.js                一键启动逻辑（找 node / 装依赖 / 编译 / 找 VS Code / 启动）
    ├── make-desktop-launcher.py 生成桌面启动器（CRLF + 纯 ASCII + 反斜杠路径，带自检）
    ├── smoke.ts                 核心逻辑冒烟测试（82 项）
    ├── smoke.build.js           冒烟测试打包脚本
    ├── loadtest.js              加载测试（54 项，含启动器校验）
    └── vscode-stub.js           测试用的 vscode 模块替身
```

---

## 开发与测试

```bash
npm install
npm run typecheck      # tsc --noEmit
npm run compile        # 打包到 out/extension.js
npm run watch          # 监听重建

npm run test           # 类型检查 + 打包 + 两套测试
npm run test:smoke     # 核心逻辑冒烟测试（82 项）
npm run test:load      # 加载测试（54 项，含启动器校验）
```

### 两套测试分别在防什么

**冒烟测试**（`scripts/smoke.ts`）—— 把 `vscode` 模块替换成替身，直接在 Node 里跑核心逻辑：

- 题库结构不变量：ID 唯一、`day` 严格递增、每关有知识点与练习、章节恰好收录全部关卡
- 解锁规则：首关可打、未过关时下一关锁定、过关后解锁、学习前线推进
- 每日任务：派发数量、连续推进、今日任务即解锁通道、完成标记、重置、当天不重复派发
- AI 返回解析：```json 包裹、前后有废话、分数越界钳制、不可运行封顶 45、非法返回回退
- **JSON 解析回归用例**：字符串内含 markdown 代码块 / 含花括号 / 被截断 / 围栏内含反引号
  （这几个用例对应的真实 bug 见「常见问题」）
- 本地评分：好代码高分、报错代码低分、空代码极低分
- **真实调用本机 Python**：正常输出（含中文编码）、NameError / SyntaxError 识别、死循环超时中断、语法检查、临时文件清理
- 持久化：写入、重载、损坏文件自愈并备份

> 题库断言刻意只校验**结构不变量**，不写死关卡数量 —— 换掉 `data/levels.json` 的内容后测试仍然全绿。

**加载测试**（`scripts/loadtest.js`）—— 真正 `require` 打包产物并调用 `activate()`：

- 模块加载期 / 激活期不报错
- `package.json` 声明的 11 个命令**全部**已注册，且没有注册未声明的命令
- 代码读取的 12 个配置项与 `package.json` 完全一致（改名漏改会直接报错）
- 快捷键、菜单引用的命令都存在；激活事件里的视图 ID 正确
- 激活后确实生成了 `progress.json` 并派发了今日任务
- 释放全部订阅、事件循环清空（进程能正常退出）
- **启动器校验**：`launch.cmd` 换行全为 CRLF、纯 ASCII、无 BOM、`goto` 标签齐全、
  失败路径有 `pause`；`launch.js --dry-run` 能跑通全部决策并选中正版 VS Code
  （桌面启动器成品校验仅在「文件存在且指向本项目」时执行，否则明确跳过）

> 关于启动器的测试方式：本环境安全策略禁止调用 `cmd.exe` 与 COM，所以 `.cmd` 无法在这里
> 真实执行。改为「静态校验批处理最容易出错的属性 + 动态验证 `launch.js` 的全部决策逻辑」。
> 其中 CRLF 这条是真踩过的坑 —— LF-only 的批处理会让 `goto :label` 和多行 `if (...)` 块失效。

---

## 常见问题

**Q：侧边栏图标点了没反应 / 面板是空的？**
先确认打开了一个**文件夹**（不是单个文件）。插件需要工作区来放 `python-camp/` 和 `.pythoncamp/`。

**Q：提交后提示「找不到 Python 解释器」**
把 `pythonCamp.pythonPath` 改成绝对路径，例如 `C:\Python312\python.exe`。

**Q：AI 批改失败，提示 401 / 404**
- 401/403：Key 无效或没额度
- 404：`apiBaseUrl` 或 `model` 写错了。注意有些服务需要 `/v1` 后缀
- 超时：把 `apiBaseUrl` 换成更近的节点，或改用更快的模型

失败时插件会自动退回本地评分，**不会**丢掉你的成绩。

**Q：提示「模型返回的内容无法解析为 JSON」怎么办？**
先跑一次 `测试 AI 连接`，看它报的是哪一步。提示里现在会带上**返回长度和结束原因**，据此判断：

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| 结束原因是 `length` | 输出被 `maxTokens` 截断，JSON 不完整 | 调大 `pythonCamp.maxTokens`（4000 → 8000） |
| 提示「只返回了思考过程、没有正文」 | 推理模型的思维链把 token 预算吃光了 | 同上，调大 `maxTokens` |
| 结束原因是 `stop`，长度也正常 | 解析器问题 | 直接提 issue，把「输出」面板里的原始返回贴上来 |

> 历史版本里有个解析器 bug：提示词要求 AI 在建议里给代码片段，于是**合法 JSON 的字符串内部会包含 ` ``` `**，而当时的解析器用非贪婪正则剥外层围栏，会被内层代码块骗到，只抠出几十字符的碎片，把一份完全正确的 JSON 判成「无法解析」。已修复，并加了回归测试。

**Q：想重来一遍怎么办？**
`Ctrl+Shift+P` → `重置全部进度`（二次确认）。或者直接删掉 `.pythoncamp/progress.json`，插件会重建。

**Q：能跳关吗？**
可以。设置里打开 `pythonCamp.allowSkipLevels`，关卡地图里所有关卡都能直接进入。

**Q：换了自己的题库，进度会错位吗？**
进度文件里存的是关卡 ID（`L01`、`L02`…）。只要 ID 和顺序不变，替换内容不会影响已有成绩。

**Q：为什么仓库里的题库只有 8 关？**
那是我手写的占位示例，用来演示框架并让测试能跑通。换成你自己的内容即可 —— 见 [接入你自己的题库](#接入你自己的题库)。

---

## 许可

MIT
