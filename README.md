# 对话微调 · Dialog Tune

一个用于 Tavo 的聊天内容定向微调插件：**点消息下方的「微调」按钮，就能微调 AI 的回复或你自己正在写的那段话，改多少你说了算。**

- 插件名：对话微调 / Dialog Tune
- 插件 ID：`io.github.dialogtune.dialog-tune`
- 形态：`.tpg` 插件包（Tavo 插件中心格式）

---

## 它解决什么问题

AI 的回复经常「差一点点」：语气太硬、结尾太啰嗦、人称错了、某句话没说清楚。
你想改，但整段重写又太浪费；逐字手改又太累。

「对话微调」的做法是：**把整段内容连同你的微调要求一起交给当前聊天绑定的模型，让它重新生成一遍整段内容**——
不改的地方按引导提示词逐字保留，改的地方只改你要求的那部分。生成结果先给你看前后对照，确认后才写回；
写回后它就是这条消息的一个版本，随时可以用 Tavo 原生的版本切换切回原文。

## 功能

| | |
| --- | --- |
| **三种触发** | 每条消息下方的行内按钮 · 右侧边栏的「对话微调」 · 输入框 `+` 菜单 |
| **微调面板** | 微调要求输入框 + 「使用长记忆」开关 + 「最近 N 条对话」开关（N 可填） |
| **上下文可控** | 默认**只有**当前选中的那一段内容；开关打开后按需叠加长记忆与最近 N 条对话（取被微调消息之前的） |
| **调用当前聊天的 API** | 直接用当前聊天绑定的模型与 API，不额外发请求 |
| **只看重写结果 + 内联差异高亮** | 改动处绿底加粗加下划线、被替换的字留红色删除线，直接标在正文里，自动滚动到第一处差异；标题右侧显示「新增 N 字 · 删除 M 字」，结果与原文一致时会明确提示 |
| **重新生成（reroll）** | 同一份上下文再来一次，历次结果都保留，可来回切换 |
| **四种落点** | 应用到消息（默认，成为该消息的一个版本）· 作为新消息 · 填回输入框 · 复制 |
| **原生版本切换** | 撤销交给 Tavo 原生的「重新生成 / 切换版本」，插件不自建撤销历史 |
| **记住你的偏好** | 开关状态会被记住，下次打开还是你上次的选择 |
| **可编辑的引导提示词** | 设置页里直接改「如何微调」的引导语，默认引导最小化改写 |
| **中英双语** | 跟随 App 语言，切换时完整重渲染 |

## 安装

### 从 Release 安装（推荐）

