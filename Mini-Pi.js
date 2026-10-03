// ==========================================
// 1. 配置云端 API 参数
// ==========================================
const API_URL = "https://openai.com/v1/chat/completions"; 
const API_KEY = "xxxxxx"; 
const MODEL = "mimo-v2.6-flash"; 

// ==========================================
// 2. Mini-Pi 持久化记忆与多会话树 (iCloud 同步)
// ==========================================
const MemoryManager = {
  fm: FileManager.iCloud() ? FileManager.iCloud() : FileManager.local(),

  memoryPath() {
    return this.fm.joinPath(this.fm.documentsDirectory(), "agent_memory.json");
  },

  async load() {
    const path = this.memoryPath();
    if (this.fm.fileExists(path)) {
      try {
        if (this.fm.isFileStoredIniCloud && this.fm.isFileStoredIniCloud(path)) {
          if (!this.fm.isFileDownloaded(path)) {
            await this.fm.downloadFileFromiCloud(path);
          }
        }
        const data = JSON.parse(this.fm.readString(path));
        if (!data.sessions || data.sessions.length === 0) {
          const initId = "sess_" + Date.now();
          data.sessions = [{ id: initId, title: "新会话", created_at: new Date().toISOString(), messages: [] }];
          data.active_session_id = initId;
        }
        if (!data.user_profile) data.user_profile = { facts: [] };
        return data;
      } catch (e) {}
    }
    const initId = "sess_" + Date.now();
    return {
      user_profile: { facts: [] },
      active_session_id: initId,
      sessions: [
        { id: initId, title: "新会话", created_at: new Date().toISOString(), messages: [] }
      ]
    };
  },

  async save(data) {
    this.fm.writeString(this.memoryPath(), JSON.stringify(data, null, 2));
  },

  async appendFact(fact) {
    const mem = await this.load();
    if (!mem.user_profile.facts.includes(fact)) {
      mem.user_profile.facts.push(fact);
      await this.save(mem);
    }
  },

  async getActiveSession() {
    const mem = await this.load();
    let sess = mem.sessions.find(s => s.id === mem.active_session_id);
    if (!sess) {
      sess = mem.sessions[0];
      mem.active_session_id = sess.id;
      await this.save(mem);
    }
    return sess;
  },

  async switchSession(sessionId) {
    const mem = await this.load();
    if (mem.sessions.some(s => s.id === sessionId)) {
      mem.active_session_id = sessionId;
      await this.save(mem);
    }
  },

  async createNewSession() {
    const mem = await this.load();
    const newId = "sess_" + Date.now();
    const newSession = {
      id: newId,
      title: "新会话",
      created_at: new Date().toISOString(),
      messages: []
    };
    mem.sessions.unshift(newSession);
    mem.active_session_id = newId;
    await this.save(mem);
    return newSession;
  },

  async deleteSession(sessionId) {
    const mem = await this.load();
    mem.sessions = mem.sessions.filter(s => s.id !== sessionId);
    if (mem.sessions.length === 0) {
      const newId = "sess_" + Date.now();
      mem.sessions = [{ id: newId, title: "新会话", created_at: new Date().toISOString(), messages: [] }];
      mem.active_session_id = newId;
    } else if (mem.active_session_id === sessionId) {
      mem.active_session_id = mem.sessions[0].id;
    }
    await this.save(mem);
  },

  async appendTurn(userPrompt, assistantReply, maxTurns = 8) {
    const mem = await this.load();
    let sess = mem.sessions.find(s => s.id === mem.active_session_id);
    if (!sess) {
      const newId = "sess_" + Date.now();
      sess = { id: newId, title: "新会话", created_at: new Date().toISOString(), messages: [] };
      mem.sessions.unshift(sess);
      mem.active_session_id = newId;
    }

    if (sess.messages.length === 0 || sess.title === "新会话") {
      sess.title = String(userPrompt).trim().slice(0, 16) || "新会话";
    }

    sess.messages.push({ role: "user", content: String(userPrompt) });
    sess.messages.push({ role: "assistant", content: String(assistantReply) });

    if (sess.messages.length > maxTurns * 2) {
      sess.messages = sess.messages.slice(-maxTurns * 2);
    }
    await this.save(mem);
  },

  async clearCurrentSession() {
    const mem = await this.load();
    let sess = mem.sessions.find(s => s.id === mem.active_session_id);
    if (sess) {
      sess.messages = [];
      sess.title = "新会话";
      await this.save(mem);
    }
  }
};

