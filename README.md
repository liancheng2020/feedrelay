# FeedRelay

将 YouTube 频道更新与指定邮件，持续送到飞书私聊的个人订阅器。

**当前为 v0.1 候选版**：核心实现与自动化测试已完成；真实163邮箱、飞书应用及连续7天试运行尚未验收。无需模型 Key，不生成视频全文摘要。

## 能做什么

- **YouTube**：订阅频道 ID / 标准频道链接，通过公开 RSS 获取标题、简介、时间和原视频链接。
- **邮件**：一个 IMAP 账户与文件夹，按实际发件地址和主题关键词过滤；只读正文，不修改已读状态、不下载附件。
- **飞书**：独立应用机器人向指定 `open_id` 私聊推送短预览，不读取通讯录或聊天历史。
- **管理**：订阅源、更新记录、投递详情、有限重试、未知结果人工核查、保留策略与备份恢复。

首次启用只建立静默基线，不推送历史内容。来源采集与内容外发分别启用；发送超时不会盲目重发。

## 本地体验

需要 **Node.js 24**。

```bash
npm ci
npm run demo
```

打开 <http://localhost:5183>，管理密码 `demo`。所有内容与发送均为模拟，数据隔离在 `data-demo/`，不连接邮箱、飞书或模型服务。点击“模拟一轮更新”验证发现与投递；不要将演示环境暴露到公网。

## 连接自己的来源

```bash
npm run setup
npm run build
npm start
# 另一终端启动持久后台任务
npm run worker
```

`setup` 创建 Git 忽略、权限受限的 `.env`，只显示一次随机管理密码；文件内仅保存密码哈希。默认访问 <http://localhost:8787>。已有 `.env` 不会覆盖，配置项见 [.env.example](.env.example)。

1. **163邮箱**：在邮箱中启用 IMAP，使用专用授权码，不填网页登录密码。配置 `IMAP_ENABLED=1`、`IMAP_HOST=imap.163.com`、`IMAP_PORT=993`、`IMAP_USER`、`IMAP_PASSWORD`、`IMAP_FOLDER`；网页添加 Newsletter 的完整发件地址。文件夹和发件地址需由你确认。
2. **飞书**：新建独立自建应用，启用机器人，仅申请 `im:message:send_as_bot` 发送权限，发布到包含接收人的可用范围，确保接收人与应用可私聊。配置 `FEISHU_ENABLED=1`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、该应用下接收人的 `FEISHU_OPEN_ID`。不沿用 CasePilot 凭证，不需要群 Webhook、事件回调或长连接。
3. 在“投递设置”发送不含私人内容的测试消息；在“订阅源”检查匹配结果，再启用采集和私聊推送。启用邮件外发前需明确确认预览字段。

凭证只在本机/服务器配置，不要贴到聊天、Issue、截图或 Git。不要开放全局通讯录权限只为找 `open_id`；可在飞书开发工具中使用本人身份获取当前应用下标识，无法获取时先核对最小权限方案。

本地开发真实适配器时，将 `.env` 的 `NODE_ENV` 改为 `development`、`APP_ORIGIN=http://localhost:5183`、`EMBED_WORKER=1`，然后 `npm run dev`；端口与访问域名必须和 Origin 一致。

## 部署与恢复

适合一个有持久磁盘、能访问 YouTube / IMAP / 飞书的常驻节点，不适合直接当作 Vercel 无状态函数或 GitHub Pages。

```bash
docker compose up -d --build
npm run backup -- backups/manual.sqlite
# 停止 Web 和 Worker 后；Docker 数据卷请在同一卷内操作
npm run restore -- backups/manual.sqlite --confirm-stopped
```

Web 与 Worker 共享同一 SQLite 数据目录；恢复后待发记录转为待人工核查，避免重放陈旧备份。备份同样含私人信息，需加密保管。公网部署必须 HTTPS，设置准确的 `APP_ORIGIN`、`COOKIE_SECURE=1`；内置监听保持回环地址，由同机反向代理接入。容器端口默认也只绑定本机。

## 验证与边界

```bash
npm run check              # 类型、单元/集成测试、生产构建
npx playwright install chromium
npm run test:e2e           # 独立合成数据库，桌面/手机浏览器测试
```

- v0.1 不支持 `@handle`、视频字幕、通用 RSS、多个邮箱、每日汇总或 AI 摘要；Sift 接入属于后续版本。
- RSS 不是完整上传日志。长时间停机可能漏抓，系统提示覆盖不确定；不承诺实时、零遗漏或 exactly-once。
- “已接受”不等于用户已读；超时/中断进入“待核查”，人工重发可能重复。
- 默认邮件正文7天、其他内容及元数据30天；未解决任务保留最小状态，过期正文和消息快照会清理。删除不等于磁盘安全擦除；旧备份仍需自行清理。
- 当前本机直连公共 YouTube RSS 未成功，真实来源可达性须在目标运行节点验证；模拟通过不能代替真实接入。

[产品需求](docs/PRODUCT.md) · [技术与运维](docs/TECHNICAL_DESIGN.md) · [开发进度](docs/ROADMAP.md) · [验证记录与风险](docs/QUALITY_AND_RISKS.md)
