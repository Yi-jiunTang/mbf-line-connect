// server.js – LINE ↔ Copilot Studio relay (Restify)
// --------------------------------------------------
// 環境變數（App Service → Settings → Configuration）
//   MBF_DIRECT_LINE_ENDPOINT=https://directline.botframework.com
//   MBF_DIRECT_LINE_SECRET=<Copilot Direct Line Secret>
//   LINE_BOT_CHANNEL_ACCESS_TOKEN=<LINE Channel Access Token>
//   PORT 由平台自動注入

const restify = require('restify');
const request = require('request');

const MBF_ENDPOINT = process.env.MBF_DIRECT_LINE_ENDPOINT || 'https://directline.botframework.com';
const MBF_SECRET   = process.env.MBF_DIRECT_LINE_SECRET;
const LINE_TOKEN  = process.env.LINE_BOT_CHANNEL_ACCESS_TOKEN;
const PORT        = process.env.PORT || 3000;

if (!MBF_SECRET || !LINE_TOKEN) {
  console.error('環境變數缺少 MBF_DIRECT_LINE_SECRET 或 LINE_BOT_CHANNEL_ACCESS_TOKEN');
  process.exit(1);
}

//--------------------------------------------------
// 1. 建立 Restify 伺服器
//--------------------------------------------------
const server = restify.createServer({ name: 'line-copilot-relay', version: '1.0.0' });
server.use(restify.plugins.acceptParser(server.acceptable));
server.use(restify.plugins.queryParser());
server.use(restify.plugins.bodyParser({ mapParams: false }));

//--------------------------------------------------
// 2. 記憶 userId ↔ conversationId，避免每次新開
//--------------------------------------------------
const convCache = new Map(); // userId -> { conversationId, token, streamUrl, watermark }

//--------------------------------------------------
// 3. 主 Webhook：先回 200，再背景處理
//--------------------------------------------------
server.post('/', (req, res, next) => {
  // LINE 1 秒超時限制 → 立即回 200
  res.send(200);
  next();

  if (!req.body || !Array.isArray(req.body.events)) return;
  processEvents(req.body.events).catch(err => console.error('processEvents error', err));
});

//--------------------------------------------------
// 4. 背景處理: 對 Copilot 說話 → 把回覆轉回 LINE
//--------------------------------------------------
async function processEvents(events) {
  for (const evt of events) {
    if (evt.type !== 'message' || evt.message.type !== 'text') continue;

    const userId     = evt.source.userId;
    const lineText   = evt.message.text;
    const replyToken = evt.replyToken;

    // 4.1 取得 conversationId & token
    const conv = await getConversation(userId);

    // 4.2 對 Copilot 發訊息
    await dlPostMessage(conv.conversationId, conv.token, userId, lineText);

    // 4.3 取得 Copilot 回覆（簡易輪詢 3 次，每 1 秒）
    const botMsg = await pollBotReply(conv, 3, 1000);

    // 4.4 回 LINE
    if (botMsg) {
      await lineReply(replyToken, botMsg);
    }
  }
}

//--------------------------------------------------
// 5. Direct Line helper
//--------------------------------------------------
function dlHeaders(tokenOrSecret) {
  return {
    auth: { bearer: tokenOrSecret },
    json: true
  };
}

function startConversation() {
  return new Promise((resolve, reject) => {
    request.post(`${MBF_ENDPOINT}/v3/directline/conversations`, dlHeaders(MBF_SECRET), (err, resp, body) => {
      if (err) return reject(err);
      resolve({
        conversationId: body.conversationId,
        token: body.token,
        streamUrl: body.streamUrl,
        watermark: undefined
      });
    });
  });
}

async function getConversation(userId) {
  if (convCache.has(userId)) return convCache.get(userId);
  const conv = await startConversation();
  convCache.set(userId, conv);
  return conv;
}

function dlPostMessage(conversationId, token, fromId, text) {
  return new Promise((resolve, reject) => {
    request.post(`${MBF_ENDPOINT}/v3/directline/conversations/${conversationId}/activities`,
      Object.assign(dlHeaders(token), {
        json: {
          type: 'message',
          from: { id: fromId },
          text
        }
      }), (err, resp, body) => {
        if (err) return reject(err);
        resolve(body);
      });
  });
}

function pollBotReply(conv, maxTry = 3, delayMs = 1000) {
  return new Promise(resolve => {
    let count = 0;
    const timer = setInterval(() => {
      count += 1;
      request.get(`${MBF_ENDPOINT}/v3/directline/conversations/${conv.conversationId}/activities?watermark=${conv.watermark || ''}`, dlHeaders(conv.token), (err, resp, body) => {
        if (!err && body && body.activities && body.activities.length > 0) {
          // 取最後一條 bot 訊息
          const msgs = body.activities.filter(a => a.from && a.from.role === 'bot' && a.text);
          if (msgs.length > 0) {
            clearInterval(timer);
            conv.watermark = body.watermark; // 更新 watermark
            return resolve(msgs[msgs.length - 1].text);
          }
        }
        if (count >= maxTry) {
          clearInterval(timer);
          return resolve(null); // 超時就不回
        }
      });
    }, delayMs);
  });
}

//--------------------------------------------------
// 6. LINE Messaging API helper
//--------------------------------------------------
function lineReply(replyToken, text) {
  return new Promise((resolve, reject) => {
    request.post('https://api.line.me/v2/bot/message/reply', {
      auth: { bearer: LINE_TOKEN },
      json: {
        replyToken,
        messages: [ { type: 'text', text } ]
      }
    }, (err, resp, body) => {
      if (err) return reject(err);
      resolve(body);
    });
  });
}

//--------------------------------------------------
// 7. 啟動伺服器
//--------------------------------------------------
server.listen(PORT, () => {
  console.log(`${server.name} listening on ${PORT}`);
});