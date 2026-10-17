<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import TransferDialog from './TransferDialog.vue';
import SummarySettings, { type SummaryConfig } from './SummarySettings.vue';
import ItemSummary, { type SummaryView } from './ItemSummary.vue';
import {
  Rss,
  CirclePlay as Youtube,
  Mail,
  Settings,
  Plus,
  Play,
  Pause,
  RefreshCw,
  X,
  LogOut,
  Send,
  Inbox,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Trash2,
  Check,
  AlertTriangle,
  LoaderCircle,
  CalendarDays,
  Upload,
  Download,
} from '@lucide/vue';

interface Source {
  id: string;
  type: string;
  name: string;
  channel: string;
  sender: string;
  subject: string;
  feed_url: string;
  delivery_mode: string;
  summary_mode: string;
  summary_notify: number;
  summary_content: 'feed' | 'captions';
  enabled: number;
  notify: number;
  initialized: number;
  last_success: number | null;
  next_check: number;
  error: string;
  coverage: string;
  backlog: number;
}
interface Item {
  id: string;
  kind: string;
  title: string;
  author: string;
  text: string;
  url: string;
  discovered: number;
  published: number | null;
  received: number | null;
  expired: number;
  status?: string;
  error?: string;
  resolution?: string;
}
interface Detail extends Item {
  summaries: SummaryView[];
  summaryAllowed: boolean;
  delivery: {
    id: string;
    status: string;
    error: string;
    resolution: string;
    attempt: number;
    mode: string;
  } | null;
  attempts: { n: number; at: number; status: string; code: string }[];
}
interface Job {
  id: string;
  resource: string;
  kind: string;
  status: string;
  error: string;
  result: string;
  created: number;
}
interface Prefs {
  timezone: string;
  youtubeMinutes: number;
  mailMinutes: number;
  dailyLimit: number;
  mailDays: number;
  itemDays: number;
  digestTime: string;
}
interface Overview {
  demo: boolean;
  stats: Record<string, number | string | null>;
  settings: Prefs;
  connections: { imap: boolean; feishu: boolean; folder: string; recipient: string };
}
const authenticated = ref(false),
  ready = ref(false),
  demo = ref(false),
  csrf = ref(''),
  password = ref('');
const view = ref('updates'),
  busy = ref(false),
  error = ref(''),
  notice = ref('');
const sources = ref<Source[]>([]),
  items = ref<Item[]>([]),
  jobs = ref<Job[]>([]),
  overview = ref<Overview | null>(null);
const page = ref(1),
  total = ref(0),
  sourceFilter = ref(''),
  statusFilter = ref(''),
  detail = ref<Detail | null>(null);
const editor = ref(false),
  editing = ref(''),
  form = ref({
    type: 'youtube',
    name: '',
    channel: '',
    sender: '',
    subject: '',
    feed_url: '',
    delivery_mode: 'immediate',
    publicConfirmed: false,
  });
interface Digest {
  id: string;
  slot: string;
  timezone: string;
  cutoff: number;
  total_parts: number;
  members: number;
  parts: { id: string; item_id: string; status: string; error: string; resolution: string }[];
}
const digests = ref<Digest[]>([]),
  transfer = ref('');
const summaryConfig = ref<SummaryConfig | null>(null);
const activation = ref<Source | null>(null),
  notify = ref(false),
  consent = ref(false),
  resumeMode = ref('new_only');
const deletion = ref<Source | null>(null),
  erase = ref(false);
