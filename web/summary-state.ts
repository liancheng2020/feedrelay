const labels: Record<string, string> = {
  none: '未生成',
  queued: '等待处理',
  running: '正在提取与总结',
  succeeded: '已生成',
  failed: '生成失败',
  unknown: '结果待核查',
  cancelled: '已失效',
  expired: '正文已过期',
};

export function summaryState(status = 'none', error = '') {
  const missing =
    status === 'failed' && ['YOUTUBE_NO_CAPTIONS', 'YOUTUBE_EMPTY_CAPTION'].includes(error);
  const blocked = status === 'failed' && error.startsWith('YOUTUBE_');
  return {
    label: missing ? '暂无可用字幕' : blocked ? '字幕获取受阻' : labels[status] || status,
    tone: missing ? 'unavailable' : blocked ? 'retry_wait' : status,
    captionIssue: blocked,
  };
}