// ==========================================
// 3. Mini-Pi 工具集 (含 AI 生图与在线搜索)
// ==========================================
const tools = [
  {
    type: "function",
    function: {
      name: "generate_image",
      description: "根据英文或中文提示词通过 AI 生成精美静态图片并在聊天气泡中输出展示",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "图像生成的详细英文或中文提示词" },
          width: { type: "integer", description: "图片宽度，默认 768" },
          height: { type: "integer", description: "图片高度，默认 768" }
        },
        required: ["prompt"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "在互联网上实时搜索最新资讯、新闻、技术资料或专业解答",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词或查询短句" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_current_location",
      description: "获取用户当前设备 GPS 经纬度及反查城市地址，失败时自动平滑降级",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "search_city_coords",
      description: "查询城市或区县的经纬度坐标，内置高频预置，无需外部网络",
      parameters: {
        type: "object",
        properties: {
          city_name: { type: "string", description: "城市或区县名称，例如：成都、广州、东莞" }
        },
        required: ["city_name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_weather_by_coords",
      description: "根据经纬度或城市名查询实时天气（气温、体感、湿度、降水等），内置多通道防阻断容灾",
      parameters: {
        type: "object",
        properties: {
          latitude: { type: "number", description: "纬度" },
          longitude: { type: "number", description: "经度" },
          city_name: { type: "string", description: "城市或区县名称" }
        },
        required: ["latitude", "longitude"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "query_calendar",
      description: "查询用户手机系统日历中的日程事件",
      parameters: {
        type: "object",
        properties: {
          days_ahead: { type: "integer", description: "查询往后多少天，默认 1" }
        },
        required: ["days_ahead"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_reminder",
      description: "在 iOS 系统提醒事项中创建待办",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "待办事项标题" },
          due_date: { type: "string", description: "截止时间 ISO 8601 格式" },
          notes: { type: "string", description: "备注说明" }
        },
        required: ["title"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "open_app_or_url",
      description: "在 iPhone 上打开指定的 URL Scheme 或跳转 App",
      parameters: {
        type: "object",
        properties: {
          url_scheme: { type: "string", description: "要打开的 App 协议头或网址" }
        },
        required: ["url_scheme"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "save_memory",
      description: "将用户的重要习惯或偏好事实写入本地知识库",
      parameters: {
        type: "object",
        properties: {
          fact: { type: "string", description: "核心事实或偏好习惯" }
        },
        required: ["fact"]
      }
    }
  }
];

// ==========================================
// 4. 工具执行器 (Local Executor)
// ==========================================
async function executeLocalTool(name, args, onStatusUpdate = null) {
  console.log(`[Mini-Pi Action] 执行: ${name}`);
  if (onStatusUpdate) await onStatusUpdate(`调用技能: ${name}...`);

  try {
    if (name === "generate_image") {
      const prompt = encodeURIComponent(args.prompt || "cyberpunk city");
      const w = args.width || 768;
      const h = args.height || 768;
      const seed = Math.floor(Math.random() * 100000);
      const imageUrl = `https://image.pollinations.ai/prompt/${prompt}?width=${w}&height=${h}&seed=${seed}&nologo=true`;
      return {
        success: true,
        image_url: imageUrl,
        markdown: `![${args.prompt}](${imageUrl})`,
        message: "图片已成功生成，请直接在回复中以 Markdown 图片语法展示。"
      };
    }

    if (name === "web_search") {
      const query = (args.query || "").trim();
      const results = [];
      try {
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const req = new Request(searchUrl);
        req.timeoutInterval = 8;
        req.headers = {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
        };
        const html = await req.loadString();
        const regex = /<a class="result__snippet[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        while ((match = regex.exec(html)) !== null && results.length < 5) {
          const rawText = match[2].replace(/<[^>]+>/g, "").trim();
          if (rawText) results.push({ snippet: rawText });
        }
      } catch (e) {}

      if (results.length === 0) {
        try {
          const wikiUrl = `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json`;
          const wReq = new Request(wikiUrl);
          wReq.timeoutInterval = 6;
          const wData = await wReq.loadJSON();
          if (wData && wData.query && wData.query.search) {
            for (const item of wData.query.search.slice(0, 4)) {
              results.push({
                title: item.title,
                snippet: item.snippet.replace(/<[^>]+>/g, "").trim()
              });
            }
          }
        } catch (e) {}
      }
      return results.length > 0 ? { query, results } : { query, note: "未获取到外部搜索结果" };
    }

    if (name === "get_current_location") {
      const timeoutPromise = new Promise((_, reject) =>
        Timer.schedule(8000, false, () => reject(new Error("硬件GPS定位超时")))
      );
      try {
        const loc = await Promise.race([Location.current(), timeoutPromise]);
        let addressDesc = "当前位置";
        try {
          const geocode = await Location.reverseGeocode(loc.latitude, loc.longitude);
          if (geocode && geocode.length > 0) {
            const g = geocode[0];
            addressDesc = `${g.administrativeArea || ''}${g.locality || ''}${g.subLocality || ''}${g.thoroughfare || ''}`.trim();
          }
        } catch (e) {}
        return { latitude: loc.latitude, longitude: loc.longitude, address: addressDesc };
      } catch (err) {
        return { latitude: 39.90, longitude: 116.40, address: "北京市 (默认降级位置)" };
      }
    }

    if (name === "search_city_coords") {
      const cityMap = {
        "成都": { latitude: 30.57, longitude: 104.07, city_name: "成都市" },
        "武汉": { latitude: 30.59, longitude: 114.31, city_name: "武汉市" },
        "西安": { latitude: 34.34, longitude: 108.94, city_name: "西安市" },
        "东莞": { latitude: 23.02, longitude: 113.75, city_name: "东莞市" },
        "广州": { latitude: 23.13, longitude: 113.26, city_name: "广州市" },
        "深圳": { latitude: 22.54, longitude: 114.06, city_name: "深圳市" },
        "北京": { latitude: 39.90, longitude: 116.40, city_name: "北京市" },
        "上海": { latitude: 31.23, longitude: 121.47, city_name: "上海市" },
        "杭州": { latitude: 30.27, longitude: 120.15, city_name: "杭州市" }
      };
      const raw = (args.city_name || "").trim();
      for (const [k, v] of Object.entries(cityMap)) {
        if (raw.includes(k)) return v;
      }
      return { latitude: 39.90, longitude: 116.40, city_name: raw || "当前地区" };
    }

    if (name === "get_weather_by_coords") {
      const cityName = args.city_name || "当地";
      try {
        const wttrUrl = `https://wttr.in/${args.latitude},${args.longitude}?format=j1&lang=zh`;
        const reqWttr = new Request(wttrUrl);
        reqWttr.timeoutInterval = 8;
        reqWttr.headers = { "User-Agent": "curl/7.88.1" };
        const data = await reqWttr.loadJSON();
        const cur = data.current_condition[0];
        return {
          location: cityName,
          weather: cur.lang_zh ? cur.lang_zh[0].value : cur.weatherDesc[0].value,
          temperature: `${cur.temp_C} °C`,
          apparent_temperature: `${cur.FeelsLikeC} °C`,
          humidity: `${cur.humidity}%`,
          wind_speed: `${cur.windspeedKmph} km/h`,
          precipitation: `${cur.precipMM} mm`
        };
      } catch (e) {
        return { location: cityName, note: "接口受阻，已提供快捷跳转", suggest_url: "weather://" };
      }
    }

    if (name === "query_calendar") {
      const now = new Date();
      const end = new Date(now.getTime() + (args.days_ahead || 1) * 24 * 60 * 60 * 1000);
      const events = await CalendarEvent.between(now, end);
      return events.map(e => ({
        title: e.title,
        startDate: e.startDate ? e.startDate.toISOString() : null,
        endDate: e.endDate ? e.endDate.toISOString() : null,
        notes: e.notes
      }));
    }

    if (name === "create_reminder") {
      const reminder = new Reminder();
      reminder.title = args.title;
      const defaultCalendar = await Calendar.defaultForReminders();
      if (!defaultCalendar) throw new Error("未找到默认提醒事项列表");
      reminder.calendar = defaultCalendar;
      if (args.due_date) {
        const parsedDate = new Date(args.due_date);
        if (!isNaN(parsedDate.getTime())) reminder.dueDate = parsedDate;
      }
      if (args.notes) reminder.notes = args.notes;
      await reminder.save();
      return { success: true, message: `已成功创建提醒: ${args.title}` };
    }

    if (name === "open_app_or_url") {
      const targetUrl = args.url_scheme.trim();
      Safari.open(targetUrl);
      return { success: true, opened_url: targetUrl };
    }

    if (name === "save_memory") {
      await MemoryManager.appendFact(args.fact);
      return { success: true, message: `已写入知识库: "${args.fact}"` };
    }

    throw new Error(`未知工具: ${name}`);
  } catch (err) {
    return { error: err.toString() };
  }
}

// ==========================================
// 5. Mini-Pi Agentic 执行引擎 (状态机)
// ==========================================
async function callChatAPI(messages) {
  const req = new Request(API_URL);
  req.method = "POST";
  req.timeoutInterval = 120;
  req.headers = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Accept-Encoding": "identity",
    "Authorization": `Bearer ${API_KEY.trim()}`
  };

  req.body = JSON.stringify({
    model: MODEL,
    messages: messages,
    tools: tools,
    tool_choice: "auto"
  });

  const data = await req.load();
  const raw = data.toRawString();

  let resp;
  try {
    resp = JSON.parse(raw);
  } catch (e) {
    throw new Error(`API 解析失败: ${raw.slice(0, 100)}`);
  }

  if (resp.error) throw new Error(resp.error.message || JSON.stringify(resp.error));
  if (!resp.choices || resp.choices.length === 0) throw new Error("API 未返回有效 choices");

  return resp.choices[0].message;
}

async function runAgentTurn(prompt, imageBase64 = null, onStatusUpdate = null) {
  const nowStr = new Date().toISOString();
  const localMem = await MemoryManager.load();
  const currentSess = await MemoryManager.getActiveSession();

  const knownFacts = localMem.user_profile.facts.length > 0 
    ? localMem.user_profile.facts.join("\n- ") 
    : "暂无持久化事实";

  let userContent;
  if (imageBase64) {
    userContent = [
      { type: "text", text: prompt || "请分析这张图片：" },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
    ];
  } else {
    userContent = prompt;
  }

  const safeHistory = (currentSess.messages || [])
    .filter(h => (h.role === "user" || h.role === "assistant") && h.content)
    .map(h => ({
      role: h.role,
      content: typeof h.content === "string" ? h.content : JSON.stringify(h.content)
    }));

  let messages = [
    {
      role: "system",
      content: `你是一个运行在用户 iPhone 设备上的 Mini-Pi 极简自主 Agent。
【当前设备时间】：${nowStr}
【持久化事实知识库】：
- ${knownFacts}

【执行规范】：
1. 涉及"变换形态"、"机械动画"、"特效展示"等交互或动态视觉效果，严禁编造外部图片链接，必须直接输出带有 SMIL/CSS 动画的标准 <svg>...</svg> 矢量代码。
2. 只有明确要求静态写实摄影/插画时，才调用 generate_image 工具出图，拿到链接后以 Markdown 图片语法格式 (![描述](URL)) 嵌入回复。
3. 涉及当前实时热点、外部资讯时，优先调用 web_search 联网检索。
4. 调度天气、待办、日历等系统动作时优先调用对应工具。
5. 请以精炼、务实、结构化的中文回复。`
    },
    ...safeHistory,
    {
      role: "user",
      content: userContent
    }
  ];

  const MAX_STEPS = 8;
  let currentStep = 0;

  while (currentStep < MAX_STEPS) {
    currentStep++;
    if (onStatusUpdate) await onStatusUpdate(`第 ${currentStep} 轮自省推理中...`);

    const assistantMessage = await callChatAPI(messages);
    messages.push(assistantMessage);

    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      for (const call of assistantMessage.tool_calls) {
        let fnArgs = {};
        try {
          fnArgs = JSON.parse(call.function.arguments);
        } catch (e) {}

        const toolResult = await executeLocalTool(call.function.name, fnArgs, onStatusUpdate);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(toolResult)
        });
      }
    } else {
      const finalReply = assistantMessage.content || "(无返回内容)";
      await MemoryManager.appendTurn(prompt || "[图片指令]", finalReply);
      return finalReply;
    }
  }

  return "达到 Mini-Pi 最大自省步数限制。";
}
// ==========================================
// 6. Mini-Pi 气泡渲染与前端视图 (防破损图容错)
// ==========================================
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderBubbleContent(text) {
  if (!text) return "";

  // 1. 优先提取并直接渲染原生 SVG 矢量动画
  const svgMatch = text.match(/<svg[\s\S]*?<\/svg>/i);
  if (svgMatch) {
    const rawSvg = svgMatch[0];
    const nonSvgText = text.replace(rawSvg, "").trim();
    return `
      ${nonSvgText ? `<div style="margin-bottom:8px;">${escapeHtml(nonSvgText)}</div>` : ''}
      <div class="svg-container">${rawSvg}</div>
    `;
  }

  // 2. 优化 Markdown 图片渲染，防止蓝色问号破损图
  const mdImgRegex = /!\[([^\]]*)\]\((https?:\/\/[^\s\)]+)\)/g;
  let parsed = text;
  let hasImage = false;

  if (mdImgRegex.test(parsed)) {
    hasImage = true;
    parsed = parsed.replace(mdImgRegex, (match, alt, url) => {
      const cleanUrl = url.trim();
      return `
        <div class="image-bubble-card">
          <img src="${cleanUrl}" alt="${escapeHtml(alt)}" loading="lazy" 
               onclick="viewFullImage('${cleanUrl}')" 
               onload="window.scrollToBottom && window.scrollToBottom()" 
               onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='block';">
          <div class="image-fallback" style="display:none; padding:12px; text-align:center; color:var(--text-secondary); font-size:12px; background:rgba(0,0,0,0.03);">
            ⚠️ 图片加载受阻 (${escapeHtml(alt || '外部图片')})
          </div>
          ${alt ? `<div class="image-caption">${escapeHtml(alt)}</div>` : ''}
        </div>
      `;
    });
  }

  if (hasImage) {
    return parsed;
  }

  return escapeHtml(text);
}

