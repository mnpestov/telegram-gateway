'use strict';

require('dotenv').config();

const express = require('express');
const { randomUUID } = require('crypto');
const { logEvent } = require('./logger');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY;

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

// Extracts correlation fields from the incoming request and immediately sets
// X-Request-Id on the response so every reply carries the correlation ID.
// Uses the caller-supplied X-Request-Id if present; generates a UUID otherwise.
function initRequest(req, res, endpoint) {
  const requestId = req.header('X-Request-Id') || randomUUID();
  const startTime = Date.now();
  const traceEnabled = req.header('X-Trace-Enabled') === 'true';
  const ip = req.ip || req.socket?.remoteAddress || null;
  const userAgent = req.header('user-agent') || null;
  const ctx = { requestId, endpoint, traceEnabled };
  res.setHeader('X-Request-Id', requestId);
  return { ctx, startTime, ip, userAgent };
}

function logReceived(ctx, ip, userAgent, method, extra = {}) {
  logEvent({ event: 'REQUEST_RECEIVED', ...ctx, method, ip, userAgent, ...extra });
}

// extra can carry key response metadata (e.g. isSubscriber, contentType, byteSize)
// so RESPONSE_SENT captures the outcome without duplicating the full body.
function logResponseSent(ctx, startTime, httpStatus, extra = {}) {
  logEvent({ event: 'RESPONSE_SENT', ...ctx, httpStatus, totalDurationMs: Date.now() - startTime, ...extra });
}

function logTgStarted(ctx, extra = {}) {
  logEvent({ event: 'TG_REQUEST_STARTED', ...ctx, ...extra });
}

function logTgResponse(ctx, extra = {}) {
  logEvent({ event: 'TG_RESPONSE', ...ctx, ...extra });
}

function logError(ctx, startTime, err) {
  logEvent({ event: 'ERROR', ...ctx, errorName: err.name, errorMessage: err.message, stack: err.stack ?? null, totalDurationMs: Date.now() - startTime });
}

// Returns false and sends 403 if the API key is missing or wrong.
function checkAuth(req, res, ctx, startTime) {
  if (req.header('X-Gateway-Key') !== GATEWAY_API_KEY) {
    logResponseSent(ctx, startTime, 403);
    res.status(403).json({ ok: false, error: 'Forbidden' });
    return false;
  }
  return true;
}

// Extracts Telegram error details to include in TG_RESPONSE when ok === false.
function tgErrorFields(data) {
  return data?.ok === false
    ? { telegramErrorCode: data.error_code ?? null, telegramDescription: data.description ?? null }
    : {};
}

// ---------------------------------------------------------------------------
// Process-level error handlers
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err) => {
  logEvent({ event: 'ERROR', errorType: 'uncaughtException', errorName: err.name, errorMessage: err.message, fatal: true });
  console.error('[Gateway] uncaughtException:', err);
  // Intentional exit: the process is in an unrecoverable state after an
  // uncaughtException. PM2 (or the system process manager) is expected to
  // restart it automatically.
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logEvent({ event: 'ERROR', errorType: 'unhandledRejection', errorName: err.name, errorMessage: err.message, fatal: false });
  console.error('[Gateway] unhandledRejection:', reason);
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => {
  const { ctx, startTime, ip, userAgent } = initRequest(req, res, '/health');

  logReceived(ctx, ip, userAgent, 'GET');

  logResponseSent(ctx, startTime, 200);
  res.json({ status: 'ok', service: 'telegram-gateway', botTokenLoaded: !!BOT_TOKEN, channelId: CHANNEL_ID || null });
});

// ---------------------------------------------------------------------------
// POST /check-subscription
// ---------------------------------------------------------------------------