const confirmation = ref<{ title: string; text: string; run: () => Promise<void> } | null>(null);
const preferences = ref<Prefs>({
  timezone: 'Asia/Shanghai',
  youtubeMinutes: 15,
  mailMinutes: 5,
  dailyLimit: 50,
  mailDays: 7,
  itemDays: 30,
  digestTime: '10:30',
});
const labels: Record<string, string> = {
  discovered: '仅采集',
  pending: '待发送',
  sending: '发送中',
  sent: '已接受',
  retry_wait: '等待重试',
  failed: '失败',
  unknown: '待核查',
  cancelled: '已取消',
  succeeded: '检查通过',
  running: '检查中',
  digest_wait: '等待日报',
  batched: '已纳入日报',
};
const errors: Record<string, string> = {
  SUMMARY_NOT_ENABLED: '请先配置 Sift，再确认启用摘要预算。',
  SUMMARY_SOURCE_NOT_AUTHORIZED: '请在订阅源单独授权此来源的摘要外发。',
  INVALID_SUMMARY_POLICY: '请检查摘要开关、累计请求及费用预算。',
  SUMMARY_CONTENT_TOO_LONG: '正文过长，本版最多处理8000个UTF-16码元，不会静默截断。',
  INVALID_FEED_URL: '请输入有效的公开 RSS 地址。',
  PUBLIC_HTTPS_FEED_REQUIRED: '仅支持不含账号、查询参数或片段的公开 HTTPS Feed。',
  RSS_PRIVATE_ADDRESS: 'RSS 地址解析到私有或特殊网络，已阻止连接。',
  RSS_NETWORK_ERROR: 'RSS 连接失败，请检查来源和服务器网络。',
  RSS_ENTRY_ID_REQUIRED: 'Feed 条目缺少稳定 ID 或有效原文链接。',
  RSS_REDIRECT_LIMIT: 'RSS 重定向次数超限。',
  INVALID_IMPORT: '配置文件格式或数量无效。',
  IMPORT_UNSUPPORTED_FIELD: '配置含不支持字段或账户引用；不能导入凭证和运行状态。',
  IMPORT_PREVIEW_CHANGED: '配置已变化，请重新预览。',
  PUBLIC_FEED_CONFIRMATION_REQUIRED: '请确认 RSS 是不含私人 Token 的公开订阅。',
  INVALID_DIGEST_TIME: '日报时间格式应为 HH:mm。',
  DIGEST_MEMBER_DISABLED: '来源已停用，受影响的未发送日报分片已整体取消。',
  DIGEST_ENTRY_TOO_LONG: '条目过长，无法安全纳入日报。',
  INVALID_PASSWORD: '密码不正确。',
  LOGIN_RATE_LIMITED: '登录尝试过多，请15分钟后重试。',
  UNAUTHORIZED: '会话已过期，请重新登录。',
  INVALID_ORIGIN: '访问地址与 APP_ORIGIN 不一致，请检查本地配置。',
  INVALID_CSRF: '会话已更新，请刷新页面。',
  SOURCE_ALREADY_EXISTS: '这个订阅源已经存在。',
  INVALID_CHANNEL: '请填写 YouTube @频道链接、@用户名，或 UC 开头的频道 ID。',
  CHANNEL_ID_REQUIRED: '配置导入仅接受已解析的 UC 频道 ID；@链接请从添加订阅源入口保存。',
  CHANNEL_NOT_FOUND: '未找到该 YouTube 频道，请核对 @用户名。',
  CHANNEL_RESOLUTION_FAILED: '未能确认频道 ID，未保存订阅；请稍后重试或填写 UC 频道 ID。',
  CHANNEL_RESPONSE_TOO_LARGE: 'YouTube 频道页面超出解析上限，未保存订阅。',
  YOUTUBE_ACCESS_BLOCKED: 'YouTube 拒绝访问或要求验证，请检查运行节点网络。',
  YOUTUBE_RATE_LIMITED: 'YouTube 暂时限流，请稍后重试。',
  DEMO_CHANNEL_HANDLE:
    '演示模式不访问真实频道；可用 @feedrelay-demo 体验，或填写 UC 频道 ID。真实 @频道解析需在非演示模式运行。',
  INVALID_MAIL_RULE: '请填写完整的发件邮箱地址。',
  SOURCE_LIMIT: '已达到订阅源数量上限。',
  IMAP_NOT_ENABLED: '尚未配置邮箱连接。',
  IMAP_AUTH_FAILED: '邮箱认证失败，请检查 IMAP 开关和授权码。',
  IMAP_CONNECTION_FAILED: '邮箱连接失败，稍后重试。',
  YOUTUBE_NETWORK_ERROR:
    '服务端无法连接 YouTube，请检查服务器网络或配置 YOUTUBE_PROXY_URL；浏览器代理不会自动作用于服务端。',
  MAILBOX_EPOCH_CHANGED: '邮箱标识已变化，已暂停规则，请重新建立基线。',
  SEND_UNCONFIRMED: '发送结果不确定，请在飞书人工核查。',
  DEMO_ACCEPTED: '模拟发送成功',
  FEISHU_RATE_LIMIT: '飞书请求受限。',
  FEED_WINDOW_GAP: 'RSS 窗口可能存在漏抓，请到频道核对。',
  OLD_ITEM_REAPPEARED: '发现基线前的旧视频，已静默收录，请核对覆盖范围。',
  REBASELINE_REQUIRED: '需要重新启用并建立基线。',
  FEISHU_NOT_ENABLED: '尚未配置飞书应用机器人。',
  CONTENT_EXPIRED: '内容已过保留期，不可重发。',
  SOURCE_DISABLED: '对应订阅源已停用，不能重发。',
  INVALID_SETTINGS: '请检查数值范围。',
  INVALID_TIMEZONE: '时区无效。',
  SOURCE_UNAVAILABLE: '采集失败，系统将按预算重试。',
  SEND_INTERRUPTED: '上次发送中断，是否已送达未知，请手动核查。',
  RESTORED_NEEDS_REVIEW: '备份恢复后的记录需要人工核查。',
  DESTINATION_CHANGED: '收件人配置已变化，需确认后重发。',
  DELIVERY_NOT_RESOLVABLE: '记录状态已变化，请刷新查看。',
};
const explain = (code: string) => errors[code] || code;
const deliveryLabels = Object.fromEntries(
  Object.entries(labels).filter(([key]) => !['running', 'succeeded', 'batched'].includes(key)),
);
const zonedTime = (value: number, zone: string) =>
  new Date(value).toLocaleString('zh-CN', { timeZone: zone, hour12: false });
const time = (value: number | string | null | undefined) =>
  value ? new Date(Number(value)).toLocaleString('zh-CN', { hour12: false }) : '尚无记录';
