<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import {
  Rss, ArrowUpRight, ArrowRight, CirclePlay, Mail, Sparkles, Send,
  Copy, Check, Maximize2, X, Menu, Terminal, CalendarDays, List, ShieldCheck, ChevronDown,
} from '@lucide/vue';

const repo = 'https://github.com/liancheng2020/feedrelay';
const guide = `${repo}/blob/main/docs/SELF_HOSTING.md`;
// Relative URLs must match in the prerender and client, including a Pages project subpath.
const images = './images/';
const interactive = ref(false);
const menuOpen = ref(false);
const activePreview = ref('summary');
const previews = [
  { id: 'updates', name: '最新更新', icon: List, image: 'workspace.png', alt: 'FeedRelay 最新更新界面，集中查看不同订阅来源、摘要与推送状态', caption: '更新集中查看，摘要和推送状态一目了然。' },
  { id: 'summary', name: 'AI 摘要', icon: Sparkles, image: 'summary.png', alt: 'FeedRelay 邮件详情与 AI 摘要界面，保留正文、提炼要点和原文引用', caption: '提炼重点，也保留回到原文的路径。' },
  { id: 'daily', name: '每日日报', icon: CalendarDays, image: 'daily.png', alt: 'FeedRelay 每日日报界面，查看每日推送和按日期归档的日报', caption: 'AIHOT 日报，每天北京时间 10:00 获取并推送。' },
];
const preview = computed(() => previews.find(item => item.id === activePreview.value)!);
const installMode = ref('install');
const commands = {
  install: 'git clone https://github.com/liancheng2020/feedrelay.git\ncd feedrelay\nnpm ci\nnpm run setup\nnpm run build\nnpm start',
  service: 'npm run service -- plan\nnpm run service -- install\nnpm run service -- status\nnpm run doctor -- --hosted',
};
const command = computed(() => commands[installMode.value as keyof typeof commands]);
const copyState = ref('');
let copyTimer: ReturnType<typeof setTimeout>;
const imageDialog = ref<HTMLDialogElement | null>(null);
const menuButton = ref<HTMLButtonElement | null>(null);
let previousFocus: HTMLElement | null = null;

function selectTab(event: KeyboardEvent, items: { id: string }[], current: string, select: (id: string) => void) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const tabs = event.currentTarget as HTMLElement;
  const index = items.findIndex(item => item.id === current);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
  select(items[next].id);
  void nextTick(() => tabs.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus());
}
async function copyCommand() {
  clearTimeout(copyTimer);
  try {
    await navigator.clipboard.writeText(command.value);
    copyState.value = '已复制';
  } catch {
    copyState.value = '无法复制，请选择下方命令';
  }
  copyTimer = setTimeout(() => { copyState.value = ''; }, 3500);
}
function enlarge() {
  previousFocus = document.activeElement as HTMLElement;
  imageDialog.value?.showModal();
  document.body.style.overflow = 'hidden';
}
function closeImage() {
  imageDialog.value?.close();
}
function imageClosed() {
  document.body.style.overflow = '';
  previousFocus?.focus();
}
const onEscape = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && menuOpen.value) {
    menuOpen.value = false;
    menuButton.value?.focus();
  }
};
onMounted(() => {
  interactive.value = true;
  document.addEventListener('keydown', onEscape);
});
onUnmounted(() => {
  clearTimeout(copyTimer);
  document.removeEventListener('keydown', onEscape);
  document.body.style.overflow = '';
});
</script>

