<script setup lang="ts">
import { computed } from 'vue';
import { DateTime } from 'luxon';
import { ChevronLeft, ChevronRight } from '@lucide/vue';
const props = defineProps<{
  month: string; selected: string; busy: boolean;
  batches: { cutoff: number; timezone: string; parts: { status: string }[] }[];
}>();
const emit = defineEmits<{ month: [value: string]; select: [value: string]; today: [] }>();
const today = () => DateTime.now().setZone('Asia/Shanghai').toISODate()!;
const start = computed(() => DateTime.fromISO(`${props.month}-01`, {zone:'Asia/Shanghai'}));
const days = computed(() => {
  const first = start.value.minus({days:start.value.weekday % 7});
  return Array.from({length:42},(_,i) => {
    const date = first.plus({days:i}), key = date.toISODate()!;
    const batches = props.batches.filter(batch => DateTime.fromMillis(batch.cutoff,{zone:batch.timezone}).toISODate() === key);
    const statuses = batches.flatMap(batch => batch.parts.map(part => part.status));
    const status = statuses.some(s => ['failed','unknown','cancelled'].includes(s)) ? 'attention' : statuses.length && statuses.every(s => s === 'sent') ? 'sent' : batches.length ? 'waiting' : '';
    const label = status === 'attention' ? '需处理' : status === 'sent' ? '已推送' : '待推送或无更新';
    return {key,day:date.day,current:date.toFormat('yyyy-MM')===props.month,count:batches.length,status,label};
  });
});
function move(amount: number) { emit('month',start.value.plus({months:amount}).toFormat('yyyy-MM')); }
function chooseMonth(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  (event.target as HTMLInputElement).value = props.month;
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) emit('month',value);
}
</script>

<template>
  <section class="daily-calendar" aria-label="日报月历">
    <header class="daily-calendar-toolbar">
      <div class="daily-calendar-month">
        <button class="icon" title="上个月" aria-label="上个月" :disabled="busy" @click="move(-1)"><ChevronLeft :size="18" /></button>
        <label class="sr-only" for="daily-month">日报月份</label>
        <input id="daily-month" type="month" :value="month" :disabled="busy" @change="chooseMonth" />
        <button class="icon" title="下个月" aria-label="下个月" :disabled="busy" @click="move(1)"><ChevronRight :size="18" /></button>
      </div>
      <button class="quiet" :disabled="busy" @click="emit('today')">今天</button>
    </header>
    <div class="daily-weekdays" aria-hidden="true"><span v-for="day in ['日','一','二','三','四','五','六']" :key="day">{{ day }}</span></div>
    <div class="daily-days" role="group" aria-label="选择日报日期">
      <button v-for="day in days" :key="day.key" class="daily-day" :class="{ outside: !day.current, selected: selected === day.key, today: day.key === today() }"
        :disabled="busy || !day.current" :aria-pressed="selected === day.key" :aria-current="day.key === today() ? 'date' : undefined"
        :aria-label="`${day.key}，${day.count ? `${day.count}份日报，${day.label}` : '暂无日报'}`" @click="emit('select',day.key)">
        <span class="daily-day-number">{{ day.day }}</span>
        <span v-if="day.count" class="daily-day-marker" :class="day.status"><span aria-hidden="true"></span><small>{{ day.count }}份{{ day.status === 'attention' ? ' !' : '' }}</small></span>
      </button>
    </div>
    <footer class="daily-calendar-legend"><span><i class="sent"></i>已推送</span><span><i class="waiting"></i>待推送 / 无更新</span><span><i class="attention"></i>需处理</span></footer>
  </section>
</template>