app.post('/check-subscription', async (req, res) => {
  const { ctx, startTime, ip, userAgent } = initRequest(req, res, '/check-subscription');
  const { userId } = req.body;

  logReceived(ctx, ip, userAgent, 'POST', { userId: userId ?? null });

  if (!checkAuth(req, res, ctx, startTime)) return;

  try {
    const url =
      `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember` +
      `?chat_id=${encodeURIComponent(CHANNEL_ID)}` +
      `&user_id=${encodeURIComponent(userId)}`;

    // ── First attempt ──────────────────────────────────────────────────────────

    logTgStarted(ctx, { telegramMethod: 'getChatMember', userId: userId ?? null, chatId: CHANNEL_ID });

    const tgStart1 = Date.now();
    let response = await fetch(url);
    let data = await response.json();
    let telegramDurationMs = Date.now() - tgStart1;

    logTgResponse(ctx, {
      telegramMethod: 'getChatMember',
      httpStatus: response.status,
      telegramOk: data.ok ?? null,
      telegramStatus: data?.result?.status ?? null,
      telegramDurationMs,
      userId: userId ?? null,
      ...tgErrorFields(data),
    });

    // ── Retry on PARTICIPANT_ID_INVALID ────────────────────────────────────────

    if (response.status === 400 && data?.description === 'Bad Request: PARTICIPANT_ID_INVALID') {
      logEvent({
        event: 'TG_RETRY_SCHEDULED',
        ...ctx,
        telegramMethod: 'getChatMember',
        userId: userId ?? null,
        retryReason: 'PARTICIPANT_ID_INVALID',
        delayMs: 2000,
      });

      await new Promise((resolve) => setTimeout(resolve, 2000));

      logTgStarted(ctx, { telegramMethod: 'getChatMember', userId: userId ?? null, chatId: CHANNEL_ID });

      const tgStart2 = Date.now();
      response = await fetch(url);
      data = await response.json();
      telegramDurationMs = Date.now() - tgStart2;

      logTgResponse(ctx, {
        telegramMethod: 'getChatMember',
        httpStatus: response.status,
        telegramOk: data.ok ?? null,
        telegramStatus: data?.result?.status ?? null,
        telegramDurationMs,
        userId: userId ?? null,
        ...tgErrorFields(data),
      });
    }

    // ── Decision (uses whichever attempt was last) ─────────────────────────────

    const status = data?.result?.status;
    const isSubscriber =
      status === 'creator' ||
      status === 'administrator' ||
      status === 'member';

    logEvent({
      event: 'SUBSCRIPTION_DECISION',
      ...ctx,
      userId: userId ?? null,
      telegramOk: data.ok ?? null,
      telegramStatus: status ?? null,
      isSubscriber,
    });

    logResponseSent(ctx, startTime, 200, { userId: userId ?? null, isSubscriber });

    res.json({ ok: true, userId, telegramOk: data.ok, telegramStatus: status ?? null, telegramResponse: data, isSubscriber, requestId: ctx.requestId });
  } catch (err) {
    logError(ctx, startTime, err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /channel-info
// ---------------------------------------------------------------------------

app.get('/channel-info', async (req, res) => {
  const { ctx, startTime, ip, userAgent } = initRequest(req, res, '/channel-info');

  logReceived(ctx, ip, userAgent, 'GET');

  if (!checkAuth(req, res, ctx, startTime)) return;

  try {
    // getChat
    logTgStarted(ctx, { telegramMethod: 'getChat', chatId: CHANNEL_ID });
    const tgStart1 = Date.now();
    const chatResponse = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getChat?chat_id=${encodeURIComponent(CHANNEL_ID)}`
    );
    const chatData = await chatResponse.json();
    logTgResponse(ctx, {
      telegramMethod: 'getChat',
      httpStatus: chatResponse.status,
      telegramOk: chatData.ok ?? null,
      title: chatData?.result?.title ?? null,
      hasPhoto: !!chatData?.result?.photo,
      telegramDurationMs: Date.now() - tgStart1,
      ...tgErrorFields(chatData),
    });

    // getChatMemberCount
    logTgStarted(ctx, { telegramMethod: 'getChatMemberCount', chatId: CHANNEL_ID });
    const tgStart2 = Date.now();
    const countResponse = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getChatMemberCount?chat_id=${encodeURIComponent(CHANNEL_ID)}`
    );
    const countData = await countResponse.json();
    logTgResponse(ctx, {
      telegramMethod: 'getChatMemberCount',
      httpStatus: countResponse.status,
      telegramOk: countData.ok ?? null,
      memberCount: countData?.result ?? null,
      telegramDurationMs: Date.now() - tgStart2,
      ...tgErrorFields(countData),
    });

    let photoUrl = 'http://server.designerka.kz:3001/channel-avatar';

    // getFile (only when the channel has a photo)
    const fileId = chatData?.result?.photo?.big_file_id;
    if (fileId) {
      logTgStarted(ctx, { telegramMethod: 'getFile', chatId: CHANNEL_ID });
      const tgStart3 = Date.now();
      const fileResponse = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`
      );
      const fileData = await fileResponse.json();
      logTgResponse(ctx, {
        telegramMethod: 'getFile',
        httpStatus: fileResponse.status,
        telegramOk: fileData.ok ?? null,
        hasFilePath: !!(fileData?.result?.file_path),
        telegramDurationMs: Date.now() - tgStart3,
        ...tgErrorFields(fileData),
      });

      if (fileData?.ok && fileData?.result?.file_path) {
        photoUrl = 'http://server.designerka.kz:3001/channel-avatar';
      }
    }

    logResponseSent(ctx, startTime, 200);
    res.json({
      title: chatData?.result?.title || null,
      username: chatData?.result?.username || null,
      photoUrl,
      subscriberCount: countData?.result || 0,
      description: chatData?.result?.description || null,
    });
  } catch (err) {
    logError(ctx, startTime, err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /channel-avatar
// ---------------------------------------------------------------------------

app.get('/channel-avatar', async (req, res) => {
  const { ctx, startTime, ip, userAgent } = initRequest(req, res, '/channel-avatar');

  logReceived(ctx, ip, userAgent, 'GET');

  if (!checkAuth(req, res, ctx, startTime)) return;

  try {
    // getChat
    logTgStarted(ctx, { telegramMethod: 'getChat', chatId: CHANNEL_ID });
    const tgStart1 = Date.now();
    const chatResponse = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getChat?chat_id=${encodeURIComponent(CHANNEL_ID)}`
    );
    const chatData = await chatResponse.json();
    logTgResponse(ctx, {
      telegramMethod: 'getChat',
      httpStatus: chatResponse.status,
      telegramOk: chatData.ok ?? null,
      hasPhoto: !!chatData?.result?.photo,
      telegramDurationMs: Date.now() - tgStart1,
      ...tgErrorFields(chatData),
    });

    const fileId = chatData?.result?.photo?.big_file_id;
    if (!fileId) {
      logResponseSent(ctx, startTime, 404);
      return res.status(404).end();
    }

    // getFile
    logTgStarted(ctx, { telegramMethod: 'getFile', chatId: CHANNEL_ID });
    const tgStart2 = Date.now();
    const fileResponse = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`
    );
    const fileData = await fileResponse.json();
    logTgResponse(ctx, {
      telegramMethod: 'getFile',
      httpStatus: fileResponse.status,
      telegramOk: fileData.ok ?? null,
      hasFilePath: !!(fileData?.result?.file_path),
      telegramDurationMs: Date.now() - tgStart2,
      ...tgErrorFields(fileData),
    });

    if (!fileData?.ok || !fileData?.result?.file_path) {
      logResponseSent(ctx, startTime, 404);
      return res.status(404).end();
    }

    // downloadFile (binary — no JSON from Telegram, no tgErrorFields)
    logTgStarted(ctx, { telegramMethod: 'downloadFile' });
    const tgStart3 = Date.now();
    const imageResponse = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.result.file_path}`
    );
    const telegramDurationMs3 = Date.now() - tgStart3;

    if (!imageResponse.ok) {
      logTgResponse(ctx, { telegramMethod: 'downloadFile', httpStatus: imageResponse.status, telegramDurationMs: telegramDurationMs3 });
      logResponseSent(ctx, startTime, 502);
      return res.status(502).end();
    }

    const buffer = Buffer.from(await imageResponse.arrayBuffer());
    const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';

    logTgResponse(ctx, { telegramMethod: 'downloadFile', httpStatus: imageResponse.status, contentType, byteSize: buffer.byteLength, telegramDurationMs: telegramDurationMs3 });
    logResponseSent(ctx, startTime, 200, { contentType, byteSize: buffer.byteLength });

    res.setHeader('Content-Type', contentType);
    res.end(buffer);
  } catch (err) {
    console.error('[channel-avatar]', err);
    logError(ctx, startTime, err);
    res.status(500).end();
  }
});

// ---------------------------------------------------------------------------
// POST /send-message
// ---------------------------------------------------------------------------

app.post('/send-message', async (req, res) => {
  const { ctx, startTime, ip, userAgent } = initRequest(req, res, '/send-message');
  const { chatId, text, parseMode } = req.body;

  logReceived(ctx, ip, userAgent, 'POST', { chatId: chatId ?? null, textLength: typeof text === 'string' ? text.length : null });

  if (!checkAuth(req, res, ctx, startTime)) return;

  if (!chatId || !text) {
    logResponseSent(ctx, startTime, 400);
    return res.status(400).json({ ok: false, error: 'chatId and text are required' });
  }

  try {
    logTgStarted(ctx, { telegramMethod: 'sendMessage', chatId: String(chatId) });

    const tgStart = Date.now();
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: String(chatId), text, parse_mode: parseMode || undefined }),
      }
    );
    const data = await response.json();
    const telegramDurationMs = Date.now() - tgStart;

    logTgResponse(ctx, {
      telegramMethod: 'sendMessage',
      httpStatus: response.status,
      telegramOk: data.ok ?? null,
      messageId: data.result?.message_id ?? null,
      telegramDurationMs,
      chatId: String(chatId),
      ...tgErrorFields(data),
    });

    if (!response.ok || !data.ok) {
      logResponseSent(ctx, startTime, 500);
      return res.status(500).json({ ok: false, telegramResponse: data });
    }

    logResponseSent(ctx, startTime, 200, { messageId: data.result?.message_id ?? null });
    res.json({ ok: true, messageId: data.result?.message_id || null, requestId: ctx.requestId });
  } catch (err) {
    logError(ctx, startTime, err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// File download proxy
// Telegram file URLs: https://api.telegram.org/file/bot{token}/{path}
// ---------------------------------------------------------------------------

app.get('/file/bot:token/*filePath', async (req, res) => {
  const { token, filePath } = req.params;
  const { ctx, startTime } = initRequest(req, res, '/file/bot:token/*filePath');

  try {
    logTgStarted(ctx, { telegramMethod: 'downloadFile', filePath });

    const tgStart = Date.now();
    const tgResponse = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    const telegramDurationMs = Date.now() - tgStart;

    if (!tgResponse.ok) {
      logTgResponse(ctx, { telegramMethod: 'downloadFile', httpStatus: tgResponse.status, telegramDurationMs });
      logResponseSent(ctx, startTime, 502);
      return res.status(502).end();
    }

    const buffer = Buffer.from(await tgResponse.arrayBuffer());
    const contentType = tgResponse.headers.get('content-type') || 'application/octet-stream';

    logTgResponse(ctx, { telegramMethod: 'downloadFile', httpStatus: tgResponse.status, contentType, byteSize: buffer.byteLength, telegramDurationMs });
    logResponseSent(ctx, startTime, 200, { contentType, byteSize: buffer.byteLength });

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(buffer);
  } catch (err) {
    logError(ctx, startTime, err);
    res.status(500).end();
  }
});

// ---------------------------------------------------------------------------
// Bot API transparent proxy
// grammY constructs: {apiRoot}/bot{token}/{method}
// This proxy forwards those calls to api.telegram.org
// ---------------------------------------------------------------------------

app.all('/bot:token/:method', async (req, res) => {
  const { token, method } = req.params;
  try {
    const qs = new URLSearchParams(req.query).toString();
    const targetUrl = `https://api.telegram.org/bot${token}/${method}${qs ? '?' + qs : ''}`;
    const options = { method: req.method };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      options.body = JSON.stringify(req.body);
      options.headers = { 'Content-Type': 'application/json' };
    }
    const tgResponse = await fetch(targetUrl, options);
    const data = await tgResponse.json();
    res.status(tgResponse.status).json(data);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  logEvent({ event: 'STARTUP', port: Number(PORT), botTokenLoaded: !!BOT_TOKEN, channelIdConfigured: !!CHANNEL_ID });
  console.log(`Telegram Gateway listening on port ${PORT}`);
});
