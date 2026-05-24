# 架构与上下文

## 技术栈

- 后端：`Node.js + Express + ssh2`
- 前端：原生 `HTML/CSS/JavaScript`
- 部署：Docker 容器部署到 ECS
- 镜像仓库：阿里云 ACR 个人版

## 目录结构（当前）

- `server.js`：后端 API、SSH 执行、认证、代理配置应用
- `public/index.html`：面板页面结构（Tab、表格、监视器）
- `public/app.js`：前端状态管理、接口调用、交互逻辑
- `public/styles.css`：响应式与可交互 UI 样式
- `.cursor/rules/*.mdc`：项目级 Agent 规则
- `docs/*.md`：项目文档

## 关键运行机制

1. 面板请求后端 API（Basic Auth）
2. 后端通过 SSH 登录目标 ECS
3. 在远端执行 `systemctl` / `docker` / `nginx` 命令
4. 返回结构化 JSON 给前端展示

## 核心 API（概览）

- 服务管理：
  - `GET /api/services`
  - `POST /api/services/:service/:action`
- 容器管理：
  - `GET /api/docker/containers`
  - `POST /api/docker/containers/:container/:action`
  - `GET /api/docker/containers/:container/logs`
- 对外暴露扫描：
  - `GET /api/exposure/summary`
- 代理配置：
  - `GET /api/proxy/mappings`
  - `PUT /api/proxy/mappings`
  - `POST /api/proxy/apply`

## 配置与约束

- 必填环境变量：
  - `SSH_HOST` `SSH_USER` `MANAGED_SERVICES`
- SSH 认证：
  - `SSH_PASSWORD` 或 `SSH_PRIVATE_KEY_PATH` 至少一个
- 安全建议：
  - 生产务必配置 `PANEL_USERNAME` / `PANEL_PASSWORD`
  - 不提交 `.env`、私钥、仓库口令

## 已知操作习惯

- 镜像版本采用时间戳式版本号
- 端口通常以 `3100` 作为面板对外端口
- 面板运行容器名固定为 `ecs-service-manage`
