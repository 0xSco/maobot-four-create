#!/usr/bin/env node
/**
 * four.meme instant launcher
 * 监听 Twitter/X -> 提取关键词/图片 -> fourmeme create-instant 创建并 dev 预买。
 * 配置只读 ./config.env。
 */

const dotenv = require('dotenv');
dotenv.config({ path: './config.env' });

const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const WORK_DIR = path.join(ROOT, '.tmp');
if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

const CFG = {
  twitterToken: process.env.TWITTER_TOKEN || '',
  togetherKey: process.env.TOGETHER_API_KEY || '',
  privateKey: process.env.PRIVATE_KEY || '',
  rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org',
  tgToken: process.env.TG_BOT_TOKEN || '',
  tgChatId: process.env.TG_CHAT_ID || '',
  tgProxy: process.env.TG_PROXY || '',
  watchAccounts: (process.env.WATCH_ACCOUNTS || '')
    .split(',')
    .map(s => s.trim().replace(/^@/, ''))
    .filter(Boolean),
  buyAmountBNB: process.env.BUY_AMOUNT_BNB || '0.001',
  maxBuyBNB: process.env.MAX_BUY_BNB || process.env.BUY_AMOUNT_BNB || '0.001',
  gasPriceGwei: process.env.GAS_PRICE_GWEI || '3',
  slippage: process.env.SLIPPAGE_PERCENT || '50',
  enabled: process.env.ENABLED !== 'false',
  dryRun: process.env.DRY_RUN === 'true',
  speedMode: process.env.SPEED_MODE || 'fast',
  tokenLabel: process.env.TOKEN_LABEL || 'Meme',
  defaultImagePath: path.resolve(ROOT, process.env.DEFAULT_IMAGE_PATH || './default.png'),
  imageTimeoutMs: Number(process.env.IMAGE_TIMEOUT_MS || 4500),
  processedDb: path.resolve(ROOT, process.env.PROCESSED_DB || './processed-tweets.json'),
  logFile: path.resolve(ROOT, process.env.LOG_FILE || './fourmeme-bot.log'),
};

function now() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function log(msg) {
  const line = `[${now()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(CFG.logFile, line + '\n'); } catch {}
}

function isMissing(v) {
  return !v || /在这里填入|your_|xxx/i.test(String(v));
}

function requireConfig() {
  const missing = [];
  if (isMissing(CFG.twitterToken)) missing.push('TWITTER_TOKEN');
  if (isMissing(CFG.togetherKey)) missing.push('TOGETHER_API_KEY');
  if (isMissing(CFG.privateKey)) missing.push('PRIVATE_KEY');
  if (isMissing(CFG.rpcUrl)) missing.push('BSC_RPC_URL');
  if (isMissing(CFG.tgToken)) missing.push('TG_BOT_TOKEN');
  if (isMissing(CFG.tgChatId)) missing.push('TG_CHAT_ID');
  if (!CFG.watchAccounts.length) missing.push('WATCH_ACCOUNTS');
  if (missing.length) {
    console.error(`配置缺失: ${missing.join(', ')}`);
    process.exit(1);
  }

  const buy = Number(CFG.buyAmountBNB);
  const max = Number(CFG.maxBuyBNB);
  if (!Number.isFinite(buy) || buy <= 0) throw new Error('BUY_AMOUNT_BNB 必须大于 0');
  if (!Number.isFinite(max) || max <= 0) throw new Error('MAX_BUY_BNB 必须大于 0');
  if (buy > max) throw new Error(`BUY_AMOUNT_BNB=${buy} 超过 MAX_BUY_BNB=${max}`);
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function tg(msg) {
  if (isMissing(CFG.tgToken) || isMissing(CFG.tgChatId)) return;

  const body = JSON.stringify({
    chat_id: CFG.tgChatId,
    text: msg,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });

  const args = ['-sS', '--max-time', '15'];
  if (CFG.tgProxy) args.push('-x', CFG.tgProxy);
  args.push(
    '-X', 'POST',
    `https://api.telegram.org/bot${CFG.tgToken}/sendMessage`,
    '-H', 'Content-Type: application/json',
    '-d', body
  );

  const child = spawn('curl', args, { shell: false });
  let out = '';
  let err = '';
  child.stdout.on('data', d => out += d.toString());
  child.stderr.on('data', d => err += d.toString());
  child.on('close', code => {
    if (code !== 0) return log(`Telegram 通知失败 curl=${code}: ${err || out}`);
    if (!/"ok"\s*:\s*true/.test(out)) log(`Telegram 返回异常: ${out.slice(0, 300)}`);
  });
}