const heading = computed(
  () =>
    ({ updates: '最新更新', sources: '订阅源', settings: '投递设置', digests: '每日日报' })[
      view.value
    ],
);
const modalOpen = computed(
  () =>
    !!(
      editor.value ||
      detail.value ||
      activation.value ||
      deletion.value ||
      confirmation.value ||
      transfer.value
    ),
);
let previousFocus: HTMLElement | null = null;
const modalLayer = computed(() =>
  confirmation.value
    ? 'confirmation'
    : transfer.value
      ? 'transfer'
      : editor.value
        ? 'editor'
        : activation.value
          ? 'activation'
          : deletion.value
            ? 'deletion'
            : detail.value
              ? 'detail'
              : '',
);
watch(modalLayer, async (open, before) => {
  document.body.style.overflow = open ? 'hidden' : '';
  if (open) {
    if (!before) previousFocus = document.activeElement as HTMLElement;
    await nextTick();
    document.querySelector<HTMLElement>('.overlay:last-child button')?.focus();
  } else previousFocus?.focus();
});
function keyboard(event: KeyboardEvent) {
  if (!modalOpen.value) return;
  if (event.key === 'Escape' && !busy.value) {
    confirmation.value
      ? (confirmation.value = null)
      : transfer.value
        ? (transfer.value = '')
        : editor.value
          ? (editor.value = false)
          : activation.value
            ? (activation.value = null)
            : deletion.value
              ? (deletion.value = null)
              : (detail.value = null);
  }
  if (event.key === 'Tab') {
    const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]'),
      dialog = dialogs[dialogs.length - 1];
    const fields = dialog?.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]',
    );
    if (!fields?.length) return;
    if (event.shiftKey && document.activeElement === fields[0]) {
      event.preventDefault();
      fields[fields.length - 1].focus();
    } else if (!event.shiftKey && document.activeElement === fields[fields.length - 1]) {
      event.preventDefault();
      fields[0].focus();
    }
  }
}
async function api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.value },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) authenticated.value = false;
    throw new Error(explain(result.error || '请求失败'));
  }
  return result as T;
}
async function load() {
  const o = await api<Overview>('/overview');
  overview.value = o;
  sources.value = await api<Source[]>('/sources');
  jobs.value = await api<Job[]>('/jobs');
  digests.value = await api<Digest[]>('/digests');
  summaryConfig.value = await api<SummaryConfig>('/summaries/settings');
  const result = await api<{ items: Item[]; total: number }>(
    `/items?page=${page.value}&source=${encodeURIComponent(sourceFilter.value)}&status=${statusFilter.value}`,
  );
  items.value = result.items;
  total.value = result.total;
  if (detail.value) detail.value = await api<Detail>(`/items/${detail.value.id}`);
}
async function act(fn: () => Promise<void>, message = '') {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await fn();
    if (authenticated.value && fn !== load) await load();
    notice.value = message;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '操作失败';
  } finally {
    busy.value = false;
  }
}
async function login() {
  await act(async () => {
    const session = await api<{ csrf: string }>('/login', 'POST', { password: password.value });
    csrf.value = session.csrf;
    authenticated.value = true;
    password.value = '';
  });
}
async function logout() {
  await act(async () => {
    await api('/logout', 'POST');
    authenticated.value = false;
    items.value = [];
    sources.value = [];
    detail.value = null;
    overview.value = null;
  });
}
function add(s?: Source) {
  editing.value = s?.id || '';
  form.value = s
    ? {
        type: s.type,
        name: s.name,
        channel: s.channel,
        sender: s.sender,
        subject: s.subject,
        feed_url: s.feed_url,
        delivery_mode: s.delivery_mode,
        publicConfirmed: false,
      }
    : {
        type: 'youtube',
        name: '',
        channel: '',
        sender: '',
        subject: '',
        feed_url: '',
        delivery_mode: 'immediate',
        publicConfirmed: false,
      };
  editor.value = true;
}
async function save() {
  await act(async () => {
    await api(
      editing.value ? `/sources/${editing.value}` : '/sources',
      editing.value ? 'PUT' : 'POST',
      form.value,
    );
    editor.value = false;
  }, '订阅源已保存，启用后开始采集。');
}
function activate(s: Source) {
  activation.value = s;
  notify.value = !!s.notify;
  consent.value = false;
  resumeMode.value = 'new_only';
}
async function enable() {
  const s = activation.value;
  if (!s) return;
  await act(async () => {
    await api(`/sources/${s.id}/toggle`, 'POST', {
      enabled: true,
      notify: notify.value,
      confirmed: consent.value,
      mode: resumeMode.value,
    });
    activation.value = null;
  }, '已启用，首次检查将建立静默基线。');
}
async function pause(s: Source) {
  confirmation.value = {
    title: '暂停采集？',
    text: '未发送内容将取消；包含此来源的未发送日报分片会整体取消，其中其他来源的成员也不会再发送。已发送或发送中的消息无法撤回。',
    run: async () => {
      await api(`/sources/${s.id}/toggle`, 'POST', { enabled: false, notify: false });
    },
  };
}
function changeMode(s: Source, event: Event) {
  const target = event.target as HTMLSelectElement,
    mode = target.value;
  target.value = s.delivery_mode;
  confirmation.value = {
    title: mode === 'digest' ? '切换为日报？' : '切换为即时？',
    text: '仅影响后续新排队内容；已有积压保持原投递方式，不会双重发送。',
    run: async () => {
      await api(`/sources/${s.id}/delivery-mode`, 'POST', { mode, confirmed: true });
    },
  };
}
async function inspectPart(id: string) {
  await act(async () => {
    detail.value = await api<Detail>(`/items/${id}`);
  });
}
function changeSummary(s: Source, event: Event, field: 'mode' | 'notify' | 'content' = 'mode') {
  const target = event.target as HTMLSelectElement | HTMLInputElement;
  const mode = field === 'mode' ? target.value : s.summary_mode;
  const notify = field === 'notify' ? (target as HTMLInputElement).checked : !!s.summary_notify;
  const content = field === 'content' ? target.value : s.summary_content;
  const recipient = overview.value?.connections.recipient || '未配置';
  const disclosure =
    s.type === 'youtube'
      ? content === 'captions'
        ? '从 YouTube 获取的公开字幕（非画面）'
        : '已采集视频简介（不是字幕或全文）'
      : s.type === 'rss'
        ? '已采集Feed文本（不代表网页全文）'
        : '已采集邮件正文（不含附件）';
  if (field === 'notify') (target as HTMLInputElement).checked = !!s.summary_notify;
  else target.value = field === 'content' ? s.summary_content : s.summary_mode;
  confirmation.value = {
    title:
      field === 'content' && mode === 'off'
        ? '修改摘要正文？'
        : mode === 'off'
          ? '关闭此来源摘要？'
          : '授权此来源摘要？',
    text:
      field === 'content' && mode === 'off'
        ? `仅保存${content === 'captions' ? '字幕' : '简介'}选择，不开启摘要或外部请求。启用时仍需确认授权。`
        : mode === 'off'
          ? '将取消排队摘要、清理结果及未发AI补充。已发出的外部请求或消息无法撤回。'
          : [
              demo.value ? '本环境为模拟，不连接外部服务。' : `${disclosure}将发送到 DeepSeek。`,
              content === 'captions'
                ? '仅取字幕，不读取Cookie、不下载音视频；最多48000码元、12次模型请求、4分钟，包含分块、合并与修复；失败不自动改用简介生成视频摘要。'
                : '',
              mode === 'auto'
                ? '只自动处理授权后新发现且已排队提醒的条目，不处理历史收件箱。'
                : '仅在你确认具体条目后处理。',
              notify
                ? `另行即时私聊发送AI补充，独立于原即时/日报，不会重发原通知。接收人：${recipient}。`
                : '摘要仅在详情页查看，不向飞书追加消息。',
              '切换正文范围使旧结果失效。失败、修复和重试均占用累计预算；引用校验不保证语义正确。',
            ]
              .filter(Boolean)
              .join(' '),
    run: async () => {
      await api(`/sources/${s.id}/summary`, 'POST', { mode, notify, content, confirmed: true });
    },
  };
}
function generateSummary(retry: boolean) {
  const id = detail.value?.id;
  if (!id) return;
  confirmation.value = {
    title: retry ? '重新处理摘要？' : '生成当前内容摘要？',
    text: `${demo.value ? '本次为模拟处理。' : '按已授权来源范围处理：简介/邮件/Feed文本，或另行获取公开字幕后发送至 DeepSeek；字幕不包含画面理解。'} 相同有效内容复用缓存；失败或中断后的重做可能再次计费，所有请求受累计预算限制。原始提醒不会重发。`,
    run: async () => {
      await api(`/items/${id}/summary`, 'POST', { confirmed: true, retry });
    },
  };
}
async function imported() {
  transfer.value = '';
  await act(load, '配置已导入，所有新增来源保持暂停。');
}
async function remove() {
  const s = deletion.value;
  if (!s) return;
  await act(async () => {
    await api(`/sources/${s.id}`, 'DELETE', { confirmed: true, erase: erase.value });
    deletion.value = null;
  });
}
async function inspect(item: Item) {
  await act(async () => {
    detail.value = await api<Detail>(`/items/${item.id}`);
  });
}
function resolve(action: 'retry' | 'acknowledge') {
  const d = detail.value?.delivery;
  if (!d) return;
  confirmation.value = {
    title: action === 'retry' ? '确认重新发送？' : '标记为已人工核查？',
    text:
      action === 'retry'
        ? '若上次已送达，重发可能产生重复消息。请先在飞书核查，再决定是否发送。'
        : '此操作只记录你的核查结论，不代表平台返回了送达或已读凭证。',
    run: async () => {
      await api(`/deliveries/${d.id}/resolve`, 'POST', { action, confirmed: true });
    },
  };
}
async function confirm() {
  const task = confirmation.value;
  if (!task) return;
  await act(async () => {
    await task.run();
    confirmation.value = null;
  }, '已提交。');
}
function testFeishu() {
  confirmation.value = {
    title: '发送飞书连接测试？',
    text: demo.value
      ? '当前为本地演示，只记录模拟结果，不会向飞书发送消息。'
      : '将向配置的用户私聊发送一条不含私人内容的测试消息。',
    run: async () => {
      await api('/settings/test-feishu', 'POST', { confirmed: true });
    },
  };
}
function switchView(next: string) {
  view.value = next;
  detail.value = null;
  if (next === 'settings' && overview.value) preferences.value = { ...overview.value.settings };
}
async function filter() {
  page.value = 1;
  await act(load);
}
const latestJob = (s: Source) =>
  jobs.value.find((j) => j.resource === s.id || (s.type === 'email' && j.kind === 'mailbox'));