function buildChatHTML(mem) {
  let activeSess = mem.sessions.find(s => s.id === mem.active_session_id) || mem.sessions[0];
  let bubbles = "";
  if (!activeSess.messages || activeSess.messages.length === 0) {
    bubbles = `
      <div class="msg-row msg-agent">
        <div class="bubble">已就绪。我是你的 Mini-Pi 本地自主 Agent，支持 AI 绘图、在线搜索、天气/日程、截图分析及 SVG 动态渲染。</div>
      </div>
    `;
  } else {
    for (const h of activeSess.messages) {
      const roleCls = h.role === "user" ? "msg-user" : "msg-agent";
      bubbles += `
        <div class="msg-row ${roleCls}">
          <div class="bubble">${renderBubbleContent(h.content)}</div>
        </div>
      `;
    }
  }

  let sessionListHtml = "";
  for (const s of mem.sessions) {
    const isCur = s.id === mem.active_session_id;
    const curCls = isCur ? "session-item active" : "session-item";
    sessionListHtml += `
      <div class="${curCls}" onclick="selectSession('${s.id}')">
        <div class="sess-title">${escapeHtml(s.title || "新会话")}</div>
        <div class="sess-del" onclick="event.stopPropagation(); deleteSession('${s.id}')">✕</div>
      </div>
    `;
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<style>
  :root {
    --bg-color: #f2f2f7;
    --card-bg: #ffffff;
    --user-bubble: #007aff;
    --agent-bubble: #e5e5ea;
    --text-primary: #000000;
    --text-secondary: #8e8e93;
    --drawer-bg: #ffffff;
    --item-active: #e3effd;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg-color: #000000;
      --card-bg: #1c1c1e;
      --user-bubble: #0a84ff;
      --agent-bubble: #2c2c2e;
      --text-primary: #ffffff;
      --text-secondary: #8e8e93;
      --drawer-bg: #1c1c1e;
      --item-active: #1e3a5f;
    }
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    margin: 0; padding: 0;
    background-color: var(--bg-color);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
    color: var(--text-primary);
    display: flex; flex-direction: column; height: 100vh; overflow: hidden;
    position: relative;
  }
  header {
    padding: calc(env(safe-area-inset-top) + 12px) 16px 12px 16px;
    background: var(--card-bg);
    border-bottom: 0.5px solid rgba(0,0,0,0.1);
    display: flex; justify-content: space-between; align-items: center;
    font-weight: 600; font-size: 17px; z-index: 10;
  }
  .header-actions { display: flex; gap: 8px; align-items: center; }
  .header-btn {
    font-size: 14px; color: var(--user-bubble); background: none; border: none; padding: 4px 6px;
  }
  #chat-container {
    flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px;
  }
  .msg-row { display: flex; flex-direction: column; max-width: 86%; }
  .msg-user { align-self: flex-end; align-items: flex-end; }
  .msg-agent { align-self: flex-start; align-items: flex-start; }
  .bubble {
    padding: 10px 14px; border-radius: 18px; font-size: 15px; line-height: 1.45; word-break: break-word; white-space: pre-wrap;
  }
  .msg-user .bubble { background-color: var(--user-bubble); color: #ffffff; border-bottom-right-radius: 4px; }
  .msg-agent .bubble { background-color: var(--agent-bubble); color: var(--text-primary); border-bottom-left-radius: 4px; }
  
  .image-bubble-card {
    margin-top: 6px; border-radius: 12px; overflow: hidden; background: rgba(0,0,0,0.04);
    box-shadow: 0 2px 8px rgba(0,0,0,0.08); display: flex; flex-direction: column;
  }
  .image-bubble-card img {
    width: 100%; max-height: 280px; object-fit: cover; display: block; cursor: pointer; border-radius: 12px;
  }
  .image-caption {
    font-size: 12px; color: var(--text-secondary); padding: 4px 8px; text-align: center;
  }

  .svg-container {
    background: #ffffff; padding: 8px; border-radius: 12px; display: flex; justify-content: center; align-items: center;
    box-shadow: 0 1px 4px rgba(0,0,0,0.06); max-width: 100%; overflow: hidden;
  }
  .svg-container svg { max-width: 100%; height: auto; display: block; }
  .status-indicator { font-size: 12px; color: var(--text-secondary); margin-top: 4px; padding: 0 4px; }
  footer {
    padding: 10px 12px calc(env(safe-area-inset-bottom) + 8px) 12px;
    background: var(--card-bg);
    border-top: 0.5px solid rgba(0,0,0,0.1);
    display: flex; gap: 8px; align-items: center; z-index: 10;
  }
  .icon-btn {
    width: 36px; height: 36px; border-radius: 50%; border: none;
    background: var(--agent-bubble); font-size: 18px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  #input-box {
    flex: 1; height: 38px; border-radius: 19px; border: 1px solid rgba(120,120,128,0.2);
    padding: 0 16px; font-size: 15px; background: var(--bg-color); color: var(--text-primary); outline: none;
  }
  #send-btn {
    width: 38px; height: 38px; border-radius: 50%; border: none;
    background: var(--user-bubble); color: #ffffff; font-weight: 600; display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }

  #drawer-mask {
    position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 90;
    display: none; opacity: 0; transition: opacity 0.25s ease;
  }
  .drawer {
    position: fixed; top: 0; bottom: 0; width: 310px;
    background: var(--drawer-bg); z-index: 100;
    transition: transform 0.25s ease;
    display: flex; flex-direction: column;
    padding-top: env(safe-area-inset-top);
    box-shadow: 2px 0 14px rgba(0,0,0,0.18);
  }
  #history-drawer { left: -310px; }
  .drawer-header {
    padding: 14px 16px; display: flex; justify-content: space-between; align-items: center;
    border-bottom: 0.5px solid rgba(0,0,0,0.1); font-weight: 600;
  }
  .action-btn {
    background: var(--user-bubble); color: #fff; border: none; border-radius: 14px;
    padding: 6px 12px; font-size: 13px; font-weight: 500;
  }
  .drawer-list {
    flex: 1; overflow-y: auto; padding: 10px 14px; display: flex; flex-direction: column; gap: 8px;
  }
  .session-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 12px; border-radius: 10px; font-size: 14px; cursor: pointer;
  }
  .session-item.active { background: var(--item-active); font-weight: 600; }
  .sess-title { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-right: 8px; }
  .sess-del { color: var(--text-secondary); font-size: 13px; padding: 4px; }

  #image-viewer-mask {
    position: fixed; inset: 0; background: rgba(0,0,0,0.92); z-index: 300;
    display: none; align-items: center; justify-content: center; padding: 12px;
  }
  #image-viewer-mask img {
    max-width: 100%; max-height: 85vh; border-radius: 8px; object-fit: contain;
  }
