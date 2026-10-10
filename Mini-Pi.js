// ============================================================
// Mini-Pi v2.1 — iPhone 上的极简本地自主 Agent
// 运行环境:Scriptable / aBuddy 等 iOS JS 运行时
//
// v2.1 修复(会话隔离与数据安全):
//  1. 会话 ID 加入随机后缀:同一毫秒创建两个会话不再撞 ID
//     (撞 ID 会让抽屉里两条记录指向同一会话,表现为"历史相同")
//  2. 历史数据自愈:加载时自动为重复/缺失的 ID 重新分配
//  3. 保存时合并磁盘数据 + 写入串行化:多实例/多设备并发不再互相覆盖
//  4. 重载界面前保留未处理事件:快速连点不再丢操作
//  5. 抽屉显示每个会话的对话条数与更新时间,便于分辨
//  6. 主循环容错:瞬时 JS 错误不再直接关闭界面
//
// v2.0 优化(相对 v1):
//  1. 新增 create_calendar_event 工具(补齐 README 承诺的"读写日历")
//  2. web_search 三通道容灾(DDG HTML → 中文维基 → DDG Instant Answer)
//  3. 天气工具支持"城市名直查",定位降级坐标可配置
//  4. API 调用失败自动重试 + HTTP 状态码报错 + token 用量统计(/usage)
//  5. 摘要式会话压缩(超长对话自动摘要,替代硬截断)
//  6. 多模型切换(/model 或标题栏模型按钮)
//  7. Skills 技能系统(pi-skills 目录下的 SKILL.md)
//  8. 会话导入/导出(/export /import)+ 命令面板(/help)
//  9. 渲染安全加固:文本转义、SVG 清洗、图片 URL 白名单
// ============================================================

// ==========================================
// 1. 配置区
// ==========================================
const API_URL = "https://api.openai.com/v1/chat/completions"; // 替换为你的 OpenAI 兼容端点
const API_KEY = "xxxxxx";                                      // 替换为你的 API Key
const MODEL   = "mimo-v2.6-flash";                             // 需支持 function calling 与视觉

// 多模型切换(可选):留空数组时自动使用上面三个常量。
// 追加条目后,聊天界面标题栏的"模型"按钮与 /model 命令可随时切换:
const MODELS = [
  // { id: "fast",  label: "快速模型", url: "https://.../v1/chat/completions", key: "...", model: "..." },
  // { id: "smart", label: "强力模型", url: "https://.../v1/chat/completions", key: "...", model: "..." },
];

// 定位失败时的默认降级位置(可按需改为你的常驻地)
const DEFAULT_LOCATION = { latitude: 39.9042, longitude: 116.4074, address: "北京市 (默认降级位置)" };

// Agentic 循环与记忆参数
const MAX_STEPS       = 8;    // 单次任务最大工具调用轮数
const HISTORY_TURNS   = 12;   // 会话兜底保留的最大轮数(1 轮 = 1 问 1 答)
const SUMMARY_TRIGGER = 16;   // 会话消息数超过该值触发摘要压缩
const REQUEST_TIMEOUT = 120;  // API 请求超时(秒)

// 技能目录:位于 iCloud 文档目录下,放入 .md 文件即被自动发现
const SKILLS_DIR = "pi-skills";

// ==========================================
// 2. 持久化记忆与多会话树 (iCloud 同步)
// ==========================================
const MEM_FM = FileManager.iCloud() || FileManager.local();

function jsLiteral(v) {
  // 把任意值安全地内嵌进 evaluateJavaScript 的代码字符串
  return JSON.stringify(v).replace(/</g, "\\u003c");
}

// 会话 ID 生成:毫秒时间戳 + 随机后缀,避免同一毫秒内创建两个会话时 ID 撞车
// (撞车会导致抽屉里出现两条记录指向同一个会话,看起来"历史相同")
function newSessionId(takenIds) {
  const taken = takenIds instanceof Set ? takenIds : new Set(takenIds || []);
  let id;
  do {
    id = "sess_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
  } while (taken.has(id));
  return id;
}

// 历史数据自愈:为重复/缺失的 ID 重新分配,保留各自的独立消息
function repairDuplicateIds(sessions) {
  const seen = new Set();
  const allIds = new Set();
  for (const s of sessions) {
    if (s && typeof s === "object" && s.id) allIds.add(s.id);
  }
  let changed = false;
  for (const s of sessions) {
    if (!s || typeof s !== "object") continue;
    if (!s.id || seen.has(s.id)) {
      const taken = new Set([...seen, ...allIds]);
      s.id = newSessionId(taken);
      allIds.add(s.id);
      changed = true;
    }
    seen.add(s.id);
  }
  return changed;
}

// 保存时合并磁盘数据:内存里没有、但磁盘上更新的会话(其他实例/其他设备创建的)予以保留
function mergeSessions(memSessions, diskSessions, lastLoadAt) {
  const merged = memSessions.slice();
  const pos = new Map();
  merged.forEach((s, i) => pos.set(s.id, i));
  for (const ds of diskSessions || []) {
    if (!ds || !ds.id) continue;
    if (!pos.has(ds.id)) {
      // 内存中不存在:比本次加载更新 = 别处新建的,保留;更旧 = 本实例已删除,丢弃
      const ts = Date.parse(ds.updated_at || ds.created_at || "") || 0;
      if (ts > lastLoadAt) {
        merged.unshift(ds);
        merged.forEach((s, i) => pos.set(s.id, i));
      }
      continue;
    }
    // 两边都有:取更新时间较新的版本
    const idx = pos.get(ds.id);
    const memTs = Date.parse(merged[idx].updated_at || merged[idx].created_at || "") || 0;
    const diskTs = Date.parse(ds.updated_at || ds.created_at || "") || 0;
    if (diskTs > memTs) merged[idx] = ds;
  }
  return merged;
}

