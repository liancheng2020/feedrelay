# 单用户自托管

每个人在自己的电脑上运行一个独立实例，使用自己的来源、模型 Key、邮箱和微信或飞书。不是公共在线服务，不需要注册，也不支持多人共享后台。

## 安装和首次使用

macOS、Windows、Linux 共用 Node.js 24 和同一套核心程序。先安装 Git、Node.js 24，再在终端或 PowerShell 运行：

```text
git clone https://github.com/liancheng2020/feedrelay.git
cd feedrelay
npm ci
npm run setup
npm run build
npm start
```

打开 http://localhost:8787。浏览器可以关闭；终端里的程序退出后任务停止。重复运行 setup 保留原配置，不覆盖凭证。

1. 按 README 配置本机 `.env`，重启服务。
2. 在“投递设置 → 运行检查”确认后台、来源、模型预算和推送通道。
3. 添加来源并启用采集和推送，选择自动摘要，确认来源授权。
4. 首次采集只建基线。等待新内容，确认接收端实际收到摘要消息，才算完整跑通。主动发送测试需要自己点击确认。

模型、邮箱和微信都未配置时仍可打开页面；“已配置”不等于外部连接已验证。API 健康也不等于全部链路可用。

## 来源、摘要和推送

在项目目录的 `.env` 中填写配置，保存后重启服务。完整字段见 [.env.example](../.env.example)，不要把密钥粘贴到问题反馈中。