</style>
</head>
<body>

<div id="drawer-mask" onclick="closeAllDrawers()"></div>

<div id="image-viewer-mask" onclick="this.style.display='none'">
  <img id="image-viewer-target" src="" alt="预览">
</div>

<div id="history-drawer" class="drawer">
  <div class="drawer-header">
    <span>历史分支</span>
    <button class="action-btn" onclick="postAction('new_session')">+ 新会话</button>
  </div>
  <div id="session-list" class="drawer-list">
    ${sessionListHtml}
  </div>
</div>

<header>
  <button class="header-btn" onclick="openHistoryDrawer()">☰ 历史</button>
  <span id="header-title">${escapeHtml(activeSess.title || "Mini-Pi Agent")}</span>
  <div class="header-actions">
    <button class="header-btn" onclick="postAction('clear')">清空</button>
  </div>
</header>

<div id="chat-container">
  ${bubbles}
</div>

<footer>
  <button class="icon-btn" onclick="postAction('photo')">📷</button>
  <input type="text" id="input-box" placeholder="画一张图、查天气、搜资讯、写待办..." onkeydown="if(event.key==='Enter') send()">
  <button id="send-btn" onclick="send()">↑</button>
</footer>

<script>
  window.__events = [];
  const container = document.getElementById("chat-container");
  const inputBox = document.getElementById("input-box");
  const historyDrawer = document.getElementById("history-drawer");
  const mask = document.getElementById("drawer-mask");

  function scrollToBottom() {
    container.scrollTop = container.scrollHeight;
  }

  function openHistoryDrawer() {
    mask.style.display = "block";
    setTimeout(() => {
      mask.style.opacity = "1";
      historyDrawer.style.transform = "translateX(310px)";
    }, 10);
  }

  function closeAllDrawers() {
    mask.style.opacity = "0";
    historyDrawer.style.transform = "translateX(0)";
    setTimeout(() => {
      mask.style.display = "none";
    }, 250);
  }

  function viewFullImage(src) {
    const vMask = document.getElementById("image-viewer-mask");
    const vImg = document.getElementById("image-viewer-target");
    vImg.src = src;
    vMask.style.display = "flex";
  }

  function selectSession(id) {
    closeAllDrawers();
    postAction('switch_session', id);
  }

  function deleteSession(id) {
    postAction('delete_session', id);
  }

  function appendBubble(role, rawContent) {
    const row = document.createElement("div");
    row.className = "msg-row msg-" + role;
    const b = document.createElement("div");
    b.className = "bubble";
    
    // 1. 判断 SVG
    const svgMatch = rawContent.match(/<svg[\\s\\S]*?<\\/svg>/i);
    if (svgMatch) {
      const rawSvg = svgMatch[0];
      const nonSvgText = rawContent.replace(rawSvg, "").trim();
      if (nonSvgText) {
        const textNode = document.createElement("div");
        textNode.style.marginBottom = "8px";
        textNode.textContent = nonSvgText;
        b.appendChild(textNode);
      }
      const svgBox = document.createElement("div");
      svgBox.className = "svg-container";
      svgBox.innerHTML = rawSvg;
      b.appendChild(svgBox);
    } else {
      // 2. 判断并渲染 Markdown 图片（防破损图容错）
      const mdImgRegex = /!\\[([^\\]]*)\\]\\((https?:\\/\\/[^\\s\\)]+)\\)/g;
      if (mdImgRegex.test(rawContent)) {
        b.innerHTML = rawContent.replace(mdImgRegex, (m, alt, url) => {
          const cleanUrl = url.trim();
          return '<div class="image-bubble-card">' +
            '<img src="' + cleanUrl + '" alt="' + (alt || '') + '" loading="lazy" onclick="viewFullImage(\\'' + cleanUrl + '\\')" onload="scrollToBottom()" onerror="this.style.display=\\'none\\'; if(this.nextElementSibling) this.nextElementSibling.style.display=\\'block\\';">' +
            '<div class="image-fallback" style="display:none; padding:12px; text-align:center; color:var(--text-secondary); font-size:12px; background:rgba(0,0,0,0.03);">⚠️ 图片加载受阻 (' + (alt || '外部图片') + ')</div>' +
            (alt ? '<div class="image-caption">' + alt + '</div>' : '') +
          '</div>';
        });
      } else {
        b.textContent = rawContent;
      }
    }

    row.appendChild(b);
    container.appendChild(row);
    scrollToBottom();
  }

  function setStatus(text) {
    let s = document.getElementById("active-status");
    if (!s && text) {
      s = document.createElement("div");
      s.id = "active-status";
      s.className = "status-indicator";
      container.appendChild(s);
    }
    if (s) {
      if (!text) s.remove();
      else s.textContent = text;
    }
    scrollToBottom();
  }

  function postAction(type, data = null) {
    window.__events.push({ type: type, data: data });
  }

  function send() {
    const val = inputBox.value.trim();
    if (!val) return;
    inputBox.value = "";
    appendBubble("user", val);
    setStatus("Mini-Pi 思考中...");
    postAction("text", val);
  }

  window.onload = function() {
    scrollToBottom();
  };
