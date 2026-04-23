/* ========================================
   GLM Coding Plan Pro 自动抢购 (控制台版)

   使用方法:
   1. 9:59 左右打开 https://open.bigmodel.cn/glm-coding 并登录
   2. 按 F12 打开控制台
   3. 粘贴这段代码，按回车
   4. 看到右上角黑色悬浮窗 = 成功
   5. 等到点自动抢购，听到提示音后扫码付款

   注意: 刷新页面后需要重新粘贴!
   ======================================== */

(function () {
  'use strict';

  const CONFIG = {
    targetPlan: 'pro',        // 'lite' | 'pro' | 'max'
    billingPeriod: 'quarterly', // 'monthly' | 'quarterly' | 'yearly'
    targetHour: 10,
    targetMinute: 0,
    targetSecond: 0,
    advanceMs: 200,           // 提前多少ms开始点击
    retryInterval: 100,       // 点击间隔(ms)
    maxRetries: 300,          // 最大重试次数 (300次 * 100ms = 30秒)
  };

  let state = {
    retryCount: 0,
    isRunning: false,
    orderCreated: false,
    modalVisible: false,
    preheated: false,
    timerId: null,
  };

  // ===== 时间窗口检查: 只在 10:00 前1分钟 ~ 后30分钟内拦截 (9:59 ~ 10:30) =====
  function isNearTarget() {
    const now = new Date(), t = new Date(now);
    t.setHours(CONFIG.targetHour, CONFIG.targetMinute, CONFIG.targetSecond, 0);
    const diff = t - now;
    return diff <= 60000 && diff >= -1800000;
  }

  // ===== 售罄确认机制 =====
  let _soldOutCount = 0;
  let _confirmedSoldOut = false;

  function isInRushWindow() {
    const now = new Date(), t = new Date(now);
    t.setHours(CONFIG.targetHour, CONFIG.targetMinute, CONFIG.targetSecond, 0);
    const elapsed = now - t;
    return elapsed >= 0 && elapsed < 120000;
  }

  function shouldInterceptSoldOut() {
    if (_confirmedSoldOut) return false;
    if (isInRushWindow()) return true;
    if (_soldOutCount >= 3) {
      confirmSoldOut();
      return false;
    }
    return true;
  }

  function confirmSoldOut() {
    if (_confirmedSoldOut) return;
    _confirmedSoldOut = true;
    log('已确认售罄，停止抢购');
    setStatus('已售罄，明日再抢', '#f44');
    if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
    state.isRunning = false;
  }

  // 捕获的 productId (必须在 JSON.parse 拦截之前声明，避免 let 暂时性死区)
  let _capturedProductId = null;

  // ===== 1. 拦截 JSON.parse =====
  const _parse = JSON.parse;
  JSON.parse = function (...args) {
    let r = _parse.apply(this, args);
    try {
      // 始终捕获 productId（不受时间窗口限制）
      if (!_capturedProductId) captureProductIdFromData(r);
      if (isNearTarget()) {
        _soldOutCount = 0; // 每次新的 API 响应重置计数器
        r = fixSoldOut(r);
      }
    } catch (e) { }
    return r;
  };
  Object.defineProperty(JSON.parse, 'toString', {
    value: () => 'function parse() { [native code] }',
  });

  // 按价格+折扣识别目标套餐 (API 返回无 name 字段)
  // Lite: monthlyOriginalAmount=49, Pro: =149, Max: =469
  // monthly: 无折扣, quarterly: campaignName含"包季", yearly: 含"包年"
  let _allProductIds = {};
  const PLAN_PRICE_MAP = { lite: 49, pro: 149, max: 469 };

  function identifyPlanFromProduct(item) {
    const price = item.monthlyOriginalAmount;
    let plan = null;
    for (const [name, p] of Object.entries(PLAN_PRICE_MAP)) {
      if (price === p) { plan = name; break; }
    }
    if (!plan) return null;
    let period = 'monthly';
    const campaigns = item.campaignDiscountDetails || [];
    for (const c of campaigns) {
      const cn = c.campaignName || '';
      if (cn.includes('包季')) { period = 'quarterly'; break; }
      if (cn.includes('包年')) { period = 'yearly'; break; }
    }
    return { plan, period };
  }

  function captureProductIdFromData(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.productList && Array.isArray(obj.productList)) {
      for (const item of obj.productList) {
        if (!item || !item.productId) continue;
        const info = identifyPlanFromProduct(item);
        if (!info) continue;
        const key = info.plan + '_' + info.period;
        _allProductIds[key] = item.productId;
        if (info.plan === CONFIG.targetPlan && info.period === CONFIG.billingPeriod) {
          _capturedProductId = item.productId;
          log('[捕获] productId=' + item.productId + ' (' + CONFIG.targetPlan + '/' + CONFIG.billingPeriod + ')');
        }
      }
      return;
    }
    if (Array.isArray(obj)) {
      for (const item of obj) { if (item && typeof item === 'object') captureProductIdFromData(item); }
    } else {
      for (const v of Object.values(obj)) { if (v && typeof v === 'object') captureProductIdFromData(v); }
    }
  }

  function getProductId() {
    if (_capturedProductId) return _capturedProductId;
    var exactKey = CONFIG.targetPlan + '_' + CONFIG.billingPeriod;
    if (_allProductIds[exactKey]) {
      _capturedProductId = _allProductIds[exactKey];
      log('[回退] 精确匹配 productId=' + _capturedProductId);
      return _capturedProductId;
    }
    for (const [key, pid] of Object.entries(_allProductIds)) {
      if (key.startsWith(CONFIG.targetPlan + '_')) {
        _capturedProductId = pid;
        log('[回退] 同套餐匹配 productId=' + pid + ' (' + key + ')');
        return pid;
      }
    }
    const entries = Object.entries(_allProductIds);
    if (entries.length > 0) {
      _capturedProductId = entries[0][1];
      log('[回退] 使用首个可用 productId=' + _capturedProductId);
      return _capturedProductId;
    }
    return null;
  }

  function fixSoldOut(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(fixSoldOut);
    for (const k of Object.keys(obj)) {
      if (/sold.?out/i.test(k) && obj[k] === true) {
        _soldOutCount++;
        if (shouldInterceptSoldOut()) {
          obj[k] = false;
          log('[拦截] ' + k + ' -> false (连续' + _soldOutCount + '次)');
        }
      }
      // 不在递归遍历中重置计数器，在 JSON.parse 拦截层重置
      if (k === 'isServerBusy' && obj[k] === true) {
        obj[k] = false;
        log('[拦截] isServerBusy -> false');
      }
      if (typeof obj[k] === 'object') obj[k] = fixSoldOut(obj[k]);
    }
    return obj;
  }

  // ===== 2. 拦截 fetch (指纹随机化 + 自动重试 + soldOut修改 + check校验) =====

  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    // 请求指纹随机化
    if (isNearTarget() && args[1]) {
      const headers = new Headers(args[1].headers);
      headers.set('X-Request-Id', Math.random().toString(36).slice(2, 15));
      headers.set('X-Timestamp', String(Date.now()));
      const q = (0.5 + Math.random() * 0.5).toFixed(1);
      headers.set('Accept-Language', 'zh-CN,zh;q=' + q + ',en;q=' + (q * 0.7).toFixed(1));
      args[1] = { ...args[1], headers };
    }

    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

    // 所有包含 body 的请求: 捕获 productId + 注入缺失的 productId
    if (args[1]?.body && typeof args[1].body === 'string') {
      try {
        let bodyObj = JSON.parse(args[1].body);
        if (bodyObj && typeof bodyObj === 'object') {
          if (bodyObj.productId) {
            _capturedProductId = bodyObj.productId;
            if (/preview/i.test(url)) log('[捕获] productId=' + _capturedProductId);
          }
          if ('productId' in bodyObj && !bodyObj.productId && _capturedProductId) {
            bodyObj.productId = _capturedProductId;
            args[1] = { ...args[1], body: JSON.stringify(bodyObj) };
            log('[注入] 已补充 productId=' + _capturedProductId + ' → ' + url.split('/').pop());
          }
        }
      } catch (e) { }
    }

    let res = await _fetch.apply(this, args);

    // 抢购窗口内，失败请求自动重试
    if (isNearTarget() && [429, 500, 502, 503].includes(res.status)) {
      for (let retry = 1; retry <= 8; retry++) {
        console.log('[GLM Sniper] fetch ' + res.status + '，重试' + retry + ': ' + url);
        await new Promise(r => setTimeout(r, 300 * retry));
        try {
          res = await _fetch.apply(this, args);
          if (res.ok) { console.log('[GLM Sniper] fetch 重试成功!'); break; }
        } catch (e) { }
      }
    }

    // 从产品列表 API 响应中捕获 productId
    if (!_capturedProductId && /coding|plan|product|package/i.test(url)) {
      try {
        const clone = res.clone();
        const text = await clone.text();
        const planKey = CONFIG.targetPlan.toLowerCase();
        const parsed = JSON.parse(text);
        const findPid = (obj) => {
          if (!obj || typeof obj !== 'object') return null;
          if (Array.isArray(obj)) {
            for (const item of obj) {
              const name = (item.name || item.title || item.planName || item.planType || '').toLowerCase();
              if (name.includes(planKey) && (item.productId || item.id)) return item.productId || item.id;
              const f = findPid(item); if (f) return f;
            }
          } else {
            for (const v of Object.values(obj)) { const f = findPid(v); if (f) return f; }
          }
          return null;
        };
        const found = findPid(parsed);
        if (found) { _capturedProductId = found; log('[捕获] 从API响应获取 productId=' + found); }
      } catch (e) { }
    }

    if (!isNearTarget() || _confirmedSoldOut) return res;

    // preview 请求优先处理: productId 缺失检测 + bizId 校验 + soldOut 拦截
    if (/preview/i.test(url)) {
      try {
        const text = await res.clone().text();

        // productId 缺失检测 — 收到此错误后立即恢复并自动重试购买
        if (text.includes('productId') && text.includes('不能为空')) {
          log('[拦截] 检测到 "productId 不能为空"，启动恢复+重试...');
          ensureProductId();
          selectBilling();
          setTimeout(function () {
            if (!state.orderCreated) {
              log('[拦截] productId 已恢复，自动重新点击购买...');
              unlock();
              clickBuy();
            }
          }, 300);
        }

        // bizId 校验
        try {
          const data = _parse(text);
          if (data?.code === 200 && data?.data?.bizId) {
            const valid = await checkBizId(data.data.bizId);
            if (!valid) {
              return new Response(JSON.stringify({ code: -1, msg: 'bizId expired' }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
              });
            }
          }
        } catch (e) { }

        // soldOut 拦截 (preview 响应也可能包含 soldOut)
        if (shouldInterceptSoldOut()) {
          const modified = text
            .replace(/"isSoldOut"\s*:\s*true/g, '"isSoldOut":false')
            .replace(/"soldOut"\s*:\s*true/g, '"soldOut":false')
            .replace(/"is_sold_out"\s*:\s*true/g, '"is_sold_out":false')
            .replace(/"sold_out"\s*:\s*true/g, '"sold_out":false');
          if (modified !== text) log('[拦截] 已修改 preview 响应中的售罄状态');
          return new Response(modified, {
            status: res.status, statusText: res.statusText, headers: res.headers,
          });
        }
        return new Response(text, {
          status: res.status, statusText: res.statusText, headers: res.headers,
        });
      } catch (e) { return res; }
    }

    // 非 preview 的其他 API: soldOut 拦截
    if (/coding|plan|order|subscribe|product|package/i.test(url)) {
      try {
        const text = await res.clone().text();
        if (!shouldInterceptSoldOut()) {
          return new Response(text, {
            status: res.status, statusText: res.statusText, headers: res.headers,
          });
        }
        const fixed = text
          .replace(/"isSoldOut"\s*:\s*true/g, '"isSoldOut":false')
          .replace(/"soldOut"\s*:\s*true/g, '"soldOut":false')
          .replace(/"is_sold_out"\s*:\s*true/g, '"is_sold_out":false')
          .replace(/"sold_out"\s*:\s*true/g, '"sold_out":false');
        if (fixed !== text) log('[拦截] fetch 响应已修改');
        return new Response(fixed, {
          status: res.status, statusText: res.statusText, headers: res.headers,
        });
      } catch (e) { return res; }
    }

    return res;
  };

  // ===== 2a-2. check 校验 =====
  async function checkBizId(bizId) {
    try {
      const checkUrl = location.origin + '/api/biz/pay/check?bizId=' + encodeURIComponent(bizId);
      const resp = await _fetch(checkUrl, { credentials: 'include' });
      const data = await resp.json();
      if (data && data.data === 'EXPIRE') {
        log('[check] bizId=' + bizId + ' 已过期');
        return false;
      }
      log('[check] bizId=' + bizId + ' 校验通过');
      return true;
    } catch (e) {
      log('[check] 校验异常: ' + e.message);
      return true;
    }
  }

  // ===== 2b. XHR 拦截 (覆盖不走 fetch 的请求) =====
  const _xhrOpen = XMLHttpRequest.prototype.open;
  const _xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._sniperUrl = url;
    this._sniperMethod = method;
    this._sniperOpenRest = rest; // 保存 async/user/password 等额外参数
    this._sniperArgs = null;
    return _xhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const url = this._sniperUrl || '';

    // XHR 请求: 捕获 + 注入 productId (所有含 productId 字段的请求)
    if (args[0] && typeof args[0] === 'string') {
      try {
        var bodyObj = JSON.parse(args[0]);
        if (bodyObj && typeof bodyObj === 'object') {
          if (bodyObj.productId) {
            _capturedProductId = bodyObj.productId;
            if (/preview/i.test(url)) log('[捕获] productId=' + _capturedProductId + ' (XHR)');
          }
          if ('productId' in bodyObj && !bodyObj.productId && _capturedProductId) {
            bodyObj.productId = _capturedProductId;
            args[0] = JSON.stringify(bodyObj);
            log('[注入] 已补充 productId=' + _capturedProductId + ' (XHR) → ' + url.split('/').pop());
          }
        }
      } catch (e) { }
    }

    this._sniperArgs = args;
    if (isNearTarget() && !this._sniperHasRetryHandler) {
      this._sniperHasRetryHandler = true;
      this._sniperRetryCount = 0;
      this.addEventListener('load', function xhrRetryHandler() {
        if ([429, 500, 502, 503].includes(this.status) && this._sniperRetryCount < 8) {
          this._sniperRetryCount++;
          console.log('[GLM Sniper] XHR ' + this.status + '，重试' + this._sniperRetryCount + '/8: ' + this._sniperUrl);
          const self = this;
          setTimeout(() => {
            _xhrOpen.call(self, self._sniperMethod, self._sniperUrl, ...(self._sniperOpenRest || [true]));
            _xhrSend.apply(self, self._sniperArgs || []);
          }, 300 * this._sniperRetryCount);
        }
      });
    }
    return _xhrSend.apply(this, args);
  };

  // ===== 2c. 弹窗保护：检测验证码/支付弹窗，冻结刷新 =====
  function setupModalProtector() {
    new MutationObserver(() => {
      const modals = document.querySelectorAll(
        '[class*="modal"],[class*="dialog"],[class*="popup"],[role="dialog"]'
      );
      let foundRealModal = false;
      for (const modal of modals) {
        if (modal.offsetParent === null || modal.offsetHeight < 30) continue;
        const text = modal.textContent || '';
        const isCaptcha = text.includes('验证') || text.includes('滑动') || text.includes('拖动') ||
          modal.querySelector('[class*="captcha"],[class*="verify"],[class*="slider-"]');
        const isPayment = text.includes('扫码') || text.includes('支付') || text.includes('付款') ||
          modal.querySelector('canvas, img[src*="qr"], img[src*="pay"]');
        if (isCaptcha || isPayment) {
          foundRealModal = true;
          if (!state.modalVisible) {
            state.modalVisible = true;
            log('检测到' + (isCaptcha ? '验证码' : '支付') + '弹窗，已冻结刷新');
            setStatus('请完成验证码 / 扫码支付!', '#fc0');
            playBeep();
            highlightCaptcha(modal, isCaptcha);
          }
          break;
        }
      }
      if (!foundRealModal && state.modalVisible) {
        state.modalVisible = false;
        log('弹窗已消失，恢复自动抢购');
        recoverAfterCaptcha();
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  // ===== 2d. 错误页面 DOM 抑制 =====
  function setupErrorSuppressor() {
    new MutationObserver(() => {
      if (!isNearTarget() || state.modalVisible) return;
      const bodyText = document.body.textContent || '';
      if (!bodyText.includes('访问人数较多') && !bodyText.includes('请刷新重试') && !bodyText.includes('服务繁忙')) return;

      const errorNodes = document.querySelectorAll('div, section, p');
      for (const node of errorNodes) {
        const t = node.textContent || '';
        if ((t.includes('访问人数较多') || t.includes('请刷新重试')) && node.offsetHeight > 50) {
          node.style.display = 'none';
          console.log('[GLM Sniper] 隐藏错误页面，触发重新加载...');
          setTimeout(() => {
            const currentUrl = window.location.href;
            window.history.pushState(null, '', currentUrl);
            window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
          }, 500);
          setTimeout(() => {
            const hash = window.location.hash;
            window.location.hash = hash + '_retry';
            setTimeout(() => { window.location.hash = hash; }, 100);
          }, 1500);
          break;
        }
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ===== 3. 悬浮窗 =====
  if (document.getElementById('glm-sniper-overlay')) {
    document.getElementById('glm-sniper-overlay').remove();
  }

  const overlay = document.createElement('div');
  overlay.id = 'glm-sniper-overlay';
  overlay.innerHTML = `
    <div style="
      position:fixed;top:10px;right:10px;z-index:999999;
      background:rgba(0,0,0,0.9);color:#0f8;padding:16px 20px;
      border-radius:12px;font-family:Consolas,Monaco,monospace;
      font-size:14px;min-width:260px;
      box-shadow:0 4px 20px rgba(0,0,0,0.6);
      border:1px solid rgba(0,255,136,0.3);
    ">
      <div style="font-size:16px;font-weight:bold;margin-bottom:6px">
        GLM Sniper <span style="color:#888;font-size:12px">console ver.</span>
      </div>
      <div style="color:#fc0;margin-bottom:4px">目标: ${CONFIG.targetPlan.toUpperCase()} / ${{ monthly: '包月', quarterly: '包季', yearly: '包年' }[CONFIG.billingPeriod] || '包季'}</div>
      <div id="glm-cd" style="font-size:22px;margin:6px 0;color:#fff">--:--:--</div>
      <div id="glm-st" style="color:#aaa;font-size:12px">就绪</div>
      <div style="color:#f44;font-size:12px;margin-top:6px;font-weight:bold;line-height:1.4;">
        ⚠ 如果订单没有显示需要支付的金额，请不要扫码付款！
      </div>
      <div id="glm-log" style="
        margin-top:8px;max-height:100px;overflow-y:auto;
        font-size:11px;color:#888;
        border-top:1px solid rgba(255,255,255,0.1);padding-top:6px;
      "></div>
    </div>`;
  document.body.appendChild(overlay);

  function log(msg) {
    console.log('[GLM Sniper] ' + msg);
    const el = document.getElementById('glm-log');
    if (!el) return;
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    el.innerHTML = '<div>' + t + ' ' + msg + '</div>' + el.innerHTML;
    while (el.children.length > 15) el.removeChild(el.lastChild);
  }

  function setStatus(msg, color) {
    const el = document.getElementById('glm-st');
    if (el) { el.textContent = msg; el.style.color = color || '#aaa'; }
  }

  // ===== 4. TCP 预热 =====
  async function preheat() {
    log('TCP 预热中...');
    try {
      const paths = ['/favicon.ico', '/api/biz/pay/check?bizId=preheat', '/'];
      for (const p of paths) {
        _fetch(location.origin + p, { method: 'HEAD', cache: 'no-cache', credentials: 'include' }).catch(() => { });
      }
      log('预热完成 (3条连接已建立)');
    } catch (e) {
      log('预热失败，不影响使用');
    }
  }

  // ===== 5. 倒计时 =====
  function getTarget() {
    const now = new Date(), t = new Date(now);
    t.setHours(CONFIG.targetHour, CONFIG.targetMinute, CONFIG.targetSecond, 0);
    if (now >= t) t.setDate(t.getDate() + 1);
    return t;
  }

  setInterval(() => {
    const diff = getTarget() - new Date();
    const el = document.getElementById('glm-cd');
    if (!el) return;

    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    const ms = diff % 1000;

    if (state.isRunning || isNearTarget()) {
      el.textContent = '抢购中...';
      el.style.color = '#0f8';
    } else if (diff <= 60000) {
      el.textContent = s + '.' + String(ms).padStart(3, '0') + 's';
      el.style.color = '#f44';
    } else {
      el.textContent = [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
      el.style.color = diff <= 300000 ? '#fc0' : '#fff';
    }

    // TCP 预热 (提前3秒)
    if (diff <= 3000 && diff > 2000 && !state.preheated) {
      state.preheated = true;
      preheat();
    }

    // 到点开抢
    if (diff <= CONFIG.advanceMs && !state.isRunning) {
      state.isRunning = true;
      log('开始抢购!');
      setStatus('正在抢购...', '#0f8');
      startSnipe();
    }
  }, 50);

  // ===== 6. 抢购 =====
  function selectBilling() {
    const periods = {
      monthly: { match: '包月', exclude: ['包季', '包年'], label: '连续包月' },
      quarterly: { match: '包季', exclude: ['包月', '包年'], label: '连续包季' },
      yearly: { match: '包年', exclude: ['包月', '包季'], label: '连续包年' },
    };
    const p = periods[CONFIG.billingPeriod] || periods.quarterly;
    for (const el of document.querySelectorAll('div,span,button,a,li,label')) {
      const t = (el.textContent || '').trim();
      if (t.includes(p.match) && p.exclude.every(ex => !t.includes(ex)) && t.length < 20) {
        el.click();
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        log('已选择: ' + p.label);
        return;
      }
    }
    log('未找到' + p.label + '，使用默认');
  }

  function startSnipe() {
    if (_confirmedSoldOut) {
      log('已确认售罄，不启动抢购');
      setStatus('已售罄，明日再抢', '#f44');
      state.isRunning = false;
      return;
    }
    selectBilling();
    unlock();
    state.timerId = setInterval(() => {
      if (_confirmedSoldOut) {
        clearInterval(state.timerId);
        state.timerId = null;
        state.isRunning = false;
        log('已确认售罄，停止抢购');
        setStatus('已售罄，明日再抢', '#f44');
        return;
      }
      if (state.orderCreated) {
        clearInterval(state.timerId);
        return;
      }
      if (state.retryCount >= CONFIG.maxRetries) {
        clearInterval(state.timerId);
        state.isRunning = false;
        state.retryCount = 0;
        log('本轮重试结束，等待页面恢复后重新触发...');
        setStatus('等待页面恢复...', '#fc0');
        return;
      }
      state.retryCount++;
      if (state.retryCount % 10 === 1) {
        log('第 ' + state.retryCount + ' 次尝试...');
      }
      unlock();
      // 有弹窗时不点击，保护验证码/支付弹窗
      if (state.modalVisible) return;
      if (clickBuy()) {
        log('已点击购买按钮!');
        setStatus('等待响应...', '#0f8');
      }
      clickConfirm();
    }, CONFIG.retryInterval);
  }

  function unlock() {
    document.querySelectorAll('button[disabled],a[disabled]').forEach(el => {
      el.removeAttribute('disabled');
      el.disabled = false;
      el.style.pointerEvents = 'auto';
      el.style.opacity = '1';
    });
    document.querySelectorAll('.disabled,.is-disabled,.sold-out,.btn-disabled').forEach(el => {
      el.classList.remove('disabled', 'is-disabled', 'sold-out', 'btn-disabled');
      el.style.pointerEvents = 'auto';
      el.style.opacity = '1';
    });
  }

  function clickBuy() {
    const buyWords = ['购买', '订阅', '订购', '立即购买', '立即订阅', '特惠购买', '特惠订阅', 'Subscribe', 'Buy'];
    const planWords = {
      lite: ['lite', 'Lite', 'LITE', '基础', '轻量'],
      pro: ['pro', 'Pro', 'PRO', '专业', '进阶'],
      max: ['max', 'Max', 'MAX', '旗舰', '高级'],
    }[CONFIG.targetPlan] || [];

    let card = null;
    for (const el of document.querySelectorAll('div,section,li,article')) {
      const t = el.textContent || '';
      if (planWords.some(k => t.includes(k)) && el.offsetHeight < 800 && el.offsetWidth < 600 && el.offsetHeight > 50) {
        card = el;
        break;
      }
    }

    const root = card || document;
    for (const btn of root.querySelectorAll('button,a[role="button"],[class*="btn"],[class*="button"]')) {
      const t = (btn.textContent || '').trim();
      if (buyWords.some(k => t.includes(k))) {
        if (card || nearPlan(btn, planWords)) {
          fire(btn);
          return true;
        }
      }
    }
    return false;
  }

  function nearPlan(btn, words) {
    let el = btn;
    for (let i = 0; i < 6; i++) {
      el = el.parentElement;
      if (!el) return false;
      if (words.some(k => (el.textContent || '').includes(k))) return true;
    }
    return false;
  }

  function clickConfirm() {
    const words = ['确认', '确定', '立即支付', '去支付', '提交订单', '确认支付', 'Confirm', 'OK'];
    for (const modal of document.querySelectorAll('[class*="modal"],[class*="dialog"],[class*="popup"],[role="dialog"]')) {
      if (modal.offsetParent === null) continue;
      for (const btn of modal.querySelectorAll('button,a[role="button"]')) {
        const t = (btn.textContent || '').trim();
        if (words.some(k => t.includes(k))) {
          fire(btn);
          log('点击确认: ' + t);
          state.orderCreated = true;
          setStatus('订单已创建! 快扫码!', '#0f8');
          playBeep();
          setTimeout(forcePayDialog, 1500);
          return;
        }
      }
    }
  }

  function fire(el) {
    el.click();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }

  // ===== 7. 监控二维码出现 =====
  new MutationObserver(muts => {
    if (!state.isRunning) return;
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        const hasQR = n.querySelector?.('canvas,img[src*="qr"],img[src*="pay"]');
        const isModal = n.matches?.('[class*="modal"],[class*="dialog"],[role="dialog"]') ||
          n.closest?.('[class*="modal"],[class*="dialog"],[role="dialog"]');
        const t = n.textContent || '';
        const hasPayText = t.includes('扫码') || t.includes('支付宝') || t.includes('微信支付');
        if (hasQR || (isModal && hasPayText)) {
          log('支付二维码出现!');
          setStatus('快扫码支付!', '#0f8');
          state.orderCreated = true;
          clearInterval(state.timerId);
          playBeep();
          setTimeout(forcePayDialog, 1500);
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  // ===== 8. 页面恢复后自动触发抢购 =====
  function setupAutoSnipeOnReady() {
    setInterval(() => {
      const now = new Date();
      if (now.getHours() !== CONFIG.targetHour || now.getMinutes() > 30) return;
      if (state.isRunning || state.orderCreated || state.modalVisible || _confirmedSoldOut) return;

      const bodyText = document.body?.textContent || '';
      const hasError = ['访问人数较多', '请刷新重试', '服务繁忙'].some(kw => bodyText.includes(kw));
      if (hasError) return;

      const hasBuyButton = ['购买', '订阅', '订购', '特惠订阅', '特惠购买'].some(kw => bodyText.includes(kw));
      if (!hasBuyButton) return;

      log('页面恢复正常，自动触发抢购!');
      setStatus('页面恢复，正在抢购...', '#0f8');
      state.isRunning = true;
      startSnipe();
    }, 2000);
  }

  // ===== 9. Vue 组件直接操作 =====

  // 验证码完成后多轮恢复 productId，防止 "productId 不能为空"
  function recoverAfterCaptcha() {
    log('[恢复] 验证码完成，开始多轮恢复 productId...');
    // 第1轮: 立即恢复
    selectBilling();
    ensureProductId();
    // 第2轮: 200ms 后 (等 Vue 渲染)
    setTimeout(function () { ensureProductId(); unlock(); }, 200);
    // 第3轮: 500ms 后，若 productId 仍为空则重新请求
    setTimeout(function () {
      ensureProductId();
      if (!_capturedProductId) {
        log('[恢复] productId 仍为空，尝试重新获取产品数据...');
        refetchProductData();
      }
    }, 500);
    // 第4轮: 1500ms 后最终检查
    setTimeout(function () {
      ensureProductId();
      if (!_capturedProductId) {
        log('[恢复] productId 持续为空，触发 SPA 路由重载...');
        var cur = window.location.href;
        window.history.pushState(null, '', cur);
        window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
      } else {
        log('[恢复] productId 已恢复: ' + _capturedProductId);
      }
    }, 1500);
  }

  function refetchProductData() {
    var paths = ['/api/biz/product/batch-preview', '/api/biz/product/list', '/api/glm-coding/product'];
    paths.forEach(function (path) {
      _fetch(location.origin + path, { method: 'GET', credentials: 'include', headers: { 'Accept': 'application/json' } })
        .then(function (resp) {
          if (!resp.ok || _capturedProductId) return;
          return resp.text();
        })
        .then(function (text) {
          if (!text || _capturedProductId) return;
          try { JSON.parse(text); } catch (e) { }
          if (_capturedProductId) {
            log('[恢复] 从 ' + path + ' 重新获取到 productId=' + _capturedProductId);
            ensureProductId();
          }
        })
        .catch(function () { });
    });
  }

  function ensureProductId() {
    const pid = getProductId();
    if (!pid) { log('[Vue] 没有捕获到 productId，无法恢复'); return; }
    const app = document.querySelector('#app');
    const vue = app?.__vue__;
    if (!vue) return;
    let fixed = 0;
    const walk = (vm, depth) => {
      if (depth > 10) return;
      if (vm.$data) {
        for (const key of Object.keys(vm.$data)) {
          if (/product.?id/i.test(key) && !vm.$data[key]) {
            vm[key] = _capturedProductId;
            fixed++;
            log('[Vue] 已设置 ' + key + '=' + _capturedProductId);
          }
        }
      }
      for (const child of (vm.$children || [])) walk(child, depth + 1);
    };
    walk(vue, 0);
    if (fixed === 0) {
      const walkAll = (vm, depth) => {
        if (depth > 10 || fixed > 0) return;
        if (vm.$data) {
          for (const key of Object.keys(vm.$data)) {
            if (/product.?id/i.test(key)) {
              vm[key] = _capturedProductId;
              fixed++;
              log('[Vue] 强制设置 ' + key + '=' + _capturedProductId);
              return;
            }
          }
        }
        for (const child of (vm.$children || [])) walkAll(child, depth + 1);
      };
      walkAll(vue, 0);
    }
  }

  function forcePayDialog() {
    const app = document.querySelector('#app');
    const vue = app?.__vue__;
    if (!vue) return;

    let payComp = null;
    const find = (vm, depth) => {
      if (depth > 8) return;
      if (vm.$data && 'payDialogVisible' in vm.$data) { payComp = vm; return; }
      for (const child of (vm.$children || [])) { find(child, depth + 1); if (payComp) return; }
    };
    find(vue, 0);

    if (!payComp) { log('[Vue] 未找到支付组件'); return; }
    if (payComp.payDialogVisible) { log('[Vue] 支付弹窗已显示'); return; }

    payComp.payDialogVisible = true;
    log('[Vue] 已直接设置 payDialogVisible=true');
  }

  function patchVueServerBusy() {
    let attempts = 0;
    const tid = setInterval(() => {
      if (++attempts > 30) { clearInterval(tid); return; }
      const vue = document.querySelector('#app')?.__vue__;
      if (!vue) return;
      let patched = 0;
      const walk = (vm, depth) => {
        if (depth > 8) return;
        if (vm.$data?.isServerBusy === true) { vm.isServerBusy = false; patched++; }
        for (const child of (vm.$children || [])) walk(child, depth + 1);
      };
      walk(vue, 0);
      if (patched > 0) {
        log('[Vue] 已解除 isServerBusy (' + patched + '个组件)');
        clearInterval(tid);
      }
    }, 500);
  }

  let _audioCtx = null;
  function playBeep() {
    try {
      if (!_audioCtx) _audioCtx = new AudioContext();
      const c = _audioCtx;
      const freqs = [660, 880, 1100, 880, 1100];
      freqs.forEach((freq, i) => {
        const o = c.createOscillator(), g = c.createGain();
        o.connect(g); g.connect(c.destination);
        o.frequency.value = freq; g.gain.value = 0.4;
        const t = c.currentTime + i * 0.18;
        o.start(t); o.stop(t + 0.12);
      });
    } catch (e) { }
  }

  function highlightCaptcha(modal, isCaptcha) {
    try {
      modal.scrollIntoView({ behavior: 'instant', block: 'center' });
      modal.style.outline = '3px solid #ff0';
      modal.style.outlineOffset = '2px';
      modal.style.boxShadow = '0 0 30px rgba(255,255,0,0.6)';
      if (!document.getElementById('glm-captcha-pulse')) {
        const s = document.createElement('style');
        s.id = 'glm-captcha-pulse';
        s.textContent = '@keyframes glm-pulse{0%,100%{outline-color:#ff0;box-shadow:0 0 20px rgba(255,255,0,.4)}50%{outline-color:#f80;box-shadow:0 0 40px rgba(255,128,0,.7)}}.glm-captcha-highlight{animation:glm-pulse .8s ease-in-out infinite!important;outline:3px solid #ff0!important;outline-offset:2px!important}';
        document.head.appendChild(s);
      }
      modal.classList.add('glm-captcha-highlight');
      if (isCaptcha) {
        setStatus('⚡ 检测到验证码，尝试自动识别...', '#ff0');
        setTimeout(() => tryAutoSolveCaptcha(modal), 500);
      }
      const cleanup = () => {
        if (!state.modalVisible) {
          modal.classList.remove('glm-captcha-highlight');
          modal.style.outline = modal.style.outlineOffset = modal.style.boxShadow = '';
        } else setTimeout(cleanup, 500);
      };
      setTimeout(cleanup, 500);
    } catch (e) { }
  }

  // ===== 6b. 文字点选验证码自动识别 =====
  const CAPTCHA_API = 'http://127.0.0.1:9898/solve';

  async function tryAutoSolveCaptcha(modal) {
    try {
      log('[自动验证码] 开始识别文字点选...');
      let imgEl = modal.querySelector(
        'img[class*="captcha"],img[class*="bg"],img[class*="pic"],' +
        'img[class*="verify"],img[src*="captcha"],img[src*="verify"],' +
        'canvas[class*="captcha"],canvas[class*="bg"]'
      );
      if (!imgEl) {
        const cands = [...modal.querySelectorAll('img,canvas')]
          .filter(el => el.offsetWidth > 100 && el.offsetHeight > 80);
        cands.sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight));
        imgEl = cands[0] || null;
      }
      if (!imgEl) { log('[自动验证码] 未找到图片，请手动完成'); setStatus('⚠ 请手动点击验证码', '#f44'); return false; }

      const promptText = extractTargetChars(modal);
      log('[自动验证码] 目标文字: "' + promptText + '"');

      const imgB64 = await elemToB64(imgEl);
      if (!imgB64) { log('[自动验证码] 无法获取图片'); return false; }

      let promptImgB64 = '';
      if (!promptText) {
        const pi = modal.querySelector('img[class*="tip"],img[class*="prompt"],img[class*="word"]');
        if (pi) promptImgB64 = await elemToB64(pi) || '';
      }

      log('[自动验证码] 发送给 OCR 服务器...');
      setStatus('⏳ OCR 识别中...', '#ff0');

      let result;
      try {
        const resp = await _fetch(CAPTCHA_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: imgB64, target: promptText, prompt_image: promptImgB64 }),
        });
        result = await resp.json();
      } catch (e) {
        log('[自动验证码] ⚠ OCR 服务未启动! 请运行: cd captcha-server && python server.py');
        setStatus('⚠ OCR 未连接，请手动点击', '#f44');
        return false;
      }

      if (!result.success || !result.points || result.points.length === 0) {
        log('[自动验证码] OCR 识别失败'); setStatus('⚠ 识别失败，请手动点击', '#f44'); return false;
      }

      log('[自动验证码] 识别到 ' + result.points.length + ' 个点位 (' + result.time_ms + 'ms)');

      const rect = imgEl.getBoundingClientRect();
      const nw = imgEl.naturalWidth || imgEl.width || rect.width;
      const nh = imgEl.naturalHeight || imgEl.height || rect.height;
      const sx = rect.width / nw, sy = rect.height / nh;

      for (let i = 0; i < result.points.length; i++) {
        const pt = result.points[i];
        const cx = rect.left + pt.x * sx + (Math.random() - 0.5) * 6;
        const cy = rect.top + pt.y * sy + (Math.random() - 0.5) * 6;
        if (i > 0) await new Promise(r => setTimeout(r, 200 + Math.random() * 200));
        log('[自动验证码] 点击第' + (i + 1) + '个: "' + pt.char + '"');
        simClick(cx, cy);
      }

      await new Promise(r => setTimeout(r, 300 + Math.random() * 200));
      for (const btn of modal.querySelectorAll('button,[class*="confirm"],[class*="submit"]')) {
        const t = (btn.textContent || '').trim();
        if (t.includes('确') || t.includes('提交') || t.includes('验证') || t.length <= 4) {
          log('[自动验证码] 点击确认: "' + t + '"'); btn.click(); break;
        }
      }

      await new Promise(r => setTimeout(r, 1200));
      if (modal.offsetParent !== null && modal.offsetHeight > 30 && state.modalVisible) {
        log('[自动验证码] 未通过，等待重试...');
        setTimeout(() => { if (state.modalVisible) tryAutoSolveCaptcha(modal); }, 2000);
        return false;
      }
      log('[自动验证码] ✅ 验证通过!');
      return true;
    } catch (e) { log('[自动验证码] 异常: ' + e.message); return false; }
  }

  function extractTargetChars(modal) {
    const txt = modal.textContent || '';
    const pats = [
      /请[依按]?[次顺]?[序]?点击[：:\s]*[「【""]?([^\n」】""]{1,10})[」】"""]?/,
      /点击[：:\s]*[「【""]?([^\n」】""]{1,10})[」】"""]?/,
      /请[依按]?[次顺]?[序]?选择[：:\s]*[「【""]?([^\n」】""]{1,10})[」】"""]?/,
    ];
    for (const p of pats) { const m = txt.match(p); if (m && m[1]) return m[1].replace(/[^\u4e00-\u9fff]/g, ''); }
    let chars = '';
    for (const el of modal.querySelectorAll('span,em,b,strong')) {
      const t = (el.textContent || '').trim();
      if (t.length === 1 && /[\u4e00-\u9fff]/.test(t)) chars += t;
    }
    return chars;
  }

  async function elemToB64(el) {
    try {
      if (el.tagName === 'CANVAS') return el.toDataURL('image/png').split(',')[1];
      const cv = document.createElement('canvas'), cx = cv.getContext('2d');
      if (!el.complete) await new Promise(r => { el.onload = r; setTimeout(r, 3000); });
      cv.width = el.naturalWidth || el.width; cv.height = el.naturalHeight || el.height;
      cx.drawImage(el, 0, 0);
      return cv.toDataURL('image/png').split(',')[1];
    } catch (e) {
      try {
        const src = el.src || el.currentSrc; if (!src) return null;
        const resp = await _fetch(src, { credentials: 'include' });
        const blob = await resp.blob();
        return new Promise(r => { const fr = new FileReader(); fr.onloadend = () => r(fr.result.split(',')[1]); fr.readAsDataURL(blob); });
      } catch (e2) { return null; }
    }
  }

  function simClick(x, y) {
    const t = document.elementFromPoint(x, y); if (!t) return;
    const o = { clientX: x, clientY: y, bubbles: true, cancelable: true };
    t.dispatchEvent(new PointerEvent('pointerdown', o));
    t.dispatchEvent(new MouseEvent('mousedown', o));
    t.dispatchEvent(new PointerEvent('pointerup', o));
    t.dispatchEvent(new MouseEvent('mouseup', o));
    t.dispatchEvent(new MouseEvent('click', o));
  }

  // ===== 10. 启动 =====
  setupModalProtector();
  setupErrorSuppressor();
  setupAutoSnipeOnReady();
  patchVueServerBusy();
  unlock();
  log('脚本已启动 - 目标: ' + CONFIG.targetPlan.toUpperCase());
  log('到 ' + CONFIG.targetHour + ':00 自动抢购');
  log('页面异常自动恢复，弹窗自动冻结刷新');
  log('已启用: TCP预热/指纹随机化/check校验/Vue直接操作');
  setStatus('等待中...', '#aaa');

  // 定期检查 productId 是否已捕获
  const pidTimer = setInterval(() => {
    if (_capturedProductId) { clearInterval(pidTimer); return; }
    getProductId();
  }, 3000);

  // 如果现在刚好是10:00
  const now = new Date();
  if (now.getHours() === CONFIG.targetHour && now.getMinutes() <= 30) {
    // 延迟2秒等待 API 数据加载，以便售罄检测生效
    setTimeout(() => {
      if (_confirmedSoldOut) {
        log('已确认售罄，不启动抢购');
        setStatus('已售罄，明日再抢', '#f44');
        return;
      }
      log('现在就是抢购时间!');
      state.isRunning = true;
      startSnipe();
    }, 2000);
  }

  console.log('%c[GLM Sniper] 脚本加载成功! 看右上角悬浮窗', 'color:#0f8;font-size:16px;font-weight:bold');
})();