function formatShortTime(iso) {
  const t = Date.parse(iso || "");
  if (!t) return "";
  const d = new Date(t);
  const now = new Date();
  const pad = n => (n < 10 ? "0" + n : String(n));
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  return sameDay ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
                 : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const MemoryManager = {
  fm: MEM_FM,

  memoryPath() {
    return this.fm.joinPath(this.fm.documentsDirectory(), "agent_memory.json");
  },

  async load() {
    this._lastLoadAt = Date.now();
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
          const initId = newSessionId();
          const nowIso = new Date().toISOString();
          data.sessions = [{ id: initId, title: "新会话", created_at: nowIso, updated_at: nowIso, messages: [] }];
          data.active_session_id = initId;
        }
        if (!data.user_profile) data.user_profile = { facts: [] };
        if (!data.usage) data.usage = { global: { prompt: 0, completion: 0 }, by_session: {} };
        if (!data.settings) data.settings = {};
        // 自愈历史数据:修复重复/缺失的会话 ID(否则两条记录会指向同一份历史)
        if (repairDuplicateIds(data.sessions)) {
          try {
            this.fm.writeString(path, JSON.stringify(data, null, 2));
          } catch (e) {}
        }
        return data;
      } catch (e) {}
    }
    const initId = newSessionId();
    const nowIso = new Date().toISOString();
    return {
      user_profile: { facts: [] },
      active_session_id: initId,
      settings: {},
      usage: { global: { prompt: 0, completion: 0 }, by_session: {} },
      sessions: [
        { id: initId, title: "新会话", created_at: nowIso, updated_at: nowIso, messages: [] }
      ]
    };
  },

  // 写入串行化 + 合并磁盘上的新数据,避免两个实例/两台设备互相覆盖
  async save(data) {
    const doWrite = async () => {
      try {
        const path = this.memoryPath();
        if (this.fm.fileExists(path) && this._lastLoadAt) {
          const diskData = JSON.parse(this.fm.readString(path));
          if (diskData && Array.isArray(diskData.sessions)) {
            data.sessions = mergeSessions(data.sessions || [], diskData.sessions, this._lastLoadAt);
          }
          // 用量取较大值:既不丢失别处的计数,也不会因重复保存而翻倍
          if (diskData && diskData.usage && data.usage) {
            const dg = diskData.usage.global || { prompt: 0, completion: 0 };
            data.usage.global = data.usage.global || { prompt: 0, completion: 0 };
            data.usage.global.prompt = Math.max(data.usage.global.prompt || 0, dg.prompt || 0);
            data.usage.global.completion = Math.max(data.usage.global.completion || 0, dg.completion || 0);
          }
        }
      } catch (e) {}
      this.fm.writeString(this.memoryPath(), JSON.stringify(data, null, 2));
    };
    this._saveChain = (this._saveChain || Promise.resolve()).then(doWrite, doWrite);
    return this._saveChain;
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
    const nowIso = new Date().toISOString();
    const newId = newSessionId(new Set(mem.sessions.map(s => s.id)));
    const newSession = {
      id: newId,
      title: "新会话",
      created_at: nowIso,
      updated_at: nowIso,
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
      const nowIso = new Date().toISOString();
      const newId = newSessionId();
      mem.sessions = [{ id: newId, title: "新会话", created_at: nowIso, updated_at: nowIso, messages: [] }];
      mem.active_session_id = newId;
    } else if (mem.active_session_id === sessionId) {
      mem.active_session_id = mem.sessions[0].id;
    }
    await this.save(mem);
  },

  async appendTurn(userPrompt, assistantReply) {
    const mem = await this.load();
    let sess = mem.sessions.find(s => s.id === mem.active_session_id);
    if (!sess) {
      const nowIso = new Date().toISOString();
      const newId = newSessionId(new Set(mem.sessions.map(s => s.id)));
      sess = { id: newId, title: "新会话", created_at: nowIso, updated_at: nowIso, messages: [] };
      mem.sessions.unshift(sess);
      mem.active_session_id = newId;
    }

    if (sess.messages.length === 0 || sess.title === "新会话") {
      sess.title = String(userPrompt).trim().slice(0, 16) || "新会话";
    }

    sess.messages.push({ role: "user", content: String(userPrompt) });
    sess.messages.push({ role: "assistant", content: String(assistantReply) });
    sess.updated_at = new Date().toISOString();

    // 兜底截断(正常情况下已由摘要压缩处理,见 compactIfNeeded)
    const cap = HISTORY_TURNS * 2;
    if (sess.messages.length > cap) {
      sess.messages = sess.messages.slice(-cap);
    }
    await this.save(mem);
  },

  async clearCurrentSession() {
    const mem = await this.load();
    let sess = mem.sessions.find(s => s.id === mem.active_session_id);
    if (sess) {
      sess.messages = [];
      sess.title = "新会话";
      sess.updated_at = new Date().toISOString();
      delete sess.summary;
      await this.save(mem);
    }
  },

  async addUsage(sessionId, usage) {
    if (!usage) return;
    const mem = await this.load();
    mem.usage = mem.usage || { global: { prompt: 0, completion: 0 }, by_session: {} };
    mem.usage.global = mem.usage.global || { prompt: 0, completion: 0 };
    mem.usage.by_session = mem.usage.by_session || {};
    const bs = mem.usage.by_session[sessionId] || { prompt: 0, completion: 0 };
    bs.prompt += usage.prompt || 0;
    bs.completion += usage.completion || 0;
    mem.usage.by_session[sessionId] = bs;
    mem.usage.global.prompt += usage.prompt || 0;
    mem.usage.global.completion += usage.completion || 0;
    await this.save(mem);
  },

  async setModel(modelId) {
    const mem = await this.load();
    mem.settings = mem.settings || {};
    mem.settings.model_id = modelId;
    await this.save(mem);
  },

  async setActiveSkill(skillName) {
    const mem = await this.load();
    mem.settings = mem.settings || {};
    if (skillName) mem.settings.active_skill = skillName;
    else delete mem.settings.active_skill;
    await this.save(mem);
  },

  async exportSession(sessionId) {
    const mem = await this.load();
    const sess = mem.sessions.find(s => s.id === sessionId) || mem.sessions[0];
    const payload = {
      app: "Mini-Pi",
      version: 2,
      exported_at: new Date().toISOString(),
      session: {
        title: sess.title,
        summary: sess.summary || "",
        messages: sess.messages || []
      }
    };
    const text = JSON.stringify(payload, null, 2);
    const fname = "mini-pi-export-" + (sess.id || Date.now()) + ".json";
    const path = this.fm.joinPath(this.fm.documentsDirectory(), fname);
    this.fm.writeString(path, text);
    Pasteboard.copyString(text);
    return { path, fname, turns: Math.floor((sess.messages || []).length / 2) };
  },

  async importSession(jsonText) {
    let payload;
    try {
      payload = JSON.parse(jsonText);
    } catch (e) {
      throw new Error("剪贴板内容不是有效 JSON");
    }
    const sess = (payload && payload.session) || (payload && payload.sessions && payload.sessions[0]) || payload;
    if (!sess || !Array.isArray(sess.messages)) {
      throw new Error("JSON 中没有可导入的会话(messages 缺失)");
    }
    const mem = await this.load();
    const nowIso = new Date().toISOString();
    const newId = newSessionId(new Set(mem.sessions.map(s => s.id)));
    const copy = {
      id: newId,
      title: sess.title || "导入会话",
      created_at: nowIso,
      updated_at: nowIso,
      summary: sess.summary || "",
      messages: sess.messages.slice(-HISTORY_TURNS * 2)
    };
    mem.sessions.unshift(copy);
    mem.active_session_id = newId;
    await this.save(mem);
    return copy;
  }
};