</script>
</body>
</html>`;
}

// ==========================================
// 7. 双模态分流引擎 (支持截图入参与活跃会话追加)
// ==========================================
async function main() {
  let externalPrompt = null;
  let externalImageBase64 = null;

  // 1. 读取快捷指令或系统共享传入的纯文本
  if (args.shortcutParameter && typeof args.shortcutParameter === "string") {
    externalPrompt = args.shortcutParameter.trim();
  } else if (args.plainText) {
    externalPrompt = args.plainText.trim();
  } else if (args.texts && args.texts.length > 0) {
    externalPrompt = args.texts[0].trim();
  }

  // 2. 读取快捷指令或共享表单传入的截图/图像文件
  if (args.images && args.images.length > 0) {
    const rawImg = args.images[0];
    const jpegData = Data.fromJPEG(rawImg, 0.6);
    externalImageBase64 = jpegData.toBase64String();
  }

  // 模式 A：由快捷指令/外部传入触发（截图或文本，保持追加至当前活跃会话）
  if (externalPrompt || externalImageBase64) {
    const promptText = externalPrompt || "请分析这张当前屏幕截图的内容，提取关键信息并给出建议：";
    let reply = "";
    try {
      reply = await runAgentTurn(promptText, externalImageBase64);
    } catch (e) {
      reply = `执行报错: ${e.message || e.toString()}`;
    }

    const alert = new Alert();
    alert.title = externalImageBase64 ? "Mini-Pi 截图已分析" : "Mini-Pi 已处理";
    alert.message = reply;
    alert.addAction("好的");

    if (config.runsInShortcut) {
      Script.setShortcutOutput(reply);
    }

    await alert.present();
    Script.complete();
    return;
  }

  // 模式 B：手动点击打开全屏视图
  const mem = await MemoryManager.load();
  const webView = new WebView();
  await webView.loadHTML(buildChatHTML(mem));

  let isWindowClosed = false;
  const presentPromise = webView.present(true).then(() => {
    isWindowClosed = true;
  });

  while (!isWindowClosed) {
    await Promise.race([
      new Promise(r => Timer.schedule(250, false, r)),
      presentPromise
    ]);

    if (isWindowClosed) break;

    let eventRaw = "";
    try {
      eventRaw = await webView.evaluateJavaScript(`
        (function() {
          if (!window.__events || window.__events.length === 0) return "";
          return JSON.stringify(window.__events.shift());
        })()
      `);
    } catch (e) {
      break;
    }

    if (!eventRaw) continue;

    const ev = JSON.parse(eventRaw);

    if (ev.type === "new_session") {
      await MemoryManager.createNewSession();
      const uMem = await MemoryManager.load();
      await webView.loadHTML(buildChatHTML(uMem));
      continue;
    }

    if (ev.type === "switch_session") {
      await MemoryManager.switchSession(ev.data);
      const uMem = await MemoryManager.load();
      await webView.loadHTML(buildChatHTML(uMem));
      continue;
    }

    if (ev.type === "delete_session") {
      await MemoryManager.deleteSession(ev.data);
      const uMem = await MemoryManager.load();
      await webView.loadHTML(buildChatHTML(uMem));
      continue;
    }

    if (ev.type === "clear") {
      await MemoryManager.clearCurrentSession();
      try {
        await webView.evaluateJavaScript(`
          document.getElementById("chat-container").innerHTML = '<div class="msg-row msg-agent"><div class="bubble">已清空当前会话记忆。</div></div>';
        `);
      } catch (e) {}
      continue;
    }

    if (ev.type === "text") {
      try {
        const reply = await runAgentTurn(ev.data, null, async (st) => {
          if (!isWindowClosed) {
            try {
              await webView.evaluateJavaScript(`setStatus(${JSON.stringify(st)})`);
            } catch (e) {}
          }
        });
        if (!isWindowClosed) {
          await webView.evaluateJavaScript(`
            setStatus("");
            appendBubble("agent", ${JSON.stringify(reply)});
          `);
        }
      } catch (err) {
        if (!isWindowClosed) {
          await webView.evaluateJavaScript(`
            setStatus("");
            appendBubble("agent", ${JSON.stringify("报错: " + (err.message || err.toString()))});
          `);
        }
      }
    }

    if (ev.type === "photo") {
      try {
        const photo = await Photos.fromLibrary();
        if (!photo) {
          if (!isWindowClosed) await webView.evaluateJavaScript(`setStatus("");`);
          continue;
        }
        if (!isWindowClosed) {
          await webView.evaluateJavaScript(`
            appendBubble("user", "[发送了照片]");
            setStatus("正在分析照片...");
          `);
        }
        const jpegData = Data.fromJPEG(photo, 0.6);
        const base64 = jpegData.toBase64String();
        const reply = await runAgentTurn("请分析这张照片", base64, async (st) => {
          if (!isWindowClosed) {
            try {
              await webView.evaluateJavaScript(`setStatus(${JSON.stringify(st)})`);
            } catch (e) {}
          }
        });
        if (!isWindowClosed) {
          await webView.evaluateJavaScript(`
            setStatus("");
            appendBubble("agent", ${JSON.stringify(reply)});
          `);
        }
      } catch (e) {
        if (!isWindowClosed) {
          await webView.evaluateJavaScript(`
            setStatus("");
            appendBubble("agent", "照片读取失败或已取消。");
          `);
        }
      }
    }
  }

  Script.complete();
}

await main();
