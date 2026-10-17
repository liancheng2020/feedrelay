<script setup lang="ts">
import { FileText, RefreshCw } from '@lucide/vue';
export interface SummaryView {
  id: string;
  status: string;
  error: string;
  scope: string;
  current: boolean;
  result: {
    oneLiner: string;
    points: { title: string; text: string; quote: string; locator: string; url?: string }[];
  } | null;
  caption: { language: string; kind: string; hash: string } | null;
  output: { status: string; error: string } | null;
  calls: { status: string; reserved_micro: number; actual_micro: number | null }[];
}
defineProps<{ rows: SummaryView[]; allowed: boolean; busy: boolean }>();
defineEmits<{ generate: [retry: boolean] }>();
const states: Record<string, string> = {
  queued: '等待摘要',
  running: '摘要处理中',
  succeeded: '已生成',
  failed: '摘要失败',
  cancelled: '已失效',
  expired: '正文已过期',
  unknown: '调用结果待核查',
};
const errors: Record<string, string> = {
  SUMMARY_NO_CONTENT: '来源没有提供可总结的正文，未按标题编造内容。',
  MODEL_AUTH_FAILED: '模型认证失败，请核对本项目的独立 Key。',
  MODEL_RATE_LIMITED: '模型接口限流，原始提醒不受影响；不会自动重做。',
  SIFT_SUMMARY_FAILED: 'Sift 未能生成通过校验的摘要，未影响原始提醒。',
  SUMMARY_BUDGET_EXHAUSTED: '累计预算已触顶，未发起下一次调用。',
  SUMMARY_CONTENT_TOO_LONG: '正文超过8000码元，未上传或静默截断。',
  SUMMARY_INTERRUPTED: '执行中断，可能已计费；不会自动重做。',
  SUMMARY_UNSUPPORTED_QUOTE: '引文未能在原文中核实，未发布该摘要。',
  SUMMARY_CONSENT_OR_CONTENT_CHANGED: '授权或原文已变化，旧摘要已失效。',
  YOUTUBE_NO_CAPTIONS: '当前没有可用字幕，原始通知照常；不会自动转写音频。',
  YOUTUBE_EMPTY_CAPTION: '字幕为空，未按标题或简介推测视频内容。',
  YOUTUBE_CAPTION_TOO_LONG: '字幕超过48000码元，未发送模型或静默截断。',
  YOUTUBE_RUNTIME_UNAVAILABLE: '字幕组件未配置或无法启动，简介订阅不受影响。',
  YOUTUBE_DEPENDENCY_MISSING: '字幕组件缺少依赖，请安装 requirements-youtube.txt。',
  YOUTUBE_DEPENDENCY_VERSION: '字幕组件版本不匹配，请按锁定版本重新安装。',
  YOUTUBE_NETWORK_ERROR: '无法连接 YouTube，请检查运行节点与显式代理。',
  YOUTUBE_ACCESS_BLOCKED: 'YouTube 拒绝访问或要求验证，不会自动读取Cookie。',
  YOUTUBE_RATE_LIMITED: 'YouTube 暂时限流，不会自动重复抓取。',
  YOUTUBE_TIMEOUT: '字幕获取超时，已终止进程；可检查网络后手动重试。',
  YOUTUBE_INVALID_CAPTION: '字幕格式或时间信息无效，未生成视频摘要。',
  YOUTUBE_EXTRACTION_FAILED: '未能获取字幕，未影响原始通知。',
  YOUTUBE_CAPTION_TOO_LARGE: '字幕响应超过大小限制，已终止读取。',
  YOUTUBE_VIDEO_UNAVAILABLE: '视频不可用或正在直播，本轮不处理。',
  YOUTUBE_VIDEO_TOO_LONG: '视频超过4小时，本版不自动处理。',
  YOUTUBE_COMPONENT_CHANGED_RESTART: '字幕组件已更新，请重启服务并重新确认授权。',
  YOUTUBE_CAPTION_CACHE_INVALID: '字幕缓存校验失败，请关闭并重新授权该来源后再处理。',
  SUMMARY_TASK_CALL_LIMIT: '本次任务请求上限已用完，未继续调用或发布不完整摘要。',
};
const deliveryStates: Record<string, string> = {
  pending: '待发送',
  sending: '发送中',
  sent: '已接受',
  retry_wait: '等待重试',
  failed: '失败',
  unknown: '待核查',
  cancelled: '已取消',
};
</script>
<template>
  <section class="item-summary">
    <div class="source-heading">
      <h3>AI 摘要</h3>
      <button
        v-if="allowed"
        :disabled="busy || rows.some((r) => ['queued', 'running'].includes(r.status))"
        @click="$emit('generate', false)"
      >
        <FileText :size="16" />生成摘要
      </button>
    </div>
    <p v-if="!allowed" class="muted">
      需先在投递设置启用预算，再单独授权此订阅源；原始提醒不受影响。
    </p>
    <p v-else class="section-note">
      按来源授权处理简介、邮件、Feed文本或公开视频字幕；字幕不包含画面理解。生成内容与引用仍需人工核对。
    </p>
    <article v-for="row in rows" :key="row.id" class="summary-result">
      <p>
        <span class="badge" :class="row.status">{{ states[row.status] || row.status }}</span>
        <span class="muted">{{ row.scope }}</span>
      </p>
      <p v-if="row.caption" class="muted">
        {{ row.caption.language }} ·
        {{ row.caption.kind === 'automatic' ? '自动字幕（可能有识别错误）' : '平台人工字幕轨道' }} ·
        时间定位仅供参考
      </p>
      <p v-if="row.error" class="alert">{{ errors[row.error] || row.error }}</p>
      <template v-if="row.result && row.current">
        <p class="summary-lead">{{ row.result.oneLiner }}</p>
        <div v-for="(point, index) in row.result.points" :key="index" class="summary-point">
          <h4>{{ point.title }}</h4>
          <p>{{ point.text }}</p>
          <blockquote>
            {{ point.quote
            }}<small
              ><a v-if="point.url" :href="point.url" target="_blank" rel="noopener noreferrer"
                >{{ point.locator }} 查看视频</a
              ><template v-else>{{ point.locator }}</template></small
            >
          </blockquote>
        </div>
      </template>
      <p v-else-if="row.result" class="muted">原文或配置已变化，旧结果不代表当前内容。</p>
      <p class="muted">
        {{ row.calls.length }} 次模型请求 · 保守占用 ¥{{
          (
            row.calls.reduce((sum, c) => sum + Math.max(c.reserved_micro, c.actual_micro || 0), 0) /
            1e6
          ).toFixed(4)
        }}<span v-if="row.output">
          · AI补充投递：{{ deliveryStates[row.output.status] || row.output.status }}</span
        >
      </p>
      <button
        v-if="allowed && ['failed', 'unknown'].includes(row.status)"
        :disabled="busy"
        @click="$emit('generate', true)"
      >
        <RefreshCw :size="16" />确认后重新处理
      </button>
    </article>
  </section>
</template>