// ==========================================
// 3. Skills 技能系统 (pi-skills 目录)
// ==========================================
function parseSkill(raw) {
  const text = String(raw || "");
  const nameM = text.match(/^name:\s*(.+)$/m);
  const descM = text.match(/^description:\s*(.+)$/m);
  const body = text.replace(/^---[\s\S]*?---\s*/, "").trim();
  return {
    name: (nameM ? nameM[1] : "未命名技能").trim(),
    description: (descM ? descM[1] : (body.slice(0, 80) || "无描述")).trim(),
    content: body || text.trim()
  };
}

const SkillsManager = {
  skillsDir() {
    return MemoryManager.fm.joinPath(MemoryManager.fm.documentsDirectory(), SKILLS_DIR);
  },

  async listSkills() {
    const out = [];
    try {
      const dir = this.skillsDir();
      if (!MemoryManager.fm.fileExists(dir)) return out;
      const names = MemoryManager.fm.listContents(dir);
      for (const n of names) {
        const name = String(n);
        if (!name.toLowerCase().endsWith(".md")) continue;
        const p = MemoryManager.fm.joinPath(dir, name);
        const raw = MemoryManager.fm.readString(p);
        const meta = parseSkill(raw);
        out.push({ file: name, name: meta.name, description: meta.description, content: meta.content });
      }
    } catch (e) {}
    return out;
  },

  async loadSkill(skillName) {
    const list = await this.listSkills();
    const target = String(skillName || "").trim().toLowerCase();
    return list.find(s =>
      s.name.toLowerCase() === target ||
      s.name.toLowerCase().includes(target) ||
      s.file.toLowerCase().replace(/\.md$/, "") === target
    ) || null;
  }
};

// ==========================================
// 4. 工具集定义 (10 个本地工具)
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
      description: "在互联网上实时搜索最新资讯、新闻、技术资料或专业解答，多通道容灾",
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
      description: "查询实时天气（气温、体感、湿度、降水等）。提供经纬度或城市名之一即可，两者都缺省时使用默认位置",
      parameters: {
        type: "object",
        properties: {
          latitude: { type: "number", description: "纬度（可选，与城市名二选一）" },
          longitude: { type: "number", description: "经度（可选，与城市名二选一）" },
          city_name: { type: "string", description: "城市或区县名称（可选，与经纬度二选一）" }
        },
        required: []
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
      name: "create_calendar_event",
      description: "在 iOS 系统日历中创建日程事件",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "事件标题" },
          start_date: { type: "string", description: "开始时间，ISO 8601 格式" },
          end_date: { type: "string", description: "结束时间，ISO 8601 格式，默认开始后 1 小时" },
          location: { type: "string", description: "地点（可选）" },
          notes: { type: "string", description: "备注（可选）" },
          all_day: { type: "boolean", description: "是否全天事件，默认 false" }
        },
        required: ["title", "start_date"]
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
// 5. 工具执行器 (Local Executor)
// ==========================================
function stripHtml(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .trim();
}

const CITY_MAP = {
  "成都": { latitude: 30.57, longitude: 104.07, city_name: "成都市" },
  "武汉": { latitude: 30.59, longitude: 114.31, city_name: "武汉市" },
  "西安": { latitude: 34.34, longitude: 108.94, city_name: "西安市" },
  "东莞": { latitude: 23.02, longitude: 113.75, city_name: "东莞市" },
  "广州": { latitude: 23.13, longitude: 113.26, city_name: "广州市" },
  "深圳": { latitude: 22.54, longitude: 114.06, city_name: "深圳市" },
  "北京": { latitude: 39.90, longitude: 116.40, city_name: "北京市" },
  "上海": { latitude: 31.23, longitude: 121.47, city_name: "上海市" },
  "杭州": { latitude: 30.27, longitude: 120.15, city_name: "杭州市" },
  "南京": { latitude: 32.06, longitude: 118.80, city_name: "南京市" },
  "重庆": { latitude: 29.56, longitude: 106.55, city_name: "重庆市" },
  "苏州": { latitude: 31.30, longitude: 120.62, city_name: "苏州市" },
  "天津": { latitude: 39.08, longitude: 117.20, city_name: "天津市" },
  "长沙": { latitude: 28.23, longitude: 112.94, city_name: "长沙市" }
};

