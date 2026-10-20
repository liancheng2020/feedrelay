# 技术与运维

## 结构

| 层 | 实现 | 职责 |
| --- | --- | --- |
| 页面 | Vue 3、TypeScript、Vite、Lucide | 订阅、列表、详情、设置、日报 |
| API | Koa、koa-session | 请求校验、配置和任务操作 |
| 存储 | Node.js SQLite、WAL | 内容、游标、任务、发送记录、用量 |
| 后台 | Engine、数据库租约 | 定时采集、摘要、日报和发送 |
| 来源 | RSS Parser、ImapFlow、MailParser、yt-dlp | Feed、邮件和视频文本提取 |
| 摘要 | DeepSeek Chat Completions | 全文提炼、结构校验和要点输出 |
| 推送 | 微信 ClawBot / 飞书应用机器人 | 当前绑定目标的纯文本消息 |

新安装默认 `EMBED_WORKER=1`，API 和后台任务同进程运行。设置为0时，用 `npm run worker` 独立启动后台，两者共享 `DATA_DIR`。进程锁和数据库租约避免重复运行任务。

## 完整链路

1. 后台约每5秒检查到期任务；来源实际采集频率由设置决定。
2. YouTube先读频道RSS，404/5xx且已配置yt-dlp时备用读取最近15条上传元数据。邮箱按UID只读匹配邮件；RSS读取公开Feed。
3. 事务保存内容、来源关联和游标。先落库再推进游标，按内容键去重；首次基线不推送历史。
4. 开启摘要的订阅创建或复用摘要任务。按需模式等待用户操作；自动模式处理新内容。
5. 摘要成功后，将标题和编号要点写入待推送记录。失败不发布部分结果，不回退为原文。
6. 即时记录直接等待发送；日报记录由汇总窗口生成消息部分。每次发送前检查来源、目标和内容是否仍有效。
7. 保存平台结果和尝试记录。明确可重试的失败有限重试，结果不确定转人工核查。

发送与摘要队列分开；发送领取时检查摘要就绪条件，所以后台先检查发送队列也不会提前发原文。生产循环不等待长摘要结束，继续轮询采集、日报和就绪消息；摘要保持单并发，手动摘要优先领取，不中断正在执行的任务。长摘要运行期间保留 Worker 租约，每30秒续租并更新心跳；租约丢失取消任务，停止服务会等待取消完成。

FR-43：跨平台用户服务、运行检查、日志轮转和可选自动备份见[自托管指南](SELF_HOSTING.md)。托管运行器只覆盖本机运行方式，不修改 `.env`；启动前拒绝已有进程和端口冲突。Windows 通过 IPC 执行同一关闭流程，系统强杀仍可能产生需核查记录。

## 数据和一致性

数据库当前为schema v5。主要表：

- `sources`、`mailbox_cursors`：来源配置、代次和采集位置。
- `items`、`source_items`：内容、去重键和来源关联。
- `jobs`、`summaries`：采集/摘要任务、状态和执行租约。
- `deliveries`、`attempts`、`digest_batches`：发送快照、尝试和日报批次。
- `model_calls`：每次模型请求的预留费用和实际用量。
- `meta`、`events`、`locks`、`admin_sessions`：设置、审计、锁及可选登录会话。

消息排队后保存快照；目标变化不把旧记录自动改投。暂停来源、删除内容、授权变化会使相关未发送任务失效。摘要缓存依据内容、范围、模型配置、授权及目标校验；失败重试不清空既有费用。

模型请求前事务预留额度，收到usage后计账；失败和修复也占用预算。累计预算不会每天自动重置。列表、筛选、详情统一关联原内容与其最新有效摘要的发送记录。

## 视频内容提取

安装独立Python环境：

```bash
python3 -m venv .cache/youtube-venv
.cache/youtube-venv/bin/python -m pip install -r requirements-youtube.txt
```

设置 `YOUTUBE_CAPTIONS_ENABLED=1`，`YOUTUBE_CAPTIONS_PYTHON` 填该环境Python的绝对路径。优先人工字幕，其次自动字幕，保留时间定位。

