# Ideabro

**Ideabro** is a full-stack AI video studio for UGC videos, ads and campaigns. You type an idea, tag your assets (`@creator`, `@product`, `@environment`, `@logo`, `@props`…), and pick a duration, platform and language. Ideabro then handles the rest:

```
idea → concepts → script → scene split → Omni prompts → clip chain (Gemini Omni 1.1 Flash via APIMart)
     → timeline preview → regenerate any clip → join clips with FFmpeg → MP4
```

The first draft is the clips joined back to back with Omni's own generated voice and sound. The optional
extra tools (captions, music, SFX, logo, end card, transitions) are off by default.

## The continuity workflow

Gemini Omni 1.1 Flash makes clips of up to 10 seconds, and it can take a whole video as a reference. Ideabro builds on that:

| Clip | Continuity input | Reference images | Prompt describes |
|---|---|---|---|
| 1 | none | your tagged assets (creator, product, environment, logo, props: up to 5) | **everything**: who the creator/narrator is, the product, the environment, logo and props, plus the scene and dialogue |
| 2 | clip 1 (`video_urls` or `extend_from_task_id`) | only elements that are **new** in this scene (e.g. a second person), plus the product so its label stays accurate | only **what changes**: camera angle, location, a new person walking in… plus the scene and dialogue |
| 3 | clip 2 | same rule | same rule |
| … | clip N-1 | | |

So a 30s video is planned as 3 clips of about 10s each. Omni has no `duration` parameter: it picks each clip's length (3–10s) from the content, so the target length goes into the prompt, and the timeline uses each clip's real length.

**Continuity modes** (per project, in the Prompts step):
- **Reference video** (default): clip N-1 is sent as `video_urls`. Ideabro uses APIMart's own link until its `expires_at`, then `PUBLIC_BASE_URL`.
- **Extend**: clip N-1's APIMart task id is sent as `extend_from_task_id`, so nothing needs hosting. If the result contains the previous clip plus the new part, Ideabro trims off the old part automatically.

Clip 1's asset images are sent with `metadata.task: "reference_to_video"`. Without it, Omni would use a single image as the opening frame.

- **Regenerate one clip**: later clips that continued from it are flagged *out of sync*. You can then use **From here →** to regenerate the rest of the chain, or restore the earlier take, which clears the flag.
- **Turn continuity off** for any clip to get a fresh shot. Its prompt then describes the cast in full again.
- Anything you don't provide (creator, environment, narrator), the script step invents, with a detailed visual description.
- The prompts are always editable. The reference legend (`Image 1 is @creator…`) is generated at send time from the images actually attached, so it can't drift out of step with them.

## Features

- **Brief**: idea with `@tag` autocomplete, format (UGC / performance ad / brand campaign / AI film), platform presets (TikTok, Reels, Shorts, YouTube, IG feed 4:5, FB/LinkedIn 1:1), any language, brand, CTA, tone.
- **Assets**: upload images/audio, tag them, describe them. **✨ Auto-describe** uses a vision LLM to write the description for you. An optional public URL per asset overrides the upload.
- **Concepts**: three hooks/angles to choose from, or write your own.
- **Script & scenes**: editable cast bible, per-scene dialogue with a word budget, speaker, camera, action, "what changes", sound design, reordering, and end card copy.
- **Omni prompts**: per-clip toggles for the reference video and reference images, the editable prompt, and a preview of the exact prompt that gets sent.
- **Generate & timeline**: sequential chain generation with live progress, a play-all rough-cut timeline, per-clip regenerate / regenerate-from-here / take history.
- **Join & edit (FFmpeg)**: the first draft is a plain join of the clips (normalized to the platform size, Omni audio untouched). Optional extras, off by default:
  - Burned-in captions in three styles (karaoke word highlight, bold outline, clean box), with position, size, words per caption and highlight color.
  - A music bed with volume, fade-out, and **auto-ducking** under speech (sidechain compression).
  - SFX cues at any timestamp.
  - A logo watermark with corner, size and opacity.
  - A generated **end card** with logo, headline and CTA pill.
  - Cut, crossfade or dip-to-black transitions, and per-clip trims and caption overrides.