function coordsForCity(name) {
  const raw = String(name || "").trim();
  if (!raw) return null;
  for (const k of Object.keys(CITY_MAP)) {
    if (raw.includes(k)) return CITY_MAP[k];
  }
  return null;
}

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

      // 通道 1: DuckDuckGo HTML(标题 + 链接 + 摘要,分别匹配两类节点)
      try {
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const req = new Request(searchUrl);
        req.timeoutInterval = 8;
        req.headers = {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
        };
        const html = await req.loadString();
        const titleRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
        const titles = [];
        const snippets = [];
        let m;
        while ((m = titleRe.exec(html)) !== null && titles.length < 5) {
          titles.push({ title: stripHtml(m[2]), url: m[1] });
        }
        while ((m = snipRe.exec(html)) !== null && snippets.length < 5) {
          const s = stripHtml(m[1]);
          if (s) snippets.push(s);
        }
        for (let i = 0; i < Math.min(titles.length, snippets.length); i++) {
          results.push({ title: titles[i].title, url: titles[i].url, snippet: snippets[i] });
        }
        if (results.length === 0 && snippets.length > 0) {
          for (const s of snippets) results.push({ snippet: s });
        }
      } catch (e) {}

      // 通道 2: 中文维基 API
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
                snippet: stripHtml(item.snippet)
              });
            }
          }
        } catch (e) {}
      }

      // 通道 3: DuckDuckGo Instant Answer API
      if (results.length === 0) {
        try {
          const iaReq = new Request(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
          iaReq.timeoutInterval = 6;
          const ia = await iaReq.loadJSON();
          if (ia && ia.AbstractText) {
            results.push({ title: ia.Heading || "摘要", snippet: ia.AbstractText, url: ia.AbstractURL || "" });
          }
          if (results.length === 0 && ia && ia.RelatedTopics && ia.RelatedTopics.length) {
            for (const t of ia.RelatedTopics.slice(0, 3)) {
              if (t && t.Text) results.push({ snippet: t.Text });
            }
          }
        } catch (e) {}
      }

      return results.length > 0
        ? { query, results }
        : { query, note: "未获取到外部搜索结果，建议换更短的关键词重试。" };
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
        return {
          latitude: DEFAULT_LOCATION.latitude,
          longitude: DEFAULT_LOCATION.longitude,
          address: DEFAULT_LOCATION.address
        };
      }
    }

    if (name === "search_city_coords") {
      const raw = (args.city_name || "").trim();
      const hit = coordsForCity(raw);
      return hit || {
        latitude: DEFAULT_LOCATION.latitude,
        longitude: DEFAULT_LOCATION.longitude,
        city_name: raw || DEFAULT_LOCATION.address
      };
    }

    if (name === "get_weather_by_coords") {
      let lat = args.latitude;
      let lon = args.longitude;
      const cityName = args.city_name || "";
      if (typeof lat !== "number" || typeof lon !== "number" || isNaN(lat) || isNaN(lon)) {
        const hit = cityName ? coordsForCity(cityName) : null;
        if (hit) {
          lat = hit.latitude;
          lon = hit.longitude;
        } else {
          lat = DEFAULT_LOCATION.latitude;
          lon = DEFAULT_LOCATION.longitude;
        }
      }
      try {
        const wttrUrl = `https://wttr.in/${lat},${lon}?format=j1&lang=zh`;
        const reqWttr = new Request(wttrUrl);
        reqWttr.timeoutInterval = 8;
        reqWttr.headers = { "User-Agent": "curl/7.88.1" };
        const data = await reqWttr.loadJSON();
        const cur = data.current_condition[0];
        return {
          location: cityName || "当地",
          weather: cur.lang_zh ? cur.lang_zh[0].value : cur.weatherDesc[0].value,
          temperature: `${cur.temp_C} °C`,
          apparent_temperature: `${cur.FeelsLikeC} °C`,
          humidity: `${cur.humidity}%`,
          wind_speed: `${cur.windspeedKmph} km/h`,
          precipitation: `${cur.precipMM} mm`
        };
      } catch (e) {
        return { location: cityName || "当地", note: "接口受阻，已提供快捷跳转", suggest_url: "weather://" };
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

    if (name === "create_calendar_event") {
      const cal = await Calendar.defaultForEvents();
      if (!cal) throw new Error("未找到默认日历");
      const startDate = new Date(args.start_date);
      if (isNaN(startDate.getTime())) throw new Error("开始时间无效: " + args.start_date);
      const evt = new CalendarEvent();
      evt.calendar = cal;
      evt.title = args.title;
      evt.startDate = startDate;
      evt.endDate = args.end_date
        ? new Date(args.end_date)
        : new Date(startDate.getTime() + 60 * 60 * 1000);
      if (isNaN(evt.endDate.getTime())) throw new Error("结束时间无效: " + args.end_date);
      if (args.location) evt.location = args.location;
      if (args.notes) evt.notes = args.notes;
      if (args.all_day) evt.isAllDay = true;
      await evt.save();
      return { success: true, message: `已成功创建日历事件: ${args.title}` };
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
// 6. Agentic 执行引擎 (状态机 + 重试 + 用量 + 摘要压缩)
// ==========================================
function getActiveModels() {
  if (MODELS && MODELS.length > 0) return MODELS;
  return [{
    id: "main",
    label: MODEL || "默认模型",
    url: API_URL,
    key: API_KEY,
    model: MODEL
  }];
}

function getActiveModelCfg(mem) {
  const list = getActiveModels();
  const sid = (mem && mem.settings && mem.settings.model_id) || null;
  return list.find(m => m.id === sid) || list[0];
}

async function callChatAPIOnce(messages, modelCfg, withTools) {
  const req = new Request(modelCfg.url);
  req.method = "POST";
  req.timeoutInterval = REQUEST_TIMEOUT;
  req.headers = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Accept-Encoding": "identity",
    "Authorization": `Bearer ${String(modelCfg.key || "").trim()}`
  };

  const body = { model: modelCfg.model, messages: messages };
  if (withTools) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  req.body = JSON.stringify(body);

  const data = await req.load();
  const raw = data.toRawString();
  const statusCode = (req.response && req.response.statusCode) || 0;

  let resp;
  try {
    resp = JSON.parse(raw);
  } catch (e) {
    throw new Error(`API 解析失败 (HTTP ${statusCode}): ${raw.slice(0, 120)}`);
  }

  if (statusCode >= 400) {
    const msg = (resp.error && (resp.error.message || resp.error.code)) || raw.slice(0, 120);
    throw new Error(`HTTP ${statusCode}: ${msg}`);
  }
  if (resp.error) throw new Error(resp.error.message || JSON.stringify(resp.error));
  if (!resp.choices || resp.choices.length === 0) throw new Error("API 未返回有效 choices");

  return { message: resp.choices[0].message, usage: resp.usage || null };
}

async function callChatAPI(messages, modelCfg, withTools = true, maxRetries = 1) {
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callChatAPIOnce(messages, modelCfg, withTools);
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message ? e.message : e);
      // 网络/超时类错误才重试;鉴权、参数、模型类错误直接抛出
      const fatal = /HTTP 4\d\d|invalid|unauthorized|api key|not found|model|参数|401|403|404|422/i.test(msg);
      if (attempt >= maxRetries || fatal) break;
      await new Promise(r => Timer.schedule(1.2, false, r));
    }
  }
  throw lastErr;
}

