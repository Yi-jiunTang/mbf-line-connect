// server.js – LINE ↔ Copilot Studio Relay (Restify)
// --------------------------------------------------
// 環境變數設定 (在 Azure Portal ➜ App Service ➜ Configuration ➜ Application settings):
// - MBF_DIRECT_LINE_ENDPOINT=https://directline.botframework.com
// - MBF_DIRECT_LINE_SECRET=<Copilot Direct Line Secret>
// - LINE_BOT_CHANNEL_ACCESS_TOKEN=<LINE Channel Access Token>
// - PORT 由平台自動注入

const restify = require('restify');
const request = require('request');

// 取得環境變數
const MBF_ENDPOINT = process.env.MBF_DIRECT_LINE_ENDPOINT || 'https://directline.botframework.com';
const MBF_SECRET   = process.env.MBF_DIRECT_LINE_SECRET;
const LINE_TOKEN  = process.env.LINE_BOT_CHANNEL_ACCESS_TOKEN;
const PORT        = process.env.PORT || 3000;

// 檢查必要變數
if (!MBF_SECRET || !LINE_TOKEN) {
  console.error('Error: Missing MBF_DIRECT_LINE_SECRET or LINE_BOT_CHANNEL_ACCESS_TOKEN');
  process.exit(1);
}

// 建立伺服器
const server = restify.createServer({ name: 'line-copilot-relay' });
// pre-route middleware
server.use(restify.plugins.acceptParser(server.acceptable));
server.use(restify.plugins.queryParser());
server.use(restify.plugins.bodyParser({ mapParams: false }));

// userId ↔ conversation cache
const convCache = new Map();

// Webhook 路由：先回 200 再背景處理
server.post('/', (req, res, next) => {
  res.send(200);
  next();
  const events = Array.isArray(req.body?.events) ? req.body.events : [];

  (async () => {
    for (const evt of events) {
      if (evt.type !== 'message' || evt.message.type !== 'text') continue;
      try {
        const userId = evt.source.userId;
        const replyToken = evt.replyToken;
        const userText = evt.message.text;

        // 取得或開啟 Direct Line conversation
        let conv = convCache.get(userId);
        if (!conv) {
          const convRes = await new Promise((resolve, reject) => {
            request.post(`${MBF_ENDPOINT}/v3/directline/conversations`, {
              auth: { bearer: MBF_SECRET }, json: true
            }, (err, _, body) => err ? reject(err) : resolve(body));
          });
          conv = { conversationId: convRes.conversationId, token: convRes.token, streamUrl: convRes.streamUrl, watermark: '' };
          convCache.set(userId, conv);
        }

        // 發送使用者訊息
        await new Promise((resolve, reject) => {
          request.post(`${MBF_ENDPOINT}/v3/directline/conversations/${conv.conversationId}/activities`, {
            auth: { bearer: conv.token },
            json: { type: 'message', from: { id: userId }, text: userText }
          }, (err, _, body) => err ? reject(err) : resolve(body));
        });

        // 輪詢 bot 回覆
        const botReply = await new Promise(resolve => {
          let attempts = 0;
          const interval = setInterval(() => {
            attempts++;
            request.get(`${MBF_ENDPOINT}/v3/directline/conversations/${conv.conversationId}/activities?watermark=${conv.watermark}`, {
              auth: { bearer: conv.token }, json: true
            }, (err, _, body) => {
              const activities = body?.activities || [];
              if (activities.length) {
                const msgs = activities.filter(a => a.from?.role === 'bot' && a.text);
                if (msgs.length) {
                  clearInterval(interval);
                  conv.watermark = body.watermark;
                  return resolve(msgs[msgs.length - 1].text);
                }
              }
              if (attempts >= 5) {
                clearInterval(interval);
                resolve(null);
              }
            });
          }, 1000);
        });

        // 回覆至 LINE
        if (botReply) {
          await new Promise((resolve, reject) => {
            request.post('https://api.line.me/v2/bot/message/reply', {
              auth: { bearer: LINE_TOKEN },
              json: { replyToken, messages: [{ type: 'text', text: botReply }] }
            }, (err, _, body) => err ? reject(err) : resolve(body));
          });
        }
      } catch (err) {
        console.error('Error processing event:', err);
      }
    }
  })().catch(err => console.error('Unexpected error:', err));
});

// 啟動伺服器
server.listen(PORT, () => {
  console.log(`${server.name} listening on ${PORT}`);
});
