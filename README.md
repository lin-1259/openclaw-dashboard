# OpenClaw Dashboard

一个为 [OpenClaw](https://github.com/openclaw/openclaw) 设计的任务看板，实时展示所有会话状态、定时任务、进程日志和上下文用量。

## 功能

- **会话列表** — 所有 Discord/Signal 等频道的会话，显示状态、任务描述、上下文进度条
- **定时任务** — cron session 可点击查看运行日志
- **进程/日志** — 实时查看 `/tmp/*.log` 日志文件，支持高亮（error/warning/success）
- **会话详情** — 分页加载对话历史（含工具调用/结果），缓存加速
- **搜索过滤** — 实时搜索频道名/任务描述
- **上下文警告** — 上下文超 80% 自动推送 Discord 提醒
- **开机自启** — 通过 pm2 管理

## 安装

```bash
# 克隆到 OpenClaw workspace
git clone https://github.com/lin-1259/openclaw-dashboard ~/.openclaw/workspace/dashboard

# 安装 pm2（如未安装）
npm install -g pm2

# 启动
cd ~/.openclaw/workspace/dashboard
pm2 start server.js --name dashboard
pm2 save
pm2 startup
```

## 配置

编辑 `server.js` 顶部的常量：

```js
const PORT = 19999;                          // 端口
const ALERT_CHANNEL = '你的Discord频道ID';    // 上下文警告推送频道
const CONTEXT_LIMIT = 200000;                // 模型上下文上限（tokens）
const ALERT_THRESHOLD = 0.8;                 // 警告阈值（80%）
const ALERT_COOLDOWN = 30 * 60 * 1000;       // 警告冷却时间（30分钟）
```

## 访问

```
http://your-server-ip:19999
```

## 依赖

- Node.js 18+
- pm2
- OpenClaw（sessions 目录：`~/.openclaw/agents/main/sessions/`）
