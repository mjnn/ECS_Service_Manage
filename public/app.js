const tableBody = document.getElementById("serviceTableBody");
const dockerTableBody = document.getElementById("dockerTableBody");
const proxyMappingBody = document.getElementById("proxyMappingBody");
const refreshBtn = document.getElementById("refreshBtn");
const logoutBtn = document.getElementById("logoutBtn");
const saveProxyMappingsBtn = document.getElementById("saveProxyMappingsBtn");
const applyProxyMappingsBtn = document.getElementById("applyProxyMappingsBtn");
const fillEcsProxyExampleBtn = document.getElementById("fillEcsProxyExampleBtn");
const proxyMappingForm = document.getElementById("proxyMappingForm");
const mapContainerName = document.getElementById("mapContainerName");
const mapHost = document.getElementById("mapHost");
const mapPath = document.getElementById("mapPath");
const mapTargetPort = document.getElementById("mapTargetPort");
const mapListenPort = document.getElementById("mapListenPort");
const tabsNav = document.getElementById("tabsNav");
const tabButtons = Array.from(document.querySelectorAll(".tab-btn"));
const tabPanels = Array.from(document.querySelectorAll(".tab-panel"));
const logArea = document.getElementById("logArea");
const monitorPanel = document.getElementById("monitorPanel");
const monitorToggleBtn = document.getElementById("monitorToggleBtn");
const monitorResizeHandle = document.getElementById("monitorResizeHandle");
const monitorHeader = monitorPanel.querySelector(".monitor-header");
const authPanel = document.getElementById("authPanel");
const authForm = document.getElementById("authForm");
const authUsername = document.getElementById("authUsername");
const authPassword = document.getElementById("authPassword");
const authMessage = document.getElementById("authMessage");
let pendingRequestCount = 0;
let authToken = localStorage.getItem("panelAuthToken") || "";
let proxyMappings = [];
const monitorLayoutKey = "monitorLayoutV1";
const appBasePath = (() => {
  const pathname = window.location.pathname || "/";
  if (pathname === "/") return "";
  const withoutIndex = pathname.endsWith("/index.html")
    ? pathname.slice(0, -"/index.html".length)
    : pathname;
  return withoutIndex.replace(/\/+$/, "");
})();

function apiUrl(pathname) {
  return `${appBasePath}${pathname}`;
}

function stateClass(state) {
  if (state === "active") return "active";
  if (state === "inactive" || state === "failed") return "inactive";
  return "unknown";
}

function setLog(message) {
  logArea.textContent = message;
  logArea.scrollTop = logArea.scrollHeight;
}

function switchTab(tabId) {
  tabButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });
  tabPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.id === tabId);
  });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

function saveMonitorLayout() {
  const rect = monitorPanel.getBoundingClientRect();
  const layout = {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    collapsed: monitorPanel.classList.contains("collapsed")
  };
  localStorage.setItem(monitorLayoutKey, JSON.stringify(layout));
}

function applyMonitorLayout() {
  const raw = localStorage.getItem(monitorLayoutKey);
  if (!raw || window.innerWidth <= 768) return;

  try {
    const layout = JSON.parse(raw);
    const minWidth = 260;
    const minHeight = 120;
    const width = clamp(layout.width || 420, minWidth, window.innerWidth - 24);
    const height = clamp(layout.height || 280, minHeight, window.innerHeight - 24);
    const left = clamp(layout.left || 0, 8, window.innerWidth - width - 8);
    const top = clamp(layout.top || 0, 8, window.innerHeight - height - 8);

    monitorPanel.style.left = `${left}px`;
    monitorPanel.style.top = `${top}px`;
    monitorPanel.style.right = "auto";
    monitorPanel.style.bottom = "auto";
    monitorPanel.style.width = `${width}px`;
    monitorPanel.style.height = `${height}px`;

    if (layout.collapsed) {
      monitorPanel.classList.add("collapsed");
      monitorToggleBtn.textContent = "展开";
    }
  } catch (error) {
    // ignore invalid local storage payload
  }
}

function enableMonitorDrag() {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  monitorHeader.addEventListener("pointerdown", (event) => {
    if (window.innerWidth <= 768 || event.target.closest("button")) return;
    dragging = true;
    const rect = monitorPanel.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    startX = event.clientX;
    startY = event.clientY;
    monitorHeader.setPointerCapture(event.pointerId);
    monitorPanel.style.right = "auto";
    monitorPanel.style.bottom = "auto";
  });

  monitorHeader.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    const rect = monitorPanel.getBoundingClientRect();
    const left = clamp(startLeft + dx, 8, window.innerWidth - rect.width - 8);
    const top = clamp(startTop + dy, 8, window.innerHeight - rect.height - 8);
    monitorPanel.style.left = `${left}px`;
    monitorPanel.style.top = `${top}px`;
  });

  function finishDrag() {
    if (!dragging) return;
    dragging = false;
    saveMonitorLayout();
  }

  monitorHeader.addEventListener("pointerup", finishDrag);
  monitorHeader.addEventListener("pointercancel", finishDrag);
}

