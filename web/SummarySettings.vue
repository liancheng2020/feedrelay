<script setup lang="ts">
import { ref, watch } from 'vue';
import { Check } from '@lucide/vue';
export interface SummaryConfig {
  enabled: boolean;
  ready: boolean;
  maxCalls: number;
  maxCostCny: number;
  calls: number;
  reservedCny: number;
  measuredCny: number;
  unknownUsageCalls: number;
  model: string;
  destination: string;
  inputPrice: number;
  outputPrice: number;
  stamp: string;
  currentStamp: string;
  captionsReady: boolean;
}
const props = defineProps<{ value: SummaryConfig; busy: boolean; demo: boolean }>();
const emit = defineEmits<{
  save: [value: { enabled: boolean; maxCalls: number; maxCostCny: number }];
}>();
const enabled = ref(false),
  maxCalls = ref(10),
  maxCostCny = ref(1),
  consent = ref(false);
watch(
  () =>
    JSON.stringify([
      props.value.enabled,
      props.value.maxCalls,
      props.value.maxCostCny,
      props.value.stamp,
    ]),
  () => {
    const value = props.value;
    enabled.value = value.enabled;
    maxCalls.value = value.maxCalls || 10;
    maxCostCny.value = value.maxCostCny || 1;
  },
  { immediate: true },
);
</script>
<template>
  <form
    class="settings-band settings-form"
    @submit.prevent="
      emit('save', { enabled, maxCalls, maxCostCny });
      consent = false;
    "
  >
    <h2>
      Sift 摘要
      <span class="badge" :class="value.enabled ? 'sent' : 'cancelled'">{{
        value.enabled ? '已启用' : '默认关闭'
      }}</span>
    </h2>
    <p class="section-note">
      {{
        demo
          ? '模拟模型，不产生外部请求或真实费用。'
          : `${value.model} · ${value.destination}。仅处理已授权来源，原始提醒不等待摘要。`
      }}
    </p>
    <p class="muted">
      YouTube 字幕：{{
        value.captionsReady ? '可选择，仍需逐频道授权' : '未启用，简介订阅不受影响'
      }}。字幕任务最多12次请求与4分钟；简介、邮件及RSS仍最多2次与60秒，均占用累计预算。
    </p>
    <p v-if="!value.ready" class="alert">尚未配置 SIFT_ENABLED、可信 SIFT_DIR、独立 Key 与价格。</p>
    <p v-else-if="value.enabled && value.stamp !== value.currentStamp" class="alert">
      配置版本已变化，请重新确认预算与来源授权。
    </p>
    <dl class="summary-usage">
      <div>
        <dt>累计请求</dt>
        <dd>{{ value.calls }} / {{ value.maxCalls }}</dd>
      </div>
      <div>
        <dt>保守预算占用</dt>
        <dd>¥{{ value.reservedCny.toFixed(4) }} / {{ value.maxCostCny }}</dd>
      </div>
      <div>
        <dt>已知 usage 估算</dt>
        <dd>¥{{ value.measuredCny.toFixed(4) }} · {{ value.unknownUsageCalls }} 次用量未知</dd>
      </div>
    </dl>
    <label class="check"
      ><input
        v-model="enabled"
        type="checkbox"
        :disabled="!value.ready && !enabled"
      />启用可选摘要</label
    >
    <label
      >累计请求上限<input v-model.number="maxCalls" type="number" min="0" max="10000" required
    /></label>
    <label
      >累计预算上限（人民币）<input
        v-model.number="maxCostCny"
        type="number"
        min="0"
        max="10000"
        step="0.01"
        required
    /></label>
    <p class="section-note">
      输入/输出价格：{{ value.inputPrice }} /
      {{ value.outputPrice }}
      元/百万token。失败与修复计入预算，未知用量不退款；更改上限不清零历史。关闭后撤销所有来源摘要授权并清理结果，已发出的请求与消息无法撤回。
    </p>
    <label class="check"
      ><input
        v-model="consent"
        type="checkbox"
      />我确认外发范围、价格和累计预算；仅对另行授权来源生效。</label
    >
    <div class="form-footer">
      <button class="primary" :disabled="busy || !consent"><Check :size="17" />保存摘要预算</button>
    </div>
  </form>
</template>
