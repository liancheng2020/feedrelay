# 项目官网

FR-44：GitHub Pages 只展示项目介绍、界面预览和安装入口，不运行采集推送后台，不连接用户实例，不收集凭证。

## 本机预览

```text
npm ci
npm run build:site
npm run preview:site
```

打开终端输出的地址，默认 http://127.0.0.1:5190/feedrelay/ 。端口占用时自动尝试下一个，不影响应用的8787/5183端口。

官网源码在 `site/`，复用Vue和Lucide，无新增依赖。构建时生成静态HTML，关闭JavaScript仍可阅读主要内容；交互加载后支持界面切换、放大和命令复制。所有资源本地打包，无外部字体或访客追踪。

## GitHub Pages 发布

1. 仓库 Settings → Pages → Build and deployment → Source 选择 GitHub Actions。
2. 提交并推送官网改动到main；或在Actions手动运行Project Website。
3. 工作流构建、测试后，只上传 `dist/site`；部署完成后查看工作流返回的地址。

预计地址：https://liancheng2020.github.io/feedrelay/ 。本地开发完成不等于线上已发布。Fork后请修改 `site/index.html`、`site/App.vue` 和 `site/public/sitemap.xml` 中的仓库、官网及规范地址。

不要上传整个仓库或整个dist：`dist/web`是本机工具，`.env`、数据库、日志与备份不能公开。网站工作流不需要邮箱、模型或推送密钥。

## 更新素材与验证

```text
npx playwright install chromium
npm run capture:site
npm run build:site
npm run test:site
```

素材由真实程序界面生成，数据为独立临时样例，摘要示例为人工编写；不读取现有数据库，不调用真实模型，不发送消息。重拍是开发操作，不属于官网访问或发布流程。

PAGE-01至05验证六种屏幕尺寸、图片与子路径、键盘切换、放大关闭、复制失败回退、移动导航、无JavaScript阅读及私有文件不可访问。官网测试独立于应用测试，不启动真实业务后台。
