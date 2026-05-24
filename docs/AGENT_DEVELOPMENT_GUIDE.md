# Agent 开发指南

## 目标

让任何新接手的 Agent 能在最少沟通成本下：

- 快速理解当前项目状态
- 按既定方式实现需求
- 以最小风险完成发布与验证

## Agent 必须遵守的工作顺序

1. **读上下文**：先看 `README.md` 与 `docs/`，再看 `.cursor/rules/`
2. **实现需求**：优先做小步可验证改动
3. **本地验证**：至少做语法检查 + lints
4. **按固定流程发布**：本机构建 -> ACR push -> ECS pull/run
5. **回执结果**：给出版本号、容器状态、访问地址、验证结果

## 发布流程（强约束）

- 镜像命名固定：
  - `crpi-02k3y8iudey5q0vb.cn-shanghai.personal.cr.aliyuncs.com/mirror_ns/ecs_service_management:<version>`
- 必经步骤：
  - 本地 `docker build`
  - 本地 `docker login` + `docker push`
  - ECS 上 `docker login` + `docker pull`
  - ECS 上重启容器并保持 `--restart unless-stopped`

## ECS 容器运行基线

- 容器名：`ecs-service-manage`
- 映射端口：`3100:3000`（或空闲端口）
- 挂载：
  - `/opt/ecs_service_management/.env`
  - `/opt/ecs_service_management/ssh:/opt/keys:ro`
  - `/var/run/docker.sock:/var/run/docker.sock`

## 常见问题处理策略

- `All configured authentication methods failed`
  - 优先判定为 SSH 认证方式不匹配，切换私钥
- `ECONNREFUSED 127.0.0.1:22`（容器内）
  - 判定为容器误连自身，修正 `SSH_HOST`
- `TLS handshake timeout`（push/pull）
  - 采用重试策略（3~5 次）并记录结果

## 输出规范（对用户）

- 先给结论，再给关键动作
- 必须包含：
  - 镜像版本号
  - ECS 容器状态
  - 可访问地址
  - 未完成项与下一步
