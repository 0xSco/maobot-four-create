# Four Create Bot Notes

These are operating notes and lessons from live testing. Do not put secrets here.

## Goal

Monitor high-signal accounts/posts and create a four.meme token as fast as possible, with dev pre-buy in the create transaction.

## Critical four.meme behavior

- Use `fourmeme create-instant`.
- Dev pre-buy is passed during creation with:

```bash
--pre-sale=<BNB_AMOUNT>
```

- `--pre-sale` is denominated in BNB/ether units, not wei.
- Do **not** create first and then run `fourmeme buy`; that is slower and can be wrong because `create-instant` may return only `txHash`.

## User naming preferences

- English single word: `builder` -> `builder / builder`.
- English phrase: `make bsc great again` -> `make bsc great again / mbga`.
- Chinese meme phrase: original/original.
  - `背手负狗` -> `背手负狗 / 背手负狗`.
  - Do not convert Chinese to pinyin acronym unless explicitly asked.
- Intro sentence patterns should extract the object/name:
  - `its name is chemy` -> `chemy / chemy`.
  - `called X`, `meet X`, `this is X`, `say hello to X` -> `X / X` for single-word English.
- Strip source/noise prefixes:
  - `小红书新热点`, `小红书热点`, `新热点`, `热点`, `热梗`, `爆火`, etc.
  - Example: `小红书新热点 背手负狗` -> `背手负狗 / 背手负狗`.

## Keyword extraction strategy

Speed and precision are more important than creative naming.

Use:

```text
candidate pool -> scoring -> pick highest -> low-confidence LLM judge only
```

Rules:

- Local candidate extraction/scoring is mandatory and should finish in milliseconds.
- LLM must only choose from candidates; it must not translate, rewrite, invent, or directly generate token names.
- If LLM is used, keep timeout low (about 600ms).
- Good env toggles:

```env
KEYWORD_SCORE_THRESHOLD=80
KEYWORD_SCORE_MARGIN=12
LLM_KEYWORD_TIMEOUT_MS=600
DEBUG_KEYWORDS=true
```

## Image strategy

Priority:

1. Tweet image if present.
2. Local avatars by keyword, e.g. `avatars/<keyword>.jpg|png`.
3. Fast local text-template avatar.
4. Search-image/cache fallback.
5. AI generation last.

Reason: live AI image generation is usually too slow and may not understand Chinese memes.

## Proxy notes

On user's Mac, Telegram and Twitter image CDN may need:

```env
TG_PROXY=http://127.0.0.1:7897
```

The bot uses this proxy for Telegram notifications and image downloads.

## Test mode

`ENABLED=false` means: monitor, extract keyword/name/symbol/avatar, send Telegram text + photo, but do not create token.

`DRY_RUN=true` means: print the fourmeme command instead of sending chain tx.

## Case study: 来都来了

Token:

```text
0xfce62c8bd060b41a52fe3144573e9e5768d24444
```

four.meme API:

```text
/meme-api/v1/private/token/get?address=0xfce62c8bd060b41a52fe3144573e9e5768d24444
```

Returned:

```text
name: 来都来了
shortName: 来都来了
descr: 来都来了
webUrl: https://www.binance.com/zh-CN/square/post/327709148771986
image: https://static.four.meme/market/528aBoA5VZ3sB.jpg
dev/userAddress: 0x6a900ee716a579a6ea984015697de9fbf98989fc
launchTime: 2026-05-28 00:16:22 +08
createDate: 2026-05-28 00:16:27 +08
```

Heyi Binance Square post time was about `00:16:20`, so this token launched about 2-7 seconds later.

Image details:

```text
221x228 JPG
~9.7KB
Last-Modified: 2026-05-27 16:16:27 UTC
```

Conclusion: likely not live AI generation. More likely one of:

- prebuilt local avatar library,
- fast template image generation,
- web image search with cache.

For this bot, add fast avatar cache/template support before relying on AI.

## GitHub maintenance

Repo:

```text
https://github.com/0xSco/maobot-four-create
```

Deploy key on this OpenClaw host:

```text
~/.ssh/maobot_four_create_deploy
```

SSH host alias:

```text
github-maobot-four-create
```

Remote should be:

```bash
git@github-maobot-four-create:0xSco/maobot-four-create.git
```

Never commit:

- `config.env`
- `.env`
- private keys
- Telegram/Together/6551 tokens
- logs/runtime artifacts
