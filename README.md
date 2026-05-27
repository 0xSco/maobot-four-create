# maobot-four-create

Four.meme instant create bot for fast meme launches from monitored social posts.

## Features

- Listen to 6551 Twitter/X websocket.
- Extract meme keyword with fast local candidate scoring and LLM fallback.
- Prefer original tweet image when available.
- Test mode: return token name/symbol/avatar via Telegram without creating token.
- Create token on four.meme with dev pre-buy using `create-instant --pre-sale=<BNB>`.
- Telegram notifications and image previews.

## Safety

Never commit `config.env`. It contains private keys and API tokens.

Copy the example config:

```bash
cp config.env.example config.env
```

Fill only local secrets in `config.env`.

## Install

```bash
npm install
npm install -g @four-meme/four-meme-ai@latest
```

## Test mode

Set:

```env
ENABLED=false
DRY_RUN=true
```

Run:

```bash
node bot.js
```

When a watched account posts, the bot sends token name/symbol/avatar to Telegram but does not create a token.

## Real create

Set carefully:

```env
ENABLED=true
DRY_RUN=false
BUY_AMOUNT_BNB=0.001
MAX_BUY_BNB=0.005
```

Run:

```bash
node bot.js
```

`BUY_AMOUNT_BNB` is passed to four.meme as `--pre-sale=<BNB>`.

## Notes

- On the user's Mac, Telegram and Twitter image CDN may need:

```env
TG_PROXY=http://127.0.0.1:7897
```

- Chinese meme keywords use original text for both name and symbol.
- English single-word keywords use word/word.
- English phrase keywords use phrase/acronym.