async function summarizeHistory(msgs, modelCfg) {
  const text = msgs
    .map(m => (m.role === "user" ? "用户" : "助手") + ": " + String(m.content).slice(0, 1500))
    .join("\n");
  const { message } = await callChatAPI([
    {
      role: "system",
      content: "你是会话压缩器。把以下对话压缩成中文要点摘要：保留任务目标、重要结论、待办事项、用户偏好与未解决的问题。不超过 300 字，直接输出摘要本身，不要解释。"
    },
    { role: "user", content: text }
  ], modelCfg, false, 0);
  return (message && message.content || "").trim();
}

async function compactIfNeeded(sess, mem) {
  if (!sess.messages || sess.messages.length <= SUMMARY_TRIGGER) return;
  const split = Math.floor(sess.messages.length * 0.5);
  if (split < 2) return;
  const older = sess.messages.slice(0, split);
  const newer = sess.messages.slice(split);
  const modelCfg = getActiveModelCfg(mem);
  try {
    const summary = await summarizeHistory(older, modelCfg);
    if (summary) {
      sess.summary = summary;
      sess.messages = newer;
    } else {
      sess.messages = sess.messages.slice(-HISTORY_TURNS * 2);
    }
  } catch (e) {
    sess.messages = sess.messages.slice(-HISTORY_TURNS * 2);
  }
  await MemoryManager.save(mem);
}

async function runAgentTurn(prompt, imageBase64 = null, onStatusUpdate = null) {
  const nowStr = new Date().toISOString();
  const localMem = await MemoryManager.load();
  const currentSess = await MemoryManager.getActiveSession();
  const modelCfg = getActiveModelCfg(localMem);

  await compactIfNeeded(currentSess, localMem);

  const knownFacts = localMem.user_profile.facts.length > 0
    ? localMem.user_profile.facts.join("\n- ")
    : "暂无持久化事实";

  // 技能索引 + 当前启用技能全文
  const skills = await SkillsManager.listSkills();
  const skillIndex = skills.length > 0
    ? skills.map(s => `- ${s.name}: ${s.description}`).join("\n")
    : "暂无(将 SKILL.md 放入 iCloud 的 pi-skills 目录即可注册)";
  let skillBlock = "";
  const activeSkillName = (localMem.settings && localMem.settings.active_skill) || "";
  if (activeSkillName) {
    const sk = await SkillsManager.loadSkill(activeSkillName);
    if (sk) {
      skillBlock = `【当前启用技能】${sk.name}\n${sk.content}\n\n请严格遵循该技能的说明完成任务。\n`;
    } else {
      skillBlock = `【技能提示】此前启用的技能 "${activeSkillName}" 已不存在，按常规规则继续。\n`;
    }
  }
  const summaryBlock = currentSess.summary
    ? `【此前对话摘要】\n${currentSess.summary}\n`
    : "";

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
【当前模型】：${modelCfg.label}
【持久化事实知识库】：
- ${knownFacts}

【可用技能】：
${skillIndex}
${skillBlock}${summaryBlock}
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

  let totalUsage = { prompt: 0, completion: 0 };
  let currentStep = 0;

  while (currentStep < MAX_STEPS) {
    currentStep++;
    const usedNote = (totalUsage.prompt + totalUsage.completion) > 0
      ? ` · 已用 ${totalUsage.prompt + totalUsage.completion} tokens`
      : "";
    if (onStatusUpdate) await onStatusUpdate(`第 ${currentStep} 轮自省推理${usedNote}...`);

    const { message, usage } = await callChatAPI(messages, modelCfg, true, 1);
    if (usage) {
      totalUsage.prompt += usage.prompt_tokens || 0;
      totalUsage.completion += usage.completion_tokens || 0;
    }
    messages.push(message);

    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const call of message.tool_calls) {
        let fnArgs = {};
        try {
          fnArgs = JSON.parse(call.function.arguments);
        } catch (e) {
          fnArgs = { _raw: call.function.arguments };
        }

        const toolResult = await executeLocalTool(call.function.name, fnArgs, onStatusUpdate);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(toolResult)
        });
      }
    } else {
      const finalReply = message.content || "(无返回内容)";
      await MemoryManager.appendTurn(prompt || "[图片指令]", finalReply);
      await MemoryManager.addUsage(currentSess.id, totalUsage);
      return finalReply;
    }
  }

  await MemoryManager.addUsage(currentSess.id, totalUsage);
  return `达到 Mini-Pi 最大自省步数限制 (${MAX_STEPS} 步)。`;
}

