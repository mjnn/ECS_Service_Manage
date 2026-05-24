const path = require("path");
const express = require("express");
const dotenv = require("dotenv");
const { Client } = require("ssh2");

dotenv.config();

const app = express();
app.use(express.json());

const requiredEnv = ["SSH_HOST", "SSH_USER", "MANAGED_SERVICES"];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const managedServices = process.env.MANAGED_SERVICES.split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const managedContainers = (process.env.MANAGED_CONTAINERS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

if (managedServices.length === 0) {
  console.error("MANAGED_SERVICES cannot be empty.");
  process.exit(1);
}

if (!process.env.SSH_PASSWORD && !process.env.SSH_PRIVATE_KEY_PATH) {
  console.error("Either SSH_PASSWORD or SSH_PRIVATE_KEY_PATH must be provided.");
  process.exit(1);
}

const allowedActions = new Set(["start", "stop", "restart", "status"]);
const allowedDockerActions = new Set(["start", "stop", "restart", "remove"]);
const safeContainerPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const proxyMappingsFile = "/opt/ecs_service_management/proxy-mappings.json";
const generatedNginxSnippetFile = "/etc/nginx/snippets/ecs-service-manage-generated-locations.conf";
const nginxDefaultSiteFile = "/etc/nginx/sites-enabled/default";
const panelPublicHost = process.env.PANEL_PUBLIC_HOST || process.env.SSH_HOST;
const panelPublicPath = (process.env.PANEL_PUBLIC_PATH || "/ops/ecs-manage/").startsWith("/")
  ? (process.env.PANEL_PUBLIC_PATH || "/ops/ecs-manage/")
  : `/${process.env.PANEL_PUBLIC_PATH || "ops/ecs-manage/"}`;
const normalizedPanelPublicPath = panelPublicPath.endsWith("/") ? panelPublicPath : `${panelPublicPath}/`;

function buildCanonicalPanelUrl(req) {
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  return `http://${panelPublicHost}${normalizedPanelPublicPath}${query}`;
}

app.get("/", (req, res, next) => {
  if (!req.headers["x-real-ip"]) {
    res.redirect(302, buildCanonicalPanelUrl(req));
    return;
  }
  next();
});

app.get("/index.html", (req, res, next) => {
  if (!req.headers["x-real-ip"]) {
    res.redirect(302, buildCanonicalPanelUrl(req));
    return;
  }
  next();
});

app.use(express.static(path.join(__dirname, "public")));

function verifyServiceAllowed(serviceName) {
  return managedServices.includes(serviceName);
}

function verifyContainerAllowed(containerName) {
  if (managedContainers.length === 0) {
    return true;
  }
  return managedContainers.includes(containerName);
}

function formatAuthError(error) {
  const rawError = error.message || String(error);
  if (rawError.includes("All configured authentication methods failed")) {
    return `${rawError}. ECS likely allows publickey only; configure SSH_PRIVATE_KEY_PATH.`;
  }
  return rawError;
}

function validateProxyPath(inputPath) {
  if (!inputPath || inputPath === "/") return "/";
  if (!inputPath.startsWith("/")) return null;
  if (inputPath.includes("..") || inputPath.includes(" ")) return null;
  return inputPath.endsWith("/") ? inputPath : `${inputPath}/`;
}

function normalizeUpstreamPath(inputPath) {
  if (!inputPath) return "/";
  if (!inputPath.startsWith("/") || inputPath.includes("..") || inputPath.includes(" ")) {
    return null;
  }
  return inputPath;
}

function validateProxyMapping(mapping) {
  if (!mapping || typeof mapping !== "object") return "Invalid mapping object";
  if (!safeContainerPattern.test(mapping.containerName || "")) return "Invalid containerName";
  if (!/^[a-zA-Z0-9.-]+$/.test(mapping.host || "")) return "Invalid host";
  const pathValue = validateProxyPath(mapping.path || "/");
  if (!pathValue) return "Invalid path";
  const targetPort = Number(mapping.targetPort);
  if (!Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) {
    return "Invalid targetPort";
  }
  const listenPort = Number(mapping.listenPort || 80);
  if (!Number.isInteger(listenPort) || listenPort <= 0 || listenPort > 65535) {
    return "Invalid listenPort";
  }
  const upstreamPath = normalizeUpstreamPath(mapping.upstreamPath || "/");
  if (!upstreamPath) return "Invalid upstreamPath";
  return null;
}

function normalizeProxyMapping(mapping) {
  return {
    containerName: mapping.containerName,
    host: mapping.host,
    path: validateProxyPath(mapping.path || "/") || "/",
    targetPort: Number(mapping.targetPort),
    listenPort: Number(mapping.listenPort || 80),
    upstreamPath: normalizeUpstreamPath(mapping.upstreamPath || "/") || "/"
  };
}

async function readProxyMappings() {
  const result = await runSshCommand(
    `if [ -f ${proxyMappingsFile} ]; then cat ${proxyMappingsFile}; else echo '[]'; fi`
  );
  try {
    const parsed = JSON.parse(result.stdout || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function buildNginxLocationSnippet(mappings, resolvedTargets) {
  const lines = ["# Generated by ecs-service-manage. Do not edit manually.", ""];
  mappings.forEach((mapping, index) => {
    const target = resolvedTargets[index];
    const pathPrefix = mapping.path.endsWith("/") ? mapping.path.slice(0, -1) : mapping.path;
    const upstreamPath = normalizeUpstreamPath(mapping.upstreamPath || "/") || "/";
    const proxyPass = `http://${target}${upstreamPath}`;

    if (mapping.path !== "/") {
      lines.push(`location = ${pathPrefix} { return 301 ${mapping.path}; }`);
    }

    lines.push(`location ${mapping.path} {`);
    lines.push(`    proxy_pass ${proxyPass};`);
    lines.push("    proxy_set_header Host $host;");
    lines.push("    proxy_set_header X-Real-IP $remote_addr;");
    lines.push("    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;");
    lines.push("    proxy_set_header X-Forwarded-Proto $scheme;");
    lines.push("}");
    lines.push("");
  });
  return lines.join("\n");
}

function parseListeningSockets(ssOutput) {
  const lines = ssOutput.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines
    .map((line) => {
      const parts = line.split(/\s+/);
      if (parts.length < 5) return null;
      const proto = parts[0].toLowerCase();
      const localAddress = parts[3];
      const process = parts.slice(5).join(" ");
      const match = localAddress.match(/^(.*):(\d+)$/);
      if (!match) return null;
      const host = match[1];
      const port = Number(match[2]);
      const isPublic = host === "0.0.0.0" || host === "*" || host === "::" || host === "[::]";
      return {
        proto,
        host,
        port,
        process: process || "-",
        isPublic
      };
    })
    .filter(Boolean);
}

function parseDockerPortMappings(dockerPsOutput) {
  const lines = dockerPsOutput.split("\n").map((line) => line.trim()).filter(Boolean);
  const results = [];
  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      const ports = item.Ports || "";
      const mappings = ports
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((entry) => {
          const m = entry.match(/(?:0\.0\.0\.0|:::|::):?(\d+)->(\d+)\/(tcp|udp)/i);
          if (!m) return null;
          return {
            hostPort: Number(m[1]),
            containerPort: Number(m[2]),
            proto: (m[3] || "tcp").toLowerCase()
          };
        })
        .filter(Boolean);
      results.push({
        name: item.Names,
        image: item.Image,
        mappings
      });
    } catch (error) {
      // ignore malformed row
    }
  }
  return results;
}

function parseNginxProxyRules(nginxText) {
  const lines = nginxText.split("\n");
  const rules = [];
  let currentServerNames = [];
  let currentListenPorts = [];
  let currentLocation = "/";
  let blockLevel = 0;
  let inServer = false;
  let inLocation = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("server {")) {
      inServer = true;
      currentServerNames = [];
      currentListenPorts = [];
    } else if (inServer && line.startsWith("server_name ")) {
      const names = line
        .replace("server_name", "")
        .replace(";", "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      currentServerNames = names.length ? names : ["_"];
    } else if (inServer && line.startsWith("listen ")) {
      const listenPart = line.replace("listen", "").replace(";", "").trim();
      const portMatch = listenPart.match(/(\d+)/);
      if (portMatch) {
        currentListenPorts.push(Number(portMatch[1]));
      }
    } else if (inServer && line.startsWith("location ")) {
      const locationMatch = line.match(/^location\s+([^\s{]+)\s*\{/);
      currentLocation = locationMatch ? locationMatch[1] : "/";
      inLocation = true;
    } else if (inServer && inLocation && line.startsWith("proxy_pass ")) {
      const upstream = line.replace("proxy_pass", "").replace(";", "").trim();
      const hosts = currentServerNames.length ? currentServerNames : ["_"];
      const ports = currentListenPorts.length ? currentListenPorts : [80];
      for (const host of hosts) {
        for (const port of ports) {
          const protocol = port === 443 ? "https" : "http";
          const base = host === "_" ? "<server_ip>" : host;
          const urlPath = currentLocation === "/" ? "" : currentLocation;
          rules.push({
            host,
            listenPort: port,
            location: currentLocation,
            proxyPass: upstream,
            url: `${protocol}://${base}${urlPath}`
          });
        }
      }
    }

    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    blockLevel += opens - closes;
    if (inLocation && closes > 0 && blockLevel >= 1) {
      inLocation = false;
    }
    if (inServer && blockLevel <= 0) {
      inServer = false;
      inLocation = false;
    }
  }

  const seen = new Set();
  return rules.filter((rule) => {
    const key = `${rule.host}|${rule.listenPort}|${rule.location}|${rule.proxyPass}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function runSshCommand(command) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";

    const connectOptions = {
      host: process.env.SSH_HOST,
      port: Number(process.env.SSH_PORT || 22),
      username: process.env.SSH_USER,
      readyTimeout: 20000,
      tryKeyboard: true
    };

    if (process.env.SSH_PRIVATE_KEY_PATH) {
      connectOptions.privateKey = require("fs").readFileSync(
        process.env.SSH_PRIVATE_KEY_PATH,
        "utf-8"
      );
      if (process.env.SSH_PASSPHRASE) {
        connectOptions.passphrase = process.env.SSH_PASSPHRASE;
      }
    } else {
      connectOptions.password = process.env.SSH_PASSWORD;
    }

    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            reject(err);
            return;
          }

          stream
            .on("close", (code) => {
              conn.end();
              resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
            })
            .on("data", (data) => {
              stdout += data.toString();
            });

          stream.stderr.on("data", (data) => {
            stderr += data.toString();
          });
        });
      })
      .on("error", (err) => {
        reject(err);
      })
      .on("keyboard-interactive", (name, instructions, instructionsLang, prompts, finish) => {
        if (!process.env.SSH_PASSWORD) {
          finish([]);
          return;
        }
        const responses = prompts.map(() => process.env.SSH_PASSWORD);
        finish(responses);
      })
      .connect(connectOptions);
  });
}

function authMiddleware(req, res, next) {
  const username = process.env.PANEL_USERNAME;
  const password = process.env.PANEL_PASSWORD;

  if (!username || !password) {
    next();
    return;
  }

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) {
    res.set("WWW-Authenticate", "Basic realm=\"ECS Service Panel\"");
    res.status(401).json({ message: "Authentication required" });
    return;
  }

  const credentials = Buffer.from(auth.split(" ")[1], "base64").toString("utf-8");
  const [inputUser, inputPass] = credentials.split(":");

  if (inputUser !== username || inputPass !== password) {
    res.set("WWW-Authenticate", "Basic realm=\"ECS Service Panel\"");
    res.status(401).json({ message: "Invalid credentials" });
    return;
  }

  next();
}

app.use(authMiddleware);

app.use((req, res, next) => {
  const isDirectPortAccess = !req.headers["x-real-ip"];
  const shouldRedirectMethod = req.method === "GET" || req.method === "HEAD";
  const isApiRequest = req.path.startsWith("/api/");

  if (!isDirectPortAccess || !shouldRedirectMethod || isApiRequest) {
    next();
    return;
  }

  let destinationPath = normalizedPanelPublicPath;
  if (req.path !== "/" && req.path !== "/index.html") {
    if (req.path.startsWith(normalizedPanelPublicPath)) {
      destinationPath = req.path;
    } else {
      destinationPath = `${normalizedPanelPublicPath}${req.path.replace(/^\/+/, "")}`;
    }
  }

  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const redirectTarget = `http://${panelPublicHost}${destinationPath}${query}`;
  res.redirect(302, redirectTarget);
});

app.get("/api/services", async (req, res) => {
  try {
    const results = [];
    for (const serviceName of managedServices) {
      const { code, stdout, stderr } = await runSshCommand(
        `systemctl is-active ${serviceName} || true`
      );
      results.push({
        name: serviceName,
        state: stdout || "unknown",
        code,
        stderr
      });
    }
    res.json({ services: results });
  } catch (error) {
    res.status(500).json({
      message: "Failed to load services",
      error: formatAuthError(error)
    });
  }
});

app.post("/api/services/:serviceName/:action", async (req, res) => {
  const { serviceName, action } = req.params;

  if (!verifyServiceAllowed(serviceName)) {
    res.status(400).json({ message: `Service not allowed: ${serviceName}` });
    return;
  }

  if (!allowedActions.has(action)) {
    res.status(400).json({ message: `Unsupported action: ${action}` });
    return;
  }

  const command =
    action === "status"
      ? `systemctl status ${serviceName} --no-pager`
      : `systemctl ${action} ${serviceName}`;

  try {
    const result = await runSshCommand(command);
    res.json({
      serviceName,
      action,
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr
    });
  } catch (error) {
    res.status(500).json({ message: "Command failed", error: formatAuthError(error) });
  }
});

app.get("/api/docker/containers", async (req, res) => {
  try {
    const result = await runSshCommand("docker ps -a --format '{{json .}}'");
    const lines = result.stdout ? result.stdout.split("\n").filter(Boolean) : [];
    const containers = lines
      .map((line) => {
        try {
          const item = JSON.parse(line);
          return {
            id: item.ID,
            name: item.Names,
            image: item.Image,
            state: item.State,
            status: item.Status
          };
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean)
      .filter((item) => verifyContainerAllowed(item.name));

    res.json({ containers });
  } catch (error) {
    res.status(500).json({
      message: "Failed to load docker containers",
      error: formatAuthError(error)
    });
  }
});

app.post("/api/docker/containers/:containerName/:action", async (req, res) => {
  const { containerName, action } = req.params;

  if (!safeContainerPattern.test(containerName)) {
    res.status(400).json({ message: `Invalid container name: ${containerName}` });
    return;
  }

  if (!verifyContainerAllowed(containerName)) {
    res.status(400).json({ message: `Container not allowed: ${containerName}` });
    return;
  }

  if (!allowedDockerActions.has(action)) {
    res.status(400).json({ message: `Unsupported action: ${action}` });
    return;
  }

  const command = action === "remove" ? `docker rm -f ${containerName}` : `docker ${action} ${containerName}`;

  try {
    const result = await runSshCommand(command);
    res.json({
      containerName,
      action,
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr
    });
  } catch (error) {
    res.status(500).json({
      message: "Docker command failed",
      error: formatAuthError(error)
    });
  }
});

app.get("/api/docker/containers/:containerName/logs", async (req, res) => {
  const { containerName } = req.params;
  const tail = Math.min(Math.max(Number(req.query.tail || 200), 1), 1000);

  if (!safeContainerPattern.test(containerName)) {
    res.status(400).json({ message: `Invalid container name: ${containerName}` });
    return;
  }

  if (!verifyContainerAllowed(containerName)) {
    res.status(400).json({ message: `Container not allowed: ${containerName}` });
    return;
  }

  try {
    const result = await runSshCommand(`docker logs --tail ${tail} ${containerName}`);
    res.json({
      containerName,
      tail,
      exitCode: result.code,
      logs: [result.stdout, result.stderr].filter(Boolean).join("\n")
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to read docker logs",
      error: formatAuthError(error)
    });
  }
});

app.get("/api/exposure/summary", async (req, res) => {
  try {
    const [ssResult, dockerResult, nginxResult] = await Promise.all([
      runSshCommand("ss -lntpH || true"),
      runSshCommand("docker ps --format '{{json .}}' || true"),
      runSshCommand("nginx -T 2>/dev/null || true")
    ]);

    const sockets = parseListeningSockets(ssResult.stdout)
      .filter((item) => item.isPublic)
      .sort((a, b) => a.port - b.port);
    const dockerMappings = parseDockerPortMappings(dockerResult.stdout).filter(
      (item) => item.mappings.length > 0
    );
    const proxyRules = parseNginxProxyRules(nginxResult.stdout).map((rule) => ({
      ...rule,
      url: rule.url.replace("<server_ip>", process.env.SSH_HOST)
    }));

    res.json({
      serverIp: process.env.SSH_HOST,
      publicServices: sockets,
      dockerPublished: dockerMappings,
      reverseProxyUrls: proxyRules
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to load exposure summary",
      error: formatAuthError(error)
    });
  }
});

app.get("/api/proxy/mappings", async (req, res) => {
  try {
    const mappings = await readProxyMappings();
    res.json({ mappings });
  } catch (error) {
    res.status(500).json({ message: "Failed to load proxy mappings", error: formatAuthError(error) });
  }
});

app.put("/api/proxy/mappings", async (req, res) => {
  const mappings = Array.isArray(req.body?.mappings) ? req.body.mappings : null;
  if (!mappings) {
    res.status(400).json({ message: "mappings must be an array" });
    return;
  }

  for (const mapping of mappings) {
    const error = validateProxyMapping(mapping);
    if (error) {
      res.status(400).json({ message: error, mapping });
      return;
    }
  }

  const normalized = mappings.map(normalizeProxyMapping);
  const content = Buffer.from(JSON.stringify(normalized, null, 2), "utf-8").toString("base64");
  try {
    await runSshCommand(
      `mkdir -p /opt/ecs_service_management && printf %s '${content}' | base64 -d > ${proxyMappingsFile}`
    );
    res.json({ message: "Proxy mappings saved", mappings: normalized });
  } catch (error) {
    res.status(500).json({ message: "Failed to save proxy mappings", error: formatAuthError(error) });
  }
});

app.post("/api/proxy/apply", async (req, res) => {
  try {
    const mappings = await readProxyMappings();
    if (!mappings.length) {
      res.status(400).json({ message: "No proxy mappings configured" });
      return;
    }

    const resolvedTargets = [];
    for (const mapping of mappings) {
      const targetPort = Number(mapping.targetPort);
      const lookup = await runSshCommand(
        `docker port ${mapping.containerName} ${targetPort}/tcp 2>/dev/null | head -n 1 || true`
      );
      const output = lookup.stdout.trim();
      const portMatch = output.match(/:(\d+)$/);
      if (portMatch) {
        resolvedTargets.push(`127.0.0.1:${Number(portMatch[1])}`);
        continue;
      }

      // Fallback to container IP when host port is not published.
      const ipLookup = await runSshCommand(
        `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${mapping.containerName} 2>/dev/null || true`
      );
      const containerIp = ipLookup.stdout.trim();
      if (!containerIp) {
        res.status(400).json({
          message: `Cannot resolve target for ${mapping.containerName}:${targetPort}. Publish port or ensure container is running.`
        });
        return;
      }
      resolvedTargets.push(`${containerIp}:${targetPort}`);
    }

    const nginxConf = buildNginxLocationSnippet(mappings, resolvedTargets);
    const encoded = Buffer.from(nginxConf, "utf-8").toString("base64");
    await runSshCommand(
      `printf %s '${encoded}' | base64 -d > ${generatedNginxSnippetFile} && grep -q 'include ${generatedNginxSnippetFile};' ${nginxDefaultSiteFile} || sed -i '/include \\/etc\\/nginx\\/snippets\\/toolbox-locations.conf;/a\\    include ${generatedNginxSnippetFile};' ${nginxDefaultSiteFile} && nginx -t && systemctl reload nginx`
    );

    res.json({
      message: "Nginx proxy rules applied",
      generatedFile: generatedNginxSnippetFile,
      mappingsApplied: mappings.length
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to apply proxy rules", error: formatAuthError(error) });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`ECS service panel is running at http://localhost:${port}`);
});
