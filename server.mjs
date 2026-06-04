import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBase } from "./feishu.mjs";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.dirname(__filename);
const PUBLIC_DIR = path.join(ROOT, "public");
const PROGRESS_PATH = path.join(ROOT, "progress.json");
const PORT = Number(process.env.PORT || 5177);

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) return res.writeHead(403).end("Forbidden");
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return res.writeHead(404).end("Not found");
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
  };
  res.writeHead(200, { "Content-Type": types[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

function textValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => textValue(item?.text ?? item?.name ?? item)).filter(Boolean).join("、");
  return textValue(value.text ?? value.name ?? value.value ?? "");
}

function toDate(value) {
  if (!value) return null;
  if (typeof value === "number") return new Date(value);
  if (/^\d+$/.test(String(value))) return new Date(Number(value));
  if (typeof value === "string" && value.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00+08:00`);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function startOfWeek(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  const day = copy.getDay() || 7;
  copy.setDate(copy.getDate() - day + 1);
  return copy;
}

function formatDate(date) {
  if (!date) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function normalizeRecord(record) {
  const fields = record.fields || {};
  const title = textValue(fields["待办事项"] ?? fields["任务"] ?? fields["事项"] ?? fields["日程"] ?? fields["标题"]);
  const createdAt = toDate(fields["创建时间"] ?? fields["日期"] ?? fields["开始时间"]);
  const dueAt = toDate(fields["截止日期"] ?? fields["结束时间"] ?? fields["完成时间"]);
  const done = fields["是否已完成"] === true || textValue(fields["状态"]).includes("完成");
  return {
    id: record.record_id || record.id,
    title: title || "未命名事项",
    createdDate: formatDate(createdAt),
    dueDate: formatDate(dueAt),
    workDate: formatDate(dueAt || createdAt),
    done,
    statusText: textValue(fields["距离截止日"] ?? fields["状态"]),
    priority: textValue(fields["优先级"]),
    owner: textValue(fields["执行人"]),
    summary: textValue(fields["AI 待办事项汇总"]),
    risk: textValue(fields["AI 任务风险判断"]),
    weight: textValue(fields["权重"]),
    taskType: textValue(fields["任务类型"]),
    delayReason: textValue(fields["延期原因分析"]),
    contentType: textValue(fields["内容类型"]),
  };
}

function taskTheme(title) {
  if (/小红书|爆款|笔记|发布|内容|选题/.test(title)) return "内容运营";
  if (/会议|摘要|记录|效率/.test(title)) return "效率工具";
  if (/网站|小程序|搭建|部署|开发|系统|工具/.test(title)) return "产品开发";
  return "日常推进";
}

function isLongTask(task) {
  return /搭建|开发|部署|系统|网站|小程序|生成|摘要|项目|工具/.test(task.title);
}

function metricsFor(tasks) {
  const completed = tasks.filter((task) => task.done).length;
  return {
    total: tasks.length,
    completed,
    pending: tasks.length - completed,
    completionRate: tasks.length ? Math.round((completed / tasks.length) * 100) : 0,
    overdue: tasks.filter((task) => task.statusText.includes("延期")).length,
    longRunning: tasks.filter(isLongTask).length,
  };
}

function delta(current, previous) {
  return current - previous;
}

function comparisonFor(current, previous) {
  const now = metricsFor(current);
  const last = metricsFor(previous);
  return [
    { label: "完成事项", value: now.completed, delta: delta(now.completed, last.completed), unit: "项", goodWhen: "up" },
    { label: "完成率", value: now.completionRate, delta: delta(now.completionRate, last.completionRate), unit: "%", goodWhen: "up" },
    { label: "延期事项", value: now.overdue, delta: delta(now.overdue, last.overdue), unit: "项", goodWhen: "down" },
    { label: "长周期事项", value: now.longRunning, delta: delta(now.longRunning, last.longRunning), unit: "项", goodWhen: "neutral" },
  ];
}

function distributionFor(tasks) {
  const total = Math.max(1, tasks.length);
  const counts = new Map();
  for (const task of tasks) counts.set(taskTheme(task.title), (counts.get(taskTheme(task.title)) || 0) + 1);
  return [...counts.entries()].map(([label, count]) => ({
    label,
    count,
    percent: Math.round((count / total) * 100),
  }));
}

function summarize(tasks, previousTasks, suggestions) {
  const metrics = metricsFor(tasks);
  const previous = metricsFor(previousTasks);
  const distribution = distributionFor(tasks);
  const themes = distribution.map((item) => item.label).join("、") || "";
  const completedTitles = tasks.filter(t => t.done).map(t => t.title).slice(0, 3);
  const pendingTitles = tasks.filter(t => !t.done).map(t => t.title);
  const highPriTasks = tasks.filter(t => /P0|高优/.test(t.priority));

  if (!tasks.length) return "本周工作记录较少，请补充任务数据后再生成周报。";

  const parts = [];

  if (metrics.completed > 0) {
    parts.push(`本周共推进 ${metrics.total} 项工作，完成 ${metrics.completed} 项（完成率 ${metrics.completionRate}%），重点集中在${themes}方向。`);
    parts.push(`已完成：${completedTitles.join("、")}。`);
  } else {
    parts.push(`本周共记录 ${metrics.total} 项工作，目前暂无完成项，需加快推进节奏。`);
  }

  if (pendingTitles.length > 0) {
    parts.push(`待推进：${pendingTitles.join("、")}。`);
  }

  if (highPriTasks.length > 0) {
    parts.push(`高优先级事项中，已完成 ${highPriTasks.filter(t => t.done).length} 项，剩余 ${highPriTasks.filter(t => !t.done).length} 项持续跟进中。`);
  }

  if (metrics.overdue > 0) {
    parts.push(`需重点关注：存在 ${metrics.overdue} 项延期事项，涉及 ${pendingTitles.length > 0 ? pendingTitles.slice(0, 2).join("、") : "多项"}，建议纳入下周首要跟进清单。`);
  }

  const topFocus = distribution.length > 1 ? distribution.reduce((max, item) => item.count > max.count ? item : max, distribution[0]) : null;
  if (topFocus && topFocus.percent > 50) {
    parts.push(`工作投入重心在 ${topFocus.label}（${topFocus.percent}%），下一步建议适当平衡各方向资源分配。`);
  }

  return parts.join("\n");
}

function reflectionFor(tasks) {
  const overdue = tasks.filter((task) => task.statusText.includes("延期") || !task.done);
  if (!overdue.length) {
    return {
      title: "本周整体进度良好，无明显风险。",
      body: "本周工作均按时推进，计划完成情况较好。建议保持当前节奏，持续关注 P0 高优事项的交付质量。",
    };
  }

  const delayLines = overdue.map(task => {
    const reasons = [];
    if (task.delayReason) reasons.push(task.delayReason);
    if (task.risk) reasons.push(`风险评估：${task.risk}`);
    if (task.taskType) reasons.push(`类型：${task.taskType}`);
    return `· ${task.title}${reasons.length ? `（${reasons.join("；")}）` : ""}`;
  });

  const longRunningDelays = overdue.filter(task => /长期/.test(task.taskType));
  const contentDelays = overdue.filter(task => /小红书|内容/.test(task.title));
  const devDelays = overdue.filter(task => /搭建|网站|小程序/.test(task.title));

  const analysis = [];
  if (longRunningDelays.length > 0) {
    analysis.push(`· 长周期任务缺少阶段性拆解与里程碑检查（如 ${longRunningDelays.map(t => t.title).join("、")}）`);
  }
  if (contentDelays.length > 0) {
    analysis.push(`· 内容类工作存在选题规划不足、素材准备周期偏长的问题（如 ${contentDelays.map(t => t.title).join("、")}）`);
  }
  if (devDelays.length > 0) {
    analysis.push(`· 开发类任务受技术验证和部署环节影响，交付缓冲储备不足`);
  }

  return {
    title: `风险洞察：本周共 ${overdue.length} 项工作存在延期或未完成情况`,
    body: [
      "【延期事项明细】",
      ...delayLines,
      "",
      "【原因分析】",
      ...(analysis.length > 0 ? analysis : ["· 截止时间设置偏紧，执行过程中缺少中间节点检查和风险预警机制。"]),
      "",
      "【改进建议】",
      "· 下周起对长周期任务实行阶段拆解，每周设置中间验收节点",
      "· 内容类工作提前 1 周完成选题和素材准备",
      "· 明确每日最低交付标准，避免多任务并行导致的交付稀释",
    ].join("\n"),
  };
}

function normalizeTitle(title) {
  return title
    .replace(/[（）()【】[\]、，。,.!?！？]/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/一个|一篇|进行|完成|相关|任务/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokensFor(title) {
  const normalized = normalizeTitle(title);
  const dict = ["小红书", "爆款", "笔记", "发布", "搭建", "会议", "记录", "摘要", "网站", "小程序", "部署", "数据", "登记", "工具"];
  const tokens = dict.filter((word) => normalized.includes(word));
  if (!tokens.length) tokens.push(...normalized.split(" ").filter((word) => word.length >= 2));
  return [...new Set(tokens)];
}

function similarity(a, b) {
  const left = new Set(tokensFor(a));
  const right = new Set(tokensFor(b));
  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size || 1;
  return intersection / union;
}

function repeatedTaskInsights(tasks) {
  const groups = [];
  for (const task of tasks) {
    let group = groups.find((item) => similarity(item.seed, task.title) >= 0.34 || taskTheme(item.seed) === taskTheme(task.title));
    if (!group) {
      group = { seed: task.title, theme: taskTheme(task.title), tasks: [] };
      groups.push(group);
    }
    group.tasks.push(task);
  }
  return groups
    .filter((group) => group.tasks.length > 1)
    .map((group) => {
      const templates = {
        "内容运营": [
          "流程拆解：选题确认 → 素材搜集 → 内容创作 → 审核发布 → 数据复盘",
          "执行要点：每周固定 2 个创作时段，单篇时长控制在 2 小时内",
          "效率工具：建立素材库和选题看板，减少每次从零开始的决策成本",
        ],
        "产品开发": [
          "流程拆解：需求确认 → 原型设计 → 功能开发 → 自测联调 → 部署上线",
          "执行要点：每个环节设置明确的交付标准和验收人",
          "效率工具：使用项目管理工具跟踪各阶段进展，每周同步一次进度",
        ],
        "效率工具": [
          "流程拆解：需求梳理 → 方案设计 → 工具搭建 → 效果验证 → 日常维护",
          "执行要点：优先使用现成工具和模版，减少重复造轮子",
          "效率工具：建立工具使用文档库，便于后续复用和交接",
        ],
        "日常推进": [
          "流程拆解：明确目标 → 分解动作 → 执行检查 → 复盘沉淀",
          "执行要点：每日结束时记录进度和阻塞点",
          "效率工具：使用待办清单管理日常事项，避免遗漏",
        ],
      };
      const steps = templates[group.theme] || templates["日常推进"];
      return {
        theme: group.theme,
        count: group.tasks.length,
        examples: group.tasks.slice(0, 4).map((task) => task.title),
        body: steps.join("\n"),
      };
    });
}

function formatAchievementResult(task) {
  if (!task.done) return "正在推进中，预计下周完成交付";
  if (/搭建|开发|网站|小程序/.test(task.title)) return "已完成功能搭建与基础验证，进入可用状态";
  if (/内容|小红书|笔记|发布/.test(task.title)) return "已完成内容生产与发布，进入效果观测阶段";
  if (/会议|摘要|记录/.test(task.title)) return "已完成流程搭建与效果验证，投入日常使用";
  if (/部署|上线/.test(task.title)) return "已完成部署上线，运行稳定";
  return "已完成交付";
}

function topAchievements(tasks) {
  const priorityScore = (task) => {
    if (/P0|高优|高/.test(task.priority)) return 3;
    if (/P1|一般/.test(task.priority)) return 2;
    if (/P2|低优|低/.test(task.priority)) return 1;
    return 0;
  };
  return [...tasks]
    .sort((a, b) => Number(b.done) - Number(a.done) || priorityScore(b) - priorityScore(a) || Number(isLongTask(b)) - Number(isLongTask(a)))
    .slice(0, 3)
    .map((task, index) => ({
      rank: index + 1,
      title: task.title,
      status: task.done ? "已完成" : "推进中",
      priority: task.priority || "未标注",
      date: task.workDate,
      result: formatAchievementResult(task),
    }));
}

function longRunningItems(tasks, start) {
  return tasks.filter(isLongTask).map((task) => {
    const created = toDate(task.createdDate) || start;
    const weeks = Math.max(1, Math.ceil((addDays(start, 6) - created) / (7 * 24 * 60 * 60 * 1000)) + 1);
    let stage = "需求与方案确认";
    if (/部署|上线/.test(task.title)) stage = "部署验证";
    else if (/搭建|开发|小程序|网站/.test(task.title)) stage = "功能搭建";
    else if (/摘要|记录|生成/.test(task.title)) stage = "流程验证";
    return {
      id: task.id,
      title: task.title,
      stage,
      weeks,
      delayed: task.statusText.includes("延期") || !task.done,
      suggestedProgress: task.done ? 100 : stage === "部署验证" ? 80 : 60,
    };
  });
}

function suggestNextWeek(tasks, repeated) {
  const unfinished = tasks.filter(t => !t.done);
  const highPriPending = unfinished.filter(t => /P0|高优/.test(t.priority));
  const lines = [];

  if (unfinished.length > 0) {
    const urgent = highPriPending.length > 0
      ? `优先完成 ${highPriPending.map(t => t.title).join("、")} 等高优事项`
      : `优先收敛 ${unfinished.length} 项未完成工作`;
    lines.push(`【必办项】${urgent}，明确每项交付标准和截止时间，避免跨周积压。`);
    lines.push(`待办清单：${unfinished.map(t => `· ${t.title}${/P0|高优/.test(t.priority) ? "（🔴高优）" : ""}`).join("\n")}`);
  }

  if (tasks.some(t => /小红书|内容/.test(t.title))) {
    lines.push("");
    lines.push("【内容运营】建立固定选题-创作-发布流程，提前储备 2 周以上的选题库和素材包，降低单次创作的决策成本和交付压力。");
  }

  if (tasks.some(t => /搭建|网站|小程序/.test(t.title))) {
    lines.push("");
    lines.push("【产品开发】将搭建类任务拆分为原型设计、核心功能开发、部署验证三阶段，每周设置一个可验收的里程碑节点。");
  }

  if (repeated.length > 0) {
    lines.push("");
    lines.push(`【流程沉淀】针对高频事项（${repeated.map(r => r.theme).join("、")}）形成标准化操作流程，下周内完成初版模板的编写与试用。`);
  }

  if (lines.length === 0) {
    lines.push("【下周安排】聚焦本周未完成事项，确保核心目标达成，同时为下阶段工作做好准备。");
  }

  return lines.join("\n");
}

function buildReport(baseData, weekStartText) {
  const records = baseData.records?.data?.items || [];
  const allTasks = records.map(normalizeRecord);
  const latestDate = allTasks.map((task) => toDate(task.workDate)).filter(Boolean).sort((a, b) => b - a)[0] || new Date();
  const start = weekStartText ? new Date(`${weekStartText}T00:00:00+08:00`) : startOfWeek(latestDate);
  const end = addDays(start, 7);
  const previousStart = addDays(start, -7);
  const tasks = allTasks.filter((task) => {
    const date = toDate(task.workDate);
    return date && date >= start && date < end;
  });
  const previousTasks = allTasks.filter((task) => {
    const date = toDate(task.workDate);
    return date && date >= previousStart && date < start;
  });
  const repeated = repeatedTaskInsights(tasks);
  const nextWeekPlan = suggestNextWeek(tasks, repeated);

  return {
    week: { start: formatDate(start), end: formatDate(addDays(start, 6)) },
    tasks,
    metrics: metricsFor(tasks),
    comparison: comparisonFor(tasks, previousTasks),
    distribution: distributionFor(tasks),
    summary: summarize(tasks, previousTasks, nextWeekPlan.split("\n").filter(Boolean)),
    achievements: topAchievements(tasks),
    longRunningItems: longRunningItems(tasks, start),
    reflection: reflectionFor(tasks),
    repeatedTasks: repeated,
    nextWeekPlan,
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "POST" && url.pathname === "/api/report") {
    const body = await readBody(req);
    if (!body.url) return sendJson(res, 400, { error: "缺少飞书文档链接。" });
    const baseData = await readBase(body.url, { limit: body.limit || "200" });
    return sendJson(res, 200, buildReport(baseData, body.weekStart));
  }
  if (req.method === "GET" && url.pathname === "/api/progress") {
    return sendJson(res, 200, readJson(PROGRESS_PATH, {}));
  }
  if (req.method === "POST" && url.pathname === "/api/progress") {
    const body = await readBody(req);
    if (!body.recordId) return sendJson(res, 400, { error: "缺少记录 ID。" });
    const progress = readJson(PROGRESS_PATH, {});
    progress[body.recordId] = {
      percent: Number(body.percent || 0),
      note: String(body.note || "").trim(),
      updatedAt: new Date().toISOString(),
    };
    writeJson(PROGRESS_PATH, progress);
    return sendJson(res, 200, { ok: true, progress: progress[body.recordId] });
  }
  return sendJson(res, 404, { error: "Not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) await handleApi(req, res);
    else serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Weekly report demo running at http://localhost:${PORT}`);
});
