<script setup lang="ts">
import { ref, onUnmounted } from 'vue';
import { QrCode, Send, Unplug, RefreshCw, X } from '@lucide/vue';
export interface WeixinStatus {
  bound: boolean;
  ready: boolean;
  recipient: string;
  lastInbound: number;
  lastPoll: number;
  lastAccepted: number;
  error: string;
}
interface Pair {
  id: string;
  status: string;
  image?: string;
  expires?: number;
}
const props = defineProps<{
  value: WeixinStatus;
  api: (path: string, method?: string, body?: unknown) => Promise<unknown>;
}>();
const emit = defineEmits<{ updated: []; test: [] }>();
const pair = ref<Pair | null>(null),
  consent = ref(false),
  code = ref(''),
  busy = ref(false),
  error = ref(''),
  disconnecting = ref(false);
let active = true,
  timer: ReturnType<typeof setTimeout> | undefined;
const messages: Record<string, string> = {
  WEIXIN_NEEDS_MESSAGE: '已绑定，等待你在微信向 ClawBot 发送一条消息。',
  WEIXIN_CONTEXT_REJECTED: '微信拒绝了当前发送上下文，请向机器人发送一条消息后重试失败记录。',
  WEIXIN_SESSION_EXPIRED: '微信登录已失效，需要重新扫码绑定。',
  WEIXIN_NETWORK_ERROR: '暂时无法连接微信服务。',
  WEIXIN_POLL_FAILED: '微信连接异常，正在等待恢复。',
  WEIXIN_LOCAL_STATE_INVALID: '本机绑定信息无法读取，请解除后重新扫码。',
};
async function run(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await fn();
  } catch (e) {
    if (active) error.value = e instanceof Error ? e.message : '连接失败';
  } finally {
    busy.value = false;
  }
}
function schedule() {
  clearTimeout(timer);
  if (active && pair.value && pair.value.status !== 'need_verifycode')
    timer = setTimeout(() => void poll(), 1500);
}
async function poll() {
  if (!pair.value) return;
  await run(async () => {
    const current = pair.value!;
    const result = (await props.api('/weixin/pair/status', 'POST', {
      id: current.id,
      ...(code.value ? { code: code.value } : {}),
    })) as Pair;
    code.value = '';
    if (!active || pair.value?.id !== current.id) return;
    if (result.status === 'confirmed') {
      pair.value = null;
      emit('updated');
    } else {
      pair.value = { ...current, status: result.status };
      schedule();
    }
  });
}
async function begin() {
  await run(async () => {
    pair.value = (await props.api('/weixin/pair', 'POST', {
      confirmed: true,
      replace: props.value.bound,
    })) as Pair;
    consent.value = false;
    schedule();
  });
}
async function cancel() {
  clearTimeout(timer);
  const id = pair.value?.id;
  pair.value = null;
  try {
    await props.api('/weixin/pair/cancel', 'POST', { id });
  } catch (e) {
    error.value = e instanceof Error ? e.message : '取消失败';
  }
}
onUnmounted(() => {
  active = false;
  clearTimeout(timer);
});
</script>

<template>
  <section class="settings-band">
    <h2>
      微信 ClawBot
      <span class="badge" :class="value.ready ? 'sent' : 'cancelled'">{{
        value.ready ? '可尝试推送' : value.bound ? '已绑定' : '未绑定'
      }}</span>
    </h2>
    <p v-if="value.bound" class="muted">
      私聊目标 {{ value.recipient }} · 最近入站
      {{ value.lastInbound ? new Date(value.lastInbound).toLocaleString() : '暂无' }}
    </p>
    <p v-if="value.lastAccepted" class="muted">
      最近接口接受 {{ new Date(value.lastAccepted).toLocaleString() }}（不代表已读）
    </p>
    <p v-if="value.error" class="alert">
      {{ messages[value.error] || '微信连接暂不可用，请检查后重试。' }}
    </p>
    <p class="muted">仅保存绑定人的发送上下文，不处理聊天指令。长时间不互动的自动推送仍待验证。</p>
    <template v-if="!pair">
      <label class="check"
        ><input v-model="consent" type="checkbox" /><span
          >我确认向扫码绑定的本人微信推送；重新绑定后，旧目标待发消息不会自动转发。</span
        ></label
      >
      <div class="weixin-actions">
        <button :disabled="busy || !consent" @click="begin">
          <QrCode :size="16" />{{ value.bound ? '重新绑定' : '扫码连接微信' }}
        </button>
        <button :disabled="busy || !value.ready" @click="emit('test')">
          <Send :size="16" />发送测试
        </button>
        <button
          v-if="value.bound || value.error === 'WEIXIN_LOCAL_STATE_INVALID'"
          :disabled="busy"
          @click="disconnecting = true"
        >
          <Unplug :size="16" />解除绑定
        </button>
      </div>
      <div v-if="disconnecting" class="alert">
        <p>确认解除当前微信绑定？未发送记录不会改投其他账号；微信客户端的授权可另行解除。</p>
        <div class="weixin-actions">
          <button
            :disabled="busy"
            @click="
              run(async () => {
                await api('/weixin/disconnect', 'POST', { confirmed: true });
                disconnecting = false;
                emit('updated');
              })
            "
          >
            确认解除
          </button>
          <button @click="disconnecting = false">取消</button>
        </div>
      </div>
    </template>
    <div v-else class="weixin-pair">
      <img :src="pair.image" width="240" height="240" alt="微信 ClawBot 绑定二维码" />
      <div>
        <strong>{{
          pair.status === 'need_verifycode'
            ? '输入手机微信显示的数字配对码'
            : pair.status === 'scaned'
              ? '已扫码，等待手机确认'
              : '请用手机微信扫码并确认'
        }}</strong>
        <p class="muted">确认后向 ClawBot 发一条消息，才能获取发送上下文。</p>
        <form v-if="pair.status === 'need_verifycode'" @submit.prevent="poll">
          <label
            >数字配对码<input
              v-model="code"
              inputmode="numeric"
              pattern="[0-9]{4,8}"
              minlength="4"
              maxlength="8"
              autocomplete="off"
              required
          /></label>
          <button :disabled="busy"><RefreshCw :size="16" />确认配对码</button>
        </form>
        <div class="weixin-actions">
          <button :disabled="busy" @click="poll"><RefreshCw :size="16" />更新绑定状态</button>
          <button @click="cancel"><X :size="16" />取消扫码</button>
        </div>
      </div>
    </div>
    <p v-if="error" class="alert" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.check input[type='checkbox'] {
  min-height: 16px;
}
.weixin-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin: 16px 0;
}
.weixin-pair {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 24px;
  margin-top: 20px;
}
.weixin-pair img {
  width: 240px;
  height: 240px;
  max-width: 100%;
  object-fit: contain;
}
.weixin-pair > div {
  flex: 1;
  min-width: min(240px, 100%);
}
.weixin-pair input {
  max-width: 180px;
}
</style>
