<script setup lang="ts">
import { ref } from 'vue';
import { X, Upload, Download, Check } from '@lucide/vue';
const props = defineProps<{
  action: string;
  call: (path: string, method?: string, body?: unknown) => Promise<unknown>;
}>();
const emit = defineEmits<{ close: []; done: [] }>();
const busy = ref(false),
  error = ref(''),
  includeFeeds = ref(false),
  confirmedPublic = ref(false);
const bundle = ref<unknown>(null),
  plan = ref<{
    hash: string;
    rows: { source: { type: string; name: string; delivery_mode: string }; duplicate: boolean }[];
  } | null>(null);
async function choose(event: Event) {
  error.value = '';
  plan.value = null;
  bundle.value = null;
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    if (file.size > 30000) throw new Error('配置文件不能超过30KB。');
    bundle.value = JSON.parse(await file.text());
  } catch (e) {
    error.value = e instanceof Error ? e.message : '文件无效';
  }
}
async function run(task: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await task();
  } catch (e) {
    error.value = e instanceof Error ? e.message : '操作失败';
  } finally {
    busy.value = false;
  }
}
async function preview() {
  await run(async () => {
    plan.value = (await props.call(
      '/sources/import-preview',
      'POST',
      bundle.value,
    )) as typeof plan.value;
  });
}
async function apply() {
  await run(async () => {
    await props.call('/sources/import', 'POST', {
      bundle: bundle.value,
      hash: plan.value?.hash,
      confirmed: true,
      confirmedPublic: confirmedPublic.value,
    });
    emit('done');
  });
}
async function download() {
  await run(async () => {
    const data = await props.call(
      '/sources/export' + (includeFeeds.value ? '?includePublicFeeds=confirmed' : ''),
    );
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'feedrelay-sources.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    emit('close');
  });
}
</script>
<template>
  <div
    class="overlay"
    @keydown.esc.stop="!busy && emit('close')"
    @click.self="!busy && emit('close')"
  >
    <section
      class="modal transfer"
      role="dialog"
      aria-modal="true"
      :aria-label="action === 'import' ? '导入订阅配置' : '导出订阅配置'"
    >
      <header>
        <h2>{{ action === 'import' ? '导入订阅配置' : '导出订阅配置' }}</h2>
        <button class="icon" aria-label="关闭导入导出" :disabled="busy" @click="emit('close')">
          <X :size="20" />
        </button>
      </header>
      <p>
        不包含密码、应用凭证、正文、运行状态或游标。配置中的发件地址仍可能涉及个人信息，请妥善保管。
      </p>
      <template v-if="action === 'import'">
        <label
          >选择 JSON 配置<input
            type="file"
            accept=".json,application/json"
            :disabled="busy"
            @change="choose"
        /></label>
        <div v-if="plan" class="import-preview">
          <p>
            新增 {{ plan.rows.filter((r) => !r.duplicate).length }} 项，跳过重复
            {{ plan.rows.filter((r) => r.duplicate).length }} 项
          </p>
          <ul>
            <li v-for="(row, index) in plan.rows" :key="index">
              <span>{{ row.source.name }}</span
              ><span class="badge">{{ row.duplicate ? '跳过重复' : '新增 · 已暂停' }}</span>
            </li>
          </ul>
          <p>导入后均暂停，不会自动读取或发送历史内容；重新启用时建立基线。</p>
          <label v-if="plan.rows.some((r) => r.source.type === 'rss')" class="check-row disclosure"
            ><input v-model="confirmedPublic" type="checkbox" />我确认 RSS URL 公开可访问且不含私人
            Token。</label
          >
        </div>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <div class="form-footer">
          <button :disabled="busy || !bundle" @click="preview"><Upload :size="16" />预览配置</button
          ><button
            v-if="plan"
            class="primary"
            :disabled="busy || (plan.rows.some((r) => r.source.type === 'rss') && !confirmedPublic)"
            @click="apply"
          >
            <Check :size="16" />确认导入
          </button>
        </div>
      </template>
      <template v-else
        ><label class="check-row disclosure"
          ><input v-model="includeFeeds" type="checkbox" />包含 RSS URL：我确认它们公开且不含私人
          Token。</label
        >
        <p class="muted">默认省略 RSS 订阅，只导出频道与邮件匹配规则。</p>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <div class="form-footer">
          <button class="primary" :disabled="busy" @click="download">
            <Download :size="16" />下载配置
          </button>
        </div></template
      >
    </section>
  </div>
</template>
