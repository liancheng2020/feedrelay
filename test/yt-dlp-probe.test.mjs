import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  argumentsFor,
  publicProxy,
  classify,
  tracks,
  captionStats,
  diagnostic,
  command,
} from '../scripts/yt-dlp-probe.mjs';
test('probe rejects arbitrary URLs/proxies and never enables credentials, playlists or media', () => {
  const args = argumentsFor('iG9CE55wbtY', '/trusted/node');
  for (const flag of [
    '--ignore-config',
    '--no-plugin-dirs',
    '--no-cookies',
    '--no-cookies-from-browser',
    '--skip-download',
    '--no-playlist',
    '--no-remote-components',
  ])
    assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--proxy') + 1], '');
  assert.throws(() => argumentsFor('https://evil.example', '/node'));
  assert.equal(publicProxy('http://127.0.0.1:1087'), 'http://127.0.0.1:1087');
  assert.throws(() => publicProxy('http://user:password@localhost:8080'));
  assert.throws(() => publicProxy('http://remote.example:8080'));
});
test('subtitle types derive from metadata; empty captions are distinct from access failure', () => {
  assert.equal(
    tracks({ subtitles: { en: [] }, automatic_captions: { 'en-orig': [] } }).selected.kind,
    'manual',
  );
  assert.equal(
    tracks({ subtitles: { en: [] }, automatic_captions: { 'zh-Hans': [], 'en-orig': [] } }, true)
      .selected.language,
    'en-orig',
  );
  assert.equal(
    tracks({ subtitles: {}, automatic_captions: { 'en-orig': [] } }).selected.kind,
    'automatic',
  );
  assert.equal(tracks({ subtitles: { live_chat: [] } }).selected, null);
  assert.equal(classify('HTTP Error 429'), 'RATE_LIMITED');
  assert.equal(classify('Sign in to confirm you are not a bot'), 'AUTH_OR_BOT_CHALLENGE');
  assert.equal(classify('Connection reset by peer'), 'NETWORK_CONNECTION_FAILED');
  assert.equal(classify('', true), 'PROCESS_TIMEOUT');
});
test('JSON3 proof requires nonempty timed cues; reports contain hashes, not caption text', () => {
  const raw = JSON.stringify({
    events: [{ tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: 'Synthetic text' }] }],
  });
  const proof = captionStats(raw);
  assert.equal(proof.cues, 1);
  assert.equal(proof.lastEndSeconds, 1.5);
  assert.equal(JSON.stringify(proof).includes('Synthetic text'), false);
  assert.throws(() => captionStats('{"events":[]}'), /EMPTY_CAPTION/);
  assert.throws(
    () => captionStats('{"events":[{"tStartMs":-1,"dDurationMs":1,"segs":[{"utf8":"x"}]}]}'),
    /CUE_TIME/,
  );
});
test('diagnostics redact signed URLs and credentials', () => {
  const text = diagnostic(
    'ERROR: https://www.youtube.com/api/timedtext?token=secret\nWARNING: Cookie: sensitive',
  );
  assert.ok(!text.includes('secret'));
  assert.ok(!text.includes('sensitive'));
});
test('child process has a hard timeout rather than indefinite retries', async () => {
  const result = await command(
    process.execPath,
    ['-e', 'setInterval(()=>{},1000)'],
    process.cwd(),
    { PATH: process.env.PATH },
    100,
  );
  assert.equal(result.category, 'PROCESS_TIMEOUT');
  assert.ok(result.milliseconds < 2000);
});