| 接入项 | 配置与操作 |
| --- | --- |
| DeepSeek | 只填 `DEEPSEEK_API_KEY`；默认模型和预算估算单价已内置，再在“投递设置”开启摘要并确认累计预算 |
| 微信 | 默认通道，无需填凭证；在“投递设置”扫码绑定，向 ClawBot 发一条消息，再测试连接 |
| 飞书 | 设置 `PUSH_CHANNEL=feishu` 及 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_OPEN_ID`；机器人需 `im:message:send_as_bot` 权限 |
| 邮箱 | 开启邮箱 IMAP，只填 `IMAP_HOST`、`IMAP_USER`、`IMAP_PASSWORD`；默认 TLS 993、INBOX，使用授权码而非网页登录密码 |
| YouTube | 添加频道 `@用户名`、链接或频道 ID；全文摘要需安装下文的视频组件 |
| RSS / Atom | 添加公开 HTTPS Feed 地址，只读取 Feed 提供的正文，不自动抓取文章网页 |

邮件规则填写实际发件地址，主题关键词可选。只读取指定文件夹中匹配的邮件正文，不修改已读状态、不下载附件；目前只支持一个邮箱连接。

来源需同时启用采集、私聊推送、自动摘要并完成授权，才会自动采集、摘要、推送。按需摘要需要手动生成；关闭摘要则发送原文预览。采集间隔在“投递设置”调整，选择日报的来源会在汇总时间发送，不是即时发送。

AIHOT 日报需在“每日日报”单独开启，每天北京时间 10:00 获取当天内容，不调用模型。10 点后首次开启则从次日开始，当天未发布会稍后重试；它与订阅汇总互相独立。

最新更新支持 10/20/50/100 条分页，默认 20 条；详情可查看正文、摘要及发送记录。删除需二次确认，停止未发送任务并清理正文和摘要，保留去重标记及用量，不能撤回已发消息。配置导入先预览再确认，导入来源默认暂停；导出不包含凭证、正文和处理历史，不代替完整备份。

## 长期运行

停止同一数据目录下手动运行的 Web、Worker 和开发服务，再运行：

```text
npm run service -- plan
npm run service -- install
npm run service -- status
npm run doctor -- --hosted
```

install 注册并启动当前用户服务，不要求管理员权限。它使用当前 Node 的绝对路径、生产构建、本机免登录和内嵌 Worker；保留 PORT、DATA_DIR 和接入配置。不修改 `.env`，不会接管或结束已有手动进程，端口冲突时直接退出。

| 平台 | 托管机制 | 启动条件 |
| --- | --- | --- |
| macOS | 用户 LaunchAgent | 登录图形桌面后 |
| Windows | 当前用户任务计划，InteractiveToken | 当前用户登录后 |
| Linux | systemd 用户服务 | 用户会话及用户管理器可用时 |

三者都不是“开机未登录即可运行”的系统服务。Linux 注销后继续运行需自行评估并配置用户 linger，本工具不自动修改。Windows/Linux 的系统托管入口需在目标机验证；CI 覆盖模板、路径和 Node 运行器，不代替真实登录、自启和电源测试。

服务退出后由系统重启；Windows 任务计划重试最多999次，之后需手动启动。休眠、关机和断网期间无法保证采集推送。系统强制终止可能留下不确定发送，恢复后不盲重发。

```text
npm run service -- stop
npm run service -- start
npm run service -- restart
npm run service -- uninstall
```

uninstall 停止并移除托管定义，保留配置、数据库、日志和备份。移动项目或升级 Node 路径前先卸载，再从新路径重新安装。修改托管选项也需卸载后重装。

macOS 可选防止空闲休眠，屏幕仍可熄灭；不修改全局电源设置，不阻止主动休眠、合盖或关机：

```text
npm run service -- install --keep-awake --backup-days=7
```

其他系统使用系统电源设置管理休眠，不接受 keep-awake 参数。笔记本注意通风与电源管理。macOS 若拒绝后台读取 Downloads/Desktop/Documents，请将项目放到普通用户目录并重新安装，不要关闭系统安全保护。

## 诊断、日志和备份

```text
npm run doctor
```

doctor 检查 Node、构建、配置、数据目录写权限、已开启的视频组件和本机诊断接口。不会连接邮箱、下载模型、调用付费模型或发送消息。有待检查项时退出码为1；摘要刻意关闭、无启用来源时也会提示，不等于程序崩溃。密码模式请登录页面查看运行检查。

`/api/health` 只证明 API 存活；`/api/diagnostics` 提供后台心跳、配置和队列概况，沿用本机边界和密码鉴权，不提供正文或凭证。

托管日志在 `.cache/service/service.log`，单份最多5MiB，保留3份轮转文件。系统注册失败可检查 launchctl、任务计划程序或 systemctl 的状态。日志仍按私有文件保管，不直接上传整个日志目录。

自动备份默认关闭。安装时传 `--backup-days=7` 后，启动30秒后和每小时检查一次，每个 UTC 日期最多保存一份在线 SQLite 快照到 `DATA_DIR/backups/automatic/`，清理超过保留天数的自有 `auto-日期.sqlite`。不会清理手动备份；失败写入托管日志，不停止采集。

备份包含私人内容，不上传 Git。它不包含 `.env`；请另行安全保存该文件，SESSION_SECRET 用于解密微信绑定。同盘备份不能防硬盘损坏。Windows 应使用当前用户的私有目录，POSIX 文件权限不等于 Windows ACL。

## 视频组件

基础采集和邮件摘要不要求 Python。YouTube 全文摘要需要 Python 和字幕组件；无字幕时的本地转写需另装依赖和模型。

macOS/Linux：

```text
python3 -m venv .cache/youtube-venv
.cache/youtube-venv/bin/python -m pip install -r requirements-youtube.txt
```

Windows PowerShell：

```powershell
py -3.12 -m venv .cache/youtube-venv
.\.cache\youtube-venv\Scripts\python.exe -m pip install -r requirements-youtube.txt
```

建议使用 Python 3.12。程序自动识别上述标准目录，重启后运行 doctor 检查导入是否成功，无需手填 Python 路径和字幕开关。自定义安装位置才需要 `YOUTUBE_CAPTIONS_PYTHON`；Windows `.env` 路径建议用正斜杠。只有匹配依赖的平台和架构才可启用本地转写；字幕、ASR 与实际网络兼容性需分别验证，不能只凭 Node 服务能启动判断。

需要无字幕音频转写时，在同一 Python 环境安装依赖并准备模型：

```text
python -m pip install -r requirements-asr.txt
python -c "from huggingface_hub import snapshot_download; snapshot_download('Systran/faster-whisper-base', local_dir='.cache/asr-model', allow_patterns=['config.json','model.bin','tokenizer.json','vocabulary.*','preprocessor_config.json'])"
```

以上 `python` 替换为虚拟环境解释器路径，macOS/Linux 为 `.cache/youtube-venv/bin/python`，Windows 为 `.\.cache\youtube-venv\Scripts\python.exe`。设置 `YOUTUBE_ASR_ENABLED=1` 后重启；其他模型目录用 `YOUTUBE_ASR_MODEL` 指定。模型不会在运行时自动下载。不读取浏览器 Cookie，服务端代理需单独配置。提取上限见[技术设计](TECHNICAL_DESIGN.md#视频内容提取)。

## 高级配置

新安装通常只需填写模型 Key 和可选邮箱三项。`SESSION_SECRET` 和密码模式的引导散列由 setup 自动生成，不手填、不删除；已有 `.env` 不会被 setup 覆盖，显式设置始终优先，包括关闭开关 `0`。

| 选项 | 默认行为 / 何时修改 |
| --- | --- |
| `PORT` / `DATA_DIR` | 8787 / `./data`；端口冲突或需要独立数据目录时修改，本机页面地址随端口推导 |
| `AUTH_MODE` / `HOST` | `local` / `127.0.0.1`；保留本机访问边界，密码访问见技术设计 |
| `EMBED_WORKER` | 1；只有单独运行 `npm run worker` 时设为 0 |
| `DEEPSEEK_ENABLED` / `IMAP_ENABLED` / `FEISHU_ENABLED` | 按凭证自动识别；显式设为 0 可停用，旧配置中的 0 不会因填入凭证而被覆盖 |
| `DEEPSEEK_MODEL` | `deepseek-flash`；改用其他模型必须同时指定下述两个单价 |
| `DEEPSEEK_INPUT_CNY_PER_MILLION` / `DEEPSEEK_OUTPUT_CNY_PER_MILLION` | 默认 2 / 8 元，以高峰、未命中缓存价保守估算；可覆盖，不影响历史用量 |
| `YOUTUBE_PROXY_URL` | 留空直连；后台无法直连 YouTube 时才填 HTTP(S) 代理，不读取浏览器/系统代理 |
| `YOUTUBE_CAPTIONS_PROXY_URL` | 未设置时共用 `YOUTUBE_PROXY_URL`；显式留空则字幕/音频直连，也可填独立代理 |
| `YOUTUBE_CAPTIONS_ENABLED` / `YOUTUBE_CAPTIONS_PYTHON` | 自动识别标准虚拟环境；设为 0 可停用，非标准位置填写解释器绝对路径 |
| `YOUTUBE_ASR_ENABLED` / `YOUTUBE_ASR_MODEL` | 默认关闭 / `.cache/asr-model`；按上文安装后显式开启，不因模型文件存在就自动处理音频 |

单价于 2026-10-20 核对 [DeepSeek 官方价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)，仅用于本地预算估算，不是供应商实际账单；供应商调价后应更新。只填 Key 不会绕过预算确认或来源授权，也不会自动启用来源。

代理没有通用默认地址，不能替别人填写本机端口。若已有配置中 `YOUTUBE_CAPTIONS_PROXY_URL=` 为空，它仍表示字幕直连；删除该行才会共用频道代理。修改任意配置后重启生效。

## 升级和恢复

1. 先运行 `npm run backup -- backups/before-upgrade.sqlite`，另存 `.env`。
2. 托管用户运行 service stop；手动用户停止全部 Web/Worker。不要在服务运行时覆盖构建文件。
3. 确认自己的改动已保留，再更新代码，运行 npm ci、npm run check。
4. 托管用户 service start；手动用户 npm start。运行 doctor，核对来源、摘要预算、绑定和接收端。

启动会迁移数据库，不能直接用旧程序打开新 schema。恢复前停止全部 Web/Worker：

```text
npm run restore -- backups/before-upgrade.sqlite --confirm-stopped
```

恢复后不自动重放旧待发消息，需先核查；摘要和 AIHOT 自动开关停用，微信需重新绑定，密码会话清除，用量账本保留。确认配置后再启用自动处理。

Docker 属于可选路径，当前不作为本机安装的默认方式。镜像不含完整 ASR 依赖和模型，公网访问、代理 HTTPS 和首次密码初始化需单独验证。GitHub Pages 只用于项目介绍，不运行后台或保存私人配置。

## 常见问题

| 现象 | 检查顺序 |
| --- | --- |
| 没有新内容 | 服务和后台心跳、来源开关、采集间隔、是否仍在首次基线；Feed 不保证完整历史，长时间停机可能漏采 |
| 已采集但未推送 | 来源推送开关、摘要模式、授权、预算、通道；按需摘要需手动生成，日报需等汇总时间 |
| 视频处理慢或失败 | 查看处理阶段；完整转写可能需要数分钟。检查服务端网络及两类代理，浏览器能播放不代表后台能读取字幕 |
| 微信发送失败 | 确认绑定，向 ClawBot 发消息刷新上下文，再处理明确失败的记录 |
| 显示“需处理” | 查看失败原因；发送结果不确定时先查接收端，不要反复点击重发 |
| 本机无法访问 | 核对 `AUTH_MODE`、`HOST`、`APP_ORIGIN`、端口；使用配置地址，不通过代理访问本机模式 |

提交问题时提供操作步骤、系统与 Node 版本、错误码和脱敏截图。不要上传 `.env`、真实正文、完整数据库或私人日志。
