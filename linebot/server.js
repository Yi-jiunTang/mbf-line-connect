const restify = require('restify');
const request = require('request');

const MBF_ENDPOINT = process.env.MBF_DIRECT_LINE_ENDPOINT || 'https://directline.botframework.com';
const MBF_SECRET   = process.env.MBF_DIRECT_LINE_SECRET;
const LINE_TOKEN   = process.env.LINE_BOT_CHANNEL_ACCESS_TOKEN;
const PORT         = process.env.PORT || 3000;

if (!MBF_SECRET || !LINE_TOKEN) {
  console.error('Error: Missing MBF_DIRECT_LINE_SECRET or LINE_BOT_CHANNEL_ACCESS_TOKEN');
  process.exit(1);
}

const server = restify.createServer({ name: 'line-copilot-relay' });
server.use(restify.plugins.acceptParser(server.acceptable));
server.use(restify.plugins.queryParser());
server.use(restify.plugins.bodyParser({ mapParams: false }));

// Optional: respond to GET for test/debug
server.get('/', (req, res, next) => {
  res.send(200, 'LINE Webhook OK');
  next();
});

// Cache user conversations
const convCache = new Map();

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

        // Create or get Direct Line conversation
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

        // Send user message to bot
        await new Promise((resolve, reject) => {
          request.post(`${MBF_ENDPOINT}/v3/directline/conversations/${conv.conversationId}/activities`, {
            auth: { bearer: conv.token },
            json: { type: 'message', from: { id: userId }, text: userText }
          }, (err, _, body) => err ? reject(err) : resolve(body));
        });

        // Poll for bot reply
        const botReply = await new Promise(resolve => {
          let attempts = 0;
          const interval = setInterval(() => {
            attempts++;
            request.get(`${MBF_ENDPOINT}/v3/directline/conversations/${conv.conversationId}/activities?watermark=${conv.watermark}`, {
              auth: { bearer: conv.token }, json: true
            }, (err, _, body) => {
                console.log('Bot activities:', JSON.stringify(body.activities, null, 2));
              const activities = body?.activities || [];
              if (activities.length) {
                const msgs = activities.filter(a => a.from?.role === 'bot');
                if (msgs.length) {
                  clearInterval(interval);
                  conv.watermark = body.watermark;

                  // Merge all messages into one reply string
                  const replyText = msgs.map(msg => {
                    if (msg.text) return msg.text;
                    if (msg.attachments?.length) {
                      return msg.attachments.map(att => {
                        if (att.content?.text) return att.content.text;
                        if (att.content?.title) return att.content.title;
                        return '[Bot sent an attachment]';
                      }).join('\n');
                    }
                    return null;
                  }).filter(Boolean).join('\n');

                  return resolve(replyText || null);
                }
              }
              if (attempts >= 5) {
                clearInterval(interval);
                resolve(null);
              }
            });
          }, 1000);
        });

        // Reply to LINE
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

server.listen(PORT, () => {
  console.log(`${server.name} listening on ${PORT}`);
});
