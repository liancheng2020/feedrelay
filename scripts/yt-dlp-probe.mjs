import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, stat, chmod } from 'node:fs/promises';
import { resolve, join, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

// Public candidates, not pre-labelled as having manual/automatic/no subtitles.
export const samples = [
  {
    id: 'iG9CE55wbtY',
    label: 'TED / Do schools kill creativity?',
    purpose: 'talk/manual-caption candidate',
  },
  {
    id: 'GjvgtwSOCao',
    label: 'Google I/O 2025 Developer Keynote',
    purpose: 'long-video candidate',
  },
  {
    id: 'jNQXAC9IVRw',
    label: 'Me at the zoo',
    purpose: 'short-video candidate; subtitle availability unknown',
  },
  {
    id: 'Gjnup-PuquQ',
    label: 'Fireship / Docker in 100 Seconds',
    purpose: 'prefer automatic captions when actually available',
    preferAutomatic: true,
  },
];
export function publicProxy(value = '') {
  if (!value) return '';
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('ONLY_EXPLICIT_LOOPBACK_HTTP_PROXY');
  return url.origin;
}
export function argumentsFor(id, node, proxy = '') {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) throw new Error('INVALID_VIDEO_ID');
  return [
    '-I',
    '-m',
    'yt_dlp',
    '--ignore-config',
    '--no-plugin-dirs',
    '--no-cookies',
    '--no-cookies-from-browser',
    '--no-remote-components',
    '--no-js-runtimes',
    '--js-runtimes',
    `node:${node}`,
    '--no-cache-dir',
    '--no-playlist',
    '--no-write-comments',
    '--skip-download',
    '--ignore-no-formats-error',
    '--socket-timeout',
    '8',
    '--retries',
    '0',
    '--extractor-retries',
    '0',
    '--sleep-requests',
    '1',
    '--proxy',
    publicProxy(proxy),
    '--no-progress',
    '--color',
    'never',
    '--',
    `https://www.youtube.com/watch?v=${id}`,
  ];
}
export function classify(message, timedOut = false) {
  if (timedOut) return 'PROCESS_TIMEOUT';
  if (/429|too many requests/i.test(message)) return 'RATE_LIMITED';
  if (/sign in|not a bot|login required|authentication/i.test(message))
    return 'AUTH_OR_BOT_CHALLENGE';
  if (/403|forbidden|po.?token/i.test(message)) return 'ACCESS_OR_TOKEN_REQUIRED';
  if (/certificate verify|ssl certificate/i.test(message)) return 'TLS_ERROR';
  if (/timed? ?out/i.test(message)) return 'NETWORK_TIMEOUT';
  if (
    /reset|connection.*(?:closed|refused)|unable to connect|network is unreachable|errno 65|errno 60/i.test(
      message,
    )
  )
    return 'NETWORK_CONNECTION_FAILED';
  if (/getaddrinfo|name.*not known|nodename/i.test(message)) return 'DNS_FAILED';
  if (/private video|not available|removed|unavailable/i.test(message)) return 'VIDEO_UNAVAILABLE';
  return 'EXTRACTION_FAILED';
}
export function diagnostic(message) {
  return message
    .replace(/https?:\/\/[^\s<>"']+/gu, '[URL]')
    .replace(/(?:Bearer\s+|Cookie:\s*)[^\r\n]+/giu, '[REDACTED]')
    .split('\n')
    .filter((line) => /ERROR|WARNING|exception/i.test(line))
    .slice(-4)
    .join('\n')
    .slice(0, 1400);
}
export function tracks(info, preferAutomatic = false) {
  const list = (value) =>
    Object.keys(value || {}).filter(
      (lang) => lang !== 'live_chat' && /^[a-zA-Z0-9-]{1,24}$/.test(lang),
    );
  const manual = list(info.subtitles),
    automatic = list(info.automatic_captions);
  const pick = (values) =>
    ['zh-Hans', 'zh-Hant', 'zh', 'en-orig', 'en'].find((lang) => values.includes(lang)) ||
    values[0];
  const original = automatic.find((lang) => lang.endsWith('-orig'));
  return {
    manual,
    automatic,
    selected:
      manual.length && !(preferAutomatic && automatic.length)
        ? { kind: 'manual', language: pick(manual) }
        : automatic.length
          ? { kind: 'automatic', language: original || pick(automatic) }
          : null,
  };
}
export function captionStats(raw) {
  const data = JSON.parse(raw);
  if (!Array.isArray(data.events)) throw new Error('INVALID_JSON3');
  const cues = data.events.flatMap((event) => {
    if (!Array.isArray(event.segs)) return [];
    const text = event.segs
      .map((s) => (typeof s.utf8 === 'string' ? s.utf8 : ''))
      .join('')
      .trim();
    if (!text) return [];
    if (
      !Number.isFinite(event.tStartMs) ||
      event.tStartMs < 0 ||
      !Number.isFinite(event.dDurationMs) ||
      event.dDurationMs < 0
    )
      throw new Error('INVALID_CUE_TIME');
    return [{ text, start: event.tStartMs, end: event.tStartMs + event.dDurationMs }];
  });
  if (!cues.length) throw new Error('EMPTY_CAPTION');
  return {
    cues: cues.length,
    utf16Units: cues.map((c) => c.text).join('\n').length,
    firstStartSeconds: Math.min(...cues.map((c) => c.start)) / 1000,
    lastEndSeconds: Math.max(...cues.map((c) => c.end)) / 1000,
    sha256: createHash('sha256').update(raw).digest('hex'),
  };
}
export async function command(python, args, cwd, env, timeout = 45000) {
  const started = Date.now();
  return new Promise((resolveResult) => {
    const child = spawn(python, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '',
      err = '',
      size = 0,
      timedOut = false,
      limited = false,
      done = false;
    const stop = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    const interrupt = () => {
      stop();
      process.exit(130);
    };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeout);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8e6) {
        limited = true;
        stop();
      } else out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (err.length < 64000) err += chunk;
    });
    const finish = (code, error = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
      resolveResult({
        code,
        out,
        diagnostic: diagnostic(err || error),
        category: limited ? 'OUTPUT_TOO_LARGE' : classify(err || error, timedOut),
        milliseconds: Date.now() - started,
      });
    };
    child.on('error', (error) => finish(-1, error.code || 'SPAWN_FAILED'));
    child.on('close', (code) => finish(code));
  });
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('NODE_24_REQUIRED');
  if (!process.argv.includes('--live')) {
    console.log(
      'Explicit network probe: node scripts/yt-dlp-probe.mjs --live [--proxy http://127.0.0.1:1087]',
    );
    return;
  }
  const option = (name) =>
    process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : '';
  const root = process.cwd(),
    proxy = publicProxy(option('--proxy'));
  const limit = Number(option('--limit') || samples.length);
  if (!Number.isInteger(limit) || limit < 1 || limit > samples.length)
    throw new Error('INVALID_SAMPLE_LIMIT');
  const python = resolve(option('--python') || '.cache/yt-dlp-probe/venv/bin/python'),
    node = process.execPath;
  const output = resolve(
    'artifacts/yt-dlp',
    new Date().toISOString().replace(/[:.]/g, '-') + (proxy ? '-proxy' : '-direct'),
  );
  const home = join(output, 'isolated-home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const env = {
    PATH: `${dirname(node)}:/usr/bin:/bin`,
    HOME: home,
    XDG_CONFIG_HOME: home,
    TMPDIR: home,
    LANG: 'en_US.UTF-8',
  };
  const version = await command(
    python,
    [
      '-I',
      '-c',
      'import importlib.metadata as m, platform, json; print(json.dumps({"ytDlp":m.version("yt-dlp"),"ejs":m.version("yt-dlp-ejs"),"python":platform.python_version()}))',
    ],
    root,
    env,
    20000,
  );
  if (version.code !== 0) throw new Error('INSTALL_ISOLATED_YT_DLP_FIRST');
  const report = {
    timestamp: new Date().toISOString(),
    environment: {
      ...JSON.parse(version.out),
      node: process.version,
      platform: process.platform,
      route: proxy ? 'explicit-local-proxy' : 'direct',
      proxy,
    },
    scope: {
      cookies: false,
      audioVideo: false,
      model: false,
      feishu: false,
      remoteComponents: false,
      captionTextInReport: false,
      maxVideos: limit,
    },
    samples: [],
  };
  const save = async () => {
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    });
  };
  for (const sample of samples.slice(0, limit)) {
    const folder = join(output, sample.id);
    await mkdir(folder, { mode: 0o700 });
    const base = argumentsFor(sample.id, node, proxy),
      sep = base.indexOf('--');
    const metadata = await command(
      python,
      [...base.slice(0, sep), '--dump-single-json', ...base.slice(sep)],
      folder,
      env,
    );
    const row = {
      ...sample,
      url: `https://www.youtube.com/watch?v=${sample.id}`,
      metadataMs: metadata.milliseconds,
      status: metadata.code === 0 ? 'METADATA_OK' : metadata.category,
      diagnostic: metadata.diagnostic,
    };
    report.samples.push(row);
    if (metadata.code === 0) {
      try {
        const info = JSON.parse(metadata.out),
          available = tracks(info, sample.preferAutomatic);
        Object.assign(row, {
          title: info.title,
          durationSeconds: info.duration,
          tracks: available,
        });
        if (!available.selected) row.status = 'NO_SUBTITLES';
        else {
          const selected = available.selected;
          const args = [
            ...base.slice(0, sep),
            '--no-simulate',
            '--sub-format',
            'json3',
            '--sub-langs',
            selected.language,
            ...(selected.kind === 'manual'
              ? ['--write-subs', '--no-write-auto-subs']
              : ['--no-write-subs', '--write-auto-subs']),
            '-o',
            'caption.%(ext)s',
            ...base.slice(sep),
          ];
          const downloaded = await command(python, args, folder, env);
          row.subtitleMs = downloaded.milliseconds;
          const files = (await readdir(folder)).filter((file) => file.endsWith('.json3'));
          if (downloaded.code !== 0)
            Object.assign(row, { status: downloaded.category, diagnostic: downloaded.diagnostic });
          else if (files.length !== 1) row.status = 'CAPTION_FILE_MISSING';
          else {
            const file = join(folder, files[0]),
              size = (await stat(file)).size;
            await chmod(file, 0o600);
            if (size > 2e6) row.status = 'CAPTION_TOO_LARGE';
            else
              Object.assign(row, {
                status: 'CAPTION_OK',
                bytes: size,
                caption: captionStats(await readFile(file, 'utf8')),
                captionFile: relative(output, file),
              });
          }
        }
      } catch (error) {
        row.status = 'INVALID_METADATA_OR_CAPTION';
        row.diagnostic = ['INVALID_JSON3', 'INVALID_CUE_TIME', 'EMPTY_CAPTION'].includes(
          error?.message,
        )
          ? error.message
          : 'INVALID_DATA';
      }
    }
    await save();
    console.log(
      JSON.stringify({
        id: row.id,
        status: row.status,
        metadataMs: row.metadataMs,
        subtitleMs: row.subtitleMs,
        cues: row.caption?.cues,
        utf16Units: row.caption?.utf16Units,
      }),
    );
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`Report: ${relative(root, join(output, 'report.json'))}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