function tgPhoto(filePath, caption = '') {
  if (isMissing(CFG.tgToken) || isMissing(CFG.tgChatId)) return;
  if (!filePath || !fs.existsSync(filePath)) return log(`Telegram 图片不存在: ${filePath}`);

  const args = ['-sS', '--max-time', '30'];
  if (CFG.tgProxy) args.push('-x', CFG.tgProxy);
  args.push(
    '-X', 'POST',
    `https://api.telegram.org/bot${CFG.tgToken}/sendPhoto`,
    '-F', `chat_id=${CFG.tgChatId}`,
    '-F', `caption=${caption}`,
    '-F', 'parse_mode=HTML',
    '-F', `photo=@${filePath}`
  );

  const child = spawn('curl', args, { shell: false });
  let out = '';
  let err = '';
  child.stdout.on('data', d => out += d.toString());
  child.stderr.on('data', d => err += d.toString());
  child.on('close', code => {
    if (code !== 0) return log(`Telegram 图片发送失败 curl=${code}: ${err || out}`);
    if (!/"ok"\s*:\s*true/.test(out)) log(`Telegram 图片返回异常: ${out.slice(0, 300)}`);
  });
}

function postJSON(hostname, urlPath, data, headers = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname,
      path: urlPath,
      method: 'POST',
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers }
    }, res => {
      let buf = '';
      res.on('data', d => buf += d.toString());
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`${hostname}${urlPath} HTTP ${res.statusCode}: ${buf.slice(0, 300)}`));
        try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function downloadFile(url, dest, timeoutMs = 12000) {
  // Mac 本地经常直连 Twitter/Telegram CDN 失败；有 TG_PROXY 时统一走代理下载。
  if (CFG.tgProxy) {
    return new Promise((resolve, reject) => {
      const args = ['-L', '-sS', '--max-time', String(Math.ceil(timeoutMs / 1000)), '-x', CFG.tgProxy, '-o', dest, url];
      const child = spawn('curl', args, { shell: false });
      let err = '';
      child.stderr.on('data', d => err += d.toString());
      child.on('close', code => {
        if (code === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 0) return resolve(dest);
        try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch {}
        reject(new Error(`curl 下载失败 code=${code}: ${err.slice(0, 300)}`));
      });
      child.on('error', reject);
    });
  }

  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    const req = proto.get(url, { timeout: timeoutMs }, res => {
      if (res.statusCode >= 400) return reject(new Error(`下载图片 HTTP ${res.statusCode}`));
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(dest); });
    });
    req.on('timeout', () => req.destroy(new Error('下载图片超时')));
    req.on('error', err => {
      try { file.close(); fs.unlinkSync(dest); } catch {}
      reject(err);
    });
  });
}

function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms))
  ]);
}

function hasChinese(s) {
  return /[\u4e00-\u9fff]/.test(String(s || ''));
}