1. 到 [Releases](https://github.com/Lethivia/tavo-dialog-tune/releases) 下载 `dialog-tune-1.0.9.tpg`
2. Tavo **设置 → 插件 → 右上角导入 → 从文件导入插件**，选这个 `.tpg`（**不需要解压**）
3. 安装后**重启 Tavo**（更新插件包需要重启才会替换已挂载的片段）
4. 在插件设置里确认「显示位置」勾选了：聊天页、消息、输入框菜单、最后一条消息

> 插件需要开启**高级渲染**才会生效。

### 从文件安装（开发/内测）

1. 下载或自行打包出 `.tpg`（本质是 zip，`manifest.json` 必须在包根目录）。
2. Tavo 中打开 **更多 → 插件 → 右上角安装 → 从文件导入插件**。
3. 安装后回到聊天页，在插件设置里确认 **显示位置** 勾选了「聊天页」「消息」「输入框菜单」「最后一条消息」。

> 建议先在一个备份聊天里试。

### 导入失败排查

Tavo 1.12 支持 specVersion 2、插件包国际化与消息候选版本，版本门槛不是原因。

已与两个**已上架的社区插件包**（`com.emon.image-viewer`、`com.jeremy.tavo-memory-curator`）逐项比对：

| 比对项 | 结论 |
| --- | --- |
| ZIP 头部 | 与参考包同为 Info-ZIP / Unix / deflate，`manifest.json` 位于偏移 0 |
| 包结构 | `manifest.json` + `entry.js` + `ui/` + `locales/` + 根目录图片，与参考包一致 |
| manifest 字段 | specVersion / id / name / version / entry / author / description / releaseNotes / localization / cover / permissions / contributes 的用法与参考包一致 |
| 图片格式 | 封面 512×512 PNG、动作图标 128×128 PNG，均经独立解码器（PIL）验证可正常解码 |
| 文案 | 中英双语的 88 条文案全部进 catalog，key 齐全 |

据此已消除的偏差：封面改为根目录 512×512 PNG、去掉 `contributes.visible`（默认本就是全开）、去掉输入动作图标。

若仍导入失败，按顺序排查：

1. **先换扩展名**：包同时提供 `.tpg` 与 `.zip` 两份内容相同的文件。移动端文件选择器对 `.tpg` 的 MIME 识别不稳定（常被归为 `application/octet-stream` 而被过滤），官方开发指南的导入流程本身用的也是 `.zip`。优先导入 `.zip`。
2. **再试最小包**：`dist/dialog-tune-minimal-1.0.1.zip` 只有 `manifest.json` + `entry.js`。
   - 最小包也装不上 → 问题在文件传输 / 文件选择器这一层，与本插件清单无关；
   - 最小包装得上 → 问题在完整清单的某个字段，可逐项加回定位。
3. **把 App 的原文报错发过来**：Tavo 拒绝插件时区分「缺 manifest / JSON 非法 / 路径不安全 / entry 不存在 / 字段不支持 / specVersion 不支持」多类，现在这句太泛，看不出落在哪一类。

排查产物由 `npm run build` 与 `npm run build:minimal` 生成；`npm run check` 会校验 manifest、图片格式与文案 key。

### 从源码构建

```bash
npm install          # 仅开发依赖（jsdom，用于跑冒烟测试）
npm run build        # 生成图标 + 打包 dist/dialog-tune-<版本>.tpg 与同名 .zip
```

> 同名同版本的包无法覆盖安装，重新发布时请先 `npm version minor`（或 patch）再打包；
> `npm run build` 会自动按 `manifest.json` 里的版本号命名产物，并在打包后自检
> 「包根目录的 manifest.json 可解析且与源文件逐字节一致」。

打包脚本零依赖，内置了最小 ZIP 写入器。

## 使用

1. 点消息下方的行内「微调」按钮（自己的输入可以用输入框 `+` 菜单里的「对话微调」）。
2. 在弹出的面板里写下微调要求，例如「把语气改得更自然一点，其他内容保持原样」。
3. 需要时打开「使用长记忆」或把「最近对话」调到几条。
4. 点 **生成微调**。按钮会转成加载态，不会让你以为卡住了。生成完成后展示改写后的正文，**改动的地方直接高亮标在正文里**，并自动滚到第一处差异。
5. 不满意就点 **重新生成**（上下文完全相同，历史结果都留着可回退），满意就点 **应用到消息**：
   - 成为这条消息的一个新版本，原文保留，可原生切回；
   - 右侧的小箭头里还有 **作为新消息** / **填回输入框** / **复制**。

### 设置项

| 设置 | 说明 |
| --- | --- |
| 显示行内微调按钮 | 每条消息下方的小按钮，可关 |
| 默认使用长记忆 | 打开面板时是否默认带上长记忆（默认关） |
| 默认最近对话条数 | 打开面板时的默认 N（默认 0） |
| 最近对话条数上限 | 面板里能填的最大值（默认 50） |
| **微调引导提示词** | 告诉模型怎么执行微调的引导语，默认引导最小化改写；**这是「只改必要部分」的保障** |
| 生成后直接应用 | 跳过对照预览（默认关） |
| 输出语言 | 与原文一致（默认） / 跟随 App 语言 |

## 设计说明

### 为什么「微调」是重新生成整段，而不是打 patch

模型拿到的是**整段原文 + 你的要求**，输出的是**整段新正文**。
这样不相关的内容由引导提示词约束逐字保留，而不是让模型去描述「该改哪几个字」——
后者既容易漏，又容易连带改坏。

### 为什么不做「自动判断是否改过头」

插件不判断生成结果是否偏离过大，也不自动重写、不做选区局部微调、不清洗模型输出。
改多少、保留什么、要不要整段替换，都是玩家自己决定；
插件只负责**把玩家的要求可靠地送到模型，再把结果原样交回来**。

### 为什么应用后能撤销

应用时用的是 Tavo 原生的消息候选（variant）机制：
新内容作为该楼层的一个候选版本并切为当前版本，原文自动进入候选历史。
于是「撤销」就是原生那个「重新生成 / 切换版本」按钮——不需要插件自建历史，也不会和原生行为打架。

### 插件片段跑在 iframe 里（架构要点）

Tavo 的插件 HTML 片段运行在**独立的 iframe** 中（官方文档：原生控件、菜单、系统弹窗和插件 iframe 不在主题 CSS 的作用范围内）。
`/messages` 片段的 iframe 只有气泡那么大，`/chat` 片段的 iframe 覆盖整个聊天区，两者还是**并列的兄弟 iframe**——这带来两个必须处理的问题：

1. **面板必须由 `/chat` 片段承载**。在消息侧就地渲染，`position: fixed` 会被限制在气泡那个小 iframe 里，
   面板既不在屏幕底部也小到无法操作。
2. **兄弟 iframe 之间不能靠 `postMessage`**（它只往祖先走），同源广播在插件 iframe 之间也不一定连通。
   因此请求借**共同的父窗口中转**：消息侧把请求 `postMessage` 给父窗口，宿主在父窗口上监听 `message`
   接单，并用 `event.source` 回执（跨域下也允许 `addEventListener` / `postMessage`）。
   另外保留同源广播、DOM 事件、聊天作用域信箱三条备用通道。

宿主 350ms 内没有回应，就在消息下方**就地展开**降级，保证点击一定有反应。

### 关于触发方式

Tavo 原生的长按气泡菜单（复制 / 改写 / 回溯 / 删除 / 隐藏 / 多选 / 折叠）是原生 UI，**插件无法往里加按钮**，
所以插件没有接管长按手势，改用三条独立路径触达同一功能：

- 消息下方的行内「微调」按钮
- 右侧边栏的「对话微调」 里的「对话微调」
- 输入框 `+` 菜单里的「对话微调」

面板统一由聊天页承载，因此无论从哪个入口进来，都会贴在屏幕底部、铺满可操作区域。

## 思考模式（仅对微调生效）

微调面板里多了一行「思考模式」：**模型族 + 档位**。选中后，这次微调请求会带上对应的思考参数。

- **只影响这一次 `tavo.generate` 请求**（`settings` 是逐请求覆盖），**不会改动你自己的 API 设置**，普通对话完全不受影响。
- 已知模型族直接给**开关 / 档位**；不认识的型号选「其它」后可以**手填 HTTP body**（例如 `{"reasoning_effort": "low"}`）。
- 各家「关闭思考」的语义不统一（`disabled` / `none` / `minimal` / 省略参数），**强制思考的型号不提供关闭档**（官方说明传 `disabled` 会 400）。

### 各模型族的参数

⚠️ **关键**：`settings` 里的键是 **Tavo 内部的模型参数 id**（形如 `openai.reasoning_effort`、`claude_thinking.budget_tokens`、`gemini_thinking_level`），原生层会查表翻译成各平台的字段。**直接写平台字段（`{"reasoning_effort":"low"}`）不保证生效**；文本生成路径也没有 `extraBody`（那是生图接口才有的）。

| 模型族 | Tavo 参数 id | 档位 | 官方文档 |
| --- | --- | --- | --- |
| OpenAI 兼容 | `openai.reasoning_effort` | none / minimal / low / medium / high / xhigh | [platform.openai.com](https://platform.openai.com/docs/guides/reasoning) |
| OpenRouter | `openrouter.reasoning_effort` | low / medium / high / xhigh | [openrouter.ai](https://openrouter.ai/docs/use-cases/reasoning-tokens) |
| DeepSeek | `deepseek.reasoning_effort` | low / high / max | [api-docs.deepseek.com](https://api-docs.deepseek.com/guides/thinking_mode/) |
| 智谱 GLM | `zhipu.reasoning_effort`（5.3 强制思考） | low / high / max | [docs.bigmodel.cn](https://docs.bigmodel.cn/cn/guide/capabilities/thinking) |
| Anthropic | `claude_thinking.budget_tokens` | 2048 / 8192 / 16384 | [platform.claude.com](https://platform.claude.com/docs/en/build-with-claude/thinking) |
| Google Gemini | `gemini_thinking_level` | MINIMAL / LOW / MEDIUM / HIGH / XHIGH | [ai.google.dev](https://ai.google.dev/gemini-api/docs/thinking) |
| 小米 MiMo | `thinking.type`（平台字段，标注未验证） | 开启 / 关闭 | [mimo](https://mimo.mi.com/static/docs/quick-start/usage-guide/text-generation/deep-thinking.md) · [grok](https://docs.x.ai/developers/model-capabilities/text/reasoning) · [kimi](https://platform.kimi.ai/docs/guide/use-reasoning-effort) · [qwen](https://www.alibabacloud.com/help/en/model-studio/deep-thinking) |

各家「关闭思考」的语义不统一（`none` / `disabled` / `minimal` / 省略参数），**强制思考的型号不给关闭档**（官方说明传 `disabled` 会 400）。

### 参数写法（两种都试）

设置页可切换「参数写法」：

- **Tavo 参数 id（推荐）**：`settings` 里放 `openai.reasoning_effort` 这类 Tavo 内部 id，原生层查表翻译成平台字段——这是 Tavo 自己认的参数，成功率最高；
- **平台原生字段**：直接发 `reasoning_effort` / `thinking:{type:"enabled"}`。文本生成路径能否透传**未经验证**，但如果上面那种不生效，多半是这个原因。

面板上每个模型族都有「关闭 / 开启 / 各级强度 / 自定义 JSON」。**没有对应 Tavo 参数 id 的厂商（MiMo / Grok / Kimi / Qwen）会自动回退到平台字段**，并在档位名后标注「未验证」——因为这些平台的官方关闭语义各不相同，插件不能替官方保证。

### ⚠️ 这个功能的确切状态

**能用，但官方没有把话说死。** 核实结论：

- ✅ 文档明确 `tavo.generate(prompt, { settings })` 会「覆盖本次请求的模型参数」，原生层有统一的参数注册表（Tavo 参数 id → 平台字段的查表翻译）；
- ✅ 这**正好满足**「只对微调生效、不改动用户 API 设置」——`settings` 是逐请求覆盖；
- ⚠️ 但文档**从未说明** `settings` 的透传规则，**已上架插件清一色只用 temperature / maxCompletionTokens**（0/10 先例），原生 Dart 层是 AOT 编译无法逐行确认。

所以插件做了三层兜底：

1. **参数 id 选对**（用 Tavo 内部 id，不写平台字段）；
2. **手填 JSON**：可以填任意 Tavo 参数 id（例如 `{"claude_thinking.budget_tokens": 4096}`），**解析失败会被忽略而不是让请求失败**；
3. **模型报错时给可操作提示**（"模型拒绝了思考参数……"），而不是一句干巴巴的失败。

**请在设备上实测**：面板选「OpenAI 兼容 + 低」→ 微调一次 → 看模型是否真的思考了（明显更慢、或回复带推理痕迹）。**如果不生效**，把模型族换成手填 JSON 试试别的参数 id；**都不通**的话，我会据实说明这个口子没开，并把该功能退回成提示。

### 思考过程为什么显示不出来

`tavo.generate` 是**一次性请求，返回完整文本，不返回流式分片**，`reasoning` 字段只存在于 App 自己的消息结构里，插件拿不到思考内容；而且插件也**读不到当前会话用的是哪个模型**（没有 `tavo.api` / `tavo.model` 这样的命名空间），所以无法自动判断该不该开思考。

替代方案：生成时显示**实时计时状态行**（"正在生成… 已等待 12 秒"），至少不会让人以为卡死。

## 项目结构

```
.
├── manifest.json          # 插件清单（specVersion 2）
├── entry.js               # 入口：注册输入动作 / 最后一条消息动作
├── ui/
│   ├── panel.html         # 聊天页片段（/chat/body/end）
│   ├── message.html       # 消息片段（/messages/end?role=user|character）
│   ├── css/panel.css      # 面板样式（浅色/深色自适应）
│   ├── css/message.css    # 行内按钮样式
│   └── js/
│       ├── core.js        # 共享核心：上下文组装、生成、差异预览、应用
│       ├── panel.js       # 聊天页装配：事件、长按手势、聊天切换
│       └── message.js     # 消息装配：定位消息容器、行内按钮
├── locales/en.json        # 英文文案
├── locales/zh-CN.json     # 简体中文文案
├── icons/                 # 动作图标与封面（脚本生成）
├── scripts/
│   ├── make-icons.mjs     # 零依赖 PNG 图标生成
│   ├── build.mjs          # 零依赖 .tpg 打包
│   ├── check.mjs          # 静态一致性检查（文案 key、路径、字段）
│   └── test-core.mjs      # jsdom 冒烟测试（真实 DOM 流程）
├── docs/PRD.md            # 产品需求文档与需求补全分析
└── LICENSE
```

## 发布到官方插件中心

插件通过 [Tavo 插件中心](https://hub.tavoai.dev) 的创作者后台投稿（登录 → 我的插件 → 上传插件），
不是往某个 Git 仓库提 PR。提交前先跑一遍投稿自检：

```bash
npm run check:hub        # 逐条核对官方 Hub 的包体与清单校验规则
```

需要准备：`.tpg` 包、插件名、**分类（必选）**、简介、更新说明，可选填讨论帖链接。
注意 manifest 里的 `author` 必须与 Hub 账号名一致，否则会被 `authorMismatch` 拒绝。

## 开发

```bash
npm run check   # 静态检查：manifest 合法性、文案 key 齐全、资源路径一致
npm test        # 两套自动化测试：
                #   test-core      核心逻辑（开面板 → 生成 → 差异 → reroll → 应用）
                #   test-fragments 片段集成（真实加载 panel.html / message.html，
                #                 覆盖同文档、跨文档、宿主缺席降级三种拓扑）
npm run build   # 生成图标并打包 .tpg
```

发布前建议：

1. `npm run check && npm test` 全绿；
2. 在 Tavo 里安装 `.tpg`，切换 App 语言确认所有界面（含 HTML 片段）都已跟随；
3. 用真实聊天分别验证：微调 AI 回复、微调自己的草稿、reroll、应用后用原生版本切回原文；
4. 把 `manifest.json` 里的 `id` 换成你自己的命名空间（当前是占位用的 `io.github.dialogtune.*`），并同步修改
   `ui/js/core.js` 的 `PLUGIN_ID` 与 `ui/*.html` 里的 `/plugins/<id>/...` 资源路径（`npm run check` 会帮你盯着）。

## 许可

MIT，见 [LICENSE](LICENSE)。