function enableMonitorResize() {
  let resizing = false;
  let startX = 0;
  let startY = 0;
  let startWidth = 0;
  let startHeight = 0;
  const minWidth = 260;
  const minHeight = 120;

  monitorResizeHandle.addEventListener("pointerdown", (event) => {
    if (window.innerWidth <= 768 || monitorPanel.classList.contains("collapsed")) return;
    resizing = true;
    const rect = monitorPanel.getBoundingClientRect();
    startWidth = rect.width;
    startHeight = rect.height;
    startX = event.clientX;
    startY = event.clientY;
    monitorResizeHandle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  monitorResizeHandle.addEventListener("pointermove", (event) => {
    if (!resizing) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    const width = clamp(startWidth + dx, minWidth, window.innerWidth - 16);
    const height = clamp(startHeight + dy, minHeight, window.innerHeight - 16);
    monitorPanel.style.width = `${width}px`;
    monitorPanel.style.height = `${height}px`;
  });

  function finishResize() {
    if (!resizing) return;
    resizing = false;
    saveMonitorLayout();
  }

  monitorResizeHandle.addEventListener("pointerup", finishResize);
  monitorResizeHandle.addEventListener("pointercancel", finishResize);
}

function setBusy(isBusy) {
  refreshBtn.disabled = isBusy || !authToken;
  refreshBtn.textContent = isBusy ? "刷新中..." : "刷新状态";
  logoutBtn.disabled = isBusy;
  saveProxyMappingsBtn.disabled = isBusy || !authToken;
  applyProxyMappingsBtn.disabled = isBusy || !authToken;
}

function beginRequest() {
  pendingRequestCount += 1;
  setBusy(true);
}

function endRequest() {
  pendingRequestCount = Math.max(0, pendingRequestCount - 1);
  if (pendingRequestCount === 0) {
    setBusy(false);
  }
}

function setAuthPanelVisible(visible, message = "") {
  authPanel.classList.toggle("visible", visible);
  authMessage.textContent = message;
}

function saveAuthToken(token) {
  authToken = token;
  if (token) {
    localStorage.setItem("panelAuthToken", token);
    setAuthPanelVisible(false);
  } else {
    localStorage.removeItem("panelAuthToken");
    setAuthPanelVisible(true, "请先登录");
  }
  setBusy(false);
}

async function requestJson(url, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  if (authToken) {
    headers.Authorization = `Basic ${authToken}`;
  }

  const resp = await fetch(url, {
    headers,
    ...options
  });

  const rawText = await resp.text();
  let data;
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch (error) {
    if (!resp.ok) {
      throw new Error(
        resp.status === 401
          ? "未认证，请登录"
          : `请求失败（HTTP ${resp.status}）: ${rawText.slice(0, 120)}`
      );
    }
    throw new Error(`接口返回非 JSON 响应: ${rawText.slice(0, 120)}`);
  }

  if (!resp.ok) {
    if (resp.status === 401) {
      saveAuthToken("");
      setAuthPanelVisible(true, "认证失效，请重新登录");
    }
    const detail = data.error ? `: ${data.error}` : "";
    throw new Error(`${data.message || "请求失败"}${detail}`);
  }

  return data;
}

async function runAction(serviceName, action) {
  beginRequest();
  try {
    setLog(`正在执行 ${serviceName} -> ${action} ...`);
    const result = await requestJson(apiUrl(`/api/services/${serviceName}/${action}`), {
      method: "POST"
    });

    const lines = [
      `service: ${result.serviceName}`,
      `action: ${result.action}`,
      `exitCode: ${result.exitCode}`,
      "",
      "stdout:",
      result.stdout || "(empty)",
      "",
      "stderr:",
      result.stderr || "(empty)"
    ];
    setLog(lines.join("\n"));
  } catch (error) {
    setLog(`执行失败: ${error.message}`);
  } finally {
    await loadAll();
    endRequest();
  }
}

function createActionButton(label, handler) {
  const btn = document.createElement("button");
  btn.textContent = label;
  btn.addEventListener("click", handler);
  return btn;
}

function createProxyDeleteButton(index) {
  const btn = document.createElement("button");
  btn.textContent = "删除";
  btn.addEventListener("click", () => {
    proxyMappings.splice(index, 1);
    renderProxyMappings();
  });
  return btn;
}

function renderRows(services) {
  tableBody.innerHTML = "";
  services.forEach((service) => {
    const tr = document.createElement("tr");

    const nameTd = document.createElement("td");
    nameTd.textContent = service.name;
    nameTd.dataset.label = "服务名";

    const stateTd = document.createElement("td");
    stateTd.className = `state ${stateClass(service.state)}`;
    stateTd.textContent = service.state;
    stateTd.dataset.label = "当前状态";

    const actionTd = document.createElement("td");
    actionTd.dataset.label = "操作";
    actionTd.className = "actions";
    actionTd.appendChild(
      createActionButton("启动", () => runAction(service.name, "start"))
    );
    actionTd.appendChild(
      createActionButton("停止", () => runAction(service.name, "stop"))
    );
    actionTd.appendChild(
      createActionButton("重启", () => runAction(service.name, "restart"))
    );
    actionTd.appendChild(
      createActionButton("状态", () => runAction(service.name, "status"))
    );

    tr.appendChild(nameTd);
    tr.appendChild(stateTd);
    tr.appendChild(actionTd);
    tableBody.appendChild(tr);
  });
}

async function runDockerAction(containerName, action) {
  beginRequest();
  try {
    setLog(`正在执行容器 ${containerName} -> ${action} ...`);
    const result = await requestJson(apiUrl(`/api/docker/containers/${containerName}/${action}`), {
      method: "POST"
    });

    const lines = [
      `container: ${result.containerName}`,
      `action: ${result.action}`,
      `exitCode: ${result.exitCode}`,
      "",
      "stdout:",
      result.stdout || "(empty)",
      "",
      "stderr:",
      result.stderr || "(empty)"
    ];
    setLog(lines.join("\n"));
  } catch (error) {
    setLog(`执行失败: ${error.message}`);
  } finally {
    await loadAll();
    endRequest();
  }
}

async function showDockerLogs(containerName) {
  beginRequest();
  try {
    setLog(`正在读取 ${containerName} 日志...`);
    const result = await requestJson(apiUrl(`/api/docker/containers/${containerName}/logs?tail=200`));
    const lines = [
      `container: ${result.containerName}`,
      `tail: ${result.tail}`,
      `exitCode: ${result.exitCode}`,
      "",
      "logs:",
      result.logs || "(empty)"
    ];
    setLog(lines.join("\n"));
  } catch (error) {
    setLog(`读取日志失败: ${error.message}`);
  } finally {
    endRequest();
  }
}

function renderDockerRows(containers) {
  dockerTableBody.innerHTML = "";

  containers.forEach((container) => {
    const tr = document.createElement("tr");

    const nameTd = document.createElement("td");
    nameTd.textContent = container.name;
    nameTd.dataset.label = "容器名";

    const imageTd = document.createElement("td");
    imageTd.textContent = container.image;
    imageTd.dataset.label = "镜像";

    const stateTd = document.createElement("td");
    stateTd.className = `state ${stateClass(container.state || "unknown")}`;
    stateTd.textContent = container.status || container.state || "unknown";
    stateTd.dataset.label = "状态";

    const actionTd = document.createElement("td");
    actionTd.dataset.label = "操作";
    actionTd.className = "actions";
    actionTd.appendChild(
      createActionButton("启动", () => runDockerAction(container.name, "start"))
    );
    actionTd.appendChild(
      createActionButton("停止", () => runDockerAction(container.name, "stop"))
    );
    actionTd.appendChild(
      createActionButton("重启", () => runDockerAction(container.name, "restart"))
    );
    actionTd.appendChild(
      createActionButton("删除", () => runDockerAction(container.name, "remove"))
    );
    actionTd.appendChild(
      createActionButton("日志", () => showDockerLogs(container.name))
    );

    tr.appendChild(nameTd);
    tr.appendChild(imageTd);
    tr.appendChild(stateTd);
    tr.appendChild(actionTd);
    dockerTableBody.appendChild(tr);
  });
}

function renderProxyMappings() {
  proxyMappingBody.innerHTML = "";
  if (!proxyMappings.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = "<td colspan='6'>暂无自定义代理规则</td>";
    proxyMappingBody.appendChild(tr);
    return;
  }

  proxyMappings.forEach((item, index) => {
    const tr = document.createElement("tr");
    const values = [
      item.containerName,
      item.host,
      item.path,
      String(item.targetPort),
      String(item.listenPort || 80)
    ];

    const labels = ["容器名", "Host", "路径", "容器端口", "监听端口"];
    values.forEach((value, idx) => {
      const td = document.createElement("td");
      td.textContent = value;
      td.dataset.label = labels[idx];
      tr.appendChild(td);
    });

    const actionTd = document.createElement("td");
    actionTd.dataset.label = "操作";
    actionTd.className = "actions";
    actionTd.appendChild(createProxyDeleteButton(index));
    tr.appendChild(actionTd);
    proxyMappingBody.appendChild(tr);
  });
}

async function loadServices() {
  try {
    const data = await requestJson(apiUrl("/api/services"));
    renderRows(data.services);
  } catch (error) {
    setLog(`加载服务失败: ${error.message}`);
  }
}

async function loadDockerContainers() {
  try {
    const data = await requestJson(apiUrl("/api/docker/containers"));
    renderDockerRows(data.containers);
  } catch (error) {
    setLog(`加载容器失败: ${error.message}`);
  }
}

async function loadProxyMappings() {
  try {
    const data = await requestJson(apiUrl("/api/proxy/mappings"));
    proxyMappings = Array.isArray(data.mappings) ? data.mappings : [];
    renderProxyMappings();
  } catch (error) {
    setLog(`加载代理配置失败: ${error.message}`);
  }
}

async function saveProxyMappings() {
  beginRequest();
  try {
    await requestJson(apiUrl("/api/proxy/mappings"), {
      method: "PUT",
      body: JSON.stringify({ mappings: proxyMappings })
    });
    setLog(`代理配置已保存，共 ${proxyMappings.length} 条`);
  } catch (error) {
    setLog(`保存代理配置失败: ${error.message}`);
  } finally {
    endRequest();
  }
}

async function applyProxyMappings() {
  beginRequest();
  try {
    const result = await requestJson(apiUrl("/api/proxy/apply"), { method: "POST" });
    setLog(`${result.message}，已应用 ${result.mappingsApplied} 条规则`);
  } catch (error) {
    setLog(`应用代理规则失败: ${error.message}`);
  } finally {
    endRequest();
  }
}

async function loadAll() {
  if (!authToken) {
    setAuthPanelVisible(true, "请先登录");
    return;
  }
  beginRequest();
  try {
    await Promise.all([
      loadServices(),
      loadDockerContainers(),
      loadProxyMappings()
    ]);
  } finally {
    endRequest();
  }
}

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = authUsername.value.trim();
  const pass = authPassword.value;
  if (!user || !pass) {
    setAuthPanelVisible(true, "用户名和密码不能为空");
    return;
  }

  const token = btoa(`${user}:${pass}`);
  saveAuthToken(token);
  setAuthPanelVisible(false);
  authPassword.value = "";
  await loadAll();
});