<template>
  <a class="skip-link" href="#main">跳到正文</a>
  <header class="site-header">
    <div class="shell nav-inner">
      <a class="wordmark" href="#" aria-label="FeedRelay 首页"><Rss :size="22" stroke-width="2.2" /><span>FeedRelay</span></a>
      <nav id="site-nav" aria-label="官网导航" :class="{ 'is-open': menuOpen }">
        <a href="#workflow" @click="menuOpen = false">工作流程</a>
        <a href="#preview" @click="menuOpen = false">界面预览</a>
        <a href="#start" @click="menuOpen = false">开始部署</a>
        <a :href="guide" target="_blank" rel="noreferrer">文档<ArrowUpRight :size="13" /></a>
      </nav>
      <div class="nav-actions">
        <a class="repo-link" :href="repo" target="_blank" rel="noreferrer">GitHub<ArrowUpRight :size="15" /></a>
        <button ref="menuButton" class="icon-button menu-toggle" :disabled="!interactive" :aria-expanded="menuOpen" aria-controls="site-nav" :aria-label="menuOpen ? '关闭导航' : '打开导航'" @click="menuOpen = !menuOpen"><X v-if="menuOpen" :size="21" /><Menu v-else :size="21" /></button>
      </div>
    </div>
  </header>

  <main id="main">
    <section class="hero" aria-labelledby="hero-title">
      <div class="hero-copy shell">
        <p class="eyebrow"><span class="signal-dot"></span>独立部署 · 为自己订阅</p>
        <h1 id="hero-title">FeedRelay<span class="title-dot">.</span></h1>
        <p class="hero-line">订阅你关心的，<br class="mobile-break" />收到提炼好的。</p>
        <p class="hero-description">自动采集视频、邮件和 RSS，<br class="mobile-break" />让 AI 摘要抵达微信或飞书。</p>
        <div class="hero-actions">
          <a class="button primary" href="#start">开始部署<ArrowRight :size="17" /></a>
          <a class="button secondary" :href="repo" target="_blank" rel="noreferrer">查看源码<ArrowUpRight :size="16" /></a>
        </div>
        <p class="platform-note">macOS / Windows / Linux<span>本机打开即用</span></p>
      </div>
      <div class="hero-product" aria-hidden="true"><picture><source media="(max-width: 760px)" :srcset="`${images}hero-mobile.png`" /><img :src="`${images}hero.png`" alt="" width="1131" height="500" fetchpriority="high" /></picture></div>
      <a class="hero-preview-link" href="#preview" aria-label="查看完整界面预览"><span>FEED IN. INSIGHT OUT.</span><ArrowUpRight :size="16" /></a>
    </section>

    <div class="source-strip">
      <div class="shell source-strip-inner">
        <span class="strip-label">从你关注的来源开始</span>
        <div class="source-names"><span><CirclePlay class="youtube" :size="20" />YouTube</span><span><Mail class="email" :size="20" />邮件</span><span><Rss class="rss" :size="19" />RSS</span></div>
        <span class="strip-end"><ShieldCheck :size="16" />数据由自己保管</span>
      </div>
    </div>

    <section id="workflow" class="workflow section shell" aria-labelledby="workflow-title">
      <div class="section-heading"><div><p class="eyebrow">THE RELAY</p><h2 id="workflow-title">信息很多，<span>重点不必错过。</span></h2></div><p class="heading-note">一条清晰的路径，<br />从关注的来源到你的手机。</p></div>
      <ol class="workflow-steps">
        <li><div class="step-top"><span class="step-number">01 / COLLECT</span><CirclePlay :size="24" /></div><h3>订阅与采集</h3><p>关注频道、匹配发件人，或添加 RSS。<br />定时检查，去重保存。</p><ArrowRight class="step-arrow" :size="20" aria-hidden="true" /></li>
        <li><div class="step-top"><span class="step-number">02 / SUMMARIZE</span><Sparkles :size="24" /></div><h3>先提取重点</h3><p>DeepSeek 提炼授权正文。<br />摘要成功后，才进入推送。</p><ArrowRight class="step-arrow" :size="20" aria-hidden="true" /></li>
        <li><div class="step-top"><span class="step-number">03 / DELIVER</span><Send :size="24" /></div><h3>送到常用的地方</h3><p>微信或飞书，选择一个通道。<br />即时推送，或汇成一份日报。</p></li>
      </ol>
    </section>

    <section id="preview" class="preview-band section" aria-labelledby="preview-title">
      <div class="shell">
        <div class="section-heading"><div><p class="eyebrow">A CLOSER LOOK</p><h2 id="preview-title">看见更新，<span>也看清重点。</span></h2></div><a class="text-link" :href="`${repo}#功能`" target="_blank" rel="noreferrer">功能说明<ArrowUpRight :size="15" /></a></div>
        <div class="preview-toolbar">
          <div class="tabs preview-tabs" role="tablist" aria-label="产品界面" @keydown="selectTab($event, previews, activePreview, id => activePreview = id)">
            <button v-for="item in previews" :id="`tab-${item.id}`" :key="item.id" role="tab" :aria-selected="activePreview === item.id" :tabindex="activePreview === item.id ? 0 : -1" :aria-controls="`panel-${item.id}`" :disabled="!interactive" @click="activePreview = item.id"><component :is="item.icon" :size="16" />{{ item.name }}</button>
          </div>
          <button class="icon-button enlarge-button" :disabled="!interactive" aria-label="放大界面预览" title="放大预览" @click="enlarge"><Maximize2 :size="17" /></button>
        </div>
        <figure v-for="item in previews" v-show="activePreview === item.id" :id="`panel-${item.id}`" :key="item.id" class="product-figure" role="tabpanel" :aria-labelledby="`tab-${item.id}`" tabindex="0">
          <img :src="`${images}${item.image}`" :alt="item.alt" width="1440" height="920" loading="lazy" />
          <figcaption><span>{{ item.caption }}</span><span>实际界面 · 示例内容</span></figcaption>
        </figure>
        <div class="product-notes"><p><ShieldCheck :size="17" /><strong>本地优先</strong><span>数据和接入凭证保存在自己的设备。</span></p><p><Sparkles :size="17" /><strong>按授权摘要</strong><span>仅授权正文发往 DeepSeek，预算可控。</span></p></div>
      </div>
    </section>

    <section id="start" class="start-band section" aria-labelledby="start-title">
      <div class="shell start-layout">
        <div class="start-copy"><p class="eyebrow">MAKE IT YOURS</p><h2 id="start-title">让它，<br />为你运行。</h2><p>准备 Node.js 24，<br />从自己的电脑开始。</p><a class="text-link" :href="guide" target="_blank" rel="noreferrer">完整安装指南<ArrowUpRight :size="16" /></a><span class="start-platforms">macOS / Windows / Linux</span></div>
        <div class="install-terminal">
          <div class="terminal-toolbar"><div class="tabs install-tabs" role="tablist" aria-label="部署步骤" @keydown="selectTab($event, [{id:'install'},{id:'service'}], installMode, id => { installMode = id; copyState = '' })"><button id="tab-install" role="tab" :aria-selected="installMode === 'install'" :tabindex="installMode === 'install' ? 0 : -1" aria-controls="install-command" :disabled="!interactive" @click="installMode = 'install'; copyState = ''"><Terminal :size="16" />首次安装</button><button id="tab-service" role="tab" :aria-selected="installMode === 'service'" :tabindex="installMode === 'service' ? 0 : -1" aria-controls="install-command" :disabled="!interactive" @click="installMode = 'service'; copyState = ''">后台托管</button></div><button class="icon-button copy-button" :disabled="!interactive" :aria-label="copyState === '已复制' ? '已复制命令' : '复制命令'" :title="copyState === '已复制' ? '已复制' : '复制命令'" @click="copyCommand"><Check v-if="copyState === '已复制'" :size="17" /><Copy v-else :size="17" /></button></div>
          <div id="install-command" role="tabpanel" :aria-labelledby="`tab-${installMode}`" tabindex="0"><pre><code>{{ command }}</code></pre></div>
          <div class="terminal-bottom"><p v-if="copyState" role="status">{{ copyState }}</p><p v-else-if="installMode === 'install'">启动后打开 <code>localhost:8787</code></p><p v-else>先停止手动服务，再安装用户托管。</p><ArrowUpRight :size="15" aria-hidden="true" /></div>
        </div>
      </div>
      <div class="shell start-footnote"><span>配置模型、来源和推送通道后，即可启用自动链路。</span><span>Windows / Linux 自启与转写需在目标机验证。</span></div>
    </section>

    <section class="faq section shell" aria-labelledby="faq-title">
      <div><p class="eyebrow">GOOD TO KNOW</p><h2 id="faq-title">开始前，<br />你可能想知道。</h2></div>
      <div class="faq-list">
        <details><summary>电脑需要一直开着吗？<ChevronDown :size="18" /></summary><p>需要保持程序运行、网络可用且系统未休眠。只熄屏可以继续，关机或休眠会暂停采集推送。</p></details>
        <details><summary>需要付费吗？<ChevronDown :size="18" /></summary><p>项目源码公开。DeepSeek 模型调用按服务商计费，可设置累计预算；AIHOT 日报不额外调用模型。</p></details>
        <details><summary>可以直接在这个网页使用吗？<ChevronDown :size="18" /></summary><p>这里是项目介绍与安装入口。工具运行在你自己的设备上，每个实例独立使用自己的配置与数据；本页面不接收密钥。</p></details>
      </div>
    </section>
  </main>

  <footer class="site-footer"><div class="shell footer-top"><a class="wordmark" href="#"><Rss :size="22" /><span>FeedRelay</span></a><p>为自己构建，也分享给你。</p><a class="text-link" :href="repo" target="_blank" rel="noreferrer">在 GitHub 留一颗 Star<ArrowUpRight :size="16" /></a></div><div class="shell footer-bottom"><span>个人订阅 · 单用户自托管</span><div><a :href="`${repo}/issues`" target="_blank" rel="noreferrer">问题反馈</a><a :href="guide" target="_blank" rel="noreferrer">部署文档</a><a href="#main">回到顶部 ↑</a></div></div></footer>

  <dialog ref="imageDialog" class="image-dialog" aria-label="界面大图" @close="imageClosed" @click="event => { if (event.target === imageDialog) closeImage() }"><div class="image-dialog-toolbar"><span>{{ preview.name }} · 示例内容</span><button class="icon-button" aria-label="关闭界面大图" title="关闭" @click="closeImage"><X :size="22" /></button></div><div class="image-dialog-scroll"><img :src="`${images}${preview.image}`" :alt="preview.alt" width="1440" height="920" /></div></dialog>
</template>
