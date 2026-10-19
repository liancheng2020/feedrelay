<script setup lang="ts">
import { ref } from 'vue';
import PasswordInput from './PasswordInput.vue';
defineProps<{ busy: boolean }>();
const emit = defineEmits<{ save: [value: { currentPassword: string; newPassword: string }] }>();
const currentPassword = ref(''), newPassword = ref(''), confirmation = ref(''), error = ref('');
function submit() {
  error.value = '';
  if (newPassword.value !== confirmation.value) { error.value = '两次输入的新密码不一致。'; return; }
  emit('save', { currentPassword: currentPassword.value, newPassword: newPassword.value });
}
</script>

<template>
  <form class="password-form" @submit.prevent="submit">
    <div><label for="current-password">当前密码</label>
      <PasswordInput id="current-password" v-model="currentPassword" autocomplete="current-password" /></div>
    <div><label for="new-password">新密码（8–16 个字符）</label>
      <PasswordInput id="new-password" v-model="newPassword" autocomplete="new-password" :minlength="8" :maxlength="16" /></div>
    <div><label for="confirm-password">确认新密码</label>
      <PasswordInput id="confirm-password" v-model="confirmation" autocomplete="new-password" :minlength="8" :maxlength="16" /></div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <button class="primary" :disabled="busy">保存并重新登录</button>
  </form>
</template>
