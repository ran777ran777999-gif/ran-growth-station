/**
 * 🌸研三上岸成长站 - 后端服务
 * 零依赖，仅使用 Node 内置模块 (http, crypto, fs, path)
 * 功能：托管前端HTML、账号注册登录、跨设备数据同步、AI接口转发
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const AI_API_KEY = process.env.AI_API_KEY || '';
const DATA_DIR = path.join(__dirname, 'users');
const TOKENS_FILE = path.join(__dirname, 'tokens.json');

// 确保目录存在
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ========== 工具函数 ==========
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function readJSON(filePath, defaultVal) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return defaultVal; }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadTokens() {
  return readJSON(TOKENS_FILE, {});
}

function saveTokens(tokens) {
  writeJSON(TOKENS_FILE, tokens);
}

function getUserFile(username) {
  // 安全：只允许字母数字
  const safe = username.replace(/[^a-zA-Z0-9_]/g, '');
  return path.join(DATA_DIR, safe + '.json');
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 10 * 1024 * 1024) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const boundary = req.headers['content-type']?.split('boundary=')[1];
    if (!boundary) { reject(new Error('No boundary')); return; }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const boundaryBuf = Buffer.from('--' + boundary);
      const parts = [];
      let start = 0;
      while (true) {
        const bStart = buf.indexOf(boundaryBuf, start);
        if (bStart === -1) break;
        const bEnd = buf.indexOf(boundaryBuf, bStart + boundaryBuf.length);
        if (bEnd === -1) break;
        const partData = buf.slice(bStart + boundaryBuf.length + 2, bEnd - 2);
        // Parse headers
        const headerEnd = partData.indexOf('\r\n\r\n');
        if (headerEnd !== -1) {
          const headers = partData.slice(0, headerEnd).toString();
          const data = partData.slice(headerEnd + 4);
          const nameMatch = headers.match(/name="([^"]+)"/);
          const fileMatch = headers.match(/filename="([^"]+)"/);
          parts.push({
            name: nameMatch ? nameMatch[1] : '',
            filename: fileMatch ? fileMatch[1] : null,
            data: data,
            headers: headers
          });
        }
        start = bEnd;
      }
      resolve(parts);
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(body);
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) { sendJSON(res, 404, { error: 'Not found' }); return; }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

function authenticate(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const tokens = loadTokens();
  const entry = tokens[token];
  if (!entry) return null;
  if (new Date(entry.expires) < new Date()) {
    delete tokens[token];
    saveTokens(tokens);
    return null;
  }
  return entry.username;
}

// ========== AI 接口转发 ==========
async function callAIFoodRecognition(imageBuffer) {
  if (!AI_API_KEY) {
    // 模拟返回（无API Key时）
    return {
      foods: [
        { name: '米饭', weight: 150, cal: 174 },
        { name: '青菜', weight: 100, cal: 15 }
      ],
      note: '演示模式：请配置 AI_API_KEY 环境变量启用真实AI识别'
    };
  }
  try {
    // 调用外部AI视觉API（以OpenAI兼容格式为例）
    const base64 = imageBuffer.toString('base64');
    const payload = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '请分析这张餐食图片，识别其中的食物。返回JSON格式：{"foods":[{"name":"食物名","weight":克数,"cal":卡路里}]}。只返回JSON，不要其他内容。' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + base64 } }
        ]
      }],
      max_tokens: 500
    });

    const result = await new Promise((resolve, reject) => {
      const aiReq = http.request('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + AI_API_KEY
        }
      }, (aiRes) => {
        let data = '';
        aiRes.on('data', c => data += c);
        aiRes.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error('AI response parse error')); }
        });
      });
      aiReq.on('error', reject);
      aiReq.write(payload);
      aiReq.end();
    });

    const content = result.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { foods: [], note: '未能识别食物' };
  } catch (e) {
    return { foods: [], note: 'AI识别出错: ' + e.message };
  }
}

async function callAIReviewSummary(reviews) {
  if (!AI_API_KEY) {
    // 模拟返回
    const count = reviews.length;
    const dones = reviews.filter(r => r.done).map(r => r.done).join('；');
    return {
      summary: `本月共完成${count}天复盘。\n核心完成事项：${dones.slice(0, 200)}...\n\n（演示模式：配置 AI_API_KEY 启用真实AI总结）`
    };
  }
  try {
    const reviewText = reviews.map(r =>
      `【${r.date}】\n完成：${r.done||'无'}\n未完成：${r.notDone||'无'}\n收获：${r.gain||'无'}\n情绪：${r.mood||'无'}\n明日调整：${r.tomorrow||'无'}`
    ).join('\n\n');

    const payload = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'system',
        content: '你是一个温暖鼓励的成长教练。请根据用户的每日复盘记录，生成一份月度成长总结。包含：核心成长亮点、待改进的问题、下月建议。语气温柔鼓励，简约有力。'
      }, {
        role: 'user',
        content: `以下是我的本月每日复盘记录，请帮我总结：\n\n${reviewText}`
      }],
      max_tokens: 800
    });

    const result = await new Promise((resolve, reject) => {
      const aiReq = http.request('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + AI_API_KEY
        }
      }, (aiRes) => {
        let data = '';
        aiRes.on('data', c => data += c);
        aiRes.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error('AI response parse error')); }
        });
      });
      aiReq.on('error', reject);
      aiReq.write(payload);
      aiReq.end();
    });

    return { summary: result.choices?.[0]?.message?.content || '总结生成失败' };
  } catch (e) {
    return { summary: 'AI总结出错: ' + e.message };
  }
}

// ========== 路由处理 ==========
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  // 健康检查
  if (pathname === '/api/health' && method === 'GET') {
    sendJSON(res, 200, {
      ok: true,
      aiEnabled: !!AI_API_KEY,
      time: new Date().toISOString()
    });
    return;
  }

  // 注册
  if (pathname === '/api/auth/register' && method === 'POST') {
    try {
      const { username, password } = await parseBody(req);
      if (!username || !password || password.length < 6) {
        sendJSON(res, 400, { error: '用户名和密码必填，密码至少6位' });
        return;
      }
      const userFile = getUserFile(username);
      if (fs.existsSync(userFile)) {
        sendJSON(res, 409, { error: '用户名已存在' });
        return;
      }
      const salt = crypto.randomBytes(16).toString('hex');
      const hashed = hashPassword(password, salt);
      const userData = { username, password: hashed, salt, data: null, updatedAt: new Date().toISOString() };
      writeJSON(userFile, userData);

      const token = generateToken();
      const tokens = loadTokens();
      const expires = new Date();
      expires.setDate(expires.getDate() + 60);
      tokens[token] = { username, expires: expires.toISOString() };
      saveTokens(tokens);

      sendJSON(res, 200, { token, username, expires: expires.toISOString() });
    } catch (e) {
      sendJSON(res, 500, { error: '注册失败: ' + e.message });
    }
    return;
  }

  // 登录
  if (pathname === '/api/auth/login' && method === 'POST') {
    try {
      const { username, password } = await parseBody(req);
      const userFile = getUserFile(username);
      if (!fs.existsSync(userFile)) {
        sendJSON(res, 401, { error: '用户名或密码错误' });
        return;
      }
      const userData = readJSON(userFile, {});
      const hashed = hashPassword(password, userData.salt);
      if (hashed !== userData.password) {
        sendJSON(res, 401, { error: '用户名或密码错误' });
        return;
      }
      const token = generateToken();
      const tokens = loadTokens();
      const expires = new Date();
      expires.setDate(expires.getDate() + 60);
      tokens[token] = { username, expires: expires.toISOString() };
      saveTokens(tokens);

      sendJSON(res, 200, { token, username, expires: expires.toISOString() });
    } catch (e) {
      sendJSON(res, 500, { error: '登录失败: ' + e.message });
    }
    return;
  }

  // 登出
  if (pathname === '/api/auth/logout' && method === 'POST') {
    const auth = req.headers['authorization'];
    if (auth && auth.startsWith('Bearer ')) {
      const token = auth.slice(7);
      const tokens = loadTokens();
      delete tokens[token];
      saveTokens(tokens);
    }
    sendJSON(res, 200, { ok: true });
    return;
  }

  // 数据同步 - 拉取
  if (pathname === '/api/sync' && method === 'GET') {
    const username = authenticate(req);
    if (!username) { sendJSON(res, 401, { error: '未登录或令牌过期' }); return; }
    const userFile = getUserFile(username);
    const userData = readJSON(userFile, {});
    sendJSON(res, 200, { data: userData.data, updatedAt: userData.updatedAt });
    return;
  }

  // 数据同步 - 推送
  if (pathname === '/api/sync' && method === 'POST') {
    const username = authenticate(req);
    if (!username) { sendJSON(res, 401, { error: '未登录或令牌过期' }); return; }
    try {
      const body = await parseBody(req);
      const userFile = getUserFile(username);
      const userData = readJSON(userFile, {});

      // 最后写入优先
      const clientTime = body.updatedAt || new Date().toISOString();
      const serverTime = userData.updatedAt || '2000-01-01';

      if (clientTime > serverTime) {
        userData.data = body;
        delete userData.data.updatedAt;
        userData.updatedAt = clientTime;
        writeJSON(userFile, userData);
        sendJSON(res, 200, { ok: true, updatedAt: clientTime });
      } else if (clientTime === serverTime) {
        sendJSON(res, 200, { ok: true, updatedAt: clientTime });
      } else {
        // 云端更新，提示切换
        sendJSON(res, 409, {
          error: 'cloud_newer',
          updatedAt: serverTime,
          message: '检测到云端数据更新，是否切换最新数据？'
        });
      }
    } catch (e) {
      sendJSON(res, 500, { error: '同步失败: ' + e.message });
    }
    return;
  }

  // AI 卡路里识别
  if (pathname === '/api/calcFoodCal' && method === 'POST') {
    const username = authenticate(req);
    if (!username) { sendJSON(res, 401, { error: '未登录' }); return; }
    try {
      const contentType = req.headers['content-type'] || '';
      let imageBuffer = null;

      if (contentType.includes('multipart/form-data')) {
        const parts = await parseMultipart(req);
        const filePart = parts.find(p => p.filename);
        if (filePart) imageBuffer = filePart.data;
      } else {
        // 直接 body 是图片
        const chunks = [];
        await new Promise((resolve) => {
          req.on('data', c => chunks.push(c));
          req.on('end', resolve);
        });
        imageBuffer = Buffer.concat(chunks);
      }

      if (!imageBuffer) { sendJSON(res, 400, { error: '未收到图片' }); return; }
      const result = await callAIFoodRecognition(imageBuffer);
      sendJSON(res, 200, result);
    } catch (e) {
      sendJSON(res, 500, { error: 'AI识别失败: ' + e.message });
    }
    return;
  }

  // AI 复盘总结
  if (pathname === '/api/sumReview' && method === 'POST') {
    const username = authenticate(req);
    if (!username) { sendJSON(res, 401, { error: '未登录' }); return; }
    try {
      const { reviews } = await parseBody(req);
      if (!reviews || !Array.isArray(reviews)) {
        sendJSON(res, 400, { error: '请提供复盘数据' });
        return;
      }
      const result = await callAIReviewSummary(reviews);
      sendJSON(res, 200, result);
    } catch (e) {
      sendJSON(res, 500, { error: 'AI总结失败: ' + e.message });
    }
    return;
  }

  // 静态文件服务
  if (method === 'GET') {
    if (pathname === '/' || pathname === '/index.html') {
      sendFile(res, path.join(__dirname, 'index.html'), 'text/html; charset=utf-8');
      return;
    }
    // 其他静态文件
    const filePath = path.join(__dirname, pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const types = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.ico': 'image/x-icon'
      };
      sendFile(res, filePath, types[ext] || 'application/octet-stream');
      return;
    }
  }

  sendJSON(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`🌸 研三上岸成长站服务已启动`);
  console.log(`   本地访问: http://localhost:${PORT}`);
  console.log(`   AI功能: ${AI_API_KEY ? '✅ 已启用' : '⚠️ 未配置 AI_API_KEY（演示模式）'}`);
});
