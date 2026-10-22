# 开发与发布

## 本地开发

使用 Node.js 24，先运行 `npm ci` 和 `npm run setup`，再运行：

```bash
npm run dev
```

打开 [localhost:5183](http://localhost:5183)。开发命令自动设置开发模式、页面地址和内嵌后台，无需改动 `.env`。不要与同一数据目录的托管服务同时运行；开发也不要使用或提交他人的凭证、真实邮件和数据库。

| 目录 | 用途 |
| --- | --- |
| `web/` | 本机管理页面 |
| `server/` | API、来源适配、摘要、推送与持久化 |
| `scripts/` | 安装、托管、诊断、备份和构建工具 |
| `test/` | 单元、集成、浏览器与托管测试 |
| `site/` | 独立静态官网，不连接业务后台 |

## 验证

```bash
npm run check
npx playwright install chromium
npm run test:e2e
npm run build:site
npm run test:site
```

`check` 包含类型检查、生产构建及单元/集成测试。测试使用临时数据和固定响应，不读取真实邮箱、不调用付费模型、不发送真实消息；真实外部验证需要明确授权。

| 验收范围 | 必须保持的行为 |
| --- | --- |
| 本机访问（FR-42 / LOCAL-01至03） | 免登录；拒绝非法 Host、代理头和跨站请求，保留 CSRF 校验 |
| 采集与摘要 | 首次静默、事务游标和去重；授权及预算有效才调用；失败不推原文，失败/修复均计账 |
| 推送与恢复 | 目标正确、同版本不重复排队；不确定结果不盲重发；删除阻止旧任务，恢复不重放旧消息 |
| 日报（FR-41 / DAILY-01） | 日期去重，整行进入详情并返回，手机无溢出 |
| 自托管（FR-43 / HOST-01至16） | 跨平台路径和启动定义、配置保护、日志轮转、在线备份、IPC 关闭、私有诊断、长任务租约、来源自动恢复及手动重试限流 |
| 默认配置（FR-45 / ENV-01至07） | 最小凭证可启动、显式旧配置优先、默认模型估算和自定义单价校验、视频环境识别、代理复用及预算/授权边界不变 |
| 官网（FR-44 / PAGE-01至05） | 六种尺寸、图片和子路径、键盘切换、放大、复制回退；无 JavaScript 可阅读，不发布私有数据 |

GitHub Actions 的 `verify` 执行应用、官网和三平台托管适配检查。CI 不代替 Windows/Linux 的真实登录自启、注销、休眠及视频组件验证，也不能证明上游接口持续可用。

可选系统托管测试为 `test/native-hosting.mjs`，必须显式设置 `FEEDRELAY_NATIVE_SERVICE_TEST=1`；只创建临时合成实例，结束后卸载，不默认加入 CI。

## 官网预览与发布

官网：[liancheng2020.github.io/feedrelay](https://liancheng2020.github.io/feedrelay/)。GitHub Pages 仅用于项目介绍和安装入口，不运行后台、不连接用户实例、不收集凭证。

```bash
npm run build:site
npm run preview:site
```

默认预览地址为 [127.0.0.1:5190/feedrelay/](http://127.0.0.1:5190/feedrelay/)，端口占用时自动换端口。官网复用 Vue 和 Lucide，构建时预渲染 HTML；资源本地打包，无外部字体和访客追踪。

仓库 Pages 来源选择 **GitHub Actions**。官网相关代码推送到 `main`，或手动运行 **Project Website**，会构建、测试并发布。仅修改文档不会触发官网部署。实际结果查看该次 Actions 运行，不要只凭本地构建判断上线。

只上传 `dist/site`，不能上传整个仓库或整个 `dist`；`.env`、数据库、日志、备份和本机工具构建不公开。网站工作流不需要邮箱、模型或推送密钥。Fork 后修改 `site/index.html`、`site/App.vue` 和 `site/public/sitemap.xml` 的仓库、官网及规范地址。

更新界面素材时运行 `npm run capture:site`，再构建和测试官网。截图使用隔离的合成数据，摘要为人工编写示例，不读取现有数据库或触发真实模型/消息。

## 后续重点

1. 观察真实新内容从采集到收件的成功率、耗时和错误分布。
2. 验证 Windows/Linux 系统托管和视频依赖，优化摘要等待时间。
3. 改善微信上下文过期后的恢复体验，验证 Docker 和升级恢复流程。

暂不建设公共注册、多人共享、组织权限或计费。多人共用需另行设计用户、凭证、队列和预算隔离；历史实现与决策查 Git 记录。
