// Cloudflare Workers 论坛后端 — 纯标准 API，无第三方依赖
const APP_HTML = "__APP_HTML__";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}
function getCookie(req, name) {
  const c = req.headers.get('Cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
/* PBKDF2 慢哈希：新用户直接用；老用户登录时自动升级 */
const PBKDF2_ITER = 100000;
async function pbkdf2Hash(password, saltHex) {
  const enc = new TextEncoder();
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function makePassHash(password) {
  const salt = randHex(16);
  const hash = await pbkdf2Hash(password, salt);
  return { salt, hash: 'pbkdf2$' + PBKDF2_ITER + '$' + hash };
}
async function checkPass(password, user) {
  if (user.pass_hash.startsWith('pbkdf2$')) {
    const parts = user.pass_hash.split('$');
    const iter = Number(parts[1]) || PBKDF2_ITER;
    const enc = new TextEncoder();
    const salt = new Uint8Array(user.salt.match(/../g).map(h => parseInt(h, 16)));
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, key, 256);
    const hash = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
    return hash === parts[2];
  }
  // 老格式 SHA-256：验证通过后自动升级为 PBKDF2（调用方负责更新）
  return (await sha256hex(user.salt + password)) === user.pass_hash;
}
function randHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}
function sessionCookie(token, maxAge) {
  return `sid=${token}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax; Secure`;
}
// 积分：静默加，不阻塞主流程
async function addPoints(env, userId, points, reason, relatedId) {
  try {
    await env.DB.prepare('UPDATE users SET points = points + ? WHERE id = ?').bind(points, userId).run();
    // 写积分流水
    if (reason) {
      await env.DB.prepare('INSERT INTO point_logs (user_id, points, reason, related_id, created_at) VALUES (?,?,?,?,?)')
        .bind(userId, points, reason, relatedId || null, Date.now()).run().catch(()=>{});
    }
  } catch (e) {}
}
// 北京时间（UTC+8）的日期字符串 YYYY-MM-DD
function beijingDate(d) {
  const b = new Date((d || Date.now()) + 8 * 3600 * 1000);
  return b.toISOString().slice(0, 10);
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
async function currentUser(req, env) {
  const token = getCookie(req, 'sid');
  if (!token) return null;
  const s = await env.DB.prepare('SELECT user_id, expires_at FROM sessions WHERE token=?').bind(token).first();
  if (!s || s.expires_at < Date.now()) return null;
  return await env.DB.prepare('SELECT id, name, is_admin, email, verified, avatar_url, bio, banned, points, checkin_streak, custom_title, avatar_frame FROM users WHERE id=?').bind(s.user_id).first();
}
function requireAdmin(me) {
  if (!me || !me.is_admin) return json({ error: '需要管理员权限' }, 403);
  return null;
}
let sensitiveCache = null;
let sensitiveCacheAt = 0;
async function getSensitiveWords(env) {
  const now = Date.now();
  if (sensitiveCache && now - sensitiveCacheAt < 60000) return sensitiveCache;
  const { results } = await env.DB.prepare('SELECT word FROM sensitive_words').all().catch(() => ({ results: [] }));
  sensitiveCache = results.map(r => r.word);
  sensitiveCacheAt = now;
  return sensitiveCache;
}
async function checkSensitive(env, text) {
  const words = await getSensitiveWords(env);
  for (const w of words) {
    if (w && text.includes(w)) return w;
  }
  return null;
}
async function sendVerificationEmail(env, email, name, token, origin) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, reason: 'no-key' };
  const from = env.FROM_EMAIL || 'noreply@email.lblb.eu';
  const link = origin + '/verify?token=' + token;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: '论坛 <' + from + '>',
        to: email,
        subject: '请验证你的论坛邮箱',
        html: '<p>你好 ' + escapeHtml(name) + '，</p><p>点击下面的链接验证你的邮箱：</p><p><a href="' + link + '">验证邮箱</a></p><p>链接 24 小时内有效。如果不是你本人操作，请忽略。</p>'
      })
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { sent: false, reason: 'resend-' + r.status, detail: t.slice(0, 200) };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: 'network' };
  }
}
async function ensureSeed(env) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS c FROM boards').first();
  if (r && r.c === 0) {
    await env.DB.prepare("INSERT INTO boards (name, descr, sort) VALUES ('综合讨论','随便聊聊',1)").run();
    await env.DB.prepare("INSERT INTO boards (name, descr, sort) VALUES ('站务公告','管理员发布',2)").run();
  }
}
/* ---------- v1.3 helpers ---------- */
function getClientIp(req) {
  return req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown';
}
async function checkRateLimit(env, key, limit, windowMs) {
  const now = Date.now();
  const row = await env.DB.prepare('SELECT * FROM rate_limits WHERE key=?').bind(key).first();
  if (!row || now - row.window_start > windowMs) {
    await env.DB.prepare('INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?,?,?)').bind(key, 1, now).run();
    return true;
  }
  if (row.count >= limit) return false;
  await env.DB.prepare('UPDATE rate_limits SET count=count+1 WHERE key=?').bind(key).run();
  return true;
}
function parseMentions(content) {
  const names = new Set();
  const re = /@([a-zA-Z0-9_\u4e00-\u9fa5]{2,16})/g;
  let m;
  while ((m = re.exec(content)) && names.size < 10) names.add(m[1]);
  return [...names];
}
async function notifyMentions(env, content, fromUserId, threadId, postId) {
  const names = parseMentions(content).filter(n => n);
  if (!names.length) return;
  const now = Date.now();
  const batch = [];
  for (const name of names) {
    const u = await env.DB.prepare('SELECT id FROM users WHERE name=?').bind(name).first();
    if (u && u.id !== fromUserId) {
      batch.push(env.DB.prepare(
        'INSERT INTO notifications (user_id, type, from_user_id, thread_id, post_id, created_at) VALUES (?,?,?,?,?,?)'
      ).bind(u.id, 'mention', fromUserId, threadId, postId, now));
    }
  }
  if (batch.length) await env.DB.batch(batch);
}
function sanitizeFts(q) {
  return q.split(/\s+/).filter(Boolean).slice(0, 5)
    .map(t => '"' + t.replace(/"/g, '""') + '"').join(' AND ');
}
/* Turnstile 人机验证：未配置 TURNSTILE_SECRET 时跳过 */
async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip || '' }),
    });
    const j = await r.json();
    return !!j.success;
  } catch (e) { return false; }
}
/* 管理操作日志 */
async function adminLog(env, me, action, target_type, target_id, detail) {
  try {
    await env.DB.prepare(
      'INSERT INTO admin_logs (admin_id, admin_name, action, target_type, target_id, detail, created_at) VALUES (?,?,?,?,?,?,?)'
    ).bind(me.id, me.name, action, target_type || null, target_id || null, detail || null, Date.now()).run();
  } catch (e) {}
}
/* 内容权限块：[hide]回复可见 [level=N]等级可见 [admin]仅管理员 */
function processContentBlocks(content, opts) {
  // opts: { isAuthor, isAdmin, hasReplied, userScore }
  content = content.replace(/\[hide\]([\s\S]*?)\[\/hide\]/gi, (m, inner) => {
    if (opts.isAuthor || opts.isAdmin || opts.hasReplied) return '{{SHOW}}' + inner + '{{/SHOW}}';
    return '{{HIDE}}';
  });
  content = content.replace(/\[level=(\d+)\]([\s\S]*?)\[\/level\]/gi, (m, n, inner) => {
    if (opts.isAuthor || opts.isAdmin || opts.userScore >= Number(n)) return '{{SHOW}}' + inner + '{{/SHOW}}';
    return '{{LEVEL:' + n + '}}';
  });
  content = content.replace(/\[admin\]([\s\S]*?)\[\/admin\]/gi, (m, inner) => {
    if (opts.isAdmin) return '{{SHOW}}' + inner + '{{/SHOW}}';
    return '{{ADMIN}}';
  });
  return content;
}
async function readBody(req) {
  try { return await req.json(); } catch (e) { return {}; }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    // ---------- sitemap ----------
    if (path === '/sitemap.xml' && method === 'GET') {
      const origin = new URL(req.url).origin;
      const { results: boards } = await env.DB.prepare('SELECT id FROM boards ORDER BY sort').all().catch(()=>({results:[]}));
      const { results: threads } = await env.DB.prepare('SELECT id, updated_at FROM threads ORDER BY updated_at DESC LIMIT 500').all().catch(()=>({results:[]}));
      let xml = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
      xml += '<url><loc>'+origin+'/</loc><changefreq>hourly</changefreq></url>';
      xml += '<url><loc>'+origin+'/tools</loc><changefreq>daily</changefreq></url>';
      xml += '<url><loc>'+origin+'/tools/quiz</loc><changefreq>weekly</changefreq></url>';
      xml += '<url><loc>'+origin+'/tools/explain</loc><changefreq>weekly</changefreq></url>';
      xml += '<url><loc>'+origin+'/tools/diff</loc><changefreq>weekly</changefreq></url>';
      xml += '<url><loc>'+origin+'/tools/distro</loc><changefreq>weekly</changefreq></url>';
      xml += '<url><loc>'+origin+'/tools/shellcheck</loc><changefreq>weekly</changefreq></url>';
      xml += '<url><loc>'+origin+'/rankings</loc><changefreq>daily</changefreq></url>';
      xml += '<url><loc>'+origin+'/shop</loc><changefreq>daily</changefreq></url>';
      boards.forEach(b=>{ xml += '<url><loc>'+origin+'/b/'+b.id+'</loc><changefreq>hourly</changefreq></url>'; });
      threads.forEach(t=>{
        xml += '<url><loc>'+origin+'/t/'+t.id+'</loc><lastmod>'+new Date(t.updated_at).toISOString()+'</lastmod><changefreq>daily</changefreq></url>';
      });
      xml += '</urlset>';
      return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
    }

    // 前端页面（History API 路由：所有非 /api/ 路径都返回 SPA）
    if (path === '/' || !path.startsWith('/api/')) {
      return new Response(APP_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    await ensureSeed(env);
    const me = await currentUser(req, env);
    const body = (method === 'POST' || method === 'PUT' || method === 'DELETE') ? await readBody(req) : {};
    const seg = path.slice(5).split('/').filter(Boolean); // 去掉 /api/

    try {
      // ---------- 忘记密码 ----------
      if (seg[0] === 'forgot-password' && method === 'POST') {
        const email = String(body.email || '').trim().toLowerCase();
        if (!email) return json({ error: '请填写邮箱' }, 400);
        const u = await env.DB.prepare('SELECT id, name, email FROM users WHERE email=?').bind(email).first();
        // 不透露邮箱是否存在，统一返回成功
        if (u && env.RESEND_API_KEY) {
          await env.DB.prepare('DELETE FROM password_resets WHERE user_id=?').bind(u.id).run();
          const token = randHex(32);
          await env.DB.prepare('INSERT INTO password_resets (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
            .bind(token, u.id, Date.now(), Date.now() + 3600 * 1000).run();
          const link = new URL(req.url).origin + '/reset?token=' + token;
          const from = env.FROM_EMAIL || 'noreply@email.lblb.eu';
          try {
            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: '论坛 <' + from + '>',
                to: u.email,
                subject: '重置你的论坛密码',
                html: '<p>你好 ' + escapeHtml(u.name) + '，</p><p>点击下面的链接重置密码：</p><p><a href="' + link + '">重置密码</a></p><p>链接 1 小时内有效。如果不是你本人操作，请忽略。</p>'
              })
            });
          } catch (e) {}
        }
        return json({ ok: true });
      }
      if (seg[0] === 'reset-password' && method === 'POST') {
        const token = String(body.token || '');
        const newPass = String(body.new_password || '');
        if (newPass.length < 4 || newPass.length > 64) return json({ error: '新密码需 4-64 位' }, 400);
        const pr = await env.DB.prepare('SELECT * FROM password_resets WHERE token=?').bind(token).first();
        if (!pr || pr.expires_at < Date.now()) return json({ error: '链接无效或已过期' }, 400);
        const ph = await makePassHash(newPass);
        await env.DB.batch([
          env.DB.prepare('UPDATE users SET pass_hash=?, salt=? WHERE id=?').bind(ph.hash, ph.salt, pr.user_id),
          env.DB.prepare('DELETE FROM password_resets WHERE user_id=?').bind(pr.user_id),
          env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(pr.user_id),
        ]);
        return json({ ok: true });
      }

      // ---------- 认证 ----------
      if (seg[0] === 'register' && method === 'POST') {
        if (!(await verifyTurnstile(env, body.turnstile_token, getClientIp(req)))) {
          return json({ error: '人机验证未通过，请重试' }, 403);
        }
        const ip = getClientIp(req);
        if (!await checkRateLimit(env, 'reg:' + ip, 5, 3600 * 1000)) {
          return json({ error: '注册太频繁，请 1 小时后再试' }, 429);
        }
        const name = String(body.name || '').trim();
        const password = String(body.password || '');
        const email = String(body.email || '').trim().toLowerCase();
        if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,16}$/.test(name)) return json({ error: '用户名需 2-16 位：中文/字母/数字/下划线' }, 400);
        if (password.length < 4 || password.length > 64) return json({ error: '密码需 4-64 位' }, 400);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: '邮箱格式不正确' }, 400);
        const exists = await env.DB.prepare('SELECT id FROM users WHERE name=?').bind(name).first();
        if (exists) return json({ error: '用户名已被占用' }, 400);
        const emailExists = await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
        if (emailExists) return json({ error: '该邮箱已注册' }, 400);
        const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first();
        const ph = await makePassHash(password);
        const hash = ph.hash; const salt = ph.salt;
        const isAdmin = count.c === 0 ? 1 : 0;
        const r = await env.DB.prepare(
          'INSERT INTO users (name, pass_hash, salt, is_admin, email, verified, created_at) VALUES (?,?,?,?,?,?,?)'
        ).bind(name, hash, salt, isAdmin, email, 0, Date.now()).run();
        const uid = r.meta.last_row_id;
        // 发验证邮件（未配置邮件服务时直接通过，避免锁死）
        let mailSent = false, mailError = null;
        if (env.RESEND_API_KEY) {
          const token = randHex(32);
          await env.DB.prepare('INSERT INTO verify_tokens (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
            .bind(token, uid, Date.now(), Date.now() + 24 * 3600 * 1000).run();
          const origin = new URL(req.url).origin;
          const ms = await sendVerificationEmail(env, email, name, token, origin);
          mailSent = ms.sent;
          if (!ms.sent) mailError = ms.reason + (ms.detail ? ': ' + ms.detail : '');
        } else {
          await env.DB.prepare('UPDATE users SET verified=1 WHERE id=?').bind(uid).run();
          mailSent = true;
        }
        const token = randHex(32);
        await env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)')
          .bind(token, uid, Date.now() + 30 * 86400 * 1000).run();
        return json({ ok: true, mailSent, mailError, user: { id: uid, name, is_admin: isAdmin, verified: !env.RESEND_API_KEY } },
          200, { 'Set-Cookie': sessionCookie(token, 2592000) });
      }
      if (seg[0] === 'login' && method === 'POST') {
        if (!(await verifyTurnstile(env, body.turnstile_token, getClientIp(req)))) {
          return json({ error: '人机验证未通过，请重试' }, 403);
        }
        const name = String(body.name || '').trim();
        const password = String(body.password || '');
        const u = await env.DB.prepare('SELECT * FROM users WHERE name=?').bind(name).first();
        if (!u || !(await checkPass(password, u))) {
          return json({ error: '用户名或密码错误' }, 401);
        }
        // 老格式密码自动升级为 PBKDF2
        if (!u.pass_hash.startsWith('pbkdf2$')) {
          const up = await makePassHash(password);
          await env.DB.prepare('UPDATE users SET pass_hash=?, salt=? WHERE id=?').bind(up.hash, up.salt, u.id).run();
        }
        const token = randHex(32);
        await env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)')
          .bind(token, u.id, Date.now() + 30 * 86400 * 1000).run();
        return json({ ok: true, user: { id: u.id, name: u.name, is_admin: u.is_admin } },
          200, { 'Set-Cookie': sessionCookie(token, 2592000) });
      }
      if (seg[0] === 'logout' && method === 'POST') {
        const token = getCookie(req, 'sid');
        if (token) await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(token).run();
        return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('deleted', 0) });
      }
      if (seg[0] === 'me' && method === 'GET') {
        return json({ user: me ? { id: me.id, name: me.name, is_admin: me.is_admin, email: me.email, verified: me.verified, avatar_url: me.avatar_url, bio: me.bio, points: me.points, custom_title: me.custom_title, avatar_frame: me.avatar_frame } : null });
      }
      // ---------- 积分明细 ----------
      if (seg[0] === 'point-logs' && method === 'GET') {
        if (!me) return json({ error: '请先登录' }, 401);
        const { results } = await env.DB.prepare(
          'SELECT * FROM point_logs WHERE user_id=? ORDER BY created_at DESC LIMIT 50'
        ).bind(me.id).all().catch(() => ({ results: [] }));
        return json({ logs: results });
      }
      // ---------- 排行榜 ----------
      // GET /api/rankings?type=points|threads|replies|activity&period=week|month|all
      if (seg[0] === 'rankings' && method === 'GET') {
        const type = url.searchParams.get('type') || 'points';
        const period = url.searchParams.get('period') || 'all';
        const now = Date.now();
        let since = 0;
        if (period === 'week') since = now - 7 * 86400000;
        else if (period === 'month') since = now - 30 * 86400000;
        let results = [];
        try {
          if (type === 'points') {
            if (period === 'all') {
              const r = await env.DB.prepare(
                'SELECT id, name, avatar_url, points, custom_title FROM users ORDER BY points DESC LIMIT 20'
              ).all();
              results = r.results.map(u => ({ ...u, score: u.points }));
            } else {
              const r = await env.DB.prepare(
                `SELECT u.id, u.name, u.avatar_url, u.custom_title, COALESCE(SUM(pl.points),0) AS score
                 FROM users u LEFT JOIN point_logs pl ON pl.user_id=u.id AND pl.created_at>=?
                 GROUP BY u.id HAVING score != 0 ORDER BY score DESC LIMIT 20`
              ).bind(since).all();
              results = r.results;
            }
          } else if (type === 'threads') {
            const r = await env.DB.prepare(
              `SELECT u.id, u.name, u.avatar_url, u.custom_title, COUNT(t.id) AS score
               FROM users u JOIN threads t ON t.user_id=u.id${since ? ' AND t.created_at>=' + since : ''}
               GROUP BY u.id ORDER BY score DESC LIMIT 20`
            ).all();
            results = r.results;
          } else if (type === 'replies') {
            // 回帖数 = posts 数 - threads 数（排除每个主题的首帖）
            const r = await env.DB.prepare(
              `SELECT u.id, u.name, u.avatar_url, u.custom_title,
                      (SELECT COUNT(*) FROM posts p WHERE p.user_id=u.id${since ? ' AND p.created_at>=' + since : ''}) -
                      (SELECT COUNT(*) FROM threads t WHERE t.user_id=u.id${since ? ' AND t.created_at>=' + since : ''}) AS score
               FROM users u ORDER BY score DESC LIMIT 20`
            ).all();
            results = r.results.filter(u => u.score > 0);
          } else if (type === 'activity') {
            // 活跃度 = 发帖*5 + 回帖*2 + 签到次数*3
            const r = await env.DB.prepare(
              `SELECT u.id, u.name, u.avatar_url, u.custom_title,
                      (SELECT COUNT(*) FROM threads t WHERE t.user_id=u.id${since ? ' AND t.created_at>=' + since : ''}) * 5 +
                      ((SELECT COUNT(*) FROM posts p WHERE p.user_id=u.id${since ? ' AND p.created_at>=' + since : ''}) -
                       (SELECT COUNT(*) FROM threads t2 WHERE t2.user_id=u.id${since ? ' AND t2.created_at>=' + since : ''})) * 2 +
                      (SELECT COUNT(*) FROM checkins c WHERE c.user_id=u.id${since ? ' AND c.created_at>=' + since : ''}) * 3 AS score
               FROM users u ORDER BY score DESC LIMIT 20`
            ).all();
            results = r.results.filter(u => u.score > 0);
          }
        } catch (e) { results = []; }
        return json({ rankings: results, type, period });
      }
      // ---------- 积分商城 ----------
      // GET /api/shop/items 商品列表
      if (seg[0] === 'shop' && seg[1] === 'items' && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM shop_items ORDER BY sort'
        ).all().catch(() => ({ results: [] }));
        // 卡密商品附带库存
        for (const it of results) {
          if (it.item_type === 'card') {
            const s = await env.DB.prepare(
              'SELECT COUNT(*) AS n FROM card_codes WHERE item_id=? AND used_by IS NULL'
            ).bind(it.id).first().catch(()=>({n:0}));
            it.stock = s.n;
          }
          try { it.params = JSON.parse(it.params || '{}'); } catch(e){ it.params = {}; }
        }
        return json({ items: results });
      }
      // POST /api/shop/buy 购买 {item_id}
      if (seg[0] === 'shop' && seg[1] === 'buy' && method === 'POST') {
        if (!me) return json({ error: '请先登录' }, 401);
        const itemId = Number(body.item_id);
        const item = await env.DB.prepare('SELECT * FROM shop_items WHERE id=?').bind(itemId).first();
        if (!item) return json({ error: '商品不存在' }, 404);
        const u = await env.DB.prepare('SELECT points FROM users WHERE id=?').bind(me.id).first();
        if ((u.points || 0) < item.price) return json({ error: '积分不足' }, 400);
        const now = Date.now();
        let extra = null;
        // 卡密商品：分配一个未使用的码
        if (item.item_type === 'card') {
          const code = await env.DB.prepare(
            'SELECT id, code FROM card_codes WHERE item_id=? AND used_by IS NULL LIMIT 1'
          ).bind(itemId).first();
          if (!code) return json({ error: '该商品已售罄' }, 400);
          await env.DB.prepare('UPDATE card_codes SET used_by=?, used_at=? WHERE id=? AND used_by IS NULL')
            .bind(me.id, now, code.id).run();
          // 确认抢到（防并发）
          const check = await env.DB.prepare('SELECT used_by FROM card_codes WHERE id=?').bind(code.id).first();
          if (check.used_by !== me.id) return json({ error: '手慢了，刚被抢完' }, 400);
          extra = code.code;
        }
        await env.DB.prepare('UPDATE users SET points = points - ? WHERE id=?').bind(item.price, me.id).run();
        await env.DB.prepare('INSERT INTO point_logs (user_id, points, reason, related_id, created_at) VALUES (?,?,?,?,?)')
          .bind(me.id, -item.price, '兑换商品：' + item.name, itemId, now).run().catch(()=>{});
        const r = await env.DB.prepare(
          'INSERT INTO user_items (user_id, item_id, extra, created_at) VALUES (?,?,?,?)'
        ).bind(me.id, itemId, extra, now).run();
        return json({ ok: true, user_item_id: r.meta.last_row_id, code: extra });
      }
      // GET /api/shop/my-items 我的物品
      if (seg[0] === 'shop' && seg[1] === 'my-items' && method === 'GET') {
        if (!me) return json({ error: '请先登录' }, 401);
        const { results } = await env.DB.prepare(
          `SELECT ui.*, si.name, si.descr, si.icon, si.item_type, si.params FROM user_items ui
           JOIN shop_items si ON si.id=ui.item_id WHERE ui.user_id=? ORDER BY ui.created_at DESC`
        ).bind(me.id).all().catch(() => ({ results: [] }));
        return json({ items: results });
      }
      // POST /api/shop/use 使用道具 {user_item_id, extra?, thread_id?}
      if (seg[0] === 'shop' && seg[1] === 'use' && method === 'POST') {
        if (!me) return json({ error: '请先登录' }, 401);
        const uiId = Number(body.user_item_id);
        const ui = await env.DB.prepare(
          `SELECT ui.*, si.item_type, si.name, si.params FROM user_items ui JOIN shop_items si ON si.id=ui.item_id
           WHERE ui.id=? AND ui.user_id=?`
        ).bind(uiId, me.id).first();
        if (!ui) return json({ error: '物品不存在' }, 404);
        if (ui.used) return json({ error: '已使用过' }, 400);
        const now = Date.now();
        const extra = String(body.extra || '').trim().slice(0, 20);
        if (ui.item_type === 'rename_card') {
          if (!extra) return json({ error: '请填写新用户名' }, 400);
          // 30天内限用1次
          const lastRename = await env.DB.prepare(
            `SELECT used_at FROM user_items ui JOIN shop_items si ON si.id=ui.item_id
             WHERE ui.user_id=? AND si.item_type='rename_card' AND ui.used=1 ORDER BY ui.used_at DESC LIMIT 1`
          ).bind(me.id).first();
          if (lastRename && now - lastRename.used_at < 30 * 86400000) {
            const daysLeft = Math.ceil((30 * 86400000 - (now - lastRename.used_at)) / 86400000);
            return json({ error: '改名卡30天内限用1次，还需等待 ' + daysLeft + ' 天' }, 400);
          }
          const exists = await env.DB.prepare('SELECT 1 FROM users WHERE name=?').bind(extra).first();
          if (exists) return json({ error: '用户名已存在' }, 400);
          await env.DB.prepare('UPDATE users SET name=? WHERE id=?').bind(extra, me.id).run();
        } else if (ui.item_type === 'avatar_frame') {
          await env.DB.prepare('UPDATE users SET avatar_frame=1 WHERE id=?').bind(me.id).run();
        } else if (ui.item_type === 'custom_title') {
          if (!extra) return json({ error: '请填写头衔' }, 400);
          await env.DB.prepare('UPDATE users SET custom_title=? WHERE id=?').bind(extra, me.id).run();
        } else if (ui.item_type === 'pin_card') {
          const threadId = Number(body.thread_id);
          if (!threadId) return json({ error: '请选择要置顶的帖子' }, 400);
          const t = await env.DB.prepare('SELECT id FROM threads WHERE id=? AND user_id=?').bind(threadId, me.id).first();
          if (!t) return json({ error: '只能置顶自己的帖子' }, 403);
          // 时长从商品 params 读，默认24小时
          let hours = 24;
          try { const p = JSON.parse(ui.params || '{}'); if (p.duration_hours) hours = Math.max(1, Math.min(720, Number(p.duration_hours))); } catch(e){}
          await env.DB.prepare('UPDATE threads SET pinned=1, pinned_until=? WHERE id=?')
            .bind(now + hours * 3600 * 1000, threadId).run();
        } else if (ui.item_type === 'card') {
          return json({ error: '卡密商品无需使用，兑换码已在我的物品中' }, 400);
        } else {
          return json({ error: '未知道具类型' }, 400);
        }
        await env.DB.prepare('UPDATE user_items SET used=1, used_at=?, extra=? WHERE id=?')
          .bind(now, extra || null, uiId).run();
        return json({ ok: true });
      }
      // ---------- 积分转增 ----------
      // POST /api/points/transfer {to_user_id, amount}
      if (seg[0] === 'points' && seg[1] === 'transfer' && method === 'POST') {
        if (!me) return json({ error: '请先登录' }, 401);
        const toId = Number(body.to_user_id);
        const amount = Math.floor(Number(body.amount));
        if (!toId || toId === me.id) return json({ error: '参数错误' }, 400);
        if (!amount || amount < 1) return json({ error: '转增数量至少 1 分' }, 400);
        if (amount > 1000) return json({ error: '单次最多转增 1000 分' }, 400);
        const target = await env.DB.prepare('SELECT id, name FROM users WHERE id=?').bind(toId).first();
        if (!target) return json({ error: '用户不存在' }, 404);
        const u = await env.DB.prepare('SELECT points FROM users WHERE id=?').bind(me.id).first();
        if ((u.points || 0) < amount) return json({ error: '积分不足' }, 400);
        const now = Date.now();
        await env.DB.prepare('UPDATE users SET points = points - ? WHERE id=?').bind(amount, me.id).run();
        await env.DB.prepare('UPDATE users SET points = points + ? WHERE id=?').bind(amount, toId).run();
        await env.DB.prepare('INSERT INTO point_logs (user_id, points, reason, related_id, created_at) VALUES (?,?,?,?,?)')
          .bind(me.id, -amount, '转增给 ' + target.name, toId, now).run().catch(()=>{});
        await env.DB.prepare('INSERT INTO point_logs (user_id, points, reason, related_id, created_at) VALUES (?,?,?,?,?)')
          .bind(toId, amount, '收到 ' + me.name + ' 转增', me.id, now).run().catch(()=>{});
        return json({ ok: true });
      }
      // ---------- 管理员手动调积分 ----------
      // POST /api/admin/users/:id/points {points, reason}
      if (seg[0] === 'admin' && seg[1] === 'users' && seg[3] === 'points' && method === 'POST') {
        const deny = requireAdmin(me); if (deny) return deny;
        const uid = Number(seg[2]);
        const points = Math.floor(Number(body.points));
        const reason = String(body.reason || '管理员调整').trim().slice(0, 50) || '管理员调整';
        if (!uid || !points) return json({ error: '参数错误' }, 400);
        if (Math.abs(points) > 10000) return json({ error: '单次最多调整 10000 分' }, 400);
        const target = await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(uid).first();
        if (!target) return json({ error: '用户不存在' }, 404);
        await env.DB.prepare('UPDATE users SET points = points + ? WHERE id=?').bind(points, uid).run();
        await env.DB.prepare('INSERT INTO point_logs (user_id, points, reason, created_at) VALUES (?,?,?,?)')
          .bind(uid, points, reason, Date.now()).run().catch(()=>{});
        await adminLog(env, me, '调整积分 ' + (points > 0 ? '+' : '') + points, 'user', uid, null);
        return json({ ok: true });
      }
      // ---------- 广告 & 友链（前台） ----------
      // GET /api/ads 按位置返回启用的广告
      if (seg[0] === 'ads' && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM ads WHERE enabled=1 ORDER BY position, sort'
        ).all().catch(() => ({ results: [] }));
        const grouped = {};
        results.forEach(a => {
          if (!grouped[a.position]) grouped[a.position] = [];
          grouped[a.position].push(a);
        });
        return json({ ads: grouped });
      }
      // POST /api/ads/:id/click 点击统计
      if (seg[0] === 'ads' && seg[2] === 'click' && method === 'POST') {
        const id = Number(seg[1]);
        await env.DB.prepare('UPDATE ads SET clicks=clicks+1 WHERE id=?').bind(id).run().catch(()=>{});
        return json({ ok: true });
      }
      // GET /api/friend-links
      if (seg[0] === 'friend-links' && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM friend_links ORDER BY sort'
        ).all().catch(() => ({ results: [] }));
        return json({ links: results });
      }
      // ---------- 广告 & 友链（后台管理） ----------
      if (seg[0] === 'admin' && seg[1] === 'ads' && method === 'GET') {
        const deny = requireAdmin(me); if (deny) return deny;
        const { results } = await env.DB.prepare('SELECT * FROM ads ORDER BY position, sort').all();
        return json({ ads: results });
      }
      if (seg[0] === 'admin' && seg[1] === 'ads' && method === 'POST') {
        const deny = requireAdmin(me); if (deny) return deny;
        const title = String(body.title || '').trim().slice(0, 50);
        const url = String(body.url || '').trim().slice(0, 500);
        const img_url = String(body.img_url || '').trim().slice(0, 500);
        const position = String(body.position || '');
        const sort = Number(body.sort) || 99;
        if (!title || !url || !position) return json({ error: '参数不完整' }, 400);
        const r = await env.DB.prepare(
          'INSERT INTO ads (title, url, img_url, position, sort, created_at) VALUES (?,?,?,?,?,?)'
        ).bind(title, url, img_url || null, position, sort, Date.now()).run();
        await adminLog(env, me, '添加广告', 'ad', r.meta.last_row_id, null);
        return json({ ok: true, id: r.meta.last_row_id });
      }
      if (seg[0] === 'admin' && seg[1] === 'ads' && seg.length === 3 && method === 'PUT') {
        const deny = requireAdmin(me); if (deny) return deny;
        const id = Number(seg[2]);
        // 支持部分更新：只更新提供的字段
        if (body.enabled !== undefined && Object.keys(body).length === 1) {
          await env.DB.prepare('UPDATE ads SET enabled=? WHERE id=?').bind(body.enabled ? 1 : 0, id).run();
          return json({ ok: true });
        }
        const { title, url, img_url, position, sort, enabled } = body;
        await env.DB.prepare(
          'UPDATE ads SET title=?, url=?, img_url=?, position=?, sort=?, enabled=? WHERE id=?'
        ).bind(String(title||'').slice(0,50), String(url||'').slice(0,500), String(img_url||'').slice(0,500) || null,
               String(position||''), Number(sort)||99, enabled ? 1 : 0, id).run();
        return json({ ok: true });
      }
      if (seg[0] === 'admin' && seg[1] === 'ads' && seg.length === 3 && method === 'DELETE') {
        const deny = requireAdmin(me); if (deny) return deny;
        await env.DB.prepare('DELETE FROM ads WHERE id=?').bind(Number(seg[2])).run();
        return json({ ok: true });
      }
      // GET /api/admin/shop/items 商品管理列表（含禁用）
      if (seg[0] === 'admin' && seg[1] === 'shop' && seg[2] === 'items' && method === 'GET') {
        const deny = requireAdmin(me); if (deny) return deny;
        const { results } = await env.DB.prepare('SELECT * FROM shop_items ORDER BY sort').all();
        for (const it of results) {
          if (it.item_type === 'card') {
            const s = await env.DB.prepare(
              'SELECT COUNT(*) AS n FROM card_codes WHERE item_id=? AND used_by IS NULL'
            ).bind(it.id).first().catch(()=>({n:0}));
            it.stock = s.n;
          }
        }
        return json({ items: results });
      }
      // POST /api/admin/shop/items 新增商品
      if (seg[0] === 'admin' && seg[1] === 'shop' && seg[2] === 'items' && method === 'POST') {
        const deny = requireAdmin(me); if (deny) return deny;
        const { name, descr, price, icon, item_type, sort, params, codes, usage } = body;
        if (!name || !price || !item_type) return json({ error: '名称、价格、类型必填' }, 400);
        if (!['pin_card', 'rename_card', 'avatar_frame', 'custom_title', 'card'].includes(item_type)) return json({ error: '类型无效' }, 400);
        const paramsStr = JSON.stringify(params || {});
        const r = await env.DB.prepare(
          'INSERT INTO shop_items (name, descr, usage, price, icon, item_type, sort, params, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
        ).bind(name, descr || '', usage || '', Math.max(1, Number(price) | 0), icon || '🎁', item_type, Number(sort) || 99, paramsStr, Date.now()).run();
        const newId = r.meta.last_row_id;
        // 卡密商品：批量导入兑换码
        if (item_type === 'card' && Array.isArray(codes) && codes.length) {
          const now = Date.now();
          const uniq = [...new Set(codes.map(c => String(c).trim()).filter(Boolean))];
          for (const c of uniq) {
            await env.DB.prepare('INSERT INTO card_codes (item_id, code, created_at) VALUES (?,?,?)')
              .bind(newId, c, now).run().catch(()=>{});
          }
        }
        adminLog(env, me.id, '新增商品：' + name);
        return json({ ok: true, id: newId });
      }
      // PUT /api/admin/shop/items/:id 更新商品
      if (seg[0] === 'admin' && seg[1] === 'shop' && seg[2] === 'items' && seg.length === 4 && method === 'PUT') {
        const deny = requireAdmin(me); if (deny) return deny;
        const id = Number(seg[3]);
        const { name, descr, price, icon, sort, params, usage } = body;
        const sets = [], vals = [];
        if (name !== undefined) { sets.push('name=?'); vals.push(name); }
        if (descr !== undefined) { sets.push('descr=?'); vals.push(descr); }
        if (usage !== undefined) { sets.push('usage=?'); vals.push(usage); }
        if (price !== undefined) { sets.push('price=?'); vals.push(Math.max(1, Number(price) | 0)); }
        if (icon !== undefined) { sets.push('icon=?'); vals.push(icon); }
        if (sort !== undefined) { sets.push('sort=?'); vals.push(Number(sort) || 99); }
        if (params !== undefined) { sets.push('params=?'); vals.push(JSON.stringify(params)); }
        if (!sets.length) return json({ error: '无更新内容' }, 400);
        vals.push(id);
        await env.DB.prepare('UPDATE shop_items SET ' + sets.join(',') + ' WHERE id=?').bind(...vals).run();
        adminLog(env, me.id, '更新商品ID：' + id);
        return json({ ok: true });
      }
      // GET /api/admin/shop/items/:id/codes 查看卡密（管理员）
      if (seg[0] === 'admin' && seg[1] === 'shop' && seg[2] === 'items' && seg[4] === 'codes' && method === 'GET') {
        const deny = requireAdmin(me); if (deny) return deny;
        const id = Number(seg[3]);
        const { results } = await env.DB.prepare(
          'SELECT id, code, used_by, used_at FROM card_codes WHERE item_id=? ORDER BY id'
        ).bind(id).all();
        const stock = await env.DB.prepare(
          'SELECT COUNT(*) AS n FROM card_codes WHERE item_id=? AND used_by IS NULL'
        ).bind(id).first();
        return json({ codes: results, stock: stock.n });
      }
      // POST /api/admin/shop/items/:id/codes 补货卡密 {codes: []}
      if (seg[0] === 'admin' && seg[1] === 'shop' && seg[2] === 'items' && seg[4] === 'codes' && method === 'POST') {
        const deny = requireAdmin(me); if (deny) return deny;
        const id = Number(seg[3]);
        const { codes } = body;
        if (!Array.isArray(codes) || !codes.length) return json({ error: '请提供兑换码' }, 400);
        const now = Date.now();
        let added = 0;
        const uniq = [...new Set(codes.map(c => String(c).trim()).filter(Boolean))];
        for (const c of uniq) {
          const r = await env.DB.prepare('INSERT INTO card_codes (item_id, code, created_at) VALUES (?,?,?)')
            .bind(id, c, now).run().catch(()=>null);
          if (r) added++;
        }
        adminLog(env, me.id, '商品ID ' + id + ' 补货卡密 ' + added + ' 个');
        return json({ ok: true, added });
      }
      // DELETE /api/admin/shop/items/:id 删除商品
      if (seg[0] === 'admin' && seg[1] === 'shop' && seg[2] === 'items' && seg.length === 4 && method === 'DELETE') {
        const deny = requireAdmin(me); if (deny) return deny;
        await env.DB.prepare('DELETE FROM shop_items WHERE id=?').bind(Number(seg[3])).run();
        adminLog(env, me.id, '删除商品ID：' + seg[3]);
        return json({ ok: true });
      }
      if (seg[0] === 'admin' && seg[1] === 'friend-links' && method === 'GET') {
        const deny = requireAdmin(me); if (deny) return deny;
        const { results } = await env.DB.prepare('SELECT * FROM friend_links ORDER BY sort').all();
        return json({ links: results });
      }
      if (seg[0] === 'admin' && seg[1] === 'friend-links' && method === 'POST') {
        const deny = requireAdmin(me); if (deny) return deny;
        const name = String(body.name || '').trim().slice(0, 30);
        const url = String(body.url || '').trim().slice(0, 500);
        const descr = String(body.descr || '').trim().slice(0, 100);
        if (!name || !url) return json({ error: '参数不完整' }, 400);
        const r = await env.DB.prepare(
          'INSERT INTO friend_links (name, url, descr, sort, created_at) VALUES (?,?,?,?,?)'
        ).bind(name, url, descr || null, Number(body.sort)||99, Date.now()).run();
        return json({ ok: true, id: r.meta.last_row_id });
      }
      if (seg[0] === 'admin' && seg[1] === 'friend-links' && seg.length === 3 && method === 'DELETE') {
        const deny = requireAdmin(me); if (deny) return deny;
        await env.DB.prepare('DELETE FROM friend_links WHERE id=?').bind(Number(seg[2])).run();
        return json({ ok: true });
      }
      // ---------- 个人资料设置 ----------
      if (seg[0] === 'me' && method === 'PUT') {
        if (!me) return json({ error: '请先登录' }, 401);
        const avatar_url = String(body.avatar_url || '').trim().slice(0, 500);
        const bio = String(body.bio || '').trim().slice(0, 200);
        if (avatar_url && !/^https?:\/\//.test(avatar_url)) return json({ error: '头像必须是 http(s) 链接' }, 400);
        const badBio = await checkSensitive(env, bio);
        if (badBio) return json({ error: '简介包含敏感词，请修改后重试' }, 400);
        await env.DB.prepare('UPDATE users SET avatar_url=?, bio=? WHERE id=?').bind(avatar_url, bio, me.id).run();
        return json({ ok: true });
      }
      if (seg[0] === 'me' && seg[1] === 'password' && method === 'PUT') {
        if (!me) return json({ error: '请先登录' }, 401);
        const oldPass = String(body.old_password || '');
        const newPass = String(body.new_password || '');
        const u = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(me.id).first();
        if (!(await checkPass(oldPass, u))) return json({ error: '原密码错误' }, 400);
        if (newPass.length < 4 || newPass.length > 64) return json({ error: '新密码需 4-64 位' }, 400);
        const salt = randHex(16);
        const ph2 = await makePassHash(newPass);
        await env.DB.prepare('UPDATE users SET pass_hash=?, salt=? WHERE id=?').bind(ph2.hash, ph2.salt, me.id).run();
        return json({ ok: true });
      }
      if (seg[0] === 'me' && seg[1] === 'email' && method === 'PUT') {
        if (!me) return json({ error: '请先登录' }, 401);
        const email = String(body.email || '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: '邮箱格式不正确' }, 400);
        const ex = await env.DB.prepare('SELECT id FROM users WHERE email=? AND id<>?').bind(email, me.id).first();
        if (ex) return json({ error: '该邮箱已被使用' }, 400);
        await env.DB.prepare('UPDATE users SET email=?, verified=0 WHERE id=?').bind(email, me.id).run();
        // 换邮箱后重新发送验证邮件
        let mailSent = false;
        if (env.RESEND_API_KEY) {
          await env.DB.prepare('DELETE FROM verify_tokens WHERE user_id=?').bind(me.id).run();
          const token = randHex(32);
          await env.DB.prepare('INSERT INTO verify_tokens (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
            .bind(token, me.id, Date.now(), Date.now() + 24 * 3600 * 1000).run();
          const ms = await sendVerificationEmail(env, email, me.name, token, new URL(req.url).origin);
          mailSent = ms.sent;
        } else {
          await env.DB.prepare('UPDATE users SET verified=1 WHERE id=?').bind(me.id).run();
          mailSent = true;
        }
        return json({ ok: true, mailSent });
      }
      if (seg[0] === 'verify' && method === 'GET') {
        const token = url.searchParams.get('token') || '';
        const vt = await env.DB.prepare('SELECT * FROM verify_tokens WHERE token=?').bind(token).first();
        if (!vt || vt.expires_at < Date.now()) return json({ error: '链接无效或已过期，请重新发送验证邮件' }, 400);
        await env.DB.batch([
          env.DB.prepare('UPDATE users SET verified=1 WHERE id=?').bind(vt.user_id),
          env.DB.prepare('DELETE FROM verify_tokens WHERE user_id=?').bind(vt.user_id),
        ]);
        return json({ ok: true });
      }
      // ---------- 每日签到 ----------
      if (seg[0] === 'checkin' && method === 'POST') {
        if (!me) return json({ error: '请先登录' }, 401);
        const today = beijingDate();
        const existing = await env.DB.prepare('SELECT * FROM checkins WHERE user_id=? AND checkin_date=?').bind(me.id, today).first();
        if (existing) return json({ ok: true, already: true, streak: existing.streak, points: existing.points });
        // 计算连续签到（北京时间）
        const yesterday = beijingDate(Date.now() - 86400000);
        const lastCheckin = await env.DB.prepare('SELECT * FROM checkins WHERE user_id=? ORDER BY checkin_date DESC LIMIT 1').bind(me.id).first();
        let streak = 1;
        if (lastCheckin && lastCheckin.checkin_date === yesterday) {
          streak = lastCheckin.streak + 1;
        }
        // 积分：基础5 + 连续加成（每7天一个周期，最多+5）
        const bonus = Math.min(Math.floor((streak - 1) / 7) * 5 + ((streak - 1) % 7), 10);
        const points = 5 + bonus;
        const now = Date.now();
        await env.DB.prepare('INSERT INTO checkins (user_id, checkin_date, points, streak, created_at) VALUES (?,?,?,?,?)')
          .bind(me.id, today, points, streak, now).run();
        await env.DB.prepare('UPDATE users SET points = points + ?, checkin_streak = ?, last_checkin_date = ? WHERE id = ?')
          .bind(points, streak, today, me.id).run();
        await env.DB.prepare('INSERT INTO point_logs (user_id, points, reason, created_at) VALUES (?,?,?,?)')
          .bind(me.id, points, '每日签到', now).run().catch(()=>{});
        return json({ ok: true, streak, points, bonus });
      }

      // ---------- 签到状态 ----------
      if (seg[0] === 'checkin' && seg[1] === 'status' && method === 'GET') {
        if (!me) return json({ checked: false });
        const today = beijingDate();
        const existing = await env.DB.prepare('SELECT * FROM checkins WHERE user_id=? AND checkin_date=?').bind(me.id, today).first();
        const u = await env.DB.prepare('SELECT points, checkin_streak FROM users WHERE id=?').bind(me.id).first();
        return json({ checked: !!existing, streak: u.checkin_streak || 0, points: u.points || 0 });
      }

      // ---------- 答题积分领取 ----------
      if (seg[0] === 'quiz' && seg[1] === 'claim' && method === 'POST') {
        if (!me) return json({ ok: false, error: '请先登录' }, 401);
        const score = Math.max(0, Math.min(100, parseInt(body.score) || 0));
        const u = await env.DB.prepare('SELECT quiz_claimed, quiz_best_score FROM users WHERE id=?').bind(me.id).first();
        // 更新最高分
        if (score > (u.quiz_best_score || 0)) {
          await env.DB.prepare('UPDATE users SET quiz_best_score=? WHERE id=?').bind(score, me.id).run();
        }
        if (u.quiz_claimed) return json({ ok: true, already: true, points: 0 });
        // 首次完成：按分数给积分（60分以下+5，60-79 +10，80+ +15）
        const award = score >= 80 ? 15 : score >= 60 ? 10 : 5;
        await env.DB.prepare('UPDATE users SET quiz_claimed=1, points=points+? WHERE id=?').bind(award, me.id).run();
        await env.DB.prepare('INSERT INTO point_logs (user_id, points, reason, created_at) VALUES (?,?,?,?)')
          .bind(me.id, award, '段位测试', Date.now()).run().catch(()=>{});
        return json({ ok: true, points: award });
      }

      // ---------- 工具访问记录 ----------
      if (seg[0] === 'tool-visit' && method === 'POST') {
        let tool = String(body.tool || '').slice(0, 50);
        if (!tool) tool = String(url.searchParams.get('tool') || '').slice(0, 50);
        if (!tool) return json({ ok: false });
        await env.DB.prepare('INSERT INTO tool_visits (tool, user_id, created_at) VALUES (?,?,?)')
          .bind(tool, me ? me.id : null, Date.now()).run().catch(() => {});
        return json({ ok: true });
      }

      // ---------- 数据看板（管理员） ----------
      if (seg[0] === 'admin' && seg[1] === 'dashboard' && method === 'GET') {
        if (!me || !me.is_admin) return json({ error: '需要管理员权限' }, 403);
        const day = 86400000;
        const now = Date.now();
        const todayStart = new Date().setHours(0, 0, 0, 0);
        const weekStart = now - 7 * day;
        const stats = {};
        // 用户
        stats.totalUsers = (await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n;
        stats.todayUsers = (await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?').bind(todayStart).first()).n;
        stats.weekUsers = (await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?').bind(weekStart).first()).n;
        // 主题
        stats.totalThreads = (await env.DB.prepare('SELECT COUNT(*) AS n FROM threads').first()).n;
        stats.todayThreads = (await env.DB.prepare('SELECT COUNT(*) AS n FROM threads WHERE created_at >= ?').bind(todayStart).first()).n;
        stats.weekThreads = (await env.DB.prepare('SELECT COUNT(*) AS n FROM threads WHERE created_at >= ?').bind(weekStart).first()).n;
        // 回帖
        stats.totalPosts = (await env.DB.prepare('SELECT COUNT(*) AS n FROM posts').first()).n;
        stats.todayPosts = (await env.DB.prepare('SELECT COUNT(*) AS n FROM posts WHERE created_at >= ?').bind(todayStart).first()).n;
        stats.weekPosts = (await env.DB.prepare('SELECT COUNT(*) AS n FROM posts WHERE created_at >= ?').bind(weekStart).first()).n;
        // 签到
        stats.todayCheckins = (await env.DB.prepare('SELECT COUNT(*) AS n FROM checkins WHERE created_at >= ?').bind(todayStart).first()).n;
        stats.weekCheckins = (await env.DB.prepare('SELECT COUNT(*) AS n FROM checkins WHERE created_at >= ?').bind(weekStart).first()).n;
        // 工具访问（7天）
        const { results: toolStats } = await env.DB.prepare(
          'SELECT tool, COUNT(*) AS n FROM tool_visits WHERE created_at >= ? GROUP BY tool ORDER BY n DESC'
        ).bind(weekStart).all().catch(() => ({ results: [] }));
        stats.toolVisits = toolStats;
        // 7天趋势
        const trend = [];
        for (let i = 6; i >= 0; i--) {
          const dStart = new Date().setHours(0, 0, 0, 0) - i * day;
          const dEnd = dStart + day;
          const u = (await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ?').bind(dStart, dEnd).first()).n;
          const t = (await env.DB.prepare('SELECT COUNT(*) AS n FROM threads WHERE created_at >= ? AND created_at < ?').bind(dStart, dEnd).first()).n;
          const p = (await env.DB.prepare('SELECT COUNT(*) AS n FROM posts WHERE created_at >= ? AND created_at < ?').bind(dStart, dEnd).first()).n;
          trend.push({ date: new Date(dStart).toISOString().slice(5, 10), users: u, threads: t, posts: p });
        }
        stats.trend = trend;
        // 积分排行 Top 10
        const { results: topUsers } = await env.DB.prepare(
          'SELECT id, name, points FROM users ORDER BY points DESC LIMIT 10'
        ).all().catch(() => ({ results: [] }));
        stats.topUsers = topUsers;
        return json(stats);
      }

      if (seg[0] === 'resend-verification' && method === 'POST') {
        if (!me) return json({ error: '请先登录' }, 401);
        if (me.verified) return json({ ok: true, already: true });
        if (!env.RESEND_API_KEY) return json({ error: '邮件服务未配置，请联系管理员' }, 503);
        const recent = await env.DB.prepare('SELECT * FROM verify_tokens WHERE user_id=? AND created_at>?')
          .bind(me.id, Date.now() - 60 * 1000).first();
        if (recent) return json({ error: '发送太频繁，请 1 分钟后再试' }, 429);
        await env.DB.prepare('DELETE FROM verify_tokens WHERE user_id=?').bind(me.id).run();
        const token = randHex(32);
        await env.DB.prepare('INSERT INTO verify_tokens (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
          .bind(token, me.id, Date.now(), Date.now() + 24 * 3600 * 1000).run();
        const origin = new URL(req.url).origin;
        const ms = await sendVerificationEmail(env, me.email, me.name, token, origin);
        if (!ms.sent) return json({ error: '发送失败：' + ms.reason }, 502);
        return json({ ok: true });
      }

      // ---------- 公开统计 ----------
      if (seg[0] === 'stats' && method === 'GET') {
        const day = Date.now() - 86400 * 1000;
        const u = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
        const t = await env.DB.prepare('SELECT COUNT(*) AS n FROM threads').first();
        const p = await env.DB.prepare('SELECT COUNT(*) AS n FROM posts').first();
        const tt = await env.DB.prepare('SELECT COUNT(*) AS n FROM threads WHERE created_at>?').bind(day).first();
        const pt = await env.DB.prepare('SELECT COUNT(*) AS n FROM posts WHERE created_at>?').bind(day).first();
        const ut = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE created_at>?').bind(day).first();
        return json({ users: u.n, threads: t.n, posts: p.n, todayThreads: tt.n, todayPosts: pt.n, todayUsers: ut.n });
      }

      // ---------- 最新主题（跨版块） ----------
      if (seg[0] === 'threads' && seg[1] === 'latest' && method === 'GET') {
        const { results } = await env.DB.prepare(
          `SELECT t.*, u.name AS author, b.name AS board_name,
                  (SELECT u2.name FROM posts p2 JOIN users u2 ON u2.id=p2.user_id WHERE p2.thread_id=t.id ORDER BY p2.id DESC LIMIT 1) AS last_reply_by
           FROM threads t JOIN users u ON u.id=t.user_id JOIN boards b ON b.id=t.board_id
           ORDER BY (t.pinned=1 AND (t.pinned_until IS NULL OR t.pinned_until>?)) DESC, t.updated_at DESC LIMIT 20`
        ).bind(Date.now()).all();
        return json({ threads: results });
      }

      // ---------- 版块 ----------
      if (seg[0] === 'boards' && seg.length === 1 && method === 'GET') {
        const { results } = await env.DB.prepare(
          `SELECT b.*, (SELECT COUNT(*) FROM threads t WHERE t.board_id=b.id) AS thread_count,
                  (SELECT MAX(updated_at) FROM threads t WHERE t.board_id=b.id) AS last_active
           FROM boards b ORDER BY sort, id`
        ).all();
        return json({ boards: results });
      }
      if (seg[0] === 'boards' && seg.length === 1 && method === 'POST') {
        if (!me || !me.is_admin) return json({ error: '需要管理员权限' }, 403);
        const name = String(body.name || '').trim().slice(0, 30);
        const descr = String(body.descr || '').trim().slice(0, 100);
        if (!name) return json({ error: '版块名不能为空' }, 400);
        await env.DB.prepare('INSERT INTO boards (name, descr, sort) VALUES (?,?,?)').bind(name, descr, 99).run();
        return json({ ok: true });
      }

      // ---------- 主题 ----------
      if (seg[0] === 'boards' && seg[2] === 'threads' && method === 'GET') {
        const boardId = Number(seg[1]);
        const page = Math.max(1, Number(url.searchParams.get('page') || 1));
        const per = 20;
        const { results } = await env.DB.prepare(
          `SELECT t.*, u.name AS author,
                  (SELECT u2.name FROM posts p2 JOIN users u2 ON u2.id=p2.user_id WHERE p2.thread_id=t.id ORDER BY p2.id DESC LIMIT 1) AS last_reply_by
           FROM threads t JOIN users u ON u.id=t.user_id
           WHERE t.board_id=? ORDER BY (t.pinned=1 AND (t.pinned_until IS NULL OR t.pinned_until>?)) DESC, t.updated_at DESC LIMIT ? OFFSET ?`
        ).bind(boardId, Date.now(), per, (page - 1) * per).all();
        const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM threads WHERE board_id=?').bind(boardId).first();
        const b = await env.DB.prepare('SELECT * FROM boards WHERE id=?').bind(boardId).first();
        return json({ board: b, threads: results, total: c.n, page, per });
      }
      if (seg[0] === 'threads' && seg.length === 1 && method === 'POST') {
        if (!me) return json({ error: '请先登录' }, 401);
        if (me.banned) return json({ error: '你已被禁言，请联系管理员' }, 403);
        if (!me.verified) return json({ error: '请先验证邮箱后再发帖', needVerify: true }, 403);
        if (!await checkRateLimit(env, 'thread:' + me.id, 5, 3600 * 1000)) {
          return json({ error: '发帖太频繁，请稍后再试' }, 429);
        }
        const boardId = Number(body.board_id);
        const title = String(body.title || '').trim().slice(0, 100);
        const content = String(body.content || '').trim().slice(0, 10000);
        if (!boardId || !title) return json({ error: '标题不能为空' }, 400);
        if (!content) return json({ error: '内容不能为空' }, 400);
        const badWord = await checkSensitive(env, title + '\n' + content);
        if (badWord) return json({ error: '内容包含敏感词，请修改后重试' }, 400);
        const now = Date.now();
        const r = await env.DB.prepare(
          'INSERT INTO threads (board_id, user_id, title, created_at, updated_at) VALUES (?,?,?,?,?)'
        ).bind(boardId, me.id, title, now, now).run();
        const tid = r.meta.last_row_id;
        await env.DB.prepare('INSERT INTO posts (thread_id, user_id, content, created_at) VALUES (?,?,?,?)')
          .bind(tid, me.id, content, now).run();
        await env.DB.prepare('INSERT INTO threads_fts (title, content, thread_id) VALUES (?,?,?)')
          .bind(title, content.slice(0, 500), tid).run().catch(() => {});
        await notifyMentions(env, title + ' ' + content, me.id, tid, null);
        await addPoints(env, me.id, 5, '发帖', tid);
        return json({ ok: true, id: tid });
      }
      if (seg[0] === 'threads' && seg.length === 2 && method === 'GET') {
        const tid = Number(seg[1]);
        const t = await env.DB.prepare(
          `SELECT t.*, u.name AS author, u.avatar_url AS author_avatar, u.custom_title AS author_title, u.avatar_frame AS author_frame, b.name AS board_name FROM threads t
           JOIN users u ON u.id=t.user_id JOIN boards b ON b.id=t.board_id WHERE t.id=?`
        ).bind(tid).first();
        if (!t) return json({ error: '主题不存在' }, 404);
        await env.DB.prepare('UPDATE threads SET views=views+1 WHERE id=?').bind(tid).run().catch(()=>{});
        t.views = (t.views || 0) + 1;
        const page = Math.max(1, Number(url.searchParams.get('page') || 1));
        const per = 20;
        const authorOnly = url.searchParams.get('author_only') === '1';
        const orderDesc = url.searchParams.get('order') === 'desc';
        const orderSql = orderDesc ? 'p.id DESC' : 'p.id';
        const whereExtra = authorOnly ? ' AND p.user_id=' + t.user_id : '';
        const { results } = await env.DB.prepare(
          `SELECT p.*, u.name AS author, u.avatar_url, u.custom_title, u.avatar_frame,
                  (SELECT COUNT(*) FROM likes l WHERE l.post_id=p.id) AS like_count
           FROM posts p JOIN users u ON u.id=p.user_id
           WHERE p.thread_id=?${whereExtra} ORDER BY ${orderSql} LIMIT ? OFFSET ?`
        ).bind(tid, per, (page - 1) * per).all();
        let likedSet = new Set();
        if (me && results.length) {
          const { results: liked } = await env.DB.prepare(
            `SELECT post_id FROM likes WHERE user_id=? AND post_id IN (${results.map(() => '?').join(',')})`
          ).bind(me.id, ...results.map(p => p.id)).all();
          likedSet = new Set(liked.map(l => l.post_id));
        }
        results.forEach(p => { p.liked_by_me = likedSet.has(p.id); });
        // 权限内容块处理
        let hasReplied = false, userScore = 0;
        if (me) {
          const hr = await env.DB.prepare('SELECT 1 FROM posts WHERE thread_id=? AND user_id=? LIMIT 1').bind(tid, me.id).first();
          hasReplied = !!hr;
          const tc = await env.DB.prepare('SELECT COUNT(*) AS n FROM threads WHERE user_id=?').bind(me.id).first();
          const pc = await env.DB.prepare('SELECT COUNT(*) AS n FROM posts WHERE user_id=?').bind(me.id).first();
          userScore = tc.n + pc.n;
        }
        results.forEach(p => {
          p.content = processContentBlocks(p.content, {
            isAuthor: me && p.user_id === me.id,
            isAdmin: me && me.is_admin,
            hasReplied,
            userScore,
          });
        });
        const pc = await env.DB.prepare(`SELECT COUNT(*) AS n FROM posts WHERE thread_id=?${authorOnly ? ' AND user_id=' + t.user_id : ''}`).bind(tid).first();
        const totalAll = authorOnly ? (await env.DB.prepare('SELECT COUNT(*) AS n FROM posts WHERE thread_id=?').bind(tid).first()).n : pc.n;
        let favorited = false;
        if (me) {
          const f = await env.DB.prepare('SELECT 1 FROM favorites WHERE user_id=? AND thread_id=?').bind(me.id, tid).first();
          favorited = !!f;
        }
        return json({ thread: t, posts: results, total: pc.n, totalAll, page, per, favorited, authorOnly, orderDesc,
          me: me ? { id: me.id, is_admin: me.is_admin } : null });
      }
      if (seg[0] === 'threads' && seg.length === 2 && method === 'DELETE') {
        const tid = Number(seg[1]);
        const t = await env.DB.prepare('SELECT * FROM threads WHERE id=?').bind(tid).first();
        if (!t) return json({ error: '主题不存在' }, 404);
        if (!me || (!me.is_admin && t.user_id !== me.id)) return json({ error: '无权限' }, 403);
        await env.DB.batch([
          env.DB.prepare('DELETE FROM likes WHERE post_id IN (SELECT id FROM posts WHERE thread_id=?)').bind(tid),
          env.DB.prepare('DELETE FROM notifications WHERE thread_id=?').bind(tid),
          env.DB.prepare('DELETE FROM reports WHERE thread_id=?').bind(tid),
          env.DB.prepare('DELETE FROM posts WHERE thread_id=?').bind(tid),
          env.DB.prepare('DELETE FROM threads WHERE id=?').bind(tid),
          env.DB.prepare('DELETE FROM threads_fts WHERE thread_id=?').bind(tid),
          env.DB.prepare('DELETE FROM favorites WHERE thread_id=?').bind(tid),
        ]);
        return json({ ok: true });
      }
      if (seg[0] === 'threads' && seg[2] === 'pin' && method === 'POST') {
        if (!me || !me.is_admin) return json({ error: '需要管理员权限' }, 403);
        const tid = Number(seg[1]);
        const pinned = body.pinned ? 1 : 0;
        await env.DB.prepare('UPDATE threads SET pinned=? WHERE id=?').bind(pinned, tid).run();
        return json({ ok: true });
      }

      // ---------- 回帖 ----------
      if (seg[0] === 'posts' && seg.length === 1 && method === 'POST') {
        if (!me) return json({ error: '请先登录' }, 401);
        if (me.banned) return json({ error: '你已被禁言，请联系管理员' }, 403);
        if (!me.verified) return json({ error: '请先验证邮箱后再回帖', needVerify: true }, 403);
        if (!await checkRateLimit(env, 'post:' + me.id, 30, 3600 * 1000)) {
          return json({ error: '回帖太频繁，请稍后再试' }, 429);
        }
        const tid = Number(body.thread_id);
        const content = String(body.content || '').trim().slice(0, 10000);
        if (!tid || !content) return json({ error: '内容不能为空' }, 400);
        const badWord = await checkSensitive(env, content);
        if (badWord) return json({ error: '内容包含敏感词，请修改后重试' }, 400);
        const t = await env.DB.prepare('SELECT id, user_id FROM threads WHERE id=?').bind(tid).first();
        if (!t) return json({ error: '主题不存在' }, 404);
        const now = Date.now();
        const pr = await env.DB.prepare('INSERT INTO posts (thread_id, user_id, content, created_at) VALUES (?,?,?,?)')
          .bind(tid, me.id, content, now).run();
        await env.DB.prepare('UPDATE threads SET updated_at=?, reply_count=reply_count+1 WHERE id=?').bind(now, tid).run();
        await notifyMentions(env, content, me.id, tid, pr.meta.last_row_id);
        // 通知楼主有人回帖（排除自己回自己；若已@楼主则不重复通知）
        if (t.user_id !== me.id) {
          const mentioned = parseMentions(content);
          const author = await env.DB.prepare('SELECT name FROM users WHERE id=?').bind(t.user_id).first();
          if (!author || !mentioned.includes(author.name)) {
            await env.DB.prepare(
              'INSERT INTO notifications (user_id, type, from_user_id, thread_id, post_id, created_at) VALUES (?,?,?,?,?,?)'
            ).bind(t.user_id, 'reply', me.id, tid, pr.meta.last_row_id, now).run();
          }
        }
        await addPoints(env, me.id, 2, '回帖', tid);
        return json({ ok: true });
      }
      if (seg[0] === 'posts' && seg.length === 2 && method === 'PUT') {
        if (!me) return json({ error: '请先登录' }, 401);
        if (me.banned) return json({ error: '你已被禁言，请联系管理员' }, 403);
        const pid = Number(seg[1]);
        const p = await env.DB.prepare('SELECT * FROM posts WHERE id=?').bind(pid).first();
        if (!p) return json({ error: '回帖不存在' }, 404);
        if (!me.is_admin && p.user_id !== me.id) return json({ error: '无权限' }, 403);
        const content = String(body.content || '').trim().slice(0, 10000);
        if (!content) return json({ error: '内容不能为空' }, 400);
        await env.DB.prepare('UPDATE posts SET content=?, updated_at=? WHERE id=?').bind(content, Date.now(), pid).run();
        // 首帖编辑 → 同步搜索索引
        const isFirst = await env.DB.prepare('SELECT id FROM posts WHERE thread_id=? ORDER BY id LIMIT 1').bind(p.thread_id).first();
        if (isFirst && isFirst.id === pid) {
          const t = await env.DB.prepare('SELECT title FROM threads WHERE id=?').bind(p.thread_id).first();
          if (t) await env.DB.prepare('UPDATE threads_fts SET title=?, content=? WHERE thread_id=?').bind(t.title, content, p.thread_id).run();
        }
        return json({ ok: true });
      }
      if (seg[0] === 'posts' && seg.length === 2 && method === 'DELETE') {
        const pid = Number(seg[1]);
        const p = await env.DB.prepare('SELECT * FROM posts WHERE id=?').bind(pid).first();
        if (!p) return json({ error: '回帖不存在' }, 404);
        if (!me || (!me.is_admin && p.user_id !== me.id)) return json({ error: '无权限' }, 403);
        const first = await env.DB.prepare('SELECT id FROM posts WHERE thread_id=? ORDER BY id LIMIT 1').bind(p.thread_id).first();
        await env.DB.prepare('DELETE FROM posts WHERE id=?').bind(pid).run();
        if (first && first.id === pid) {
          // 删的是首帖 → 整个主题删除
          await env.DB.batch([
            env.DB.prepare('DELETE FROM likes WHERE post_id IN (SELECT id FROM posts WHERE thread_id=?)').bind(p.thread_id),
            env.DB.prepare('DELETE FROM notifications WHERE thread_id=?').bind(p.thread_id),
            env.DB.prepare('DELETE FROM reports WHERE thread_id=?').bind(p.thread_id),
            env.DB.prepare('DELETE FROM posts WHERE thread_id=?').bind(p.thread_id),
            env.DB.prepare('DELETE FROM threads WHERE id=?').bind(p.thread_id),
            env.DB.prepare('DELETE FROM threads_fts WHERE thread_id=?').bind(p.thread_id),
            env.DB.prepare('DELETE FROM favorites WHERE thread_id=?').bind(p.thread_id),
          ]);
          return json({ ok: true, threadDeleted: true });
        }
        await env.DB.prepare('UPDATE threads SET reply_count=MAX(0,reply_count-1) WHERE id=?').bind(p.thread_id).run();
        return json({ ok: true });
      }

      // ---------- 搜索 ----------
      if (seg[0] === 'search' && method === 'GET') {
        const q = String(url.searchParams.get('q') || '').trim().slice(0, 50);
        if (!q) return json({ results: [] });
        const hasChinese = /[\u4e00-\u9fff]/.test(q);
        let results = [];
        if (hasChinese) {
          // 中文用 LIKE 模糊搜索（FTS5 默认分词器切不动中文）
          const like = '%' + q.replace(/[%_]/g, '') + '%';
          const r = await env.DB.prepare(
            `SELECT t.id, t.title, t.user_id, t.reply_count, t.updated_at, u.name AS author, b.name AS board_name
             FROM threads t JOIN users u ON u.id=t.user_id JOIN boards b ON b.id=t.board_id
             WHERE t.title LIKE ? OR t.id IN (SELECT thread_id FROM posts WHERE content LIKE ?)
             ORDER BY t.updated_at DESC LIMIT 20`
          ).bind(like, like).all().catch(() => ({ results: [] }));
          results = r.results;
        } else {
          const ftsq = sanitizeFts(q);
          if (ftsq) {
            const r = await env.DB.prepare(
              `SELECT t.id, t.title, t.user_id, t.reply_count, t.updated_at, u.name AS author, b.name AS board_name
               FROM threads_fts f JOIN threads t ON t.id=f.thread_id
               JOIN users u ON u.id=t.user_id JOIN boards b ON b.id=t.board_id
               WHERE threads_fts MATCH ? ORDER BY rank LIMIT 20`
            ).bind(ftsq).all().catch(() => ({ results: [] }));
            results = r.results;
          }
          // FTS 无结果时回退到 LIKE（支持前缀/模糊）
          if (!results.length) {
            const like = '%' + q.replace(/[%_]/g, '') + '%';
            const r2 = await env.DB.prepare(
              `SELECT t.id, t.title, t.user_id, t.reply_count, t.updated_at, u.name AS author, b.name AS board_name
               FROM threads t JOIN users u ON u.id=t.user_id JOIN boards b ON b.id=t.board_id
               WHERE t.title LIKE ? OR t.id IN (SELECT thread_id FROM posts WHERE content LIKE ?)
               ORDER BY t.updated_at DESC LIMIT 20`
            ).bind(like, like).all().catch(() => ({ results: [] }));
            results = r2.results;
          }
        }
        return json({ results });
      }

      // ---------- 图片外链说明 ----------
      // 图片使用外链：用户在内容中粘贴图片 URL，前端 renderContent 渲染为 <img>

      // ---------- 通知 ----------
      if (seg[0] === 'notifications' && method === 'GET') {
        if (!me) return json({ error: '请先登录' }, 401);
        const { results } = await env.DB.prepare(
          `SELECT n.*, u.name AS from_name, t.title AS thread_title FROM notifications n
           JOIN users u ON u.id=n.from_user_id JOIN threads t ON t.id=n.thread_id
           WHERE n.user_id=? ORDER BY n.created_at DESC LIMIT 30`
        ).bind(me.id).all();
        const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND is_read=0').bind(me.id).first();
        return json({ notifications: results, unread: c.n });
      }
      if (seg[0] === 'notifications' && seg[1] === 'read' && method === 'POST') {
        if (!me) return json({ error: '请先登录' }, 401);
        await env.DB.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').bind(me.id).run();
        return json({ ok: true });
      }

      // ---------- 定位回帖所在页 ----------
      if (seg[0] === 'posts' && seg[2] === 'locate' && method === 'GET') {
        const pid = Number(seg[1]);
        const p = await env.DB.prepare('SELECT thread_id FROM posts WHERE id=?').bind(pid).first();
        if (!p) return json({ error: '回帖不存在' }, 404);
        const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM posts WHERE thread_id=? AND id<?').bind(p.thread_id, pid).first();
        const per = 20;
        const page = Math.floor(c.n / per) + 1;
        return json({ thread_id: p.thread_id, page, floor: c.n + 1 });
      }

      // ---------- 点赞 ----------
      if (seg[0] === 'posts' && seg[2] === 'like' && method === 'POST') {
        if (!me) return json({ error: '请先登录' }, 401);
        const pid = Number(seg[1]);
        const p = await env.DB.prepare('SELECT * FROM posts WHERE id=?').bind(pid).first();
        if (!p) return json({ error: '回帖不存在' }, 404);
        const ex = await env.DB.prepare('SELECT * FROM likes WHERE post_id=? AND user_id=?').bind(pid, me.id).first();
        if (ex) {
          await env.DB.prepare('DELETE FROM likes WHERE post_id=? AND user_id=?').bind(pid, me.id).run();
          // 取消点赞扣回 1 分（防刷）
          if (p.user_id !== me.id) await addPoints(env, p.user_id, -1, '取消点赞', pid);
        } else {
          await env.DB.prepare('INSERT INTO likes (post_id, user_id, created_at) VALUES (?,?,?)').bind(pid, me.id, Date.now()).run();
          // 被点赞者 +1（不给自己点赞加分）
          if (p.user_id !== me.id) await addPoints(env, p.user_id, 1, '被点赞', pid);
        }
        const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM likes WHERE post_id=?').bind(pid).first();
        return json({ ok: true, liked: !ex, count: c.n });
      }

      // ---------- 标记为解决方案 ----------
      if (seg[0] === 'posts' && seg[2] === 'solution' && method === 'POST') {
        if (!me) return json({ error: '请先登录' }, 401);
        const pid = Number(seg[1]);
        const p = await env.DB.prepare('SELECT * FROM posts WHERE id=?').bind(pid).first();
        if (!p) return json({ error: '回帖不存在' }, 404);
        const t = await env.DB.prepare('SELECT * FROM threads WHERE id=?').bind(p.thread_id).first();
        // 只有楼主和管理员可以标记
        if (t.user_id !== me.id && !me.is_admin) return json({ error: '只有楼主可以标记解决方案' }, 403);
        // 如果已经是解决方案，不重复加分
        if (p.is_solution === 1) return json({ ok: true, already: true });
        // 找到旧方案，扣回它的 20 分
        const oldSol = await env.DB.prepare('SELECT * FROM posts WHERE thread_id=? AND is_solution=1').bind(p.thread_id).first();
        if (oldSol) await addPoints(env, oldSol.user_id, -20, '解决方案被替换', oldSol.id);
        // 取消该主题下其他方案标记（只保留一个）
        await env.DB.prepare('UPDATE posts SET is_solution=0 WHERE thread_id=?').bind(p.thread_id).run();
        await env.DB.prepare('UPDATE posts SET is_solution=1 WHERE id=?').bind(pid).run();
        await logAdmin(env, me.id, 'mark_solution', `标记回帖 #${pid} 为解决方案（主题 #${p.thread_id}）`);
        await addPoints(env, p.user_id, 20, '回帖被采纳', pid);
        return json({ ok: true });
      }

      // ---------- 取消解决方案标记 ----------
      if (seg[0] === 'posts' && seg[2] === 'unsolution' && method === 'POST') {
        if (!me) return json({ error: '请先登录' }, 401);
        const pid = Number(seg[1]);
        const p = await env.DB.prepare('SELECT * FROM posts WHERE id=?').bind(pid).first();
        if (!p) return json({ error: '回帖不存在' }, 404);
        const t = await env.DB.prepare('SELECT * FROM threads WHERE id=?').bind(p.thread_id).first();
        if (t.user_id !== me.id && !me.is_admin) return json({ error: '只有楼主可以操作' }, 403);
        await env.DB.prepare('UPDATE posts SET is_solution=0 WHERE id=?').bind(pid).run();
        // 取消时扣回 20 分
        if (p.is_solution === 1) await addPoints(env, p.user_id, -20, '取消解决方案', pid);
        return json({ ok: true });
      }

      // ---------- 用户搜索（@补全） ----------
      if (seg[0] === 'users' && seg[1] === 'search' && method === 'GET') {
        const q = String(url.searchParams.get('q') || '').trim().slice(0, 16);
        if (!q) return json({ users: [] });
        const { results } = await env.DB.prepare(
          'SELECT id, name, avatar_url FROM users WHERE name LIKE ? LIMIT 8'
        ).bind('%' + q + '%').all();
        return json({ users: results });
      }

      // ---------- 个人主页 ----------
      if (seg[0] === 'users' && seg.length === 2 && method === 'GET') {
        const uid = Number(seg[1]);
        const u = await env.DB.prepare('SELECT id, name, is_admin, avatar_url, bio, created_at, points, checkin_streak, custom_title, avatar_frame FROM users WHERE id=?').bind(uid).first();
        if (!u) return json({ error: '用户不存在' }, 404);
        const { results: threads } = await env.DB.prepare(
          `SELECT t.*, b.name AS board_name FROM threads t JOIN boards b ON b.id=t.board_id
           WHERE t.user_id=? ORDER BY t.created_at DESC LIMIT 20`
        ).bind(uid).all();
        const pc = await env.DB.prepare('SELECT COUNT(*) AS n FROM posts WHERE user_id=?').bind(uid).first();
        return json({ user: u, threads, postCount: pc.n });
      }

      if (seg[0] === 'threads' && seg[2] === 'favorite' && method === 'POST') {
        if (!me) return json({ error: '请先登录' }, 401);
        const tid = Number(seg[1]);
        const ex = await env.DB.prepare('SELECT 1 FROM favorites WHERE user_id=? AND thread_id=?').bind(me.id, tid).first();
        if (ex) {
          await env.DB.prepare('DELETE FROM favorites WHERE user_id=? AND thread_id=?').bind(me.id, tid).run();
        } else {
          await env.DB.prepare('INSERT INTO favorites (user_id, thread_id, created_at) VALUES (?,?,?)').bind(me.id, tid, Date.now()).run();
        }
        return json({ ok: true, favorited: !ex });
      }
      if (seg[0] === 'me' && seg[1] === 'favorites' && method === 'GET') {
        if (!me) return json({ error: '请先登录' }, 401);
        const { results } = await env.DB.prepare(
          `SELECT t.*, u.name AS author, b.name AS board_name FROM favorites f
           JOIN threads t ON t.id=f.thread_id JOIN users u ON u.id=t.user_id JOIN boards b ON b.id=t.board_id
           WHERE f.user_id=? ORDER BY f.created_at DESC LIMIT 50`
        ).bind(me.id).all();
        return json({ favorites: results });
      }

      // ---------- 站点设置 ----------
      if (seg[0] === 'settings' && method === 'GET') {
        const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
        const s = {};
        results.forEach(r => { s[r.key] = r.value; });
        if (env.TURNSTILE_SITEKEY) s.turnstile_sitekey = env.TURNSTILE_SITEKEY;
        return json({ settings: s });
      }
      if (seg[0] === 'admin' && seg[1] === 'settings' && method === 'PUT') {
        const deny = requireAdmin(me); if (deny) return deny;
        const allowed = ['site_name', 'site_logo', 'site_desc', 'announcement'];
        const batch = [];
        for (const k of allowed) {
          if (body[k] !== undefined) {
            const v = String(body[k]).slice(0, k === 'announcement' ? 500 : 100);
            batch.push(env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)').bind(k, v));
          }
        }
        if (batch.length) await env.DB.batch(batch);
        return json({ ok: true });
      }

      // ---------- 私信 ----------
      if (seg[0] === 'dm' && seg.length === 1 && method === 'GET') {
        if (!me) return json({ error: '请先登录' }, 401);
        const { results } = await env.DB.prepare(
          `SELECT
             CASE WHEN sender_id=? THEN receiver_id ELSE sender_id END AS uid,
             MAX(created_at) AS last_at,
             SUM(CASE WHEN receiver_id=? AND is_read=0 THEN 1 ELSE 0 END) AS unread
           FROM dm_messages WHERE sender_id=? OR receiver_id=?
           GROUP BY uid ORDER BY last_at DESC LIMIT 30`
        ).bind(me.id, me.id, me.id, me.id).all();
        // 每个会话的最后一条消息（避免在子查询中引用 uid 别名）
        for (const r of results) {
          const lm = await env.DB.prepare(
            `SELECT content FROM dm_messages
             WHERE (sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?)
             ORDER BY created_at DESC LIMIT 1`
          ).bind(me.id, r.uid, r.uid, me.id).first();
          r.last_msg = lm ? lm.content : '';
        }
        const uids = results.map(r => r.uid);
        let names = {};
        if (uids.length) {
          const { results: us } = await env.DB.prepare(
            `SELECT id, name, avatar_url FROM users WHERE id IN (${uids.map(()=>'?').join(',')})`
          ).bind(...uids).all();
          us.forEach(u => { names[u.id] = u; });
        }
        results.forEach(r => { r.user = names[r.uid] || { id: r.uid, name: '未知', avatar_url: '' }; });
        const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM dm_messages WHERE receiver_id=? AND is_read=0').bind(me.id).first();
        return json({ conversations: results, totalUnread: total.n });
      }
      if (seg[0] === 'dm' && seg.length === 2 && method === 'GET') {
        if (!me) return json({ error: '请先登录' }, 401);
        const uid = Number(seg[1]);
        if (uid === me.id) return json({ error: '不能给自己发私信' }, 400);
        const other = await env.DB.prepare('SELECT id, name, avatar_url FROM users WHERE id=?').bind(uid).first();
        if (!other) return json({ error: '用户不存在' }, 404);
        const { results } = await env.DB.prepare(
          `SELECT * FROM dm_messages WHERE (sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?)
           ORDER BY created_at DESC LIMIT 50`
        ).bind(me.id, uid, uid, me.id).all();
        results.reverse();
        await env.DB.prepare('UPDATE dm_messages SET is_read=1 WHERE sender_id=? AND receiver_id=?').bind(uid, me.id).run();
        return json({ user: other, messages: results });
      }
      if (seg[0] === 'dm' && seg.length === 2 && method === 'POST') {
        if (!me) return json({ error: '请先登录' }, 401);
        if (me.banned) return json({ error: '你已被禁言' }, 403);
        if (!me.verified) return json({ error: '请先验证邮箱后再发私信', needVerify: true }, 403);
        if (!await checkRateLimit(env, 'dm:' + me.id, 30, 3600 * 1000)) {
          return json({ error: '发送太频繁，请稍后再试' }, 429);
        }
        const uid = Number(seg[1]);
        if (uid === me.id) return json({ error: '不能给自己发私信' }, 400);
        const other = await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(uid).first();
        if (!other) return json({ error: '用户不存在' }, 404);
        const content = String(body.content || '').trim().slice(0, 2000);
        if (!content) return json({ error: '内容不能为空' }, 400);
        const badWord = await checkSensitive(env, content);
        if (badWord) return json({ error: '内容包含敏感词，请修改后重试' }, 400);
        await env.DB.prepare(
          'INSERT INTO dm_messages (sender_id, receiver_id, content, created_at) VALUES (?,?,?,?)'
        ).bind(me.id, uid, content, Date.now()).run();
        return json({ ok: true });
      }

      // ---------- 举报 ----------
      if (seg[0] === 'reports' && seg.length === 1 && method === 'POST') {
        if (!me) return json({ error: '请先登录' }, 401);
        const target_type = String(body.target_type || '');
        const target_id = Number(body.target_id);
        const reason = String(body.reason || '').trim().slice(0, 200);
        if (!['thread', 'post'].includes(target_type) || !target_id) return json({ error: '参数错误' }, 400);
        if (!reason) return json({ error: '请填写举报理由' }, 400);
        let thread_id = 0;
        if (target_type === 'thread') {
          const t = await env.DB.prepare('SELECT id FROM threads WHERE id=?').bind(target_id).first();
          if (!t) return json({ error: '主题不存在' }, 404);
          thread_id = target_id;
        } else {
          const p = await env.DB.prepare('SELECT thread_id FROM posts WHERE id=?').bind(target_id).first();
          if (!p) return json({ error: '回帖不存在' }, 404);
          thread_id = p.thread_id;
        }
        const dup = await env.DB.prepare(
          'SELECT id FROM reports WHERE reporter_id=? AND target_type=? AND target_id=? AND status=?'
        ).bind(me.id, target_type, target_id, 'pending').first();
        if (dup) return json({ error: '你已经举报过，等待处理中' }, 400);
        await env.DB.prepare(
          'INSERT INTO reports (reporter_id, target_type, target_id, thread_id, reason, created_at) VALUES (?,?,?,?,?,?)'
        ).bind(me.id, target_type, target_id, thread_id, reason, Date.now()).run();
        return json({ ok: true });
      }
      if (seg[0] === 'admin' && seg[1] === 'reports' && method === 'GET') {
        const deny = requireAdmin(me); if (deny) return deny;
        const status = url.searchParams.get('status') || 'pending';
        const { results } = await env.DB.prepare(
          `SELECT r.*, u.name AS reporter_name, t.title AS thread_title FROM reports r
           JOIN users u ON u.id=r.reporter_id JOIN threads t ON t.id=r.thread_id
           WHERE r.status=? ORDER BY r.created_at DESC LIMIT 50`
        ).bind(status).all();
        const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE status='pending'").first();
        return json({ reports: results, pendingCount: c.n });
      }
      if (seg[0] === 'admin' && seg[1] === 'reports' && seg[3] === 'handle' && method === 'POST') {
        const deny = requireAdmin(me); if (deny) return deny;
        const rid = Number(seg[2]);
        const action = String(body.action || '');
        if (!['dismiss', 'delete'].includes(action)) return json({ error: '参数错误' }, 400);
        const r = await env.DB.prepare('SELECT * FROM reports WHERE id=?').bind(rid).first();
        if (!r) return json({ error: '举报不存在' }, 404);
        if (action === 'delete') {
          if (r.target_type === 'thread') {
            await env.DB.batch([
              env.DB.prepare('DELETE FROM posts WHERE thread_id=?').bind(r.target_id),
              env.DB.prepare('DELETE FROM threads WHERE id=?').bind(r.target_id),
              env.DB.prepare('DELETE FROM threads_fts WHERE thread_id=?').bind(r.target_id),
              env.DB.prepare('DELETE FROM favorites WHERE thread_id=?').bind(r.target_id),
              env.DB.prepare("UPDATE reports SET status='deleted', handled_at=? WHERE thread_id=? AND status='pending'").bind(Date.now(), r.target_id),
            ]);
          } else {
            const p = await env.DB.prepare('SELECT thread_id FROM posts WHERE id=?').bind(r.target_id).first();
            await env.DB.batch([
              env.DB.prepare('DELETE FROM likes WHERE post_id=?').bind(r.target_id),
              env.DB.prepare('DELETE FROM notifications WHERE post_id=?').bind(r.target_id),
              env.DB.prepare('DELETE FROM posts WHERE id=?').bind(r.target_id),
              env.DB.prepare("UPDATE reports SET status='deleted', handled_at=? WHERE target_type='post' AND target_id=? AND status='pending'").bind(Date.now(), r.target_id),
            ]);
            if (p) await env.DB.prepare('UPDATE threads SET reply_count=MAX(0,reply_count-1) WHERE id=?').bind(p.thread_id).run();
          }
        }
        await env.DB.prepare("UPDATE reports SET status=?, handled_at=? WHERE id=?")
          .bind(action === 'delete' ? 'deleted' : 'dismissed', Date.now(), rid).run();
        await adminLog(env, me, action === 'delete' ? '举报处理-删除内容' : '举报处理-驳回', r.target_type, r.target_id, '举报#' + rid);
        return json({ ok: true });
      }

      // ---------- 精华 ----------
      if (seg[0] === 'threads' && seg[2] === 'digest' && method === 'POST') {
        const deny = requireAdmin(me); if (deny) return deny;
        const tid = Number(seg[1]);
        await env.DB.prepare('UPDATE threads SET is_digest=? WHERE id=?').bind(body.digest ? 1 : 0, tid).run();
        return json({ ok: true });
      }

      // ---------- 敏感词管理 ----------
      if (seg[0] === 'admin' && seg[1] === 'sensitive-words' && method === 'GET') {
        const deny = requireAdmin(me); if (deny) return deny;
        const { results } = await env.DB.prepare('SELECT word FROM sensitive_words ORDER BY word').all();
        return json({ words: results.map(r => r.word) });
      }
      if (seg[0] === 'admin' && seg[1] === 'sensitive-words' && method === 'POST') {
        const deny = requireAdmin(me); if (deny) return deny;
        const word = String(body.word || '').trim().slice(0, 20);
        if (!word) return json({ error: '词不能为空' }, 400);
        await env.DB.prepare('INSERT OR IGNORE INTO sensitive_words (word, created_at) VALUES (?,?)').bind(word, Date.now()).run();
        sensitiveCache = null;
        return json({ ok: true });
      }
      if (seg[0] === 'admin' && seg[1] === 'sensitive-words' && seg.length === 3 && method === 'DELETE') {
        const deny = requireAdmin(me); if (deny) return deny;
        const word = decodeURIComponent(seg[2]);
        await env.DB.prepare('DELETE FROM sensitive_words WHERE word=?').bind(word).run();
        sensitiveCache = null;
        return json({ ok: true });
      }

      // ---------- 管理后台 ----------
      if (seg[0] === 'admin' && seg[1] === 'logs' && method === 'GET') {
        const deny = requireAdmin(me); if (deny) return deny;
        const page = Math.max(1, Number(url.searchParams.get('p') || 1));
        const per = 30;
        const { results } = await env.DB.prepare(
          'SELECT * FROM admin_logs ORDER BY id DESC LIMIT ? OFFSET ?'
        ).bind(per, (page - 1) * per).all();
        const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_logs').first();
        return json({ logs: results, total: c.n, page, per });
      }
      if (seg[0] === 'admin' && seg[1] === 'stats' && method === 'GET') {
        const deny = requireAdmin(me); if (deny) return deny;
        const u = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
        const t = await env.DB.prepare('SELECT COUNT(*) AS n FROM threads').first();
        const p = await env.DB.prepare('SELECT COUNT(*) AS n FROM posts').first();
        const b = await env.DB.prepare('SELECT COUNT(*) AS n FROM boards').first();
        const today = await env.DB.prepare('SELECT COUNT(*) AS n FROM posts WHERE created_at>?').bind(Date.now() - 86400 * 1000).first();
        return json({ users: u.n, threads: t.n, posts: p.n, boards: b.n, todayPosts: today.n });
      }
      if (seg[0] === 'admin' && seg[1] === 'users' && method === 'GET') {
        const deny = requireAdmin(me); if (deny) return deny;
        const page = Math.max(1, Number(url.searchParams.get('page') || 1));
        const per = 20;
        const { results } = await env.DB.prepare(
          `SELECT id, name, email, is_admin, verified, banned, avatar_url, created_at, points,
                  (SELECT COUNT(*) FROM threads WHERE user_id=users.id) AS thread_count,
                  (SELECT COUNT(*) FROM posts WHERE user_id=users.id) AS post_count
           FROM users ORDER BY id DESC LIMIT ? OFFSET ?`
        ).bind(per, (page - 1) * per).all();
        const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
        return json({ users: results, total: c.n, page, per });
      }
      if (seg[0] === 'admin' && seg[1] === 'users' && seg[3] === 'ban' && method === 'POST') {
        const deny = requireAdmin(me); if (deny) return deny;
        const uid = Number(seg[2]);
        if (uid === me.id) return json({ error: '不能禁言自己' }, 400);
        await env.DB.prepare('UPDATE users SET banned=? WHERE id=?').bind(body.banned ? 1 : 0, uid).run();
        await adminLog(env, me, body.banned ? '禁言用户' : '解禁用户', 'user', uid, null);
        return json({ ok: true });
      }
      if (seg[0] === 'admin' && seg[1] === 'users' && seg[3] === 'role' && method === 'POST') {
        const deny = requireAdmin(me); if (deny) return deny;
        const uid = Number(seg[2]);
        if (uid === me.id) return json({ error: '不能修改自己的管理员身份' }, 400);
        await env.DB.prepare('UPDATE users SET is_admin=? WHERE id=?').bind(body.is_admin ? 1 : 0, uid).run();
        await adminLog(env, me, body.is_admin ? '设为管理员' : '撤销管理员', 'user', uid, null);
        return json({ ok: true });
      }
      if (seg[0] === 'admin' && seg[1] === 'users' && seg.length === 3 && method === 'DELETE') {
        const deny = requireAdmin(me); if (deny) return deny;
        const uid = Number(seg[2]);
        if (uid === me.id) return json({ error: '不能删除自己' }, 400);
        const tids = await env.DB.prepare('SELECT id FROM threads WHERE user_id=?').bind(uid).all();
        const batch = [
          env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(uid),
          env.DB.prepare('DELETE FROM verify_tokens WHERE user_id=?').bind(uid),
          env.DB.prepare('DELETE FROM password_resets WHERE user_id=?').bind(uid),
          env.DB.prepare('DELETE FROM notifications WHERE user_id=? OR from_user_id=?').bind(uid, uid),
          env.DB.prepare('DELETE FROM likes WHERE user_id=?').bind(uid),
          env.DB.prepare('DELETE FROM favorites WHERE user_id=?').bind(uid),
          env.DB.prepare('DELETE FROM reports WHERE reporter_id=?').bind(uid),
          env.DB.prepare('DELETE FROM dm_messages WHERE sender_id=? OR receiver_id=?').bind(uid, uid),
          env.DB.prepare('DELETE FROM posts WHERE user_id=?').bind(uid),
        ];
        for (const t of tids.results) {
          batch.push(env.DB.prepare('DELETE FROM threads_fts WHERE thread_id=?').bind(t.id));
        }
        batch.push(env.DB.prepare('DELETE FROM threads WHERE user_id=?').bind(uid));
        batch.push(env.DB.prepare('DELETE FROM users WHERE id=?').bind(uid));
        await env.DB.batch(batch);
        await adminLog(env, me, '删除用户', 'user', uid, null);
        return json({ ok: true });
      }
      if (seg[0] === 'admin' && seg[1] === 'boards' && seg.length === 3 && method === 'PUT') {
        const deny = requireAdmin(me); if (deny) return deny;
        const bid = Number(seg[2]);
        const name = String(body.name || '').trim().slice(0, 30);
        const descr = String(body.descr || '').trim().slice(0, 100);
        const sort = Math.max(0, Math.min(999, Number(body.sort) || 99));
        if (!name) return json({ error: '版块名不能为空' }, 400);
        await env.DB.prepare('UPDATE boards SET name=?, descr=?, sort=? WHERE id=?').bind(name, descr, sort, bid).run();
        return json({ ok: true });
      }
      if (seg[0] === 'admin' && seg[1] === 'boards' && seg.length === 3 && method === 'DELETE') {
        const deny = requireAdmin(me); if (deny) return deny;
        const bid = Number(seg[2]);
        const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM threads WHERE board_id=?').bind(bid).first();
        if (c.n > 0) return json({ error: '版块下还有 ' + c.n + ' 个主题，不能删除' }, 400);
        await env.DB.prepare('DELETE FROM boards WHERE id=?').bind(bid).run();
        return json({ ok: true });
      }

      return json({ error: '未知接口' }, 404);
    } catch (e) {
      return json({ error: '服务器错误' }, 500);
    }
  },
};