function jobSummary(job: Job) {
  try {
    const result = JSON.parse(job.result || '{}');
    return result.matched !== undefined
      ? `最近5封中匹配 ${result.matched} 封（未读取正文）`
      : result.visible !== undefined
        ? `RSS 当前可见 ${result.visible} 条`
        : '';
  } catch {
    return '';
  }
}
let timer: ReturnType<typeof setInterval>;
onMounted(async () => {
  document.addEventListener('keydown', keyboard);
  try {
    const session = await api<{ authenticated: boolean; demo: boolean; csrf: string }>('/session');
    csrf.value = session.csrf;
    demo.value = session.demo;
    authenticated.value = session.authenticated;
    if (authenticated.value) await load();
  } catch (e) {
    error.value = String(e);
  } finally {
    ready.value = true;
  }
  timer = setInterval(() => {
    if (!document.hidden && authenticated.value && !busy.value) act(load);
  }, 5000);
});
onUnmounted(() => {
  clearInterval(timer);
  document.removeEventListener('keydown', keyboard);
  document.body.style.overflow = '';
});
</script>

<template>
  <div v-if="!ready" class="loading"><LoaderCircle class="spin" :size="24" />正在连接</div>
  <main v-else-if="!authenticated" class="login">
    <div class="brand"><Rss :size="28" /><strong>FeedRelay</strong></div>
    <h1>订阅工作台</h1>
    <p>频道更新与邮件资讯，集中送达。</p>
    <p v-if="demo" class="demo-note">本地演示 · 模拟数据 · 密码 demo</p>
    <form @submit.prevent="login">
      <label for="password">管理密码</label
      ><input
        id="password"
        v-model="password"
        type="password"
        autocomplete="current-password"
        required
        maxlength="256"
      /><button class="primary" :disabled="busy">
        <span>登录</span><ChevronRight :size="18" />
      </button>
    </form>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
  </main>
  <div v-else class="workspace">
    <aside class="sidebar">
      <a class="brand" href="#" @click.prevent="switchView('updates')"
        ><Rss :size="26" /><strong>FeedRelay</strong></a
      >
      <nav aria-label="主导航">
        <button :class="{ active: view === 'updates' }" @click="switchView('updates')">
          <Inbox :size="19" />最新更新</button
        ><button :class="{ active: view === 'sources' }" @click="switchView('sources')">
          <Rss :size="19" />订阅源<span class="nav-count">{{ sources.length }}</span></button
        ><button :class="{ active: view === 'settings' }" @click="switchView('settings')">
          <Settings :size="19" />投递设置
        </button>
        <button :class="{ active: view === 'digests' }" @click="switchView('digests')">
          <CalendarDays :size="19" />每日日报
        </button>
      </nav>
      <div class="sidebar-bottom">
        <span class="connection"
          ><i
            :class="{
              live:
                overview?.stats.heartbeat && Date.now() - Number(overview.stats.heartbeat) < 120000,
            }"
          ></i
          >后台任务</span
        ><small>{{ time(overview?.stats.heartbeat) }}</small
        ><button class="quiet" @click="logout" :disabled="busy">
          <LogOut :size="16" />退出登录
        </button>
      </div>
    </aside>
    <main class="content">
      <div v-if="demo" class="demo-banner">
        <span>演示环境 · 所有邮件、频道与发送结果均为模拟，不连接外部服务。</span
        ><button
          @click="
            act(async () => {
              await api('/demo/advance', 'POST');
            }, '已生成模拟更新，后台将在数秒内处理。')
          "
          :disabled="busy"
        >
          <Plus :size="15" />模拟一轮更新
        </button>
      </div>
      <header class="page-head">
        <div>
          <p class="eyebrow">
            {{ view === 'updates' ? 'INBOX' : view === 'sources' ? 'SUBSCRIPTIONS' : 'DELIVERY' }}
          </p>
          <h1>{{ heading }}</h1>
        </div>
        <div class="actions">
          <button class="icon" title="刷新" aria-label="刷新" :disabled="busy" @click="act(load)">
            <RefreshCw :size="18" :class="{ spin: busy }" /></button
          ><button v-if="view === 'sources'" class="primary" @click="add()">
            <Plus :size="17" />添加订阅源
          </button>
        </div>
      </header>
      <div v-if="error" class="alert error" role="alert">
        <AlertTriangle :size="17" /><span>{{ error }}</span
        ><button class="icon" aria-label="关闭错误" @click="error = ''"><X :size="16" /></button>
      </div>
      <p v-if="notice" class="alert success" role="status"><Check :size="17" />{{ notice }}</p>
      <template v-if="view === 'updates'">
        <section class="metrics" aria-label="投递概况">
          <div>
            <span>收录内容</span><strong>{{ overview?.stats.items || 0 }}</strong>
          </div>
          <div>
            <span>待发送</span><strong>{{ overview?.stats.pending || 0 }}</strong>
          </div>
          <div>
            <span>待人工核查</span><strong class="amber">{{ overview?.stats.unknown || 0 }}</strong>
          </div>
          <div>
            <span>今日发送尝试</span
            ><strong
              >{{ overview?.stats.today || 0
              }}<small> / {{ overview?.settings.dailyLimit }}</small></strong
            >
          </div>
        </section>
        <div class="filter-bar">
          <label
            >订阅源<select v-model="sourceFilter" @change="filter">
              <option value="">全部来源</option>
              <option v-for="s in sources" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select></label
          ><label
            >投递状态<select v-model="statusFilter" @change="filter">
              <option value="">全部状态</option>
              <option v-for="(name, key) in deliveryLabels" :key="key" :value="key">
                {{ name }}
              </option>
            </select></label
          ><span class="muted">{{ total }} 条记录</span>
        </div>
        <div v-if="!items.length" class="empty">
          <Inbox :size="34" />
          <h2>暂无更新</h2>
          <p>启用订阅源后，首次检查只建立基线，之后的新内容才会推送。</p>
          <button @click="switchView('sources')">管理订阅源<ChevronRight :size="16" /></button>
        </div>
        <section v-else class="item-list" aria-label="更新记录">
          <article v-for="item in items" :key="item.id">
            <div class="source-icon" :class="item.kind">
              <Youtube v-if="item.kind === 'youtube'" :size="21" /><Rss
                v-else-if="item.kind === 'rss'"
                :size="20"
              /><Mail v-else :size="20" />
            </div>
            <div class="item-main">
              <div class="item-meta">
                <span>{{ item.author || '内容已清理' }}</span
                ><time>{{ time(item.received || item.published || item.discovered) }}</time>
              </div>
              <button class="item-title" @click="inspect(item)">
                {{ item.title || '过期记录' }}
              </button>
              <p>{{ item.expired ? '正文已按保留策略清理。' : item.text || '无正文预览' }}</p>
              <div class="item-foot">
                <span class="badge" :class="item.status">{{
                  item.resolution === 'user_acknowledged'
                    ? '已人工核查'
                    : labels[item.status || 'discovered']
                }}</span
                ><span v-if="item.error" class="muted">{{ explain(item.error) }}</span>
              </div>
            </div>
            <button class="icon" title="查看详情" aria-label="查看详情" @click="inspect(item)">
              <ChevronRight :size="20" />
            </button>
          </article>
        </section>
        <footer class="pagination">
          <span>第 {{ page }} 页</span
          ><button
            class="icon"
            aria-label="上一页"
            :disabled="page <= 1 || busy"
            @click="
              page--;
              act(load);
            "
          >
            <ChevronLeft :size="18" /></button
          ><button
            class="icon"
            aria-label="下一页"
            :disabled="page * 30 >= total || busy"
            @click="
              page++;
              act(load);
            "
          >
            <ChevronRight :size="18" />
          </button>
        </footer>
      </template>
      <template v-if="view === 'digests'">
        <div class="digest-schedule">
          <CalendarDays :size="20" /><span
            >每天 {{ overview?.settings.digestTime }} · {{ overview?.settings.timezone }}</span
          ><button @click="switchView('settings')">调整时间</button>
        </div>
        <div v-if="!digests.length" class="empty">
          <CalendarDays :size="34" />
          <h2>暂无日报批次</h2>
          <p>来源选择日报并启用推送后，新内容等待下一个本地时间窗口。</p>
          <button @click="switchView('sources')">管理订阅源<ChevronRight :size="16" /></button>
        </div>
        <section class="digest-list">
          <article v-for="batch in digests" :key="batch.id">
            <header>
              <div>
                <h2>{{ zonedTime(batch.cutoff, batch.timezone) }}</h2>
                <p class="muted">
                  {{ batch.timezone }} · {{ batch.members }} 条内容 · {{ batch.total_parts }} 个分片
                </p>
              </div>
              <span v-if="!batch.total_parts" class="badge">无更新，不发送</span>
            </header>
            <div v-for="(part, index) in batch.parts" :key="part.id" class="digest-part">
              <span>分片 {{ index + 1 }}/{{ batch.total_parts }}</span
              ><span class="badge" :class="part.status">{{
                part.resolution === 'user_acknowledged' ? '已人工核查' : labels[part.status]
              }}</span
              ><span class="muted">{{ part.error ? explain(part.error) : '' }}</span
              ><button @click="inspectPart(part.item_id)">
                查看分片<ChevronRight :size="16" />
              </button>
            </div>
          </article>
        </section>
      </template>
      <template v-if="view === 'sources'">
        <div class="transfer-actions">
          <button @click="transfer = 'import'"><Upload :size="16" />导入配置</button
          ><button @click="transfer = 'export'"><Download :size="16" />导出配置</button>
        </div>
        <p class="section-note">频道通知使用标题与简介；字幕摘要需另外启用组件并授权。</p>
        <div v-if="!sources.length" class="empty">
          <Rss :size="34" />
          <h2>添加第一个订阅源</h2>
          <button class="primary" @click="add()"><Plus :size="17" />添加订阅源</button>
        </div>
        <section class="source-list">
          <article v-for="s in sources" :key="s.id" class="source-row">
            <div class="source-icon" :class="s.type">
              <Youtube v-if="s.type === 'youtube'" :size="22" /><Rss
                v-else-if="s.type === 'rss'"
                :size="21"
              /><Mail v-else :size="21" />
            </div>
            <div class="source-main">
              <div class="source-heading">
                <h2>{{ s.name }}</h2>
                <span class="badge" :class="s.enabled ? 'sent' : 'cancelled'">{{
                  s.enabled ? '采集中' : '已暂停'
                }}</span
                ><span v-if="s.enabled" class="muted">{{ s.notify ? '私聊推送' : '仅采集' }}</span>
              </div>
              <p class="identifier">
                {{ s.type === 'youtube' ? s.channel : s.type === 'rss' ? s.feed_url : s.sender
                }}<span v-if="s.subject"> · 主题包含“{{ s.subject }}”</span>
              </p>
              <label class="mode-picker"
                >投递方式<select
                  :value="s.delivery_mode"
                  :disabled="busy"
                  @change="changeMode(s, $event)"
                >
                  <option value="immediate">即时通知</option>
                  <option value="digest">每日日报</option>
                </select></label
              >
              <div class="summary-source-controls">
                <label class="mode-picker"
                  >AI摘要<select
                    aria-label="AI摘要"
                    :value="s.summary_mode"
                    :disabled="busy || (!summaryConfig?.enabled && s.summary_mode === 'off')"
                    @change="changeSummary(s, $event)"
                  >
                    <option value="off">关闭</option>
                    <option value="manual">按需</option>
                    <option value="auto">自动 · 仅后续更新</option>
                  </select></label
                >
                <label v-if="s.type === 'youtube'" class="mode-picker"
                  >摘要正文<select
                    aria-label="摘要正文"
                    :value="s.summary_content"
                    :disabled="busy"
                    @change="changeSummary(s, $event, 'content')"
                  >
                    <option value="feed">视频简介</option>
                    <option value="captions" :disabled="!summaryConfig?.captionsReady">
                      视频字幕 · 不含画面
                    </option>
                  </select></label
                >
                <label v-if="s.summary_mode !== 'off'" class="check"
                  ><input
                    type="checkbox"
                    :checked="!!s.summary_notify"
                    :disabled="busy"
                    @change="changeSummary(s, $event, 'notify')"
                  />私聊追加AI补充</label
                >
              </div>
              <div class="source-times">
                <span>最近成功 {{ time(s.last_success) }}</span
                ><span v-if="s.enabled">{{ s.initialized ? '基线已建立' : '等待首次基线' }}</span
                ><span v-if="s.backlog">积压 {{ s.backlog }} 条</span>
              </div>
              <p v-if="s.error || s.coverage" class="source-warning">
                {{ explain(s.error || s.coverage) }}
              </p>
              <p v-if="latestJob(s)" class="job-result">
                {{ labels[latestJob(s)!.status] || latestJob(s)!.status
                }}<span v-if="latestJob(s)!.error"> · {{ explain(latestJob(s)!.error) }}</span
                ><span v-else> {{ jobSummary(latestJob(s)!) }}</span>
              </p>
            </div>
            <div class="source-actions">
              <button
                title="检查连接"
                aria-label="检查连接"
                class="icon"
                :disabled="busy"
                @click="
                  act(async () => {
                    await api(`/sources/${s.id}/check`, 'POST');
                  }, '检查已排队。')
                "
              >
                <RefreshCw :size="17" /></button
              ><button
                :title="s.enabled ? '暂停采集' : '启用采集'"
                :aria-label="s.enabled ? '暂停采集' : '启用采集'"
                class="icon"
                :disabled="busy"
                @click="s.enabled ? pause(s) : activate(s)"
              >
                <Pause v-if="s.enabled" :size="17" /><Play v-else :size="17" /></button
              ><button title="编辑" aria-label="编辑" class="icon" @click="add(s)">
                <Pencil :size="17" /></button
              ><button
                title="删除"
                aria-label="删除"
                class="icon danger"
                @click="
                  deletion = s;
                  erase = false;
                "
              >
                <Trash2 :size="17" />
              </button>
            </div>
          </article>
        </section>
      </template>
      <template v-if="view === 'settings'">
        <section class="settings-band">
          <h2>连接状态</h2>
          <div class="connection-row">
            <Mail :size="21" />
            <div>
              <strong>163 / IMAP 邮箱</strong>
              <p>只读 · {{ overview?.connections.folder }}</p>
            </div>
            <span class="badge" :class="overview?.connections.imap ? 'sent' : 'cancelled'">{{
              demo ? '模拟连接' : overview?.connections.imap ? '已配置，待检查' : '未配置'
            }}</span>
          </div>
          <div class="connection-row">
            <Send :size="21" />
            <div>
              <strong>飞书应用机器人</strong>
              <p>私聊目标 {{ overview?.connections.recipient }} · 不接收会话消息</p>
            </div>
            <span class="badge" :class="overview?.connections.feishu ? 'sent' : 'cancelled'">{{
              demo ? '模拟连接' : overview?.connections.feishu ? '已配置，待检查' : '未配置'
            }}</span
            ><button :disabled="busy || !overview?.connections.feishu" @click="testFeishu">
              <Send :size="16" />发送测试
            </button>
          </div>
          <p class="muted">
            {{
              demo
                ? '演示环境不会建立外部连接。'
                : '连接信息在本机 .env 中配置；“已配置”不代表连接测试通过。'
            }}
          </p>
        </section>
        <SummarySettings
          v-if="summaryConfig"
          :value="summaryConfig"
          :busy="busy"
          :demo="demo"
          @save="
            (value) =>
              act(async () => {
                await api('/summaries/settings', 'PUT', { ...value, confirmed: true });
              }, '摘要预算已保存；请在订阅源单独授权。')
          "
        />
        <form
          class="settings-band settings-form"
          @submit.prevent="
            act(async () => {
              await api('/settings', 'PUT', preferences);
            }, '设置已保存。')
          "
        >
          <h2>采集与保留</h2>
          <label
            >日报时间（所选时区）<input v-model="preferences.digestTime" type="time" required
          /></label>
          <label>统计与日报时区<input v-model="preferences.timezone" required /></label
          ><label
            >频道 / RSS 检查间隔（分钟）<input
              v-model.number="preferences.youtubeMinutes"
              type="number"
              min="5"
              max="1440"
              required /></label
          ><label
            >邮箱检查间隔（分钟）<input
              v-model.number="preferences.mailMinutes"
              type="number"
              min="5"
              max="1440"
              required /></label
          ><label
            >每日发送尝试上限<input
              v-model.number="preferences.dailyLimit"
              type="number"
              min="1"
              max="500"
              required /></label
          ><label
            >邮件正文保留（天）<input
              v-model.number="preferences.mailDays"
              type="number"
              min="1"
              max="30"
              required /></label
          ><label
            >其他内容与元数据保留（天）<input
              v-model.number="preferences.itemDays"
              type="number"
              min="1"
              max="90"
              required
          /></label>
          <div class="form-footer">
            <button class="primary" :disabled="busy"><Check :size="17" />保存设置</button>
          </div>
        </form>
      </template>
    </main>
    <div v-if="detail" class="overlay" @click.self="detail = null">
      <section class="drawer" role="dialog" aria-modal="true" aria-label="内容详情">
        <header>
          <span class="eyebrow">{{
            detail.kind === 'email'
              ? '邮件详情'
              : detail.kind === 'digest'
                ? '日报分片'
                : detail.kind === 'rss'
                  ? 'RSS 条目'
                  : '视频简介'
          }}</span
          ><button class="icon" aria-label="关闭详情" @click="detail = null">
            <X :size="20" />
          </button>
        </header>
        <h2>{{ detail.title || '内容已清理' }}</h2>
        <p class="muted">
          {{ detail.author }} · {{ time(detail.received || detail.published || detail.discovered) }}
        </p>
        <span class="badge" :class="detail.delivery?.status">{{
          detail.delivery?.resolution === 'user_acknowledged'
            ? '已人工核查'
            : labels[detail.delivery?.status || 'discovered']
        }}</span>
        <p v-if="detail.delivery?.error" class="alert error">
          {{ explain(detail.delivery.error) }}
        </p>
        <p v-if="detail.delivery?.mode === 'digest_part'" class="section-note">
          此记录属于日报分片。核查与重发作用于整个分片，不会单独发送某一成员。
        </p>
        <p class="body-text">{{ detail.expired ? '正文已过保留期。' : detail.text }}</p>
        <ItemSummary
          v-if="['youtube', 'email', 'rss'].includes(detail.kind) && !detail.expired"
          :rows="detail.summaries"
          :allowed="detail.summaryAllowed"
          :busy="busy"
          @generate="generateSummary"
        />
        <a
          v-if="detail.url"
          :href="detail.url"
          target="_blank"
          rel="noopener noreferrer"
          class="external"
          >查看来源原文<ArrowUpRight :size="17"
        /></a>
        <p v-else-if="detail.kind === 'email'" class="muted">
          邮件无公共链接，请在邮箱按发件地址与主题查看原文。
        </p>
        <section class="attempts">
          <h3>发送记录</h3>
          <p v-if="!detail.attempts.length" class="muted">尚无发送尝试。</p>
          <div v-for="(attempt, index) in detail.attempts" :key="index">
            <time>{{ time(attempt.at) }}</time
            ><strong>{{ labels[attempt.status] }}</strong
            ><small>{{ attempt.code }}</small>
          </div>
        </section>
        <div v-if="['unknown', 'failed'].includes(detail.delivery?.status || '')" class="actions">
          <button :disabled="busy || !!detail.expired" @click="resolve('retry')">
            <RefreshCw :size="17" />确认后重发</button
          ><button :disabled="busy" @click="resolve('acknowledge')">
            <Check :size="17" />已核查
          </button>
        </div>
        <p class="muted">“已接受”仅表示飞书接口成功接受消息，不代表已读。</p>
      </section>
    </div>
    <div v-if="editor" class="overlay" @click.self="editor = false">
      <section class="modal" role="dialog" aria-modal="true" aria-label="订阅源设置">
        <header>
          <h2>{{ editing ? '编辑订阅源' : '添加订阅源' }}</h2>
          <button class="icon" aria-label="关闭" @click="editor = false"><X :size="20" /></button>
        </header>
        <form @submit.prevent="save">
          <div class="segmented" v-if="!editing">
            <button
              type="button"
              :class="{ selected: form.type === 'youtube' }"
              @click="form.type = 'youtube'"
            >
              <Youtube :size="18" />YouTube</button
            ><button
              type="button"
              :class="{ selected: form.type === 'email' }"
              @click="form.type = 'email'"
            >
              <Mail :size="18" />邮件规则
            </button>
            <button
              type="button"
              :class="{ selected: form.type === 'rss' }"
              @click="form.type = 'rss'"
            >
              <Rss :size="18" />RSS
            </button>
          </div>
          <label>名称<input v-model="form.name" required maxlength="100" /></label
          ><label v-if="form.type === 'youtube'"
            >频道地址 / ID<input
              v-model="form.channel"
              :disabled="!!editing"
              required
              maxlength="2048"
              placeholder="https://www.youtube.com/@频道名 / UC…" /></label
          ><template v-else-if="form.type === 'email'"
            ><label
              >发件邮箱地址<input
                v-model="form.sender"
                type="email"
                :disabled="!!editing"
                required
                placeholder="newsletter@example.com" /></label
            ><label>主题关键词（可选）<input v-model="form.subject" maxlength="200" /></label
          ></template>
          <template v-else
            ><label
              >公开 RSS / Atom 地址<input
                v-model="form.feed_url"
                type="url"
                required
                :disabled="!!editing"
                placeholder="https://site.com/feed.xml" /></label
            ><label v-if="!editing" class="check-row disclosure"
              ><input
                v-model="form.publicConfirmed"
                type="checkbox"
                required
              />我确认此地址公开且不含私人 Token。</label
            ></template
          >
          <label v-if="!editing"
            >投递方式<select v-model="form.delivery_mode" aria-label="投递方式">
              <option value="immediate">即时通知</option>
              <option value="digest">每日日报</option>
            </select></label
          >
          <p class="muted">
            {{
              editing
                ? '保存修改会暂停采集，重新启用后建立基线。'
                : '添加后默认暂停，不会立即读取或推送历史内容。'
            }}
          </p>
          <p v-if="error" class="error" role="alert">{{ error }}</p>
          <div class="form-footer">
            <button type="button" @click="editor = false">取消</button
            ><button class="primary" :disabled="busy">{{ busy ? '保存中…' : '保存订阅源' }}</button>
          </div>
        </form>
      </section>
    </div>
    <div v-if="activation" class="overlay" @click.self="activation = null">
      <section class="modal" role="dialog" aria-modal="true" aria-label="启用订阅">
        <header>
          <h2>启用 {{ activation.name }}</h2>
          <button class="icon" aria-label="关闭" @click="activation = null">
            <X :size="20" />
          </button>
        </header>
        <form @submit.prevent="enable">
          <label
            >启动方式<select v-model="resumeMode">
              <option value="new_only">从当前建立基线，只收之后的新内容</option>
              <option v-if="activation.initialized" value="catch_up">
                补抓暂停期间内容（受 RSS 窗口限制）
              </option>
            </select></label
          ><label class="check-row"
            ><input v-model="notify" type="checkbox" />同时启用飞书私聊推送</label
          ><label v-if="notify" class="check-row disclosure"
            ><input v-model="consent" type="checkbox" required /><span
              >我确认将匹配内容的标题、发件地址及最多400字正文预览发送到配置的飞书用户私聊。</span
            ></label
          >
          <p v-if="error" class="error" role="alert">{{ error }}</p>
          <div class="form-footer">
            <button class="primary" :disabled="busy || (notify && !consent)">
              <Play :size="17" />确认启用
            </button>
          </div>
        </form>
      </section>
    </div>
    <div v-if="deletion" class="overlay" @click.self="deletion = null">
      <section class="modal" role="dialog" aria-modal="true" aria-label="删除订阅源">
        <header>
          <h2>删除 {{ deletion.name }}？</h2>
          <button class="icon" aria-label="关闭" @click="deletion = null"><X :size="20" /></button>
        </header>
        <p>
          停止采集并取消未发送内容；受影响的未发送日报分片整体取消。其他订阅源仍关联的正文记录会保留，已发送消息无法撤回。
        </p>
        <label class="check-row"
          ><input v-model="erase" type="checkbox" />同时清理仅属于此源的历史正文与元数据</label
        >
        <div class="form-footer">
          <button @click="deletion = null">取消</button
          ><button class="danger" :disabled="busy" @click="remove">
            <Trash2 :size="16" />确认删除
          </button>
        </div>
      </section>
    </div>
    <div v-if="confirmation" class="overlay top" @click.self="confirmation = null">
      <section class="modal" role="dialog" aria-modal="true" :aria-label="confirmation.title">
        <header>
          <h2>{{ confirmation.title }}</h2>
          <button class="icon" aria-label="关闭" @click="confirmation = null">
            <X :size="20" />
          </button>
        </header>
        <p>{{ confirmation.text }}</p>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <div class="form-footer">
          <button @click="confirmation = null">取消</button
          ><button class="primary" :disabled="busy" @click="confirm">确认</button>
        </div>
      </section>
    </div>
    <TransferDialog
      v-if="transfer"
      :action="transfer"
      :call="api"
      @close="transfer = ''"
      @done="imported"
    />
  </div>
</template>