- **Export**: H.264/AAC MP4 at the platform resolution, with `+faststart` and a render history.
- **⚡ Autopilot**: one click runs every remaining step, from concepts to the final MP4.
- **Demo mode**: with no API key, you get placeholder clips and template scripts, so you can try the whole flow offline.

## Quick start

```bash
npm install
cp .env.example .env        # add APIMART_API_KEY (and ideally PUBLIC_BASE_URL)
npm run dev                 # server :8787 + web :5173 → open http://localhost:5173
```

Production:

```bash
npm run build && npm start  # serves the UI and API on :8787
# or
docker build -t ideabro . && docker run -p 8787:8787 --env-file .env -v ideabro-data:/data ideabro
```

Requirements: Node 20+. Installing FFmpeg yourself is optional, because a static build is bundled through `@ffmpeg-installer`. A system FFmpeg ≥ 4.3 is preferred when present, since it enables real crossfades. The Docker image installs FFmpeg and Noto fonts, which captions in Hindi, Arabic, Tamil and other scripts need.

### `PUBLIC_BASE_URL` (required for real generation with images)

APIMart only accepts **public HTTP(S) URLs** for `image_urls` and `video_urls`. Ideabro sends uploaded assets as `PUBLIC_BASE_URL + /files/...`, so set it to your deployed domain or an `ngrok http 8787` tunnel. Alternatively, paste a public URL on each asset. Localhost URLs are rejected before submitting, so a bad setup doesn't cost anything.

## APIMart integration

Implemented in `server/src/services/apimart.ts`, following the [Gemini Omni 1.1 Flash docs](https://docs.apimart.ai/en/api-reference/videos/gemini-omni-1.1-flash/generation):

- `POST /v1/videos/generations` with `model: gemini-omni-1.1-flash`, `prompt`, `aspect_ratio` (16:9 / 9:16), `resolution` (360p / 720p / 1080p / 4k, per project), `image_urls` (≤10), `video_urls` (1 clip, ≤10s) **or** `extend_from_task_id`, and `metadata.task` → `data[0].task_id`
- `GET /v1/tasks/{id}` polled every 5s until `completed`/`failed` → `result.videos[0].url[0]` (+ `expires_at`) is downloaded to `data/`

`APIMART_EXTRA_BODY` (JSON) is merged into every request if you need to pass extra fields.

The script, concept and auto-describe steps use APIMart's OpenAI-compatible chat endpoint with **Gemini 3.8 Flash** (`LLM_MODEL=gemini-3.8-flash`) and the same key. If APIMart lists the model under a slightly different id, change `LLM_MODEL`.

## Project layout

```
shared/types.ts                 data model shared by server and web
server/src/
  index.ts                      Express app, /api, /files (assets, clips, renders)
  store.ts                      JSON-file project store (data/projects/<id>/project.json)
  routes/projects.ts            REST API
  services/planner.ts           concepts, script + scene split, vision auto-describe (LLM)
  services/prompts.ts           continuity prompt builder + reference image selection
  services/apimart.ts           Omni generation client
  services/generator.ts         sequential clip chain, regenerate, stale tracking, resume after restart
  services/captions.ts          timeline math + ASS captions / end card text
  services/render.ts            FFmpeg: normalize → assemble → captions/logo/music/SFX mix → MP4
  services/pipeline.ts          autopilot
  services/mock.ts              demo-mode placeholder clips
web/src/                        React + Vite + Tailwind UI (one component per step)
```

`npm test` runs the server unit tests (clip splitting, reference selection, prompt structure, caption timing, response parsing). `npm run typecheck` checks both packages.
