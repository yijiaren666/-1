const state = { report: null, progress: {} };

const els = {
  docUrl: document.querySelector("#docUrl"),
  weekStart: document.querySelector("#weekStart"),
  generateBtn: document.querySelector("#generateBtn"),
  copyBtn: document.querySelector("#copyBtn"),
  statusLine: document.querySelector("#statusLine"),
  weekTitle: document.querySelector("#weekTitle"),
  completionBadge: document.querySelector("#completionBadge"),
  summaryText: document.querySelector("#summaryText"),
  comparisonGrid: document.querySelector("#comparisonGrid"),
  distributionChart: document.querySelector("#distributionChart"),
  distributionLegend: document.querySelector("#distributionLegend"),
  achievementTimeline: document.querySelector("#achievementTimeline"),
  longRunningList: document.querySelector("#longRunningList"),
  riskText: document.querySelector("#riskText"),
  sopText: document.querySelector("#sopText"),
  nextWeekText: document.querySelector("#nextWeekText"),
};

function setStatus(message, kind = "info") {
  els.statusLine.textContent = message;
  els.statusLine.dataset.kind = kind;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

async function loadProgress() {
  state.progress = await api("/api/progress");
}

function setupCanvas(canvas) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  return ctx;
}

function drawDistributionChart(items) {
  const canvas = els.distributionChart;
  const ctx = setupCanvas(canvas);
  const colors = ["#b87a7a", "#8ba888", "#7a9aa8", "#c4a882", "#b8956a"];
  const total = Math.max(1, items.reduce((sum, item) => sum + item.count, 0));
  const cx = canvas.clientWidth / 2;
  const cy = 105;
  const radius = 78;
  let start = -Math.PI / 2;

  if (!items.length) {
    ctx.fillStyle = "#8a8588";
    ctx.textAlign = "center";
    ctx.font = "14px Inter, Microsoft YaHei, sans-serif";
    ctx.fillText("暂无数据", cx, cy);
    els.distributionLegend.innerHTML = "";
    return;
  }

  items.forEach((item, index) => {
    const angle = (item.count / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, start, start + angle);
    ctx.closePath();
    ctx.fillStyle = colors[index % colors.length];
    ctx.fill();
    start += angle;
  });

  ctx.beginPath();
  ctx.arc(cx, cy, 42, 0, Math.PI * 2);
  ctx.fillStyle = "#fcf9f5";
  ctx.fill();
  ctx.fillStyle = "#3a3538";
  ctx.font = "700 22px Inter, Microsoft YaHei, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`${total}`, cx, cy + 4);
  ctx.fillStyle = "#8a8588";
  ctx.font = "12px Inter, Microsoft YaHei, sans-serif";
  ctx.fillText("事项", cx, cy + 22);

  els.distributionLegend.innerHTML = items.map((item, index) => `
    <span><i style="background:${colors[index % colors.length]}"></i>${escapeHtml(item.label)} ${item.percent}%</span>
  `).join("");
}

function renderComparison(items) {
  els.comparisonGrid.innerHTML = items.map((item) => {
    const direction = item.delta > 0 ? "↑" : item.delta < 0 ? "↓" : "→";
    const good = item.goodWhen === "neutral" ? "neutral" : (item.goodWhen === "up" ? item.delta >= 0 : item.delta <= 0) ? "good" : "bad";
    const deltaText = item.unit === "%" ? `${Math.abs(item.delta)}%` : `${Math.abs(item.delta)}${item.unit}`;
    return `
      <article class="mini-card ${good}">
        <span class="label">${escapeHtml(item.label)}</span>
        <strong class="value">${item.value}${item.unit}</strong>
        <em class="delta">${direction} ${deltaText}</em>
      </article>
    `;
  }).join("");
}

function renderAchievements(items) {
  els.achievementTimeline.innerHTML = items.length ? items.map((item) => {
    const statusClass = item.status === "已完成" ? "tag-done" : "tag-progress";
    return `
      <article class="timeline-item">
        <div class="timeline-dot">${item.rank}</div>
        <div>
          <h4>${escapeHtml(item.title)}</h4>
          <p class="meta">
            <span class="tag ${statusClass}">${escapeHtml(item.status)}</span>
            ${escapeHtml(item.result)} · ${escapeHtml(item.priority)} · ${escapeHtml(item.date || "未设置日期")}
          </p>
        </div>
      </article>
    `;
  }).join("") : '<p style="color: #8a8588; font-size: 14px; margin: 0;">本周暂无可展示核心成果。</p>';
}

