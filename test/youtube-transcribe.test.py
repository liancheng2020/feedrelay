import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('transcribe', 'scripts/youtube-transcribe.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Tests(unittest.TestCase):
    def test_duration(self):
        for duration in (None, float('nan'), 0):
            with self.assertRaisesRegex(module.TranscribeError, 'UNAVAILABLE'):
                module.check_duration({'duration': duration})
        with self.assertRaisesRegex(module.TranscribeError, 'TOO_LONG'):
            module.check_duration({'duration': 3601})

    def test_audio_lifecycle(self):
        options, paths = {}, []
        fail = False
        class Downloader:
            def __init__(self, value): options.update(value)
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def extract_info(self, url, download):
                self.assert_url = url
                assert download is False
                return {'id':'abcdefghijk', 'duration':120}
            def prepare_filename(self, info): return options['outtmpl'].replace('%(ext)s','m4a')
            def process_info(self, info):
                path = Path(self.prepare_filename(info))
                paths.append(path)
                path.write_bytes(b'SYNTHETIC_AUDIO')
        class Model:
            def __init__(self, path, **kwargs):
                assert kwargs['local_files_only'] is True
                assert kwargs['device'] == 'cpu'
            def transcribe(self, path, **kwargs):
                assert kwargs['batch_size'] == 4
                assert kwargs['beam_size'] == 3
                assert kwargs['without_timestamps'] is False
                assert kwargs['vad_parameters'] == {'min_silence_duration_ms': 2000}
                assert Path(path).read_bytes() == b'SYNTHETIC_AUDIO'
                if fail: raise ValueError('synthetic failure')
                return iter([types.SimpleNamespace(start=0,end=10,text='first'),
                             types.SimpleNamespace(start=110,end=120,text='last')]), types.SimpleNamespace(language='en')
        modules = {'yt_dlp':types.SimpleNamespace(YoutubeDL=Downloader),
                   'yt_dlp.globals':types.SimpleNamespace(plugin_dirs=types.SimpleNamespace(value=[])),
                   'faster_whisper':types.SimpleNamespace(WhisperModel=Model, BatchedInferencePipeline=lambda model: model)}
        with patch.dict(sys.modules,modules), patch.object(module,'version',side_effect=lambda name: '1.2.1' if name=='faster-whisper' else '16.1.0'), patch.object(Path,'read_bytes',autospec=True,side_effect=lambda p: b'{}' if p.name=='config.json' else b'SYNTHETIC_AUDIO'):
            result = module.transcribe({'id':'abcdefghijk','proxy':'','node':'/trusted/node','model':'/local/model'})
            fail = True
            with self.assertRaisesRegex(ValueError,'synthetic failure'):
                module.transcribe({'id':'abcdefghijk','proxy':'','node':'/trusted/node','model':'/local/model'})
        self.assertEqual(len(result['cues']),2)
        self.assertEqual(result['cues'][-1]['start'],110000)
        self.assertTrue(all(not path.exists() for path in paths))
        self.assertIsNone(options['cookiesfrombrowser'])
        self.assertEqual(options['socket_timeout'],30)
        self.assertEqual(options['retries'],2)
        self.assertEqual(options['http_chunk_size'],1024*1024)
        self.assertEqual(options['format'], 'bestaudio[abr<=64]/bestaudio')
        self.assertNotIn('vcodec',options['format'])
        with self.assertRaisesRegex(module.TranscribeError,'TOO_LARGE'):
            options['progress_hooks'][0]({'downloaded_bytes':100000001})


if __name__ == '__main__': unittest.main()
