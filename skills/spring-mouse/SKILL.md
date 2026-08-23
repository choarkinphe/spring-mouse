---
name: spring-mouse
description: Entry point for Spring Mouse — local/remote AI gateway with OpenAI-compatible REST for chat, image, TTS, embeddings, web search, web fetch. Use when the user mentions Spring Mouse, SPRING_MOUSE_URL, or wants AI without writing provider boilerplate. This skill covers setup + indexes capability skills; fetch the relevant capability SKILL.md from the URLs below when needed.
---

# Spring Mouse

Local/remote AI gateway exposing OpenAI-compatible REST. One key, many providers, auto-fallback.

## Setup

```bash
export SPRING_MOUSE_URL="http://localhost:8008"      # or VPS / tunnel URL
export SPRING_MOUSE_KEY="sk-..."                      # from Dashboard → Keys (only if requireApiKey=true)
```

All requests: `${SPRING_MOUSE_URL}/v1/...` with header `Authorization: Bearer ${SPRING_MOUSE_KEY}` (omit if auth disabled).

Verify: `curl $SPRING_MOUSE_URL/api/health` → `{"ok":true}`

## Discover models

```bash
curl $SPRING_MOUSE_URL/v1/models                  # chat/LLM (default)
curl $SPRING_MOUSE_URL/v1/models/image            # image-gen
curl $SPRING_MOUSE_URL/v1/models/tts              # text-to-speech
curl $SPRING_MOUSE_URL/v1/models/embedding        # embeddings
curl $SPRING_MOUSE_URL/v1/models/web              # web search + fetch (entries have `kind` field)
curl $SPRING_MOUSE_URL/v1/models/stt              # speech-to-text
curl $SPRING_MOUSE_URL/v1/models/image-to-text    # vision
```

Use `data[].id` as `model` field in requests. Combos appear with `owned_by:"combo"`.

Response shape:
```json
{ "object": "list", "data": [
  { "id": "openai/gpt-5", "object": "model", "owned_by": "openai", "created": 1735000000 },
  { "id": "tavily/search", "object": "model", "kind": "webSearch", "owned_by": "tavily", "created": 1735000000 }
]}
```

## Capability skills

When the user needs a specific capability, fetch that skill's `SKILL.md` from its raw URL:

| Capability | Raw URL |
|---|---|
| Chat / code-gen | https://git.wiguo.cn/service/spring-mouse/raw/main/skills/spring-mouse-chat/SKILL.md |
| Image generation | https://git.wiguo.cn/service/spring-mouse/raw/main/skills/spring-mouse-image/SKILL.md |
| Text-to-speech | https://git.wiguo.cn/service/spring-mouse/raw/main/skills/spring-mouse-tts/SKILL.md |
| Speech-to-text | https://git.wiguo.cn/service/spring-mouse/raw/main/skills/spring-mouse-stt/SKILL.md |
| Embeddings | https://git.wiguo.cn/service/spring-mouse/raw/main/skills/spring-mouse-embeddings/SKILL.md |
| Web search | https://git.wiguo.cn/service/spring-mouse/raw/main/skills/spring-mouse-web-search/SKILL.md |
| Web fetch (URL → markdown) | https://git.wiguo.cn/service/spring-mouse/raw/main/skills/spring-mouse-web-fetch/SKILL.md |

## Errors

- 401 → set/refresh `SPRING_MOUSE_KEY` (Dashboard → Keys)
- 400 `Invalid model format` → check `model` exists in `/v1/models/<kind>`
- 503 `All accounts unavailable` → wait `retry-after` or add another provider account
