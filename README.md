# Mini-Pi v3.0

一个运行在 iPhone 脚本运行时（Scriptable / aBuddy 等 JS 环境）上的**极简本地自主 Agent**。单文件即可运行，通过 OpenAI 兼容接口 + Function Calling 驱动，把 AI 能力直接接到 iOS 系统 API 上。

> **v3.0 核心：按脚本名物理隔离存储。** 同一份代码复制成「助手A」「助手B」等多个脚本时，各自的会话历史、用户画像完全独立，互不干扰。

## 功能特性

- 🤖 **Agentic 循环**：最多 8 步工具调用自省推理（ReAct 式状态机）
- 🗂️ **脚本间存储隔离**：数据文件按脚本名动态生成（`agent_memory_<脚本名>.json`），多个脚本各存各的，无需任何配置
- 🧠 **持久化记忆**：多会话树 + 用户画像 facts，iCloud 跨设备同步；会话自动命名，每会话保留最近 8 轮
- 🎨 **AI 生图**：基于 Pollinations 免 Key 图像接口，Markdown 嵌入气泡渲染
- 🌐 **在线搜索**：DuckDuckGo HTML 抓取，失败自动降级中文维基 API
- 📍 **定位与天气**：GPS 定位 + 逆地理编码；wttr.in 多语言天气（气温/体感/湿度/风速/降水）
- 📅 **系统集成**：查询系统日历、创建提醒事项、打开 URL Scheme 跳转 App
- 🖼️ **多模态输入**：支持快捷指令传入截图/照片，Base64 视觉分析
- ⚡ **SVG 动画渲染**：动态视觉效果直接输出 SMIL/CSS 矢量动画，不依赖外部资源
- 💬 **原生聊天 UI**：手写 iOS 风格 WebView（气泡、抽屉式会话列表、图片查看器、深色模式）

## 快速开始

1. 在脚本 App 中新建脚本，粘贴 `Mini-Pi.js`
2. 修改顶部配置：

   ```js
   const API_URL = "https://<你的 OpenAI 兼容端点>/v1/chat/completions";
   const API_KEY = "<你的 API Key>";
   const MODEL   = "<支持 function calling 与视觉的模型名>";
   ```

3. 授予定位、日历、提醒事项、照片权限
4. 直接运行 → 全屏聊天视图；或从快捷指令传入文本/图片 → Alert 模式返回结果

## 脚本间存储机制

数据文件路径由当前脚本名动态生成：

```js
memoryPath() {
  const scriptName = (typeof Script !== "undefined" && Script.name())
    ? encodeURIComponent(Script.name())
    : "default";
  return this.fm.joinPath(this.fm.documentsDirectory(), `agent_memory_${scriptName}.json`);
}
```

| 场景 | 结果 |
| --- | --- |
| 同一份代码存成「助手A」「助手B」 | 各自使用 `agent_memory_助手A.json` / `agent_memory_助手B.json`，历史完全独立 |
| 想把某个脚本的聊天记录给别人或搬走 | 直接复制 iCloud 文档目录下对应的 `agent_memory_<脚本名>.json` |
| 想让两个脚本**共用**一份记忆 | 把上面 `memoryPath()` 改回固定文件名（例如 `"agent_memory.json"`），两个脚本都这样改即可 |
| 脚本被改名 | 数据文件名随之改变，旧数据不会自动跟随；需要手动把旧文件重命名为新脚本名 |

存储位置：iCloud 的 Scriptable 文档目录（`FileManager.iCloud()`，无 iCloud 时回退本机）。

## 架构

```
┌─────────────────────────────────────────┐
│  main() 双模态分流                        │
│  ├─ 模式 A: 快捷指令/共享 → Alert 输出     │
│  └─ 模式 B: WebView 聊天 UI ←→ 事件轮询   │
├─────────────────────────────────────────┤
│  runAgentTurn  Agentic 状态机 (≤8 步)     │
│    callChatAPI ⇄ executeLocalTool        │
├─────────────────────────────────────────┤
│  9 个本地工具: 生图/搜索/定位/城市坐标/    │
│  天气/日历查询/创建提醒/URL Scheme/记忆写入 │
├─────────────────────────────────────────┤
│  MemoryManager (iCloud JSON 持久化)       │
│    └─ agent_memory_<脚本名>.json ← 脚本隔离 │
└─────────────────────────────────────────┘
```

## 注意事项

- `API_KEY` 请勿提交真实密钥，建议使用运行时占位符并自行替换
- 定位失败时降级为默认坐标（北京市），可按需改为你的常驻地（注意别提交到公开仓库）
- 内置城市坐标表：成都、武汉、西安、东莞、广州、深圳、北京、上海、杭州
- 搜索依赖 DuckDuckGo HTML 端点，可能因反爬失效，已内置维基降级通道
- 生图使用 Pollinations 公共服务，不保证 SLA
- 会话历史每轮保留最近 8 轮（`appendTurn` 的 `maxTurns`），更早内容会被丢弃

## 版本沿革

- **v3.0（2026-10-10）**：以「按脚本名物理隔离存储」的实现为基线；公开发布版本已将定位降级坐标与内置城市表统一为通用值（北京 + 通用城市），不含任何真实住址
- v2.x 期间试验过的多模型切换、Skills 技能系统、会话导入导出、token 用量统计、摘要压缩等能力**未纳入 v3.0**，以保持单文件极简基线

## 隐私与安全

脚本会把对话与用户画像保存在本机 / iCloud，分享或提交代码前请留意：

- **API Key**：只写在脚本顶部。不要把填了真实 Key 的副本提交到公开仓库或发给他人；一旦泄露，立即到服务商后台撤销
- **记忆文件**：`agent_memory_<脚本名>.json` 保存全部会话与 `user_profile.facts`（可能含偏好、日程、位置等私人信息），**不要上传或截图公开**
- **默认降级位置**：仓库中预置的是北京市，不含任何真实住址；若改成你的常驻地，请勿把该改动提交到公开仓库
- **脚本名**：会出现在数据文件名中，若脚本名本身是私人信息，公开截图时注意遮挡
- **仓库现状**：本仓库不含真实 API Key、Token、住址或账号信息

## License

MIT
