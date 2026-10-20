# 单用户自托管

FR-43：每个人在自己的电脑上运行一个独立实例，使用自己的来源、模型 Key、邮箱和微信或飞书。不是公共在线服务，不需要注册，也不支持多人共享后台。

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

建议使用 Python 3.12。将该环境 Python 的绝对路径填写到 `YOUTUBE_CAPTIONS_PYTHON`，Windows `.env` 路径建议用正斜杠；开启 `YOUTUBE_CAPTIONS_ENABLED=1` 后重启。运行 doctor 检查导入是否成功。只有匹配依赖的平台和架构才可启用本地转写；字幕、ASR 与实际网络兼容性需分别验证，不能只凭 Node 服务能启动判断。

可选转写安装和模型准备见[技术说明](TECHNICAL_DESIGN.md#视频内容提取)。模型不会在运行时自动下载。不读取浏览器 Cookie，服务端代理需单独配置。

## 升级和恢复

1. 先运行 `npm run backup -- backups/before-upgrade.sqlite`，另存 `.env`。
2. 托管用户运行 service stop；手动用户停止全部 Web/Worker。不要在服务运行时覆盖构建文件。
3. 确认自己的改动已保留，再更新代码，运行 npm ci、npm run check。
4. 托管用户 service start；手动用户 npm start。运行 doctor，核对来源、摘要预算、绑定和接收端。

启动会迁移数据库，不能直接用旧程序打开新 schema。恢复命令和恢复后重新授权、绑定的要求见[技术说明](TECHNICAL_DESIGN.md#升级和恢复)。不要在未知发送结果上反复重试。

Docker 属于可选路径，当前不作为本机安装的默认方式。镜像不含完整 ASR 依赖和模型，公网访问、代理 HTTPS 和首次密码初始化需单独验证。GitHub Pages 只用于项目介绍，不运行后台或保存私人配置。
