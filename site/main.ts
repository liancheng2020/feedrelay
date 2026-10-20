import { createSSRApp } from 'vue';
import App from './App.vue';
import './styles.css';

createSSRApp(App).mount('#app');