function sanitizeName(s) {
  const raw = String(s || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return 'meme';
  if (hasChinese(raw)) return raw.replace(/[，。！？、：；“”"'`~!@#$%^&*()+=\[\]{}|\\<>/?]/g, '').trim().slice(0, 20) || 'meme';
  return raw.replace(/[^a-zA-Z0-9 $._-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32) || 'meme';
}

function sanitizeSymbol(s) {
  const raw = String(s || '').trim();
  if (hasChinese(raw)) return sanitizeName(raw).slice(0, 20) || 'meme';
  const out = raw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 10);
  return out.length >= 2 ? out : 'meme';
}

function cleanTweetText(tweetText) {
  return String(tweetText || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[A-Za-z0-9_]+/g, ' ')
    .replace(/[#$]/g, ' ')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripNoise(text) {
  let s = cleanTweetText(text);
  const noise = [
    '小红书新热点', '小红书热点', '微博新热点', '微博热点', '抖音新热点', '抖音热点',
    '今日新热点', '今日热点', '最新热点', '新热点', '热点', '热梗', '爆火', '爆了', '火了',
    'breaking news', 'breaking', 'latest news', 'latest', 'update', 'watch', 'new', 'hot',
    'its name is', "it's name is", 'his name is', 'her name is', 'the name is', 'name is',
    'called', 'meet', 'say hello to', 'this is', 'here is', 'introducing'
  ];
  for (const n of noise) {
    const re = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
    s = s.replace(re, ' ');
  }
  return s.replace(/[：:，,。.!！?？、;；]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function acronym(words) {
  return words.map(w => w[0] || '').join('').toLowerCase().slice(0, 10) || 'meme';
}

function addCandidate(list, keyword, score, source, reason) {
  const key = sanitizeName(keyword);
  if (!key || key.length < 2) return;
  list.push({ keyword: key, score, source, reason });
}

function extractCandidates(tweetText, account) {
  const text = String(tweetText || '');
  const cleaned = cleanTweetText(text);
  const stripped = stripNoise(text);
  const c = [];

  // 强信号：ticker / hashtag / 引号
  for (const m of text.matchAll(/\$([A-Za-z][A-Za-z0-9]{1,15})/g)) addCandidate(c, m[1], 100, 'cashtag', '$ticker');
  for (const m of text.matchAll(/#([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z0-9]{1,20})/g)) addCandidate(c, m[1], 96, 'hashtag', '#tag');
  for (const m of text.matchAll(/[「“\"']([^」”\"']{2,24})[」”\"']/g)) addCandidate(c, m[1], 92, 'quote', 'quoted text');

  // 英文介绍句模板：its name is chemy / called chemy / meet chemy
  const introPatterns = [
    /(?:it'?s|its|his|her|the)?\s*name\s+is\s+([A-Za-z][A-Za-z0-9]{1,20})/i,
    /(?:called|named|meet|introducing)\s+([A-Za-z][A-Za-z0-9]{1,20})/i,
    /(?:this\s+is|here\s+is|say\s+hello\s+to)\s+([A-Za-z][A-Za-z0-9]{1,20})/i,
  ];
  for (const re of introPatterns) {
    const m = text.match(re);
    if (m?.[1]) addCandidate(c, m[1].toLowerCase(), 90, 'intro-pattern', 'english intro pattern');
  }

  // 中文：去掉热点/平台前缀后，中文短梗原文保留
  const zhChunks = stripped.match(/[\u4e00-\u9fff]{2,12}/g) || [];
  if (zhChunks.length === 1) addCandidate(c, zhChunks[0], 88, 'zh-short', 'single chinese meme chunk');
  if (zhChunks.length > 1) {
    addCandidate(c, zhChunks[zhChunks.length - 1], 84, 'zh-last', 'last chinese chunk likely meme');
    addCandidate(c, zhChunks.join(''), 70, 'zh-all', 'all chinese chunks');
  }

  // 短英文：单词或短语
  const words = stripped.match(/[A-Za-z][A-Za-z0-9]{1,20}/g) || [];
  const stop = new Set(['the','a','an','is','are','was','were','it','its','his','her','name','called','this','that','here','meet','say','hello','to','of','and','or','on','in','for','with','from','by','new','hot','latest','update','watch']);
  const meaningful = words.filter(w => !stop.has(w.toLowerCase()));
  if (meaningful.length === 1 && stripped.replace(words.join(' '), '').trim().length === 0) addCandidate(c, meaningful[0].toLowerCase(), 86, 'en-one', 'single english word');
  if (meaningful.length === 1 && words.length <= 5) addCandidate(c, meaningful[0].toLowerCase(), 78, 'en-one-after-stop', 'one meaningful word after stopwords');
  if (meaningful.length >= 2 && meaningful.length <= 6 && stripped.replace(/[A-Za-z0-9\s]/g, '').trim().length === 0) {
    addCandidate(c, meaningful.map(w => w.toLowerCase()).join(' '), 72, 'en-phrase', 'short english phrase');
  }

  // 整体兜底
  if (stripped) addCandidate(c, stripped.slice(0, 60), 45, 'stripped', 'cleaned whole text');
  addCandidate(c, account.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'meme', 10, 'account', 'account fallback');

  return scoreCandidates(c, cleaned);
}

function scoreCandidates(candidates, cleanedText) {
  const bad = new Set(['the','its','it','his','her','name','is','called','this','here','meet','hello','new','hot','latest','update','watch','小红书','热点','新热点']);
  const byKey = new Map();
  for (const item of candidates) {
    let kw = sanitizeName(item.keyword);
    if (!kw) continue;
    let score = item.score;
    const lower = kw.toLowerCase();

    if (bad.has(lower) || bad.has(kw)) score -= 100;
    if (hasChinese(kw)) {
      score += 8;
      if (kw.length >= 2 && kw.length <= 8) score += 8;
    } else {
      const words = kw.match(/[A-Za-z][A-Za-z0-9]{0,20}/g) || [];
      if (words.length === 1) score += 6;
      if (words.length >= 2 && words.length <= 5) score += 2;
      if (words.length > 6) score -= 20;
      if (lower.length > 18) score -= 10;
    }

    // 越靠后通常越像结论/名字，但权重很小，避免误伤
    const idx = cleanedText.toLowerCase().lastIndexOf(lower);
    if (idx >= 0) score += Math.min(6, Math.floor(idx / 8));

    const prev = byKey.get(kw);
    if (!prev || score > prev.score) byKey.set(kw, { ...item, keyword: kw, score });
  }
  return Array.from(byKey.values()).sort((a,b) => b.score - a.score);
}

function buildTokenInfoFromKeyword(keyword, source) {
  const key = sanitizeName(keyword).trim();
  if (!key) return { name: 'meme', symbol: 'meme', image_prompt: 'meme', source };
  if (hasChinese(key)) return { name: key, symbol: key, image_prompt: `${key} meme`, source };
  const words = key.match(/[A-Za-z][A-Za-z0-9]{0,20}/g) || [];
  if (words.length <= 1) {
    const w = (words[0] || key).toLowerCase();
    return { name: w, symbol: sanitizeSymbol(w), image_prompt: `${w} meme`, source };
  }
  const phrase = words.map(w => w.toLowerCase()).join(' ');
  return { name: phrase, symbol: sanitizeSymbol(acronym(words)), image_prompt: `${phrase} meme`, source };
}

async function llmPickKeyword(tweetText, account, candidates) {
  try {
    const shortlist = candidates.slice(0, 8).map(c => c.keyword);
    const res = await postJSON('api.together.xyz', '/v1/chat/completions', {
      model: 'meta-llama/Meta-Llama-3-8B-Instruct-Lite',
      messages: [
        { role: 'system', content: 'Pick the best meme coin keyword from candidates. You MUST choose exactly one candidate. Do not translate. Do not rewrite. Return ONLY JSON: {"keyword":"candidate","confidence":0.0}.' },
        { role: 'user', content: `tweet=${String(tweetText || '').slice(0, 500)}\naccount=@${account}\ncandidates=${JSON.stringify(shortlist)}` }
      ],
      max_tokens: 80,
      temperature: 0.02
    }, { Authorization: `Bearer ${CFG.togetherKey}` }, Number(process.env.LLM_KEYWORD_TIMEOUT_MS || 600));

    const content = res?.choices?.[0]?.message?.content || '';
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('LLM 未返回 JSON');
    const parsed = JSON.parse(match[0]);
    const kw = sanitizeName(parsed.keyword || '');
    const found = candidates.find(c => c.keyword === kw) || candidates.find(c => c.keyword.toLowerCase() === kw.toLowerCase());
    if (!found) throw new Error(`LLM 选择不在候选里: ${kw}`);
    return { ...found, source: `llm-pick:${found.source}`, confidence: Number(parsed.confidence || 0.75) };
  } catch (err) {
    log(`LLM 裁判失败，使用最高分候选: ${err.message}`);
    return null;
  }
}

async function extractTokenInfo(tweetText, account) {
  const candidates = extractCandidates(tweetText, account);
  const top = candidates[0] || { keyword: 'meme', score: 0, source: 'empty' };
  const second = candidates[1];
  const threshold = Number(process.env.KEYWORD_SCORE_THRESHOLD || 80);
  const margin = Number(process.env.KEYWORD_SCORE_MARGIN || 12);
  let picked = top;

  // 高分且领先明显：本地直接定，毫秒级。否则 LLM 只做候选裁判，最多 600ms。
  if (top.score < threshold || (second && top.score - second.score < margin)) {
    picked = await llmPickKeyword(tweetText, account, candidates) || top;
  }

  const info = buildTokenInfoFromKeyword(picked.keyword, picked.source);
  log(`关键词: ${picked.keyword} 来源=${picked.source} 分数=${picked.score}`);
  if (process.env.DEBUG_KEYWORDS === 'true') {
    log(`候选: ${candidates.slice(0, 6).map(c => `${c.keyword}:${c.score}:${c.source}`).join(' | ')}`);
  }
  return info;
}

function getTweetImageUrl(tweet) {
  const media = tweet?.media || tweet?.extended_entities?.media || tweet?.entities?.media || [];
  const item = Array.isArray(media) ? media.find(m => m?.type === 'photo' && (m.url || m.media_url_https || m.media_url)) : null;
  return item?.url || item?.media_url_https || item?.media_url || null;
}

async function pickImage(tokenInfo, tweet) {
  const tweetImageUrl = getTweetImageUrl(tweet);
  if (tweetImageUrl) {
    try {
      const ext = 'jpg';
      const imgPath = path.join(WORK_DIR, `tweet_${Date.now()}.${ext}`);
      await downloadFile(tweetImageUrl, imgPath, 12000);
      log(`使用推文原图: ${tweetImageUrl}`);
      return imgPath;
    } catch (err) {
      log(`推文原图下载失败，尝试 AI 生成: ${err.message}`);
    }
  }

  try {
    return await withTimeout(generateImage(tokenInfo.image_prompt || tokenInfo.name), CFG.imageTimeoutMs, '生成图片');
  } catch (err) {
    log(`图片生成失败，使用默认图: ${err.message}`);
    if (fs.existsSync(CFG.defaultImagePath)) return CFG.defaultImagePath;
    throw err;
  }
}

async function generateImage(prompt) {
  const res = await postJSON('api.together.xyz', '/v1/images/generations', {
    model: 'black-forest-labs/FLUX.1-schnell',
    prompt: `${prompt}, meme coin crypto style, funny cartoon, clean logo, centered`,
    width: 512,
    height: 512,
    steps: CFG.speedMode === 'fast' ? 4 : 6,
    n: 1
  }, { Authorization: `Bearer ${CFG.togetherKey}` }, Math.max(6000, CFG.imageTimeoutMs));

  const url = res?.data?.[0]?.url;
  if (!url) throw new Error('图片生成失败');
  const imgPath = path.join(WORK_DIR, `img_${Date.now()}.jpg`);
  await downloadFile(url, imgPath, 12000);
  return imgPath;
}

function getTweetImageUrl(tweet) {
  const media = tweet?.media || tweet?.extended_entities?.media || tweet?.entities?.media || [];
  const item = Array.isArray(media) ? media.find(m => m?.type === 'photo' && (m.url || m.media_url_https || m.media_url)) : null;
  return item?.url || item?.media_url_https || item?.media_url || null;
}

async function pickImage(tokenInfo, tweet) {
  const tweetImageUrl = getTweetImageUrl(tweet);
  if (tweetImageUrl) {
    try {
      const ext = /\.(png|jpg|jpeg|webp)(?:\?|$)/i.exec(tweetImageUrl)?.[1] || 'jpg';
      const imgPath = path.join(WORK_DIR, `tweet_${Date.now()}.${ext}`);
      await downloadFile(tweetImageUrl, imgPath, 12000);
      log(`使用推文原图: ${tweetImageUrl}`);
      return imgPath;
    } catch (err) {
      log(`推文原图下载失败，尝试 AI 生成: ${err.message}`);
    }
  }

  try {
    return await withTimeout(generateImage(tokenInfo.image_prompt || tokenInfo.name), CFG.imageTimeoutMs, '生成图片');
  } catch (err) {
    log(`图片生成失败，使用默认图: ${err.message}`);
    if (fs.existsSync(CFG.defaultImagePath)) return CFG.defaultImagePath;
    throw err;
  }
}

function runFourmemeCreate(args, env, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    if (CFG.dryRun) {
      log(`[DRY_RUN] fourmeme ${args.map(a => JSON.stringify(a)).join(' ')}`);
      return resolve({ txHash: '0xDRYRUN000000000000000000000000000000000000' });
    }

    const child = spawn('fourmeme', args, { env, cwd: ROOT, shell: false });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`fourmeme create-instant 超时 ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`fourmeme 退出码 ${code}: ${(stderr || stdout).slice(0, 800)}`));
      const out = stdout.trim();
      try { resolve(JSON.parse(out)); } catch { resolve({ raw: out }); }
    });
  });
}

async function createAndDevBuy(tokenInfo, imagePath, tweetText) {
  const desc = String(tweetText || '').replace(/[\r\n]+/g, ' ').slice(0, 180) || tokenInfo.name;
  const env = {
    ...process.env,
    PRIVATE_KEY: CFG.privateKey,
    BSC_RPC_URL: CFG.rpcUrl,
    GAS_PRICE_GWEI: CFG.gasPriceGwei,
    SLIPPAGE_PERCENT: CFG.slippage,
  };

  // four skill 明确：--pre-sale 单位是 BNB/ether，如 0.001，不是 wei。
  const args = [
    'create-instant',
    '--image', imagePath,
    '--name', tokenInfo.name,
    '--short-name', tokenInfo.symbol,
    '--desc', desc,
    '--label', CFG.tokenLabel,
    `--pre-sale=${CFG.buyAmountBNB}`,
  ];

  const result = await runFourmemeCreate(args, env);
  const txHash = result?.txHash || result?.hash || result?.transactionHash || result?.data?.txHash;
  const tokenAddress = result?.tokenAddress || result?.address || result?.data?.tokenAddress || '';
  if (!txHash && !tokenAddress) throw new Error('fourmeme 未返回 txHash/tokenAddress: ' + JSON.stringify(result).slice(0, 500));
  return { txHash, tokenAddress };
}

function loadProcessed() {
  try {
    const arr = JSON.parse(fs.readFileSync(CFG.processedDb, 'utf8'));
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveProcessed(set) {
  try { fs.writeFileSync(CFG.processedDb, JSON.stringify(Array.from(set).slice(-2000), null, 2)); } catch {}
}

const processed = loadProcessed();
const processing = new Set();

async function handleTweet(account, tweetText, tweetId, tweet = null) {
  const id = String(tweetId || `${account}:${tweetText}`).slice(0, 300);
  if (processed.has(id) || processing.has(id)) return;
  processing.add(id);
  const t0 = Date.now();
  let imagePath = null;

  try {
    log(`监控到 @${account} 发推 提取图片和关键字`);
    log(`推文内容: ${String(tweetText || '').slice(0, 160)}`);
    tg(`🐦 监控到 @${escapeHtml(account)} 发推，正在提取图片和关键字\n${escapeHtml(String(tweetText || '').slice(0, 250))}`);

    const tokenInfo = await extractTokenInfo(tweetText, account);
    log(`代币符号/代币名称 ${tokenInfo.symbol} / ${tokenInfo.name}`);

    imagePath = await pickImage(tokenInfo, tweet);
    log(`头像/图片路径 ${imagePath}`);

    if (!CFG.enabled) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
      log('测试模式：总开关关闭，只返回名字和头像，不创建代币');
      processed.add(id);
      saveProcessed(processed);
      tg(`🧪 测试模式：已监控到推文，不创建代币\n代币符号/代币名称: ${escapeHtml(tokenInfo.symbol)} / ${escapeHtml(tokenInfo.name)}\n头像/图片: <code>${escapeHtml(imagePath)}</code>\n耗时: ${elapsed}s`);
      tgPhoto(imagePath, `🖼 ${escapeHtml(tokenInfo.symbol)} / ${escapeHtml(tokenInfo.name)}`);
      return;
    }

    const { txHash, tokenAddress } = await createAndDevBuy(tokenInfo, imagePath, tweetText);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

    processed.add(id);
    saveProcessed(processed);

    log(`已创建并买入 ${CFG.buyAmountBNB} BNB`);
    log(`代币符号/代币名称 ${tokenInfo.symbol} / ${tokenInfo.name}`);
    log(`代币合约地址${tokenAddress || '等待链上/页面确认'}`);
    if (txHash) log(`交易哈希 ${txHash}`);

    tg(`✅ 已创建并买入 ${escapeHtml(CFG.buyAmountBNB)} BNB${CFG.dryRun ? '（DRY_RUN）' : ''}\n代币符号/代币名称: ${escapeHtml(tokenInfo.symbol)} / ${escapeHtml(tokenInfo.name)}\n代币合约地址: <code>${escapeHtml(tokenAddress || '等待链上/页面确认')}</code>${txHash ? `\n交易哈希: <code>${escapeHtml(txHash)}</code>\nhttps://bscscan.com/tx/${escapeHtml(txHash)}` : ''}\n耗时: ${elapsed}s`);
    tgPhoto(imagePath, `🖼 ${escapeHtml(tokenInfo.symbol)} / ${escapeHtml(tokenInfo.name)}`);
  } catch (err) {
    log(`处理失败: ${err.stack || err.message}`);
    tg(`❌ four 创建代币失败\n${escapeHtml(String(err.message || err).slice(0, 600))}`);
  } finally {
    processing.delete(id);
    if (CFG.enabled && imagePath && imagePath.startsWith(WORK_DIR) && fs.existsSync(imagePath)) {
      try { fs.unlinkSync(imagePath); } catch {}
    }
  }
}

let reconnectTimer = null;
function connect() {
  const url = `wss://ai.6551.io/open/twitter_wss?token=${encodeURIComponent(CFG.twitterToken)}`;
  const ws = new WebSocket(url, { handshakeTimeout: 10000 });

  ws.on('open', () => {
    log('正在监控推文');
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'twitter.subscribe' }));
  });

  ws.on('message', async data => {
    try {
      const msg = JSON.parse(data);
      if (msg.method !== 'twitter.event') return;
      const { twAccount, eventType, content } = msg.params || {};
      const account = String(twAccount || '').replace(/^@/, '');
      if (!CFG.watchAccounts.includes(account)) return;
      if (!['NEW_TWEET', 'NEW_TWEET_QUOTE'].includes(eventType)) return;
      const tweet = typeof content === 'string' ? JSON.parse(content) : content;
      if (!tweet || tweet.retweetedStatus) return;
      await handleTweet(account, tweet.text || tweet.full_text || '', tweet.id || tweet.id_str || '', tweet);
    } catch (err) {
      log(`WebSocket 消息处理异常: ${err.stack || err.message}`);
    }
  });

  ws.on('close', () => scheduleReconnect('连接断开'));
  ws.on('error', err => scheduleReconnect(`连接错误: ${err.message}`));
}

function scheduleReconnect(reason) {
  if (reconnectTimer) return;
  log(`${reason}，3秒后重连`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 3000);
}

try {
  requireConfig();
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}

log('four创建代币已开启');
log(`监控账号: ${CFG.watchAccounts.join(', ')}`);
log(`买入金额: ${CFG.buyAmountBNB} BNB | Gas: ${CFG.gasPriceGwei} | 滑点: ${CFG.slippage}% | 总开关: ${CFG.enabled} | 速度: ${CFG.speedMode} | DRY_RUN: ${CFG.dryRun}`);
tg(`✅ four创建代币已开启\n正在监控推文\n监控账号: ${escapeHtml(CFG.watchAccounts.join(', '))}\n买入金额: ${escapeHtml(CFG.buyAmountBNB)} BNB\n总开关: ${CFG.enabled}\n速度: ${escapeHtml(CFG.speedMode)}\nDRY_RUN: ${CFG.dryRun}`);
connect();
