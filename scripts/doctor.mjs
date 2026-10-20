import { execFileSync } from 'node:child_process';
import { existsSync, statSync, accessSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'dotenv';
import { loadEnvironment, hostedEnvironment, paths } from './hosting.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hosted = process.argv.includes('--hosted');
const rows = [];
const check = (name, ok, detail) => rows.push({ name, ok, detail });
check('Node.js', Number(process.versions.node.split('.')[0]) === 24, '需要 Node.js 24');
check('配置', existsSync(join(root, '.env')), '缺少时运行 npm run setup；不会覆盖已有配置');
const env = loadEnvironment(root, process.env, parse);
const effective = hosted ? hostedEnvironment(env) : env;
const { entry, data } = paths(root, effective);
check('生产构建', existsSync(entry) && existsSync(join(root, 'dist', 'web', 'index.html')), '运行 npm run build');
if (existsSync(entry)) {
  try {
    const { readConfig } = await import(pathToFileURL(join(root, 'dist', 'server', 'config.js')).href);
    readConfig(effective);
    check('配置校验', true, hosted ? '托管模式：生产构建、本机免登录、内嵌后台；不修改 .env' : '配置有效，不代表外部连接成功');
  } catch (error) { check('配置校验', false, /^[A-Z_]+$/.test(error.message) ? error.message : '配置格式错误'); }
}
try {
  let existing = data;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  accessSync(existing, constants.W_OK);
  check('数据目录', true, '目录或父目录可写');
} catch { check('数据目录', false, '当前用户无写入权限'); }
if (env.YOUTUBE_CAPTIONS_ENABLED === '1') {
  try {
    execFileSync(env.YOUTUBE_CAPTIONS_PYTHON || '', ['-c', 'import youtube_transcript_api, yt_dlp'], { timeout: 15_000, stdio: 'pipe', windowsHide: true });
    check('视频组件', true, 'Python 字幕和 yt-dlp 可导入；未访问 YouTube');
  } catch { check('视频组件', false, '检查 Python 绝对路径并安装 requirements-youtube.txt'); }
}
if (env.YOUTUBE_ASR_ENABLED === '1') {
  try {
    execFileSync(env.YOUTUBE_CAPTIONS_PYTHON || '', ['-c', 'import faster_whisper, av'], { timeout: 30_000, stdio: 'pipe', windowsHide: true });
    const model = env.YOUTUBE_ASR_MODEL || join(root, '.cache', 'asr-model');
    check('本地转写', existsSync(join(model, 'model.bin')) && statSync(join(model, 'model.bin')).size > 0, '检查本地模型；不自动下载');
  } catch { check('本地转写', false, '安装 requirements-asr.txt 并准备本地模型'); }
}
try {
  const port = Number(env.PORT || 8787);
  const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics`, { signal: AbortSignal.timeout(3000) });
  if (response.status === 401 || response.status === 403) {
    check('应用诊断', false, '需在已登录页面查看，或使用本机直接访问');
  } else {
    if (!response.ok) throw new Error();
    const status = await response.json();
    for (const row of status.checks) check(row.label, row.ok, row.detail);
    check('发送核查', status.queues.unknownDeliveries === 0, `${status.queues.unknownDeliveries} 条结果不确定；不自动重发`);
  }
} catch { check('应用诊断', false, '服务未启动或无法访问；启动后重试'); }
for (const row of rows) console.log(`[${row.ok ? 'OK' : '待检查'}] ${row.name}：${row.detail}`);
console.log('只检查本机，不读取邮件、不调用模型、不发送消息。此结果不代表外部服务持续可用。');
process.exitCode = rows.every(row => row.ok) ? 0 : 1;
