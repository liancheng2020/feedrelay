# FeedRelay

自动采集 YouTube、邮件和 RSS，使用 DeepSeek 提取要点，再推送到微信或飞书。每个人都可以在自己的电脑上独立部署。

本机打开即用，无需登录。每个部署使用自己的数据和凭证，目前不支持多人共用。

## 工作流程

```text
订阅源 → 定时采集 → 去重并保存正文 → AI 摘要 → 推送队列 → 微信 / 飞书
                                         ↓
                                    失败则等待处理
```

- 自动摘要：新内容采集后自动生成摘要，成功后再推送。
- 按需摘要：等待你在详情页生成摘要，再按订阅设置处理推送。
- 关闭摘要：按订阅设置发送标题和原文预览，不调用模型。
- 新来源默认暂停，首次采集只建立基线，不推送历史内容。

## 启动

需要 Node.js 24，在项目目录运行：

```bash
npm ci
npm run setup
npm run build
npm start
```

打开 [localhost:8787](http://localhost:8787)。后台任务随服务运行，浏览器可以关闭；电脑休眠或服务退出会暂停处理。

`setup` 创建本机 `.env`，不会覆盖已有文件。配置参考 [.env.example](.env.example)，修改后重启服务。已有配置若设置了 `EMBED_WORKER=0`，需要另外运行 `npm run worker`。

macOS、Windows、Linux 的安装、视频组件和长期托管见[自托管指南](docs/SELF_HOSTING.md)。首次配置先确认能收到一条真实消息，再启用长期托管。

```text
npm run doctor
# 停止手动服务后，安装当前用户托管并立即启动
npm run service -- install
npm run service -- status
```

托管默认登录系统后启动，异常退出自动重启；休眠和关机仍会暂停。Windows/Linux 已提供托管入口，系统自启和视频组件需在目标机单独验证。

## 接入来源和推送

1. **模型**：在 `.env` 填写 `DEEPSEEK_ENABLED=1`、Key、模型名及输入/输出单价。在“投递设置”确认累计预算。
2. **微信**：设置 `PUSH_CHANNEL=weixin`。重启后在“投递设置”扫码绑定，向 ClawBot 发一条消息，再测试连接。
3. **邮箱**：开启邮箱 IMAP，用授权码填写 `IMAP_*` 配置。在“订阅源”填写实际发件地址，主题关键词可选。只读取匹配邮件正文，不修改已读状态、不下载附件。
4. **YouTube**：添加频道 `@用户名`、频道链接或频道 ID。视频摘要需要安装字幕组件，见[技术说明](docs/TECHNICAL_DESIGN.md#视频内容提取)。
5. **RSS**：添加公开 HTTPS Feed 地址，读取 Feed 中提供的正文，不自动抓取文章网页。

最后启用来源采集、私聊推送，选择“自动摘要”并确认来源授权，完整自动链路才会运行。只配置模型 Key 不会自动开启摘要。

微信和飞书二选一。使用飞书时设置 `PUSH_CHANNEL=feishu`、`FEISHU_ENABLED=1` 及应用凭证、收件人 `open_id`，机器人需要 `im:message:send_as_bot` 权限。

## 每日日报

- **AIHOT AI 日报**：在“每日日报”开启，每天北京时间 10:00 获取 [AIHOT](https://aihot.news/daily) 当天日报并推送，不额外调用 DeepSeek。10 点后首次开启则从次日开始，当天未发布会稍后重试。
- **订阅汇总**：将选择“日报”投递的订阅内容按设置时间汇总；启用摘要的内容必须先完成摘要。
- 点击日报整行查看详情。日期显示为 `YYYY/MM/DD`。

## 使用边界

- 视频优先取字幕；只有启用本地转写后，无字幕视频才会下载临时音频转写。不读取浏览器 Cookie，不分析画面。
- 摘要失败或预算不足不会回退为原文推送。失败、修复和重试都计入累计模型预算。
- 推送成功表示平台已接受，不代表已读。结果不确定时先核查接收端，避免重复发送。
- 微信发送上下文可能过期，需要本人发消息刷新。网络、上游接口和长视频处理都可能造成延迟。
- `.env`、`data/` 和备份包含私人信息，不要提交到 Git。

## 维护和开发

```bash
npm run backup -- backups/manual.sqlite
npm run check
npx playwright install chromium
npm run test:e2e
```

开发时将 `.env` 设置为 `NODE_ENV=development`、`APP_ORIGIN=http://localhost:5183`、`EMBED_WORKER=1`，运行 `npm run dev`，打开 [localhost:5183](http://localhost:5183)。

本机模式要求 `AUTH_MODE=local`、`HOST=127.0.0.1`，不用于反向代理、端口转发或远程访问。需要保留密码访问时使用 `AUTH_MODE=password`，运行构建后的 `npm run reset-password` 设置密码；本机模式下不会显示密码和退出入口。

[自托管指南](docs/SELF_HOSTING.md) · [功能说明](docs/PRODUCT.md) · [技术与运维](docs/TECHNICAL_DESIGN.md) · [开发计划](docs/ROADMAP.md) · [验证与排查](docs/QUALITY_AND_RISKS.md)