// ==========================================
// 7. 气泡渲染与前端视图 (安全渲染加固)
// ==========================================
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildChatHTML(mem) {
  const activeSess = mem.sessions.find(s => s.id === mem.active_session_id) || mem.sessions[0];
  const modelCfg = getActiveModelCfg(mem);

  const initial = (activeSess.messages && activeSess.messages.length > 0)
    ? activeSess.messages.map(h => ({
        role: h.role === "user" ? "user" : "agent",
        content: String(h.content || "")
      }))
    : [{
        role: "agent",
        content: "已就绪。我是你的 Mini-Pi 本地自主 Agent，支持 AI 绘图、在线搜索、天气/日程、截图分析及 SVG 动态渲染。输入 /help 查看全部命令。"
      }];
  const initialJson = jsLiteral(initial);

  let sessionListHtml = "";
  for (const s of mem.sessions) {
    const isCur = s.id === mem.active_session_id;
    const curCls = isCur ? "session-item active" : "session-item";
    const turns = Math.floor(((s.messages || []).length) / 2);
    const when = formatShortTime(s.updated_at || s.created_at);
    sessionListHtml += `
      <div class="${curCls}" onclick="selectSession('${escapeHtml(s.id)}')">
        <div class="sess-main">
          <div class="sess-title">${escapeHtml(s.title || "新会话")}</div>
          <div class="sess-sub">${turns} 条对话${when ? " · " + escapeHtml(when) : ""}</div>
        </div>
        <div class="sess-del" onclick="event.stopPropagation(); deleteSession('${escapeHtml(s.id)}')">✕</div>
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
  .model-tag {
    font-size: 12px; color: var(--user-bubble);
    background: var(--item-active); border-radius: 12px; padding: 4px 10px;
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

  .md-text { margin-bottom: 6px; }
  .md-text:last-child { margin-bottom: 0; }

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
    box-shadow: 0 1px 4px rgba(0,0,0,0.06); max-width: 100%; overflow: hidden; margin-top: 6px;
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
  .drawer-actions { display: flex; gap: 6px; align-items: center; }
  .action-btn {
    background: var(--user-bubble); color: #fff; border: none; border-radius: 14px;
    padding: 6px 12px; font-size: 13px; font-weight: 500;
  }
  .action-btn.ghost { background: var(--agent-bubble); color: var(--text-primary); }
  .drawer-list {
    flex: 1; overflow-y: auto; padding: 10px 14px; display: flex; flex-direction: column; gap: 8px;
  }
  .session-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 12px; border-radius: 10px; font-size: 14px; cursor: pointer;
  }
  .session-item.active { background: var(--item-active); font-weight: 600; }
  .sess-main { flex: 1; min-width: 0; margin-right: 8px; }
  .sess-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sess-sub { font-size: 11px; font-weight: 400; color: var(--text-secondary); margin-top: 2px; }
  .sess-del { color: var(--text-secondary); font-size: 13px; padding: 4px; }

  #image-viewer-mask {
    position: fixed; inset: 0; background: rgba(0,0,0,0.92); z-index: 300;
    display: none; align-items: center; justify-content: center; padding: 12px;
  }
  #image-viewer-mask img {
    max-width: 100%; max-height: 85vh; border-radius: 8px; object-fit: contain;
  }

  .modal-mask {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 200;
    display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  .modal-box {
    background: var(--card-bg); border-radius: 16px; padding: 10px;
    width: 100%; max-width: 340px; display: flex; flex-direction: column; gap: 6px;
    box-shadow: 0 8px 30px rgba(0,0,0,0.25);
  }
  .modal-title { font-weight: 600; font-size: 15px; padding: 6px 10px; }
  .modal-btn {
    padding: 12px 10px; border-radius: 10px; border: none;
    background: var(--bg-color); color: var(--text-primary); font-size: 14px; text-align: left;
  }
  .modal-btn:active { opacity: 0.6; }
  .modal-cancel { color: var(--user-bubble); font-weight: 600; text-align: center; }
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
    <div class="drawer-actions">
      <button class="action-btn ghost" onclick="postAction('export_session')">导出</button>
      <button class="action-btn ghost" onclick="postAction('import_session')">导入</button>
      <button class="action-btn" onclick="postAction('new_session')">+ 新会话</button>
    </div>
  </div>
  <div id="session-list" class="drawer-list">
    ${sessionListHtml}
  </div>
</div>

<header>
  <button class="header-btn" onclick="openHistoryDrawer()">☰ 历史</button>
  <span id="header-title">${escapeHtml(activeSess.title || "Mini-Pi Agent")}</span>
  <div class="header-actions">
    <button class="header-btn model-tag" onclick="postAction('open_model_picker')">${escapeHtml(modelCfg.label || "模型")}</button>
    <button class="header-btn" onclick="postAction('clear')">清空</button>
  </div>
</header>

<div id="chat-container">
</div>

<footer>
  <button class="icon-btn" onclick="postAction('photo')">📷</button>
  <input type="text" id="input-box" placeholder="画图、搜资讯、查天气、写待办… 或输入 /help" onkeydown="if(event.key==='Enter') send()">
  <button id="send-btn" onclick="send()">↑</button>
</footer>

<script>
  window.__initial = ${initialJson};
  window.__events = [];
  const container = document.getElementById("chat-container");
  const inputBox = document.getElementById("input-box");
  const historyDrawer = document.getElementById("history-drawer");
  const mask = document.getElementById("drawer-mask");

  function scrollToBottom() {
    container.scrollTop = container.scrollHeight;
  }

  function escapeHtml(s) {
    if (s === null || s === undefined) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  // SVG 清洗:移除脚本、事件处理器与 javascript: 链接
  function sanitizeSvg(svg) {
    return String(svg || "")
      .replace(/<script[\\s\\S]*?<\\/script>/gi, "")
      .replace(/\\son\\w+\\s*=\\s*"[^"]*"/gi, "")
      .replace(/\\son\\w+\\s*=\\s*'[^']*'/gi, "")
      .replace(/href\\s*=\\s*["']javascript:[^"']*["']/gi, 'href="#"');
  }

  function imageCard(url, alt) {
    const u = escapeHtml(url);
    const a = escapeHtml(alt || "");
    const onclick = escapeHtml("viewFullImage(" + JSON.stringify(url) + ")");
    return '<div class="image-bubble-card">' +
      '<img src="' + u + '" alt="' + a + '" loading="lazy" onclick="' + onclick + '" ' +
      'onload="window.scrollToBottom && window.scrollToBottom()" ' +
      'onerror="this.style.display=\\'none\\'; if(this.nextElementSibling) this.nextElementSibling.style.display=\\'block\\';">' +
      '<div class="image-fallback" style="display:none; padding:12px; text-align:center; color:var(--text-secondary); font-size:12px; background:rgba(0,0,0,0.03);">⚠️ 图片加载受阻 (' + a + ')</div>' +
      (alt ? '<div class="image-caption">' + a + '</div>' : '') +
      '</div>';
  }

  // 安全渲染:文本一律转义,仅图片卡片与清洗后的 SVG 以 HTML 插入
  function renderBubbleHTML(raw) {
    const text = String(raw || "");
    const tokenRe = /<svg[\\s\\S]*?<\\/svg>|!\\[[^\\]]*\\]\\((?:https?:\\/\\/)[^\\s\\)]+\\)/gi;
    const out = [];
    let last = 0;
    let m;
    while ((m = tokenRe.exec(text)) !== null) {
      if (m.index > last) {
        out.push('<div class="md-text">' + escapeHtml(text.slice(last, m.index)) + '</div>');
      }
      const tok = m[0];
      if (tok.charAt(0) === '<') {
        out.push('<div class="svg-container">' + sanitizeSvg(tok) + '</div>');
      } else {
        const imgM = tok.match(/!\\[([^\\]]*)\\]\\(((?:https?:\\/\\/)[^\\s\\)]+)\\)/);
        if (imgM) out.push(imageCard(imgM[2], imgM[1]));
      }
      last = tokenRe.lastIndex;
    }
    if (last < text.length) {
      out.push('<div class="md-text">' + escapeHtml(text.slice(last)) + '</div>');
    }
    if (out.length === 0) return escapeHtml(text);
    return out.join("");
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

  function openModelPicker(models) {
    closeAllDrawers();
    const old = document.getElementById("model-mask");
    if (old) old.remove();
    const mmask = document.createElement("div");
    mmask.id = "model-mask";
    mmask.className = "modal-mask";
    const box = document.createElement("div");
    box.className = "modal-box";
    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = "选择模型";
    box.appendChild(title);
    (models || []).forEach((m) => {
      const btn = document.createElement("button");
      btn.className = "modal-btn";
      btn.textContent = (m.active ? "✓ " : "") + (m.label || m.id);
      btn.onclick = () => {
        const el = document.getElementById("model-mask");
        if (el) el.remove();
        postAction('select_model', m.id);
      };
      box.appendChild(btn);
    });
    const cancel = document.createElement("button");
    cancel.className = "modal-btn modal-cancel";
    cancel.textContent = "取消";
    cancel.onclick = () => {
      const el = document.getElementById("model-mask");
      if (el) el.remove();
    };
    box.appendChild(cancel);
    mmask.appendChild(box);
    mmask.onclick = (e) => {
      if (e.target === mmask) mmask.remove();
    };
    document.body.appendChild(mmask);
  }

  function appendBubble(role, rawContent) {
    const row = document.createElement("div");
    row.className = "msg-row " + (role === "user" ? "msg-user" : "msg-agent");
    const b = document.createElement("div");
    b.className = "bubble";
    if (role === "user") {
      b.textContent = String(rawContent || "");
    } else {
      b.innerHTML = renderBubbleHTML(rawContent);
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
    const initial = window.__initial || [];
    for (let i = 0; i < initial.length; i++) {
      appendBubble(initial[i].role, initial[i].content);
    }
    scrollToBottom();
  };
</script>
</body>
</html>`;
}

// ==========================================
// 8. 命令处理与 UI 辅助
// ==========================================
// 取出页面里尚未处理的事件(重新加载会重建页面并清空队列,必须先取出再回注)
async function drainPendingEvents(webView) {
  try {
    const raw = await webView.evaluateJavaScript(`
      (function() {
        var e = window.__events || [];
        window.__events = [];
        return JSON.stringify(e);
      })()
    `);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

// 已经生效的结构性事件不回注,避免重复执行;用户输入类事件(text/photo)回注,避免丢失
const STRUCTURAL_EVENTS = [
  "new_session", "switch_session", "delete_session", "clear",
  "select_model", "open_model_picker", "export_session", "import_session"
];

async function reloadUI(webView) {
  const pending = await drainPendingEvents(webView);
  const mem = await MemoryManager.load();
  await webView.loadHTML(buildChatHTML(mem));
  const keep = (pending || []).filter(ev => ev && ev.type && STRUCTURAL_EVENTS.indexOf(ev.type) === -1);
  if (keep.length > 0) {
    try {
      await webView.evaluateJavaScript(`window.__events = ${jsLiteral(keep)};`);
    } catch (e) {}
  }
}

async function appendAgentMsg(webView, text) {
  await webView.evaluateJavaScript(`appendBubble("agent", ${jsLiteral(text)});`);
}

async function openModelPickerUI(webView, mem) {
  const list = getActiveModels();
  const activeId = (mem.settings && mem.settings.model_id) || null;
  const payload = list.map(m => ({ id: m.id, label: m.label, active: m.id === activeId }));
  await webView.evaluateJavaScript(`openModelPicker(${jsLiteral(payload)});`);
}

async function handleSlashCommand(cmd, webView) {
  const c = String(cmd || "").trim();
  const mem = await MemoryManager.load();

  if (c === "/help") {
    await appendAgentMsg(webView,
      "可用命令:\n" +
      "/model    切换模型\n" +
      "/skills   查看可用技能\n" +
      "/skill:名称  启用指定技能\n" +
      "/skill:off   关闭当前技能\n" +
      "/usage    查看 token 用量\n" +
      "/export   导出当前会话(写文件+复制剪贴板)\n" +
      "/import   从剪贴板导入会话 JSON\n" +
      "/new      新建会话\n" +
      "/clear    清空当前会话\n" +
      "/help     显示本帮助");
    return;
  }

  if (c === "/model") {
    await openModelPickerUI(webView, mem);
    return;
  }

  if (c === "/skills") {
    const list = await SkillsManager.listSkills();
    if (list.length === 0) {
      await appendAgentMsg(webView, "未发现技能。把 .md 技能文件放入 iCloud 的 " + SKILLS_DIR + " 目录即可注册。\n文件开头支持 name: 与 description: 元数据,正文为完整技能说明。");
    } else {
      await appendAgentMsg(webView, "已注册技能:\n" + list.map(s => `- ${s.name}: ${s.description}`).join("\n") + "\n\n用 /skill:名称 启用。");
    }
    return;
  }

  if (c === "/skill:off") {
    await MemoryManager.setActiveSkill(null);
    await appendAgentMsg(webView, "已关闭当前技能,回到常规模式。");
    return;
  }

  if (c.startsWith("/skill:")) {
    const name = c.slice(7).trim();
    if (!name) {
      await appendAgentMsg(webView, "用法: /skill:技能名");
      return;
    }
    const sk = await SkillsManager.loadSkill(name);
    if (!sk) {
      await appendAgentMsg(webView, `未找到技能 "${name}",先输入 /skills 查看列表。`);
      return;
    }
    await MemoryManager.setActiveSkill(sk.name);
    await appendAgentMsg(webView, `已启用技能: ${sk.name}\n${sk.description}\n\n之后的对话将严格遵循该技能说明。输入 /skill:off 关闭。`);
    return;
  }

  if (c === "/usage") {
    const sess = mem.sessions.find(s => s.id === mem.active_session_id) || mem.sessions[0];
    const u = mem.usage || { global: { prompt: 0, completion: 0 }, by_session: {} };
    const su = (u.by_session && u.by_session[sess.id]) || { prompt: 0, completion: 0 };
    const turns = Math.floor((sess.messages || []).length / 2);
    await appendAgentMsg(webView,
      `本会话: 输入 ${su.prompt} / 输出 ${su.completion} tokens,共 ${turns} 轮\n` +
      `全局累计: 输入 ${u.global.prompt} / 输出 ${u.global.completion} tokens`);
    return;
  }

  if (c === "/export") {
    try {
      const r = await MemoryManager.exportSession(mem.active_session_id);
      await appendAgentMsg(webView, `会话已导出(共 ${r.turns} 轮):\n文件: ${r.fname}(iCloud 文档目录)\n内容已复制到剪贴板。`);
    } catch (e) {
      await appendAgentMsg(webView, "导出失败: " + (e.message || e.toString()));
    }
    return;
  }

  if (c === "/import") {
    try {
      const text = Pasteboard.pasteString();
      if (!text || !text.trim()) {
        await appendAgentMsg(webView, "剪贴板为空。请先复制一份 Mini-Pi 导出的 JSON 再执行 /import。");
        return;
      }
      const copy = await MemoryManager.importSession(text);
      await reloadUI(webView);
      await appendAgentMsg(webView, `已导入会话: ${copy.title}(共 ${Math.floor(copy.messages.length / 2)} 轮)`);
    } catch (e) {
      await appendAgentMsg(webView, "导入失败: " + (e.message || e.toString()));
    }
    return;
  }

  if (c === "/new") {
    await MemoryManager.createNewSession();
    await reloadUI(webView);
    return;
  }

  if (c === "/clear") {
    await MemoryManager.clearCurrentSession();
    try {
      await webView.evaluateJavaScript(`
        document.getElementById("chat-container").innerHTML = '<div class="msg-row msg-agent"><div class="bubble">已清空当前会话记忆。</div></div>';
      `);
    } catch (e) {}
    return;
  }

  await appendAgentMsg(webView, "未知命令: " + c + ",输入 /help 查看全部命令。");
}

// ==========================================
// 9. 双模态分流引擎 (支持截图入参与活跃会话追加)
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
  let jsFailures = 0;
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
      jsFailures = 0;
    } catch (e) {
      // 页面正在重建等瞬时错误不应终止整个界面,连续失败才判定窗口已关闭
      jsFailures++;
      if (jsFailures > 20) break;
      continue;
    }

    if (!eventRaw) continue;

    let ev;
    try {
      ev = JSON.parse(eventRaw);
    } catch (e) {
      continue;
    }

    if (ev.type === "new_session") {
      await MemoryManager.createNewSession();
      await reloadUI(webView);
      continue;
    }

    if (ev.type === "switch_session") {
      await MemoryManager.switchSession(ev.data);
      await reloadUI(webView);
      continue;
    }

    if (ev.type === "delete_session") {
      await MemoryManager.deleteSession(ev.data);
      await reloadUI(webView);
      continue;
    }

    if (ev.type === "open_model_picker") {
      const uMem = await MemoryManager.load();
      await openModelPickerUI(webView, uMem);
      continue;
    }

    if (ev.type === "select_model") {
      await MemoryManager.setModel(String(ev.data));
      await reloadUI(webView);
      continue;
    }

    if (ev.type === "export_session") {
      const uMem = await MemoryManager.load();
      try {
        const r = await MemoryManager.exportSession(uMem.active_session_id);
        await appendAgentMsg(webView, `会话已导出(共 ${r.turns} 轮):\n文件: ${r.fname}(iCloud 文档目录)\n内容已复制到剪贴板。`);
      } catch (e) {
        await appendAgentMsg(webView, "导出失败: " + (e.message || e.toString()));
      }
      continue;
    }

    if (ev.type === "import_session") {
      try {
        const text = Pasteboard.pasteString();
        if (!text || !text.trim()) {
          await appendAgentMsg(webView, "剪贴板为空。请先复制一份 Mini-Pi 导出的 JSON 再点击导入。");
        } else {
          const copy = await MemoryManager.importSession(text);
          await reloadUI(webView);
          await appendAgentMsg(webView, `已导入会话: ${copy.title}(共 ${Math.floor(copy.messages.length / 2)} 轮)`);
        }
      } catch (e) {
        await appendAgentMsg(webView, "导入失败: " + (e.message || e.toString()));
      }
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
      const text = String(ev.data || "");
      if (text.trim().startsWith("/")) {
        try {
          await handleSlashCommand(text, webView);
        } catch (e) {
          await appendAgentMsg(webView, "命令执行失败: " + (e.message || e.toString()));
        }
        continue;
      }

      try {
        const reply = await runAgentTurn(text, null, async (st) => {
          if (!isWindowClosed) {
            try {
              await webView.evaluateJavaScript(`setStatus(${jsLiteral(st)})`);
            } catch (e) {}
          }
        });
        if (!isWindowClosed) {
          await webView.evaluateJavaScript(`
            setStatus("");
            appendBubble("agent", ${jsLiteral(reply)});
          `);
        }
      } catch (err) {
        if (!isWindowClosed) {
          await webView.evaluateJavaScript(`
            setStatus("");
            appendBubble("agent", ${jsLiteral("报错: " + (err.message || err.toString()))});
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
              await webView.evaluateJavaScript(`setStatus(${jsLiteral(st)})`);
            } catch (e) {}
          }
        });
        if (!isWindowClosed) {
          await webView.evaluateJavaScript(`
            setStatus("");
            appendBubble("agent", ${jsLiteral(reply)});
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
