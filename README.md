# ECS Service Manage

面向 Ubuntu ECS 的轻量级 Web 运维面板。通过 SSH 在远端执行命令，在浏览器中完成 **systemd 服务**、**Docker 容器**、**Nginx 反向代理** 的日常管理，适合手机或桌面快速运维。

## 功能特性

| 模块 | 能力 |
|------|------|
| **Systemd** | 对白名单内服务执行启动 / 停止 / 重启 / 查看状态 |
| **Docker** | 容器列表、启停 / 重启 / 删除、查看日志（最近 200 行，可配置） |
| **Nginx 代理** | 为容器配置「域名 + 路径」映射，保存后一键生成并 reload Nginx |
| **暴露面扫描** | 汇总公网监听端口、Docker 端口映射、现有反向代理规则 |
| **安全** | 面板 Basic Auth、服务/容器白名单、容器名校验、命令白名单 |

## 技术栈

- **后端**：Node.js、Express、[ssh2](https://github.com/mscdex/ssh2)
- **前端**：原生 HTML / CSS / JavaScript（响应式，支持移动端）
- **部署**：Docker（Alpine + Node 20）

## 架构概览

```
浏览器 ──HTTP(Basic Auth)──► Express API ──SSH──► Ubuntu ECS
                                              ├── systemctl
                                              ├── docker
                                              └── nginx
```

面板进程本身可运行在本地或 ECS 上的 Docker 容器中；所有实际操作均通过 SSH 在目标 ECS 上执行。

## 快速开始

### 环境要求

- Node.js 18+（本地开发）
- 可 SSH 登录的 Ubuntu ECS（密码或私钥）
- 远端已安装 `systemd`、`docker`；使用代理功能时需安装 `nginx`

### 1. 克隆与安装

```bash
git clone https://github.com/mjnn/ECS_Service_Manage.git
cd ECS_Service_Manage
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，至少配置以下项：

| 变量 | 必填 | 说明 |
|------|------|------|
| `SSH_HOST` | 是 | ECS 公网 IP 或域名 |
| `SSH_USER` | 是 | SSH 用户名 |
| `SSH_PASSWORD` 或 `SSH_PRIVATE_KEY_PATH` | 二选一 | 认证方式 |
| `MANAGED_SERVICES` | 是 | 允许管理的 systemd 服务，逗号分隔 |
| `PANEL_USERNAME` / `PANEL_PASSWORD` | 建议 | 面板 Basic Auth，公网暴露时务必开启 |
| `MANAGED_CONTAINERS` | 否 | 容器白名单；留空表示允许所有容器 |
| `PANEL_PUBLIC_HOST` / `PANEL_PUBLIC_PATH` | 否 | 经 Nginx 反代时的对外访问地址 |

### 3. 启动

```bash
npm start
```

浏览器访问：`http://localhost:3000`

## 项目结构

```
ECS_Service_Manage/
├── server.js           # Express API、SSH 执行、认证与代理逻辑
├── public/
│   ├── index.html      # 面板页面
│   ├── app.js          # 前端交互与 API 调用
│   └── styles.css      # 样式
├── docs/               # 架构与开发文档
├── Dockerfile
├── .env.example
└── package.json
```

## API 概览

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/services` | 获取白名单服务状态 |
| `POST` | `/api/services/:name/:action` | `start` / `stop` / `restart` / `status` |
| `GET` | `/api/docker/containers` | 容器列表 |
| `POST` | `/api/docker/containers/:name/:action` | `start` / `stop` / `restart` / `remove` |
| `GET` | `/api/docker/containers/:name/logs` | 容器日志 |
| `GET` | `/api/exposure/summary` | 暴露面扫描 |
| `GET` / `PUT` | `/api/proxy/mappings` | 读取 / 保存代理规则 |
| `POST` | `/api/proxy/apply` | 生成 Nginx 配置并 reload |

## Docker 部署

### 本机构建与推送（示例）

镜像命名规范：

`crpi-02k3y8iudey5q0vb.cn-shanghai.personal.cr.aliyuncs.com/mirror_ns/ecs_service_management:<version>`

```powershell
$version = "v1.0.0"
$image = "crpi-02k3y8iudey5q0vb.cn-shanghai.personal.cr.aliyuncs.com/mirror_ns/ecs_service_management:$version"

docker build -t $image .
docker login --username=<your-acr-username> crpi-02k3y8iudey5q0vb.cn-shanghai.personal.cr.aliyuncs.com
docker push $image
```

### ECS 上拉取并运行

```bash
# 1. 登录 ACR 并拉取镜像
docker login --username=<your-acr-username> crpi-02k3y8iudey5q0vb.cn-shanghai.personal.cr.aliyuncs.com
docker pull crpi-02k3y8iudey5q0vb.cn-shanghai.personal.cr.aliyuncs.com/mirror_ns/ecs_service_management:<version>

# 2. 准备 .env（勿提交到 Git）
mkdir -p /opt/ecs_service_management
vi /opt/ecs_service_management/.env

# 3. 选择空闲端口（从 3100 起递增亦可）
PORT=3100
while ss -lnt | awk '{print $4}' | grep -q ":${PORT}$"; do PORT=$((PORT+1)); done
echo "Use port: $PORT"

# 4. 启动容器
docker rm -f ecs-service-manage 2>/dev/null || true
docker run -d \
  --name ecs-service-manage \
  --restart unless-stopped \
  --env-file /opt/ecs_service_management/.env \
  -p ${PORT}:3000 \
  crpi-02k3y8iudey5q0vb.cn-shanghai.personal.cr.aliyuncs.com/mirror_ns/ecs_service_management:<version>
```

验收：

```bash
docker ps | grep ecs-service-manage
curl -I http://127.0.0.1:${PORT}/
```

若使用私钥登录 ECS，需将私钥挂载进容器，并在 `.env` 中设置 `SSH_PRIVATE_KEY_PATH` 为容器内路径（例如 `/opt/keys/id_rsa`）。

## 安全建议

- **不要**将 `.env`、私钥、真实密码提交到仓库（`.env` 已在 `.gitignore` 中忽略）。
- 公网暴露面板时，务必配置 `PANEL_USERNAME` / `PANEL_PASSWORD`，并修改默认弱口令。
- `MANAGED_SERVICES` 仅填写必要服务，降低误操作风险。
- 建议在云安全组中收敛来源 IP，仅允许可信网段访问面板端口。
- Docker 操作限定白名单动作；容器名经过格式校验，防止命令注入。

## 常见问题

**页面提示 `Failed to load services: All configured authentication methods failed`**

- ECS 可能仅允许公钥登录（禁用了 root 密码）。
- 检查 `SSH_HOST`、`SSH_PORT`、`SSH_USER` 是否正确。
- 在 `.env` 中配置 `SSH_PRIVATE_KEY_PATH`，部署时挂载私钥到容器内对应路径。
- 可在本机先用 `ssh -i <key> user@host` 验证连通性。

**面板在容器内需要 SSH 回连本机**

- 使用容器可读挂载路径，例如 `-v /root/.ssh/id_rsa:/opt/keys/id_rsa:ro`，并设置 `SSH_PRIVATE_KEY_PATH=/opt/keys/id_rsa`。

## 文档

- [项目定位](docs/PROJECT_POSITIONING.md)
- [架构与上下文](docs/ARCHITECTURE_AND_CONTEXT.md)
- [Agent 开发指南](docs/AGENT_DEVELOPMENT_GUIDE.md)
- [最佳实践](docs/BEST_PRACTICES_AND_CONVERGENCE.md)

## License

MIT
