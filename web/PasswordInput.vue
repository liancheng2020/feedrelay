<script setup lang="ts">
import { ref } from 'vue';
import { Eye, EyeOff } from '@lucide/vue';
defineProps<{ id: string; autocomplete: 'current-password' | 'new-password'; minlength?: number; maxlength?: number }>();
const model = defineModel<string>({ required: true });
const visible = ref(false);
</script>

<template>
  <div class="password-input">
    <input :id="id" v-model="model" :type="visible ? 'text' : 'password'"
      :autocomplete="autocomplete" :minlength="minlength" :maxlength="maxlength ?? 256" required />
    <button type="button" class="quiet" :aria-label="visible ? '隐藏密码' : '显示密码'"
      :title="visible ? '隐藏密码' : '显示密码'" :aria-pressed="visible" @click="visible = !visible">
      <component :is="visible ? EyeOff : Eye" :size="18" />
    </button>
  </div>
</template>