logoutBtn.addEventListener("click", () => {
  saveAuthToken("");
  tableBody.innerHTML = "";
  dockerTableBody.innerHTML = "";
  proxyMappingBody.innerHTML = "";
  setLog("已退出登录");
});

refreshBtn.addEventListener("click", loadAll);
tabsNav.addEventListener("click", (event) => {
  const btn = event.target.closest(".tab-btn");
  if (!btn) return;
  switchTab(btn.dataset.tab);
});

proxyMappingForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const mapping = {
    containerName: mapContainerName.value.trim(),
    host: mapHost.value.trim(),
    path: mapPath.value.trim() || "/",
    targetPort: Number(mapTargetPort.value),
    listenPort: Number(mapListenPort.value || 80)
  };
  if (!mapping.containerName || !mapping.host || !mapping.targetPort) {
    setLog("新增代理规则失败: 容器名/域名/容器端口必填");
    return;
  }
  if (!mapping.path.startsWith("/")) {
    setLog("新增代理规则失败: 路径必须以 / 开头");
    return;
  }
  if (mapping.path !== "/" && !mapping.path.endsWith("/")) {
    mapping.path = `${mapping.path}/`;
  }
  proxyMappings.push(mapping);
  renderProxyMappings();
  proxyMappingForm.reset();
  mapPath.value = "/";
  mapListenPort.value = "80";
});

saveProxyMappingsBtn.addEventListener("click", saveProxyMappings);
applyProxyMappingsBtn.addEventListener("click", applyProxyMappings);
fillEcsProxyExampleBtn.addEventListener("click", () => {
  mapContainerName.value = "ecs-service-manage";
  mapHost.value = "47.116.180.173";
  mapPath.value = "/manage/";
  mapTargetPort.value = "3000";
  mapListenPort.value = "80";
  switchTab("proxyConfigTab");
  setLog("已填充示例：ecs-service-manage -> http://<host>/manage/");
});

monitorToggleBtn.addEventListener("click", () => {
  const collapsed = monitorPanel.classList.toggle("collapsed");
  monitorToggleBtn.textContent = collapsed ? "展开" : "收起";
  saveMonitorLayout();
});

applyMonitorLayout();
enableMonitorDrag();
enableMonitorResize();

if (authToken) {
  loadAll();
} else {
  setAuthPanelVisible(true, "请先登录");
  setBusy(false);
}
