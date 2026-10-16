import type { Config } from './config.js';
import { Store, type Incoming } from './store.js';
import { channelId, type Envelope } from './adapters.js';
import type { Adapters } from './engine.js';

const channels = ['UC' + 'a'.repeat(22), 'UC' + 'b'.repeat(22)];
export function seedDemo(store: Store) {
  if (store.sources().length) return;
  const sources = [
    store.createSource({ type: 'youtube', name: 'AI 工程观察 · 样例', channel: channels[0] }),
    store.createSource({ type: 'youtube', name: '产品与技术 · 样例', channel: channels[1] }),
    store.createSource({
      type: 'email',
      name: '市场观察日报 · 样例',
      sender: 'brief@example.com',
      subject: '',
    }),
  ];
  for (const s of sources)
    store.run(
      'UPDATE sources SET enabled=1,notify=1,initialized=1,baseline=?,last_success=?,next_check=?,boundary=100,epoch=? WHERE id=?',
      store.now() - 86_400_000,
      store.now() - 120_000,
      store.now() + 900_000,
      'demo-1',
      s.id,
    );
  store.run('INSERT OR IGNORE INTO mailbox_cursors VALUES (1,?,?,0)', 'demo-1', 100);
  const titles = [
    'Agent 的边界：把不确定的决策放进确定的流程',
    '今日资讯：市场、产品与技术动态',
    '为什么幂等不是加一个重试按钮',
    '从需求到上线：一个小工具的工程取舍',
    '邮件与 RSS：信息流的不同入口',
    '长任务中断之后，应该从哪里继续',
  ];
  const texts = [
    '本条为合成演示内容，不代表真实视频或新闻。\n\n关注执行边界、持久化状态和可回查证据。没有完整资料时，不用标题猜测全文。',
    '本邮件为测试样例，不读取真实163邮箱。\n\n1. 核对资讯时间与来源。\n2. 区分事实和作者观点。\n3. 重要内容回到原文。',
  ];
  titles.forEach((title, index) => {
    const source = sources[index % 3],
      email = source.type === 'email';
    const item = store.put(
      {
        key: 'demo:seed:' + index,
        kind: email ? 'email' : 'youtube',
        title,
        author: source.name,
        url: '',
        text: texts[+email],
        published: store.now() - (index + 1) * 3_600_000,
        received: email ? store.now() - (index + 1) * 3_600_000 : null,
      },
      [store.source(source.id)],
      true,
      'demo',
    );
    store.run(
      `UPDATE deliveries SET status=?,error=?,sent=? WHERE item_id=?`,
      index === 2 ? 'unknown' : index === 4 ? 'failed' : 'sent',
      index === 2 ? 'SEND_UNCONFIRMED' : index === 4 ? 'FEISHU_RATE_LIMIT' : 'DEMO_ACCEPTED',
      index === 2 || index === 4 ? null : store.now() - index * 60_000,
      item.id,
    );
  });
  store.run('INSERT OR IGNORE INTO meta VALUES (?,?)', 'demo-sequence', '0');
}
export function advanceDemo(store: Store) {
  const n =
    Number(
      store.get<{ value: string }>('SELECT value FROM meta WHERE key=?', 'demo-sequence')?.value ||
        0,
    ) + 1;
  store.run(
    'INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    'demo-sequence',
    String(n),
  );
  store.run('UPDATE sources SET next_check=0 WHERE enabled=1 AND deleted=0');
  return n;
}
export function demoAdapters(store: Store, config: Config): Adapters {
  const sequence = () =>
    Number(
      store.get<{ value: string }>('SELECT value FROM meta WHERE key=?', 'demo-sequence')?.value ||
        0,
    );
  return {
    async feed(channel) {
      channelId(channel);
      const n = sequence();
      const item: Incoming = {
        key: `youtube:d${String(n).padStart(10, '0')}`,
        kind: 'youtube',
        title: `订阅更新 #${n} · 合成样例`,
        author: 'AI 工程观察 · 样例',
        text: '这是一条用于验证发现、去重和推送状态的演示更新。没有读取真实频道或发送外部消息。',
        url: '',
        published: store.now(),
      };
      return { unchanged: false, items: n ? [item] : [], etag: '', modified: '' };
    },
    async mailbox() {
      const n = sequence();
      return {
        epoch: 'demo-1',
        upper: 100 + n,
        async headers(from, to) {
          const out: Envelope[] = [];
          for (let uid = from; uid <= to; uid++)
            out.push({
              uid,
              sender: 'brief@example.com',
              subject: `资讯更新 #${uid - 100} · 合成样例`,
              received: store.now(),
              published: store.now(),
            });
          return out;
        },
        async body() {
          return '合成 Newsletter 正文：账户、文件夹和飞书目标均未连接真实服务。';
        },
        async close() {},
      };
    },
    async send() {
      return { status: 'sent', code: 'DEMO_ACCEPTED' };
    },
  };
}
