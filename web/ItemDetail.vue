<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ArrowLeft, ExternalLink, Play, Sparkles, RefreshCw, Check } from '@lucide/vue';
import SummaryReading, { type SummaryView } from './SummaryReading.vue';
import { summaryState } from './summary-state';
export interface ReadingDetail {
  id: string;
  videoId: string;
  kind: string;
  title: string;
  author: string;
  text: string;
  url: string;
  expired: number;
  received: number | null;
  published: number | null;
  discovered: number;
  summaries: SummaryView[];
  canSummarize: boolean;
  transcript: { language: string; kind: string; text: string } | null;
  delivery: {
    id: string;
    status: string;
    error: string;
    resolution: string;
    mode: string;
    attempt: number;
  } | null;
  attempts: { n: number; at: number; status: string; code: string }[];
}
const props = defineProps<{
  detail: ReadingDetail;
  demo: boolean;
  busy: boolean;
  captionsReady: boolean;
  asrReady?: boolean;
  pushReady: boolean;
  pushLabel: string;
  time: (v: number | null | undefined) => string;
  explain: (s: string) => string;
  labels: Record<string, string>;
}>();
const emit = defineEmits<{
  back: [];
  generate: [retry: boolean, refresh: boolean, content: 'feed' | 'captions'];
  push: [row: SummaryView];
  resolve: [action: 'retry' | 'acknowledge'];
  settings: [];
  delivery: [id: string];
}>();
const playing = ref(false);
const current = computed(() => props.detail.summaries.find((r) => r.current));
const captionIssue = computed(
  () => current.value && summaryState(current.value.status, current.value.error).captionIssue,
);
watch(
  () => props.detail.id,
  () => {
    playing.value = false;
  },
  { immediate: true },
);
const video = computed(() => {
  if (props.detail.kind !== 'youtube') return '';
  if (/^[a-zA-Z0-9_-]{11}$/.test(props.detail.videoId)) return props.detail.videoId;
  try {
    const u = new URL(props.detail.url),
      id = u.searchParams.get('v') || '';
    return u.hostname === 'www.youtube.com' && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : '';
  } catch {
    return '';
  }
});
const generating = computed(() =>
  props.detail.summaries.some((r) => r.current && ['queued', 'running'].includes(r.status)),
);
const segments = computed(
  () =>
    props.detail.transcript?.text.split(/\n\s*\n/).map((s) => {
      const m = s.match(/^\[([\d:]+)\]\s*(.*)$/s);
      return {
        label: m?.[1] || '',
        text: m?.[2] || s,
        seconds: m ? m[1].split(':').reduce((n, v) => n * 60 + Number(v), 0) : 0,
      };
    }) || [],
);
</script>
<template>
  <section class="reading-page" aria-label="内容详情">
    <header class="reading-header">
      <div class="reading-topline">
        <div class="reading-meta">
          <span>{{
            detail.kind === 'youtube' ? 'YOUTUBE' : detail.kind === 'email' ? 'EMAIL' : 'FEED'
          }}</span
          ><span>{{ detail.author }}</span
          ><time>{{ time(detail.received || detail.published || detail.discovered) }}</time>
        </div>
        <button class="quiet reading-back" @click="emit('back')">
          <ArrowLeft :size="17" />返回列表
        </button>
      </div>
      <h1>{{ detail.title || '内容已清理' }}</h1>
      <div class="reading-meta">
        <span class="badge" :class="detail.delivery?.status">{{
          detail.delivery?.resolution === 'user_acknowledged'
            ? '已人工核查'
            : detail.delivery?.error === 'SUMMARY_REQUIRED' ? '等待摘要' : labels[detail.delivery?.status || 'discovered']
        }}</span
        ><a v-if="detail.url" :href="detail.url" target="_blank" rel="noopener noreferrer"
          >查看来源<ExternalLink :size="14"
        /></a>
      </div>
    </header>
    <p v-if="detail.expired" class="alert">正文已过保留期，不能生成或推送旧摘要。</p>
    <div class="reading-layout">
      <section class="reading-source" aria-label="来源内容">
        <div v-if="video && !demo && !detail.expired" class="video-surface">
          <iframe
            v-if="playing"
            :src="`https://www.youtube-nocookie.com/embed/${video}`"
            :title="detail.title"
            allow="autoplay; encrypted-media; picture-in-picture"
            allowfullscreen
            referrerpolicy="strict-origin-when-cross-origin"
          ></iframe
          ><button v-else class="video-poster" @click="playing = true" aria-label="播放视频">
            <img
              :src="`https://i.ytimg.com/vi/${video}/hqdefault.jpg`"
              :alt="detail.title"
              referrerpolicy="no-referrer"
            /><span><Play :size="24" />播放视频</span>
          </button>
        </div>
        <div v-if="detail.kind !== 'youtube' || detail.transcript" class="reading-section-head">
          <h2>
            {{
              detail.kind === 'youtube'
                ? detail.transcript?.kind === 'transcribed'
                  ? '音频转写全文'
                  : '字幕原文'
                : '来源内容'
            }}
          </h2>
          <span v-if="detail.transcript" class="muted"
            >{{ detail.transcript.language }} ·
            {{
              detail.transcript.kind === 'transcribed'
                ? '本地转写 · 可能误识别'
                : detail.transcript.kind === 'automatic'
                  ? '自动字幕'
                  : '人工字幕'
            }}</span
          >
        </div>
        <div v-if="detail.kind === 'youtube' && detail.transcript" class="transcript-scroll">
          <p v-for="(s, i) in segments" :key="i">
            <a
              v-if="s.label"
              :href="`https://www.youtube.com/watch?v=${video}&t=${s.seconds}s`"
              target="_blank"
              rel="noopener noreferrer"
              >{{ s.label }}</a
            ><span>{{ s.text }}</span>
          </p>
        </div>
        <p v-else-if="detail.kind !== 'youtube'" class="reading-body">
          {{ detail.expired ? '正文已清理。' : detail.text || '来源没有提供正文。' }}
        </p>
      </section>
      <div class="reading-analysis">
        <div
          v-if="['youtube', 'email', 'rss'].includes(detail.kind) && !detail.expired"
          class="summary-controls"
        >
          <button
            class="primary"
            :disabled="
              busy ||
              generating ||
              !detail.canSummarize ||
              (detail.kind === 'youtube' && !captionsReady)
            "
            @click="
              emit(
                'generate',
                !!current && ['failed', 'unknown'].includes(current.status),
                false,
                detail.kind === 'youtube' ? 'captions' : 'feed',
              )
            "
          >
            <RefreshCw v-if="captionIssue" :size="16" /><Sparkles v-else :size="16" />{{
              generating
                ? '处理中'
                : captionIssue
                  ? asrReady
                    ? '重新提取并总结'
                    : '重新获取字幕'
                  : '生成摘要'
            }}</button
          ><button
            v-if="current?.status === 'succeeded'"
            class="icon"
            title="重新生成摘要"
            aria-label="重新生成摘要"
            :disabled="busy || generating || !detail.canSummarize"
            @click="emit('generate', false, true, detail.kind === 'youtube' ? 'captions' : 'feed')"
          >
            <RefreshCw :size="16" /></button
          ><button v-if="!detail.canSummarize" class="quiet" @click="emit('settings')">
            配置AI预算
          </button>
          <span v-if="detail.kind === 'youtube'" class="muted">{{
            asrReady
              ? '字幕优先 · 无字幕时本地转写'
              : captionsReady
                ? '基于视频字幕 · 不含画面'
                : '字幕组件未启用，请检查本机配置。'
          }}</span>
        </div>
        <SummaryReading
          v-if="['youtube', 'email', 'rss'].includes(detail.kind) && !detail.expired"
          :rows="detail.summaries"
          :busy="busy"
          :push-ready="pushReady"
          :push-label="pushLabel"
          @push="emit('push', $event)"
          @delivery="emit('delivery', $event)"
        />
        <section class="reading-delivery" aria-label="发送记录">
          <div class="reading-section-head">
            <h2>发送记录</h2>
            <span class="muted">接口接受不代表已读</span>
          </div>
          <p v-if="detail.delivery?.error && detail.delivery.status !== 'sent'" class="alert">
            {{ explain(detail.delivery.error) }}
          </p>
          <p v-if="!detail.attempts.length" class="muted">尚无发送尝试。</p>
          <div v-for="(a, i) in detail.attempts" :key="i" class="attempt-line">
            <time>{{ time(a.at) }}</time
            ><span class="badge" :class="a.status">{{ labels[a.status] }}</span
            ><small>{{ explain(a.code) }}</small>
          </div>
          <div v-if="['unknown', 'failed'].includes(detail.delivery?.status || '')" class="actions">
            <button :disabled="busy || !!detail.expired" @click="emit('resolve', 'retry')">
              <RefreshCw :size="16" />确认后重发</button
            ><button :disabled="busy" @click="emit('resolve', 'acknowledge')">
              <Check :size="16" />已核查
            </button>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>
