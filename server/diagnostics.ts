import type { Engine } from './engine.js';

export function diagnostics(engine: Engine) {
  const { store, config } = engine;
  const count = (sql: string) => Number(store.get<{ n: number }>(sql)?.n || 0);
  const heartbeat = Number(store.stats().heartbeat || 0);
  const state = store.get<{ value: string }>("SELECT value FROM meta WHERE key='worker-state'")?.value;
  const parsed = state ? JSON.parse(state) : { phase: 'idle', summarizing: false };
  const worker = parsed.phase !== 'stopped' && heartbeat > 0 && store.now() - heartbeat >= 0 && store.now() - heartbeat < 120_000;
  const summary = engine.summaries.describe();
  const weixin = config.pushChannel === 'weixin' && !config.demo ? engine.weixin.describe() : undefined;
  const reasons: Record<string, string> = {
    WEIXIN_CONTEXT_REJECTED: '微信拒绝发送，可能上下文或发送限制',
    WEIXIN_SESSION_EXPIRED: '微信登录失效，请重新扫码绑定',
    WEIXIN_NEEDS_MESSAGE: '缺少发送上下文，请向机器人发一条新消息',
    WEIXIN_LOCAL_STATE_INVALID: '本机绑定信息无法读取，请重新绑定',
  };
  const push = { ready: engine.pushReady, reason: weixin && !weixin.ready ? weixin.error || 'WEIXIN_UNBOUND' : '',
    nextRetryAt: weixin && (weixin.ready || weixin.error === 'WEIXIN_CONTEXT_REJECTED') ? weixin.nextRetryAt : 0 };
  const enabled = store.sources().filter(s => s.enabled);
  const automatic = enabled.filter(s => s.notify && s.summary_mode === 'auto');
  const sourceIssues = enabled.filter(s => s.error).map(s => {
    const job = store.get<{ status: string; available: number }>(
      `SELECT status,available FROM jobs WHERE kind=? AND resource=? AND (?='mailbox' OR generation=?) AND status IN ('pending','running','retry_wait') ORDER BY created DESC LIMIT 1`,
      s.type === 'email' ? 'mailbox' : 'source', s.type === 'email' ? 'default' : s.id,
      s.type === 'email' ? 'mailbox' : 'source', s.generation,
    );
    return { sourceId: s.id, name: s.name, error: s.error, lastSuccess: s.last_success,
      status: job?.status || 'failed', nextCheck: job?.status === 'retry_wait' ? job.available : s.next_check };
  });
  return {
    worker: { running: worker, heartbeat: heartbeat || null, phase: parsed.phase, summarizing: parsed.summarizing },
    sourceIssues,
    push,
    checks: [
      { id: 'worker', ok: worker, label: '后台任务', detail: worker ? '运行中' : '未检测到近期心跳，检查服务或独立 Worker' },
      { id: 'sources', ok: enabled.length > 0 && sourceIssues.length === 0, label: '订阅采集', detail: `${enabled.length} 个已启用；${sourceIssues.length} 个异常` },
      { id: 'push', ok: push.ready, label: '推送通道', detail: push.ready ? push.nextRetryAt ? '整点重试窗口内，符合条件的当日任务待后台调度（仍受授权及额度限制）' : '已就绪，实际收件仍需验证' : `${reasons[push.reason] || '未就绪，请检查绑定或通道配置'}${push.nextRetryAt > store.now() ? `；下次自动重试（北京时间）：${new Date(push.nextRetryAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（含任务创建当日24:00最后一轮，仍受授权及额度限制）` : push.reason === 'WEIXIN_CONTEXT_REJECTED' ? '；当日已无可用整点，旧任务00:01过期，不再补发' : ''}` },
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