需要无字幕音频转写时，继续安装并下载本地模型：

```bash
.cache/youtube-venv/bin/python -m pip install -r requirements-asr.txt
.cache/youtube-venv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('Systran/faster-whisper-base', local_dir='.cache/asr-model', allow_patterns=['config.json','model.bin','tokenizer.json','vocabulary.*','preprocessor_config.json'])"
```

设置 `YOUTUBE_ASR_ENABLED=1`；其他模型位置用 `YOUTUBE_ASR_MODEL` 指定。模型需提前准备，运行时不会自动下载。

仅字幕确实缺失或为空时尝试本地转写；网络或登录限制不会触发绕过。使用faster-whisper完整处理音频，任务结束清理临时文件，不下载视频画面。

| 输入 | 上限 |
| --- | --- |
| 邮件 / RSS 正文 | 20000码元、2次模型请求、60秒 |
| 视频文本 | 48000码元，按约12000码元分段，最多12次模型请求 |
| 字幕任务 | 4分钟 |
| 含本地转写的任务 | 最长60分钟视频、100MB音频、总任务35分钟 |

超限直接报错，不静默截断。转写和模型均可能出错，原文定位仅用于核查，不保证结论正确。

## 网络和凭证

`.env` 保存接入配置，不提交到Git。频道解析/RSS用 `YOUTUBE_PROXY_URL`，字幕/音频用 `YOUTUBE_CAPTIONS_PROXY_URL`，两者独立且不继承浏览器代理。远程环境中的127.0.0.1指远程机器自身。

RSS仅允许公共HTTPS地址，检查DNS和每次重定向，拒绝私网、账号和Token等受限地址。邮件只读，不取附件。

微信凭证使用 `SESSION_SECRET` 派生密钥进行AES-GCM加密；修改该密钥会影响已有绑定。入站消息只更新绑定人的发送上下文，不触发任务或模型调用。微信和飞书二选一。

## 本机访问和密码模式

`AUTH_MODE=local` 是默认值。监听仅允许127.0.0.1或::1，页面Origin必须为回环地址。后端检查真实连接地址、Host、Origin和转发头，拒绝跨站或代理请求；修改操作仍需要会话Cookie及CSRF令牌。本机会话不生成密码登录凭证。

本机模式不提供改密和退出接口，不用于反向代理、端口转发或远程共享。需要登录访问时显式设置 `AUTH_MODE=password`，运行构建后的 `npm run reset-password` 设置新密码。密码8–16位，默认会话8小时，可选30天；改密撤销全部会话。部署为公网服务还需正确配置HTTPS和代理，不能直接开放本机模式。

Compose使用密码模式，容器内部监听0.0.0.0，宿主端口仅发布到127.0.0.1。默认镜像不包含本地转写依赖，Docker及公网代理部署需在目标环境单独验证。

## 日报

AIHOT请求 `https://aihot.news/api/v1/dailies/latest`，只接收当天版次；北京时间10点后获取，未就绪每小时重试并遵守Retry-After。按日期唯一批次去重，保留来源链接，不调用DeepSeek。

订阅汇总按设置时区和时间执行，每批最多500条，只纳入已就绪内容。消息过长拆为多部分，各部分独立记录发送结果。

## 升级和恢复

升级前备份，停止Web和Worker后安装依赖、构建并重启；启动时自动迁移数据库，旧版本不能直接打开新schema。

```bash
npm run backup -- backups/manual.sqlite
# 停止Web与Worker后执行
npm run restore -- backups/manual.sqlite --confirm-stopped
```

恢复后旧待发记录需要核查，不自动重放；摘要和AIHOT自动开关停用，微信需重新绑定，密码会话清除，用量账本保留。确认配置后再启用自动处理。

默认邮件正文保留7天、其他内容保留30天，去重和审计等最小记录按保留策略清理。页面删除不等于磁盘安全擦除，旧备份需自行管理。
