# Spring Mouse — Agent Skills

Drop-in skills for any AI agent (Claude, Cursor, ChatGPT, custom SDK). Just **copy a link** below and paste it to your AI — it will fetch the skill and use Spring Mouse for you.

> Tip: start with the **spring-mouse** entry skill — it covers setup and links to all capability skills.

## Skills

| Capability | Copy link below and paste to your AI |
|---|---|
| **Entry / Setup** (start here) | https://git.wiguo.cn/service/spring-mouse/raw/main/skills/spring-mouse/SKILL.md |
| Chat / code-gen | https://git.wiguo.cn/service/spring-mouse/raw/main/skills/spring-mouse-chat/SKILL.md |
| Image generation | https://git.wiguo.cn/service/spring-mouse/raw/main/skills/spring-mouse-image/SKILL.md |
| Video generation (xAI Grok Imagine) | https://git.wiguo.cn/service/spring-mouse/raw/main/skills/spring-mouse-video/SKILL.md |
| Text-to-speech | https://git.wiguo.cn/service/spring-mouse/raw/main/skills/spring-mouse-tts/SKILL.md |
| Speech-to-text | https://git.wiguo.cn/service/spring-mouse/raw/main/skills/spring-mouse-stt/SKILL.md |
| Embeddings | https://git.wiguo.cn/service/spring-mouse/raw/main/skills/spring-mouse-embeddings/SKILL.md |
| Web search | https://git.wiguo.cn/service/spring-mouse/raw/main/skills/spring-mouse-web-search/SKILL.md |
| Web fetch (URL → markdown) | https://git.wiguo.cn/service/spring-mouse/raw/main/skills/spring-mouse-web-fetch/SKILL.md |

## How to use

Paste to your AI (Claude, Cursor, ChatGPT, …):

```
Read this skill and use it: https://git.wiguo.cn/service/spring-mouse/raw/main/skills/spring-mouse/SKILL.md
```

Then ask normally — *"generate an image of a cat"*, *"transcribe this URL"*, etc.

## Configure your shell once

```bash
export SPRING_MOUSE_URL="http://localhost:20128"   # local default, or your VPS / tunnel URL
export SPRING_MOUSE_KEY="sk-..."                   # from Dashboard → Keys (only if requireApiKey=true)
```

Verify: `curl $SPRING_MOUSE_URL/api/health` → `{"ok":true}`.

## Links

- Source: https://git.wiguo.cn/service/spring-mouse
- Dashboard: http://localhost:8008
