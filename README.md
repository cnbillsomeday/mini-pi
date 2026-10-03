# Mini-Pi

一个运行在 iPhone 脚本运行时（Scriptable / aBuddy 等 JS 环境）上的**极简本地自主 Agent**。单文件即可运行，通过 OpenAI 兼容接口 + Function Calling 驱动，把 AI 能力直接接到 iOS 系统 API 上。

## 功能特性

- 🤖 **Agentic 循环**：最多 8 步工具调用自省推理（ReAct 式状态机）
- 🧠 **持久化记忆**：多会话树 + 用户画像 facts，存储于 `agent_memory.json`，支持 iCloud 跨设备同步
- 🎨 **AI 生图**：基于 Pollinations 免 Key 图像接口，Markdown 嵌入气泡渲染
- 🌐 **在线搜索**：DuckDuckGo HTML 抓取，失败自动降级中文维基 API
- 📍 **定位与天气**：GPS 定位 + 逆地理编码，wttr.in 多语言天气查询
- 📅 **系统集成**：读写 iOS 日历、创建提醒事项、打开 URL Scheme 跳转 App
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
│  9 个本地工具: 生图/搜索/定位/坐标/天气/    │
│  日历/提醒/URL Scheme/记忆写入             │
├─────────────────────────────────────────┤
│  MemoryManager (iCloud JSON 持久化)       │
└─────────────────────────────────────────┘
```

## 注意事项

- `API_KEY` 请勿提交真实密钥，建议使用运行时占位符并自行替换
- 定位失败时降级为默认城市坐标（北京），可按需改为你的常驻地
- 搜索依赖 DuckDuckGo HTML 端点，可能因反爬失效，已内置维基降级通道
- 生图使用 Pollinations 公共服务，不保证 SLA

## License

MIT
