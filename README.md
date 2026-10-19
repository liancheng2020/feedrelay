# FeedRelay

“每日日报”可开启 AIHOT 日报：直接获取官方公开日报，每天北京时间 10:00 推送至当前微信通道，不额外调用 DeepSeek。当天未发布则稍后重试，按日期去重；需保持后台运行与电脑唤醒。内容来源：[AIHOT](https://aihot.news/daily)。

将 YouTube 频道更新与指定邮件，送到微信或飞书私聊的个人订阅器。

支持列表阅读、独立详情、DeepSeek 摘要、微信/飞书推送、日报与公共 RSS/Atom。真实163邮箱、飞书应用及连续7天试运行仍未验收；微信已完成本人短期连接测试。不配置模型或字幕组件也可运行。

## 能做什么

- **YouTube**：支持 `@用户名`、`https://www.youtube.com/@频道名` 和频道 ID / 标准频道链接；优先通过公开 RSS 获取更新。已配置 yt-dlp 时，RSS 异常自动改用最近15条上传元数据。
- **邮件**：一个 IMAP 账户与文件夹，按实际发件地址和主题关键词过滤；只读正文，不修改已读状态、不下载附件。
- **飞书**：独立应用机器人向指定 `open_id` 私聊推送短预览，不读取通讯录或聊天历史。
- **微信（试用）**：ClawBot扫码绑定本人，纯文本推送；入站仅更新该绑定人的发送上下文，不执行聊天指令、不调用模型。与飞书二选一，长期无互动的定时推送仍待验证。
- **管理**：订阅源、更新记录、投递详情、有限重试、未知结果人工核查、保留策略与备份恢复。更新列表支持每页10/20/50/100条，默认20条。
- **RSS/Atom**：订阅公共 HTTPS Feed，按同一来源的 GUID / ID / 原文链接去重，首次静默；不自动打开条目页面。
- **日报**：来源可选即时或日报，默认每天10:30按配置时区汇总；分片各自重试与核查，不把部分成功当作全部成功。
- **配置迁移**：JSON 先预览、后确认；重复项跳过，导入后暂停，不迁移凭证、正文、状态或游标。
- **可选摘要**：来源分别选择关闭、按需或自动；开启后先摘要再推送，消息为标题与编号要点。失败或预算不足时等待处理，不回退原文/简介。按需模式等待手动生成；自动模式处理后续更新。

首次启用只建立静默基线，不推送历史内容。来源采集与内容外发分别启用；发送超时不会盲目重发。

已有积压保持首次排队时的投递方式，模式切换仅影响未来内容，不双重发送。日报只纳入已就绪内容，AI来源等待摘要，未开启AI的来源保留原文预览；迟到或尚未生成摘要的内容进入后续窗口，无更新不发空消息。暂停来源会取消受影响的未发送日报分片（包括同片其他成员）。

## 本地体验

需要 **Node.js 24**。

```bash
npm ci
npm run demo
```

打开 <http://localhost:5183>，管理密码 `demo`。所有内容与发送均为模拟，数据隔离在 `data-demo/`，不连接邮箱、飞书或模型服务。新演示库自带日报样例；点击“模拟一轮更新”可观察即时与等待日报两条路径。不要将演示环境暴露到公网。

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

### 个人微信接收（ClawBot）

`.env`只需增加`PUSH_CHANNEL=weixin`，重启Web / Worker；不需要安装OpenClaw或填写微信密码/Token。在“投递设置”扫码并用手机确认；如需数字配对码，只填本机页面。再向ClawBot发一条消息，获取发送上下文，然后发送连接测试。只绑定扫码人本人，不支持群聊、任意联系人、媒体或微信聊天指令。重新绑定可能影响其他ClawBot实例，请核对手机提示。

绑定凭证与上下文使用`SESSION_SECRET`派生密钥加密保存在当前数据目录，网页不返回Token，不保留入站正文。不要随意更改该密钥；恢复备份会清除微信绑定，需重新扫码。解除本机绑定不等于撤销微信客户端授权。新绑定产生新目标指纹，旧目标待发记录不会自动改投。

**扫码成功不代表长期主动推送可靠。** 微信可能拒绝过期的会话上下文；此时停止尝试新的推送，需本人发消息刷新后，手动重试明确失败的记录。超时或不完整响应进入“待核查”，不能盲重发。先验证即时、延迟、隔夜及24/48小时无互动推送，再决定是否作为唯一接收端。切回飞书使用`PUSH_CHANNEL=feishu`并配置原有飞书凭证，不会同时双发。

本机已验证扫码、接收本人消息、重启保留绑定和队列文本发送，用户确认收到测试；这不代表隔夜或长期推送通过。[验证记录](docs/QUALITY_AND_RISKS.md#16-微信clawbot受限接入--2026-10-17)

本地开发真实适配器时，将 `.env` 的 `NODE_ENV` 改为 `development`、`APP_ORIGIN=http://localhost:5183`、`EMBED_WORKER=1`，然后 `npm run dev`；端口与访问域名必须和 Origin 一致。

添加 `@频道` 会在保存前只读查询公开频道页，无需 YouTube API Key 或 yt-dlp；失败不保存、不启动采集。服务端需要代理时显式设置 `YOUTUBE_PROXY_URL=http://127.0.0.1:1087`（仅示例），重启 Web / Worker，频道解析和YouTube RSS共用此配置；不影响邮箱、模型、飞书或通用RSS。浏览器代理不会自动作用于服务端，远程服务器不能照抄本机回环地址。

演示模式不访问真实频道；用 `@feedrelay-demo` 体验，或填写标准频道 ID。真实 `@频道` 解析请在 `npm run setup` 配置的非演示模式运行。配置导入只接受已解析的频道ID，预览不会联网。

## 部署与恢复

升级前先备份并停止 Web / Worker，再安装依赖、构建和重启。启动时事务升级 schema v1/v2/v3 到 v4，保留订阅和投递；新增字幕选项默认不启用。摘要授权版本已更新，已有用户需重新确认全局预算及来源。不要混跑不同版本；回滚需恢复旧版备份，旧程序不能读取 v4 数据库。

适合一个有持久磁盘、能访问 YouTube / IMAP / 飞书的常驻节点，不适合直接当作 Vercel 无状态函数或 GitHub Pages。

```bash
docker compose up -d --build
npm run backup -- backups/manual.sqlite
# 停止 Web 和 Worker 后；Docker 数据卷请在同一卷内操作
npm run restore -- backups/manual.sqlite --confirm-stopped
```

Web 与 Worker 共享同一 SQLite 数据目录；恢复后待发记录转为待人工核查，避免重放陈旧备份。备份同样含私人信息，需加密保管。公网部署必须 HTTPS，设置准确的 `APP_ORIGIN`、`COOKIE_SECURE=1`；内置监听保持回环地址，由同机反向代理接入。容器端口默认也只绑定本机。

## DeepSeek 摘要

无需其他项目或摘要服务，后端直接调用 DeepSeek。配置 `DEEPSEEK_ENABLED=1`、`DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL` 与输入/输出单价；在投递设置确认累计请求和人民币预算。

最新更新以列表展示标题、来源、摘要状态、投递状态及内容时间，点击进入独立详情；详情链接可刷新、分享给同一受权用户或使用浏览器返回。

- **原文**：视频入口及带时间定位的字幕/音频转写全文，不展示推广简介；优先公开字幕，无字幕时可用本地转写，不改用简介。邮件/RSS保留已采集正文。
- **总结**：选择本条范围、确认后生成；支持要点、内容脉络图和字幕时间线，引文链接返回对应原文。相同有效结果复用；明确重新生成会再次计费。
- **推送**：点击“微信推送”或“飞书推送”，确认后将最新有效摘要加入当前通道的队列，不双发、不重新调用模型；同一版本重复点击不重复排队。失败/未知通过投递记录核查，不盲重发。

请求、失败和修复都计入持久预算；不清零历史、不每日重置。简介/邮件/RSS最多20000码元、2次请求、60秒；字幕采用下节独立上限。摘要JSON和原文引用均校验，但引用存在不保证推论正确，请核对数字、日期、否定与观点归属。脉络图不代表因果关系或投资建议。

旧配置按 [.env.example](.env.example) 迁移为 `DEEPSEEK_` 前缀，删除旧本地模块目录项。原调用账本和微信绑定保留，适配器版本改变后重新确认预算及来源。不要复制或公开 Key。本机配置已迁移，无需重新填写。

`npm run demo` 的摘要和推送均为模拟，不产生真实费用。

## YouTube 字幕（可选）

频道发现与内容提取分开；已授权频道生成视频内容摘要后，再按订阅方式推送。需要 Python 3.10+、Node24及锁定的 yt-dlp/EJS；无需 ffmpeg。

```bash
python3 -m venv .cache/youtube-venv
.cache/youtube-venv/bin/python -m pip install -r requirements-youtube.txt
```

在 `.env` 设置 `YOUTUBE_CAPTIONS_ENABLED=1`、`YOUTUBE_CAPTIONS_PYTHON` 为该虚拟环境 Python 的绝对路径；按需设置无账号的 HTTP(S) `YOUTUBE_CAPTIONS_PROXY_URL`。空值明确直连，不继承系统或浏览器代理。`127.0.0.1` 只指 Worker 所在机器，不能照抄给远程容器。重启 Web / Worker 后，授权频道摘要，并将“摘要正文”改为“视频字幕”。

字幕代理仍由 `YOUTUBE_CAPTIONS_PROXY_URL` 单独控制；频道解析/RSS使用 `YOUTUBE_PROXY_URL`，两者不会隐式继承。

- 优先平台人工字幕轨道，其次原始自动字幕；保留语言、类型、内容hash和时间戳链接。默认不下载音视频，只有显式启用下方ASR时才获取临时音频；不读取Cookie、不接付费转写，不理解画面。
- 相邻字幕在起点跨度不足20秒、合并后不超过600码元时组成短段，避免逐秒碎片截断引用；时间链接指向段落起点，不是引文的逐词时间。仍逐段核对原文，不接受跨段拼接或改写的引文。
- 字幕最多48000码元，按12000码元目标分段后通过DeepSeek提炼、合并；仅字幕任务最多12次模型请求和4分钟（含45秒内字幕获取），每次分块、修复与合并均占用累计预算。超限不发布部分结果，也不静默截断；启用ASR后的计算时限见下节。
- 原通知先执行，不等待摘要成功；单Worker下一轮检查仍可能被字幕任务延后最多4分钟。无字幕/网络失败明确展示，不自动改用简介冒充视频摘要；排除历史基线，不自动重试失败视频。
- 相同有效任务复用字幕及结果；模型失败后手动重试复用字幕、不抹除先前费用。切换范围、撤销授权、正文变化/到期、恢复备份会清理相应缓存。缓存不是永久字幕库，不承诺来源后来修改字幕会被主动发现。

Docker 可选设置 `YOUTUBE_CAPTIONS_BUILD=1` 后重新构建，并用 `YOUTUBE_CAPTIONS_PYTHON=/opt/youtube/bin/python`。默认镜像不安装Python；同一镜像供Web与Worker使用，不需额外挂载摘要项目。Docker与目标云节点尚未验收。

### 无字幕视频：本地转写

可选安装 [faster-whisper](https://github.com/SYSTRAN/faster-whisper)，使用 PyAV 直接解码音频，无需系统 ffmpeg 或付费转写 Key。推荐 Python 3.12，在上述隔离环境执行：

```bash
.cache/youtube-venv/bin/python -m pip install -r requirements-asr.txt
.cache/youtube-venv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('Systran/faster-whisper-base', local_dir='.cache/asr-model', allow_patterns=['config.json','model.bin','tokenizer.json','vocabulary.*','preprocessor_config.json'])"
```

设置 `YOUTUBE_ASR_ENABLED=1`，`YOUTUBE_CAPTIONS_PYTHON` 指向这个环境；模型默认读取 `.cache/asr-model`，其他位置可用 `YOUTUBE_ASR_MODEL` 指定。首次准备约需150MB模型文件；Worker只读取本地模型，不会偷偷下载模型。重启后重新确认原预算与来源范围，不增加额度。

点击“生成摘要”后：取字幕 → 无/空字幕时下载公开音频 → 本机转写 → DeepSeek提炼完整文本。界面显示阶段与进度，转写全文、引文和时间链接共用原缓存；模型重试不重复转写。网络/登录限制不会触发ASR绕过，不读取Cookie、不下载画面、不使用抽样片段冒充全文。

本地转写采用4窗口批处理，保留时间定位，优先下载紧凑音轨。手动摘要优先于自动摘要和尚未开始的来源检查；不会中断正在执行的任务。

限60分钟视频、100MB音频、48000码元完整文本、35分钟总任务；超限停止而不静默截断，模型仍最多12次且受原累计预算限制。临时音频成功或失败均清理；转写可能误识别，无法代替画面理解。CPU转写可能需要数分钟，单Worker期间其他采集/推送会延后；停机会取消处理。当前Alpine镜像不包含ASR依赖，本轮不承诺Docker中的本地转写可用。

流程参考 [yt-transcribe](https://github.com/bennigo/yt-transcribe) 的音频→转写→清理分层；不复用其默认浏览器Cookie设置。Sift的第三方转写/故事板OCR仅作设计参考，没有引入其运行时或凭证。

## 验证与边界

```bash
npm run check              # 类型、单元/集成测试、生产构建
npx playwright install chromium
npm run test:e2e           # 独立合成数据库，桌面/手机浏览器测试
```

YouTube 字幕接入前实验：先在隔离目录安装已验证版本（不改全局Python），再显式开启真实网络探针。仅测试4个固定公开视频，不读Cookie、不下载音视频、不调用模型/飞书；代理仅可显式传入本机无账号的HTTP代理，不改项目运行配置。

```bash
python3 -m venv .cache/yt-dlp-probe/venv
.cache/yt-dlp-probe/venv/bin/python -m pip install --index-url https://pypi.org/simple 'yt-dlp[default]==2026.8.19'
npm run probe:youtube -- --live --limit 1
# 仅在你有本机代理时使用，不能照抄到远程容器
npm run probe:youtube -- --live --proxy http://127.0.0.1:1087
```

本机代理路径已取到人工/自动字幕，直连未通过；探针及正式适配器的证据分别见验证文档第11、12节。探针用于手动诊断，不会自动打开摘要、模型或飞书。[实测结果](docs/QUALITY_AND_RISKS.md#11-yt-dlp-真实小样本--2026-10-17)

- 不支持旧式 `/c/`、`/user/` 自定义地址、多邮箱或画面理解；字幕/语音摘要不等于完整视频理解，没有原文时不推测全文。
- RSS 仅支持无账号、查询参数和自定义端口的公共 HTTPS 地址及 UTF-8 / ASCII Feed；不支持私有 Token Feed、压缩响应或 HTML 自动发现。连接检查 DNS 及每次重定向，拒绝私网和特殊 IP；不自动复用系统代理。
- 日报按发现时间排队，每批最多500条，剩余保留至下一窗口；每轮/每日额度按发送尝试计数。修改时间或时区可能立即处理新窗口内的未分配积压。
- 导出默认省略 RSS 地址；只有明确确认 URL 公开且不含 Token 时才包含。发件地址可能涉及个人信息，配置文件仍需妥善保管。
- RSS 不是完整上传日志。长时间停机可能漏抓，系统提示覆盖不确定；不承诺实时、零遗漏或 exactly-once。
- “已接受”不等于用户已读；超时/中断进入“待核查”，人工重发可能重复。
- 默认邮件正文7天、其他内容及元数据30天；未解决任务保留最小状态，过期正文和消息快照会清理。删除不等于磁盘安全擦除；旧备份仍需自行清理。
- 去重标记保留90天；更早的旧条目再次出现可能重新通知，不跨不同 RSS 来源合并文章。
- 本机公共 YouTube / RSS 直连尚未通过（RSS 验证遇到连接重置），须在目标运行节点验证网络；模拟与浏览器测试通过不等于真实来源或飞书可用。

[产品需求](docs/PRODUCT.md) · [技术与运维](docs/TECHNICAL_DESIGN.md) · [开发进度](docs/ROADMAP.md) · [验证记录与风险](docs/QUALITY_AND_RISKS.md)
