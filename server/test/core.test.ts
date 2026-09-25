import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitDuration, type Asset, type Project, type Scene } from '../../shared/types.ts';
import { buildClipPrompt, referenceLegend, selectImageRefs } from '../src/services/prompts.ts';
import { timeWords } from '../src/services/captions.ts';
import { buildGenerationBody, findVideoUrl, nearestAspect } from '../src/services/apimart.ts';
import { defaultBrief, defaultEdit } from '../src/store.ts';

test('splitDuration splits into clips of at most 10s', () => {
  assert.deepEqual(splitDuration(30), [10, 10, 10]);
  assert.deepEqual(splitDuration(15), [8, 7]);
  assert.deepEqual(splitDuration(8), [8]);
  assert.deepEqual(splitDuration(45), [9, 9, 9, 9, 9]);
  assert.ok(splitDuration(61).every((d) => d <= 10));
  assert.equal(splitDuration(61).reduce((a, b) => a + b, 0), 61);
});

const asset = (id: string, kind: Asset['kind'], tag: string = kind): Asset => ({
  id,
  kind,
  tag,
  name: tag,
  description: `${tag} description`,
  createdAt: '',
  file: { path: '/x.png', url: '/files/x.png', mime: 'image/png', originalName: 'x.png', size: 1 },
});

const scene = (index: number, tags: string[], extra: Partial<Scene> = {}): Scene => ({
  id: `s${index}`,
  index,
  durationSec: 10,
  beat: 'hook',
  setting: '',
  camera: 'selfie',
  action: '',
  dialogue: 'Hello there',
  speaker: '@creator',
  assetTags: tags,
  changes: index ? 'close-up' : '',
  sfx: '',
  ...extra,
});

function project(): Project {
  const scenes = [scene(0, ['creator', 'product']), scene(1, ['creator', 'product']), scene(2, ['creator', 'friend'], { changes: '@friend walks in' })];
  return {
    id: 'p',
    name: 'test',
    createdAt: '',
    updatedAt: '',
    stage: 'prompts',
    brief: { ...defaultBrief(), language: 'Hindi' },
    assets: [asset('a1', 'creator'), asset('a2', 'product'), asset('a3', 'environment'), asset('a4', 'logo'), asset('a5', 'creator', 'friend')],
    concepts: [],
    script: {
      title: 't',
      logline: '',
      voiceStyle: 'upbeat',
      musicMood: '',
      visualStyle: 'UGC selfie',
      cast: [
        { tag: 'creator', kind: 'creator', description: 'Maya, 28', generated: false },
        { tag: 'product', kind: 'product', description: 'blue can', generated: false },
        { tag: 'friend', kind: 'creator', description: 'Raj, 30', generated: false },
      ],
      scenes,
      endCard: { headline: '', cta: '' },
    },
    clips: [],
    generating: false,
    edit: defaultEdit(),
    render: { status: 'idle', progress: 0, history: [] },
    autopilot: { running: false },
  };
}

test('first clip gets the core cast as image references', () => {
  const p = project();
  const refs = selectImageRefs(p, p.script!.scenes[0], false);
  assert.deepEqual(refs.slice(0, 3), ['a1', 'a2', 'a3']);
  assert.ok(refs.includes('a4'), 'logo included on the first clip');
  assert.ok(!refs.includes('a5'), 'friend is not in scene 1');
});

test('continuation clips only get images for new elements (+ product)', () => {
  const p = project();
  assert.deepEqual(selectImageRefs(p, p.script!.scenes[1], true), ['a2']);
  assert.deepEqual(selectImageRefs(p, p.script!.scenes[2], true), ['a5']);
});

test('prompts: clip 1 describes the cast, later clips describe changes only', () => {
  const p = project();
  const first = buildClipPrompt(p, p.script!.scenes[0], false);
  assert.match(first, /CAST & ASSETS/);
  assert.match(first, /about 10 seconds long/);
  assert.match(first, /@creator \(creator\): Maya, 28/);
  assert.match(first, /speaks Hindi/);
  const third = buildClipPrompt(p, p.script!.scenes[2], true);
  assert.match(third, /Continue from the previous shot/);
  assert.match(third, /CHANGES FROM THE PREVIOUS SHOT: @friend walks in/);
  assert.match(third, /NEW IN THIS SHOT:\n- @friend/);
  assert.doesNotMatch(third, /Maya, 28/);
});

test('reference legend numbers images in send order', () => {
  const p = project();
  const legend = referenceLegend(p, { imageAssetIds: ['a2', 'a1'] } as never, true);
  assert.match(legend, /reference video is the previous shot/);
  assert.match(legend, /Image 1 is @product/);
  assert.match(legend, /Image 2 is @creator/);
});

test('timeWords spreads words across the window and chunks them', () => {
  const cues = timeWords('one two three four five', 0, 5, 2);
  assert.equal(cues.length, 3);
  assert.equal(cues[0].start, 0);
  assert.ok(Math.abs(cues[cues.length - 1].end - 5) < 1e-9);
  const withStop = timeWords('Hi. This is great', 0, 4, 3);
  assert.deepEqual(withStop[0].words.map((w) => w.text), ['Hi.']);
});

test('findVideoUrl reads the documented task result shape', () => {
  const doc = { videos: [{ url: ['https://cdn.example.com/gemini_omni_xxx.mp4'], expires_at: 1788518400 }] };
  assert.equal(findVideoUrl(doc), 'https://cdn.example.com/gemini_omni_xxx.mp4');
  assert.equal(findVideoUrl({ images: ['https://cdn/a.png'], video_url: 'https://cdn/v?id=1' }), 'https://cdn/v?id=1');
});

test('nearestAspect maps platform ratios onto 16:9 / 9:16', () => {
  assert.equal(nearestAspect('9:16'), '9:16');
  assert.equal(nearestAspect('16:9'), '16:9');
  assert.equal(nearestAspect('4:5'), '9:16');
});

test('generation body follows the APIMart docs', () => {
  const first = buildGenerationBody({ prompt: 'p', aspect: '9:16', resolution: '1080P', imageUrls: ['https://x/creator.png'] });
  assert.equal(first.model, 'gemini-omni-1.1-flash');
  assert.equal(first.resolution, '1080p');
  assert.equal(first.aspect_ratio, '9:16');
  assert.equal('duration' in first, false, 'Omni has no duration parameter');
  // A single image would otherwise become the first frame.
  assert.deepEqual(first.metadata, { task: 'reference_to_video' });

  const cont = buildGenerationBody({ prompt: 'p', aspect: '9:16', resolution: '720p', imageUrls: [], videoUrl: 'https://x/clip1.mp4' });
  assert.deepEqual(cont.video_urls, ['https://x/clip1.mp4']);
  assert.equal('image_urls' in cont, false);

  const ext = buildGenerationBody({ prompt: 'p', aspect: '9:16', resolution: '720p', imageUrls: [], extendFromTaskId: 'task_1' });
  assert.equal(ext.extend_from_task_id, 'task_1');
  assert.deepEqual(ext.metadata, { task: 'extend' });
  assert.equal('video_urls' in ext, false);

  assert.throws(() => buildGenerationBody({ prompt: 'p', aspect: '9:16', resolution: '720p', imageUrls: [], videoUrl: 'https://x/a.mp4', extendFromTaskId: 't' }));
  const text = buildGenerationBody({ prompt: 'p', aspect: '1:1', resolution: '8k', imageUrls: [] });
  assert.equal('metadata' in text, false);
  assert.equal(text.resolution, '720p');
});
