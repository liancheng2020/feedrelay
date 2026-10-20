import type { Engine } from './engine.js';

export function diagnostics(engine: Engine) {
  const { store, config } = engine;
  const count = (sql: string) => Number(store.get<{ n: number }>(sql)?.n || 0);
  const heartbeat = Number(store.stats().heartbeat || 0);
  const state = store.get<{ value: string }>("SELECT value FROM meta WHERE key='worker-state'")?.value;
  const parsed = state ? JSON.parse(state) : { phase: 'idle', summarizing: false };
  const worker = parsed.phase !== 'stopped' && heartbeat > 0 && store.now() - heartbeat >= 0 && store.now() - heartbeat < 120_000;
  const summary = engine.summaries.describe();
  const enabled = store.sources().filter(s => s.enabled);
  const automatic = enabled.filter(s => s.notify && s.summary_mode === 'auto');
  return {
    worker: { running: worker, heartbeat: heartbeat || null, phase: parsed.phase, summarizing: parsed.summarizing },
    checks: [
      { id: 'worker', ok: worker, label: '后台任务', detail: worker ? '运行中' : '未检测到近期心跳，检查服务或独立 Worker' },
      { id: 'sources', ok: enabled.length > 0 && !enabled.some(s => s.error), label: '订阅采集', detail: `${enabled.length} 个已启用；${enabled.filter(s => s.error).length} 个异常` },
      { id: 'push', ok: engine.pushReady, label: '推送通道', detail: engine.pushReady ? '已就绪，实际收件仍需验证' : '未就绪，请检查绑定或通道配置' },
      { id: 'summary', ok: summary.ready && summary.enabled && summary.calls < summary.maxCalls && summary.reservedCny < summary.maxCostCny,
        label: 'AI 摘要', detail: !summary.ready ? '模型未配置或不可用' : !summary.enabled ? '未开启摘要预算' : summary.calls >= summary.maxCalls || summary.reservedCny >= summary.maxCostCny ? '预算已用完' : '模型与预算已配置' },
      { id: 'automatic', ok: automatic.some(s => s.summary_consent === summary.currentStamp && (s.summary_content !== 'captions' || summary.captionsReady)),
        label: '自动摘要推送', detail: `${automatic.filter(s => s.summary_consent === summary.currentStamp && (s.summary_content !== 'captions' || summary.captionsReady)).length} 个来源已授权自动摘要及推送` },
      { id: 'mail', ok: !enabled.some(s => s.type === 'email') || config.imap.enabled,
        label: '邮件接入', detail: config.imap.enabled ? 'IMAP 已配置，不代表连接验证通过' : 'IMAP 未启用' },
    ],
    queues: {
      summaries: count("SELECT count(*) n FROM summaries WHERE status='running'"),
      summaryFailures: count("SELECT count(*) n FROM summaries s JOIN items i ON i.id=s.item_id WHERE s.status IN ('failed','unknown') AND i.expired=0"),
      unknownDeliveries: count("SELECT count(*) n FROM deliveries d JOIN items i ON i.id=d.item_id WHERE d.status='unknown' AND i.expired=0"),
    },
  };
}