function renderLongRunning(items) {
  els.longRunningList.innerHTML = items.length ? items.map((item) => {
    const saved = state.progress[item.id];
    const percent = saved?.percent ?? item.suggestedProgress;
    const blocks = `${"█".repeat(Math.round(percent / 10))}${"░".repeat(10 - Math.round(percent / 10))}`;
    return `
      <article class="long-item">
        <div>
          <h4>${escapeHtml(item.title)}</h4>
          <div class="bar-text">${blocks} ${percent}%</div>
        </div>
        <aside>
          <span><span class="dot" style="background:currentColor"></span> 当前阶段：${escapeHtml(item.stage)}</span>
          <span><span class="dot" style="background:currentColor"></span> 已推进周数：${item.weeks}</span>
          <span class="${item.delayed ? "risk" : "ok"}"><span class="dot"></span> ${item.delayed ? "有延迟" : "正常推进"}</span>
        </aside>
      </article>
    `;
  }).join("") : '<p style="color: #8a8588; font-size: 14px; margin: 0;">本周暂无长周期事项。</p>';
}

function renderEditableBlocks(report) {
  els.summaryText.textContent = report.summary;
  els.riskText.innerHTML = `<strong>${escapeHtml(report.reflection.title)}</strong>\n${formatEditable(report.reflection.body)}`;
  els.sopText.innerHTML = report.repeatedTasks.length
    ? report.repeatedTasks.map((item) => `<strong>【${escapeHtml(item.theme)}】出现 ${item.count} 次</strong>\n代表事项：${escapeHtml(item.examples.join("、"))}\n${item.body}`).join("\n\n")
    : "本周暂未识别到出现频率大于 2 次且名称相似的重复性任务。建议继续沉淀任务命名规范，以便后续自动提炼 SOP。";
  els.nextWeekText.innerHTML = formatEditable(report.nextWeekPlan) || "下周建议围绕核心交付、风险收敛和复盘沉淀形成明确任务安排。";
}

function formatEditable(text) {
  return text.replace(/\n/g, "\n").replace(/(【[^】]+】)/g, "<strong>$1</strong>");
}

function renderReport(report) {
  state.report = report;
  els.weekStart.value = report.week.start;
  els.weekTitle.textContent = `${report.week.start} 至 ${report.week.end} 周报`;
  els.completionBadge.textContent = `完成率 ${report.metrics.completionRate}%`;
  renderEditableBlocks(report);
  renderComparison(report.comparison || []);
  drawDistributionChart(report.distribution || []);
  renderAchievements(report.achievements || []);
  renderLongRunning(report.longRunningItems || []);
}

async function generateReport() {
  const url = els.docUrl.value.trim();
  if (!url) return setStatus("请先输入飞书文档链接。", "error");
  els.generateBtn.disabled = true;
  setStatus("正在读取飞书内容并生成周报...");
  try {
    await loadProgress();
    const report = await api("/api/report", {
      method: "POST",
      body: JSON.stringify({ url, weekStart: els.weekStart.value }),
    });
    renderReport(report);
    setStatus("周报已生成。");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    els.generateBtn.disabled = false;
  }
}

function buildCopyText() {
  if (!state.report) return "";
  const sections = [
    ["周报标题", els.weekTitle.textContent],
    ["AI 本周摘要", els.summaryText.innerText.trim()],
    ["风险洞察", els.riskText.innerText.trim()],
    ["高频任务和重复性任务 SOP", els.sopText.innerText.trim()],
    ["下周任务安排", els.nextWeekText.innerText.trim()],
  ];
  return sections.map(([title, content]) => `${title}\n${content}`).join("\n\n");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[char]));
}

els.generateBtn.addEventListener("click", generateReport);
els.copyBtn.addEventListener("click", async () => {
  const text = buildCopyText();
  if (!text) return setStatus("请先生成周报。", "error");
  await navigator.clipboard.writeText(text);
  setStatus("周报文本已复制。");
});
window.addEventListener("resize", () => {
  if (state.report) drawDistributionChart(state.report.distribution || []);
});

generateReport();