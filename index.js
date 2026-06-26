require('dotenv').config();

const express = require('express');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY;

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'telegram-gateway',
    botTokenLoaded: !!BOT_TOKEN,
    channelId: CHANNEL_ID || null
  });
});

app.post('/check-subscription', async (req, res) => {
  const { userId } = req.body;
const apiKey = req.header('X-Gateway-Key');

if (apiKey !== GATEWAY_API_KEY) {
  return res.status(403).json({
    ok: false,
    error: 'Forbidden'
  });
}

  try {
    const url =
      `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember` +
      `?chat_id=${encodeURIComponent(CHANNEL_ID)}` +
      `&user_id=${encodeURIComponent(userId)}`;

    const response = await fetch(url);
    const data = await response.json();

    const status = data?.result?.status;
    const isSubscriber =
      status === 'creator' ||
      status === 'administrator' ||
      status === 'member';

    res.json({
      ok: true,
      userId,
      telegramOk: data.ok,
      telegramStatus: status ?? null,
      telegramResponse: data,
      isSubscriber
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.get('/channel-info', async (req, res) => {
  const apiKey = req.header('X-Gateway-Key');

  if (apiKey !== GATEWAY_API_KEY) {
    return res.status(403).json({
      ok: false,
      error: 'Forbidden'
    });
  }

  try {
    const chatResponse = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getChat?chat_id=${encodeURIComponent(CHANNEL_ID)}`
    );
    const chatData = await chatResponse.json();

    const countResponse = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getChatMemberCount?chat_id=${encodeURIComponent(CHANNEL_ID)}`
    );
    const countData = await countResponse.json();

    let photoUrl = 'http://server.designerka.kz:3001/channel-avatar';;

    const fileId = chatData?.result?.photo?.big_file_id;
    if (fileId) {
      const fileResponse = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`
      );
      const fileData = await fileResponse.json();

      if (fileData?.ok && fileData?.result?.file_path) {
        photoUrl = "http://server.designerka.kz:3001/channel-avatar";
      }
    }

    res.json({
      title: chatData?.result?.title || null,
      username: chatData?.result?.username || null,
      photoUrl,
      subscriberCount: countData?.result || 0,
      description: chatData?.result?.description || null
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.get('/channel-avatar', async (req, res) => {
  try {
    const chatResponse = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getChat?chat_id=${encodeURIComponent(CHANNEL_ID)}`
    );
    const chatData = await chatResponse.json();

    const fileId = chatData?.result?.photo?.big_file_id;

    if (!fileId) {
      return res.status(404).end();
    }

    const fileResponse = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`
    );
    const fileData = await fileResponse.json();

    if (!fileData?.ok || !fileData?.result?.file_path) {
      return res.status(404).end();
    }

    const imageResponse = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.result.file_path}`
    );

    if (!imageResponse.ok) {
      return res.status(502).end();
    }

    res.setHeader(
      'Content-Type',
      imageResponse.headers.get('content-type') || 'image/jpeg'
    );

    const buffer = Buffer.from(await imageResponse.arrayBuffer());
    res.end(buffer);
  } catch (err) {
    console.error('[channel-avatar]', err);
    res.status(500).end();
  }
});

app.listen(PORT, () => {
  console.log(`Telegram Gateway listening on port ${PORT}`);
});

app.post('/send-message', async (req, res) => {
  const apiKey = req.header('X-Gateway-Key');

  if (apiKey !== GATEWAY_API_KEY) {
    return res.status(403).json({
      ok: false,
      error: 'Forbidden'
    });
  }

  const { chatId, text, parseMode } = req.body;

  if (!chatId || !text) {
    return res.status(400).json({
      ok: false,
      error: 'chatId and text are required'
    });
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          chat_id: String(chatId),
          text,
          parse_mode: parseMode || undefined
        })
      }
    );

    const data = await response.json();

    if (!response.ok || !data.ok) {
      return res.status(500).json({
        ok: false,
        telegramResponse: data
      });
    }

    res.json({
      ok: true,
      messageId: data.result?.message_id || null
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

