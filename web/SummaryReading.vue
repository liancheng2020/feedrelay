<script setup lang="ts">
import { computed, ref } from 'vue';
import { List, GitBranch, Clock3, Quote, Send, ExternalLink, LoaderCircle } from '@lucide/vue';
import { summaryState } from './summary-state';
export interface SummaryView {
  id: string;
  status: string;
  error: string;
  scope: string;
  current: boolean;
  revision: string;
  created: number;
  finished: number | null;
  progress?: { stage: string; percent: number } | null;
  result: {
    oneLiner: string;
    formatRepaired?: boolean;
    points: { title: string; text: string; quote: string; locator: string; url?: string }[];
  } | null;
  caption: { language: string; kind: string; hash: string } | null;
  output: { id: string; item_id: string; status: string; error: string; resolution: string } | null;
  calls: { status: string; reserved_micro: number; actual_micro: number | null }[];
}
const props = defineProps<{
  rows: SummaryView[];
  busy: boolean;
  pushReady: boolean;
  pushLabel: string;
}>();
const emit = defineEmits<{ push: [row: SummaryView]; delivery: [id: string] }>();
const mode = ref('points');
const latest = computed(() => props.rows.find((r) => r.current) || props.rows[0]);
const result = computed(() => (latest.value?.current ? latest.value.result : null));
const ordered = computed(() =>
  [...(result.value?.points || [])].sort((a, b) => {
    const seconds = (p: typeof a) =>
      p.locator
        .replace(/[\[\]]/g, '')
        .split(':')
        .reduce((n, v) => n * 60 + Number(v), 0);
    return seconds(a) - seconds(b);
  }),
);
const state = computed(() => summaryState(latest.value?.status, latest.value?.error));
const stages: Record<string, string> = {
  captions: '正在获取公开字幕',
  downloading: '正在提取视频音频',
  transcribing: '正在本地转写完整音频',
  summarizing: '正在调用 DeepSeek 提炼总结',
};
const errors: Record<string, string> = {
  SUMMARY_NO_CONTENT: '没有可总结的正文。',
  SUMMARY_INVALID_OUTPUT: '模型输出未通过结构或引文校验，请核对后重试。',
  SUMMARY_GENERATION_FAILED: '摘要生成失败，未发布不完整结果。',
  SUMMARY_BUDGET_EXHAUSTED: '累计预算已用完，未继续调用。',
  SUMMARY_UNSUPPORTED_QUOTE: '引用无法在对应原文段落核实，未发布摘要。',
  SUMMARY_CONTENT_TOO_LONG: '正文超过20000字符上限，未截断内容。',
  SUMMARY_CONTENT_UNIT_TOO_LONG: '单段内容过长，无法在不截断证据的前提下处理。',
  SUMMARY_INTERRUPTED: '执行中断，可能已计费，不会自动重做。',
  SUMMARY_CONSENT_OR_CONTENT_CHANGED: '正文、范围或配置已变化，请重新生成。',
  SUMMARY_CONSENT_REVOKED: '此前授权已撤销；生成前请重新确认本条内容范围。',
  MODEL_AUTH_FAILED: 'DeepSeek认证失败，请核对本机配置。',
  MODEL_RATE_LIMITED: 'DeepSeek暂时限流，请稍后手动重试。',
  MODEL_SERVICE_FAILED: 'DeepSeek服务暂不可用。',
  YOUTUBE_NO_CAPTIONS:
    '暂未获取到此视频的公开字幕，未调用 DeepSeek。可重新获取字幕，或前往 YouTube 查看字幕是否可用；不会用推广简介代替视频内容。',
  YOUTUBE_EMPTY_CAPTION: '返回的字幕为空，未调用 DeepSeek。请稍后重新获取字幕。',
  YOUTUBE_CAPTION_TOO_LONG: '字幕超过48000码元上限。',
  YOUTUBE_RUNTIME_UNAVAILABLE: '字幕组件不可用，请检查本机配置。',
  YOUTUBE_ASR_NOT_READY: '本地转写尚未就绪，请安装转写组件和模型后重启服务。',
  YOUTUBE_ASR_DEPENDENCY_MISSING: '缺少本地转写依赖，请安装 requirements-asr.txt 后重启。',
  YOUTUBE_ASR_FAILED: '音频转写失败，未用简介代替视频内容。可手动重试。',
  YOUTUBE_ASR_EMPTY: '未识别到可用语音，未调用 DeepSeek。',
  YOUTUBE_ASR_VIDEO_TOO_LONG: '视频超过本地转写的60分钟上限，未只取片段冒充全文。',
  YOUTUBE_AUDIO_TOO_LARGE: '音频超过100MB上限，已停止处理。',
  YOUTUBE_AUDIO_UNAVAILABLE: '未能取得音频文件，尚未开始转写或总结。',
  YOUTUBE_EXTRACTION_FAILED: '字幕提取失败，请检查网络后重试。',
  YOUTUBE_ACCESS_BLOCKED: 'YouTube要求验证，未读取Cookie或绕过限制。',
  YOUTUBE_RATE_LIMITED: 'YouTube暂时限流。',
  YOUTUBE_NETWORK_ERROR: '无法连接YouTube，请检查服务端代理。',
  YOUTUBE_TIMEOUT: '视频内容提取或本地转写超时，已停止处理。',
  SUMMARY_TASK_CALL_LIMIT: '本次任务已达请求上限，未继续调用。',
};
const deliveryStates: Record<string, string> = {
  pending: '待发送',
  sending: '发送中',
  sent: '接口已接受',
  retry_wait: '等待重试',
  unknown: '待核查',
  failed: '失败',
  cancelled: '已取消',
};
</script>
<template>
  <section class="reading-summary" aria-label="AI摘要">
    <div class="reading-section-head">
      <h2>AI 摘要</h2>
      <span v-if="latest" class="badge" :class="state.tone">{{ state.label }}</span>
    </div>
    <div
      v-if="latest && ['queued', 'running'].includes(latest.status)"
      class="summary-progress"
      role="status"
    >
      <LoaderCircle :size="18" class="spin" />{{
        stages[latest.progress?.stage || ''] || state.label
      }}{{
        ['downloading', 'transcribing'].includes(latest.progress?.stage || '')
          ? ` · ${Math.floor(latest.progress!.percent)}%`
          : ''
      }}
    </div>
    <p
      v-if="latest?.error"
      :class="state.captionIssue ? 'summary-source-notice' : 'alert'"
      role="status"
    >
      {{ errors[latest.error] || latest.error }}
    </p>
    <template v-if="result">
      <p class="summary-lead">{{ result.oneLiner }}</p>
      <p v-if="result.formatRepaired" class="muted">
        输出格式经过本地修复，内容与引用未改写；仍请核对原文。
      </p>
      <div class="reading-meta">
        <span>{{ latest?.scope }}</span
        ><time v-if="latest?.finished">{{ new Date(latest.finished).toLocaleString() }}</time>
      </div>
      <div class="summary-toolbar">
        <div class="segmented" role="tablist" aria-label="摘要视图">
          <button
            role="tab"
            :aria-selected="mode === 'points'"
            :class="{ selected: mode === 'points' }"
            @click="mode = 'points'"
          >
            <List :size="15" />要点</button
          ><button
            role="tab"
            :aria-selected="mode === 'map'"
            :class="{ selected: mode === 'map' }"
            @click="mode = 'map'"
          >
            <GitBranch :size="15" />脉络</button
          ><button
            v-if="result.points.some((p) => p.url)"
            role="tab"
            :aria-selected="mode === 'timeline'"
            :class="{ selected: mode === 'timeline' }"
            @click="mode = 'timeline'"
          >
            <Clock3 :size="15" />时间线
          </button>
        </div>
        <button
          class="primary"
          :disabled="
            busy || !pushReady || (!!latest?.output && latest.output.status !== 'cancelled')
          "
          @click="emit('push', latest!)"
        >
          <Send :size="16" />{{ pushLabel }}推送
        </button>
      </div>
      <p v-if="!pushReady" class="muted">推送通道尚未就绪，请先在投递设置连接。</p>
      <div v-if="latest?.output" class="summary-delivery">
        <span class="badge" :class="latest.output.status">{{
          deliveryStates[latest.output.status] || latest.output.status
        }}</span
        ><button class="quiet" @click="emit('delivery', latest!.output!.item_id)">
          查看投递记录<ExternalLink :size="14" />
        </button>
      </div>
      <div v-if="mode === 'map'" class="summary-map" role="group" aria-label="内容脉络图">
        <div class="map-root">{{ result.oneLiner }}</div>
        <ol>
          <li v-for="(p, index) in result.points" :key="index">
            <strong>{{ p.title }}</strong>
            <p>{{ p.text }}</p>
          </li>
        </ol>
      </div>
      <ol v-else-if="mode === 'timeline'" class="summary-timeline">
        <li v-for="(p, index) in ordered" :key="index">
          <a v-if="p.url" :href="p.url" target="_blank" rel="noopener noreferrer">{{ p.locator }}</a
          ><strong>{{ p.title }}</strong>
          <p>{{ p.text }}</p>
        </li>
      </ol>
      <div v-else class="summary-points">
        <article v-for="(p, index) in result.points" :key="index">
          <h3>
            <span>{{ String(index + 1).padStart(2, '0') }}</span
            >{{ p.title }}
          </h3>
          <p>{{ p.text }}</p>
          <blockquote>
            <Quote :size="14" />
            <div>
              <small>原文定位片段</small>
              {{ p.quote
              }}<a v-if="p.url" :href="p.url" target="_blank" rel="noopener noreferrer"
                >{{ p.locator }} 查看原文<ExternalLink :size="12" /></a
              ><small v-else>{{ p.locator }}</small>
            </div>
          </blockquote>
        </article>
      </div>
    </template>
    <p v-else-if="!latest || latest.status === 'cancelled'" class="summary-placeholder">
      尚无当前内容的有效摘要。
    </p>
    <p v-if="latest?.calls.length" class="summary-usage-note">
      累计 {{ latest.calls.length }} 次请求 · 保守预算占用 ¥{{
        (
          latest.calls.reduce(
            (sum, c) => sum + Math.max(c.reserved_micro, c.actual_micro || 0),
            0,
          ) / 1e6
        ).toFixed(4)
      }}
    </p>
  </section>
</template>
