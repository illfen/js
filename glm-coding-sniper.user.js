// ==UserScript==
// @name         GLM Coding Plan Pro 自动抢购
// @namespace    https://bigmodel.cn
// @version      1.3.0
// @description  每天10:00自动抢购GLM Coding Plan Pro套餐，拦截售罄+自动点击+错误恢复+弹窗保护+自动重触发
// @author       qiandai
// @match        https://open.bigmodel.cn/*
// @match        https://www.bigmodel.cn/*
// @match        https://bigmodel.cn/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ==================== 0. 限流页面早期退出 ====================
  // 在 rate-limit 页面上运行会触发 CSP 错误，直接跳回购买页
  if (window.location.pathname.includes('rate-limit') || window.location.href.includes('rate-limit.html')) {
    const redirectCount = parseInt(sessionStorage.getItem('glm_redirect_count') || '0');
    if (redirectCount >= 10) {
      console.log('[GLM Sniper] 重定向次数过多 (10次)，冷却30秒...');
      sessionStorage.setItem('glm_redirect_count', '0');
      setTimeout(() => window.location.replace('https://open.bigmodel.cn/glm-coding'), 30000);
      return;
    }
    sessionStorage.setItem('glm_redirect_count', String(redirectCount + 1));
    console.log(`[GLM Sniper] 检测到限流页，跳回购买页... (第${redirectCount + 1}次)`);
    setTimeout(() => window.location.replace('https://open.bigmodel.cn/glm-coding'), 1000 + redirectCount * 500);
    return;
  }

  // 成功到达非限流页面，重置重定向计数器
  sessionStorage.setItem('glm_redirect_count', '0');

  // ==================== 配置 ====================
  const CONFIG = {
    // 目标套餐: 'lite' | 'pro' | 'max'
    targetPlan: 'pro',
    // 计费周期: 'monthly' | 'quarterly' | 'yearly'
    billingPeriod: 'quarterly',
    // 抢购时间 (24小时制)
    targetHour: 10,
    targetMinute: 0,
    targetSecond: 0,
    // 提前多少毫秒开始点击 (补偿网络延迟)
    advanceMs: 200,
    // 点击重试间隔(ms)
    retryInterval: 100,
    // 最大重试次数 (300次 * 100ms = 30秒)
    maxRetries: 300,
    // 是否自动刷新页面 (在9:59:50自动刷新一次以获取最新状态)
    autoRefresh: true,
    autoRefreshSecondsBefore: 10,
    // 测试模式: 设为 true 则始终拦截 soldOut (不限时间窗口)，测试完记得关掉
    testMode: false,
  };

  // ==================== 状态 ====================
  let state = {
    retryCount: 0,
    isRunning: false,
    orderCreated: false,
    modalVisible: false,  // 检测到弹窗（验证码/支付）后停止一切刷新
    preheated: false,     // TCP 预热是否已完成
    timerId: null,
    countdownId: null,
  };

  // ==================== 1. 拦截 JSON.parse，修改售罄状态 ====================
  // 只在 10:00 前1分钟内才拦截，避免非抢购时段产生无效订单
  function isNearTargetTime() {
    const now = new Date();
    const target = new Date(now);
    target.setHours(CONFIG.targetHour, CONFIG.targetMinute, CONFIG.targetSecond, 0);
    const diff = target - now;
    // 前1分钟 到 后30分钟 的窗口期内才拦截 (9:59 ~ 10:30)
    return diff <= 60000 && diff >= -1800000;
  }

  // 售罄确认机制：前2分钟无条件拦截，之后连续N次soldOut则判定为真正售罄
  let _soldOutCount = 0;          // 连续 soldOut 计数
  let _confirmedSoldOut = false;  // 是否已确认售罄

  function isInRushWindow() {
    // 10:00 后前2分钟 = 黄金抢购窗口，无条件拦截
    const now = new Date();
    const target = new Date(now);
    target.setHours(CONFIG.targetHour, CONFIG.targetMinute, CONFIG.targetSecond, 0);
    const elapsed = now - target; // 过了多久
    return elapsed >= 0 && elapsed < 120000; // 0~2分钟
  }

  function shouldInterceptSoldOut() {
    if (_confirmedSoldOut) return false;
    if (CONFIG.testMode) return true; // 测试模式无条件拦截
    if (isInRushWindow()) return true; // 前2分钟无条件拦截
    // 2分钟后：本次响应中所有产品都售罄 → 确认售罄，停止拦截
    if (_soldOutCount >= 3) {
      confirmSoldOut();
      return false;
    }
    // 部分售罄（<3），继续拦截
    return true;
  }

  function confirmSoldOut() {
    if (_confirmedSoldOut) return;
    _confirmedSoldOut = true;
    log('已确认售罄，停止抢购');
    setStatus('已售罄，明日再抢', '#ff4444');
    // 停止所有正在运行的抢购逻辑
    if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
    state.isRunning = false;
  }

  // 捕获的 productId (从 JSON.parse / API 响应 / 请求中提取)
  // 注意: 必须在 JSON.parse 拦截之前声明，否则闭包引用会落入 let 的暂时性死区
  let _capturedProductId = null;
  let _capturedProductInfo = null; // 完整的产品信息

  const originalParse = JSON.parse;
  JSON.parse = function (...args) {
    let result = originalParse.apply(this, args);
    try {
      // 始终捕获 productId（不受时间窗口限制，页面加载时就捕获）
      if (!_capturedProductId) {
        // 调试: 看看有没有任何含 product 的 JSON 数据经过
        const raw = typeof args[0] === 'string' ? args[0] : '';
        if (raw.includes('productId') || raw.includes('productList') || raw.includes('productName') || raw.includes('membership')) {
          log('[捕获调试] JSON.parse 发现产品相关数据: ' + raw.substring(0, 500));
        }
        captureProductIdFromData(result);
      }
      // soldOut 拦截 (testMode 下始终生效)
      if (CONFIG.testMode || isNearTargetTime()) {
        // 先统计本次响应中有多少个 soldOut，再统一决定是否拦截
        _soldOutCount = countSoldOut(result);
        if (shouldInterceptSoldOut()) {
          result = deepModifySoldOut(result);
        }
      }
    } catch (e) {
      // 静默失败，不影响页面正常功能
    }
    return result;
  };

  // 伪装拦截后的 JSON.parse，防止被检测
  Object.defineProperty(JSON.parse, 'toString', {
    value: () => 'function parse() { [native code] }',
  });

  // 从 batch-preview 响应中按价格+折扣识别目标套餐的 productId
  // API 返回的 productList 没有 name 字段，只能通过价格区分套餐:
  //   Lite: monthlyOriginalAmount=49, Pro: =149, Max: =469
  // 计费周期通过 campaignDiscountDetails 区分:
  //   monthly: 无折扣, quarterly: "包季", yearly: "包年"
  let _allProductIds = {}; // { 'lite_monthly': productId, ... }

  const PLAN_PRICE_MAP = { lite: 49, pro: 149, max: 469 };

  function identifyPlanFromProduct(item) {
    const price = Number(item.monthlyOriginalAmount);
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

    // 检测 batch-preview 响应结构: { data: { productList: [...] } }
    if (obj.productList && Array.isArray(obj.productList)) {
      log(`[捕获调试] 发现 productList (${obj.productList.length}项)`);
      for (const item of obj.productList) {
        if (!item) continue;
        // 调试: 打印每个产品的关键字段
        log(`[捕获调试] 产品: pid=${item.productId} price=${item.monthlyOriginalAmount} campaigns=${JSON.stringify((item.campaignDiscountDetails || []).map(c => c.campaignName))}`);
        // 直接用 productId，不管能不能识别套餐
        if (item.productId) {
          const info = identifyPlanFromProduct(item);
          log(`[捕获调试] 识别结果: pid=${item.productId} → info=${JSON.stringify(info)} 目标=${CONFIG.targetPlan}/${CONFIG.billingPeriod} 已有=${_capturedProductId}`);
          if (info) {
            const key = `${info.plan}_${info.period}`;
            _allProductIds[key] = item.productId;
            if (!_capturedProductId && info.plan === CONFIG.targetPlan && info.period === CONFIG.billingPeriod) {
              _capturedProductId = item.productId;
              _capturedProductInfo = item;
              log(`[捕获] ✅ productId=${item.productId} (${CONFIG.targetPlan}/${CONFIG.billingPeriod})`);
            }
          } else {
            _allProductIds[`unknown_${item.productId}`] = item.productId;
          }
        }
      }
      if (Object.keys(_allProductIds).length > 0 && !_capturedProductId) {
        log(`[捕获] 找到${Object.keys(_allProductIds).length}个产品但未精确匹配，尝试回退`);
        getProductId(); // 尝试回退匹配
      }
      return;
    }
    // 直接含 productId 的对象 (如单个预览响应)
    if (obj.productId && !_capturedProductId) {
      _capturedProductId = obj.productId;
      log(`[捕获] 直接捕获 productId=${obj.productId}`);
      return;
    }

    // 递归搜索嵌套的 data 字段
    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (item && typeof item === 'object') captureProductIdFromData(item);
      }
    } else {
      for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') captureProductIdFromData(v);
      }
    }
  }

  // 获取 productId（含备选列表回退）
  function getProductId() {
    if (_capturedProductId) return _capturedProductId;
    // 精确匹配
    const exactKey = `${CONFIG.targetPlan}_${CONFIG.billingPeriod}`;
    if (_allProductIds[exactKey]) {
      _capturedProductId = _allProductIds[exactKey];
      log(`[回退] 精确匹配 productId=${_capturedProductId} (${exactKey})`);
      return _capturedProductId;
    }
    // 同套餐不同周期
    for (const [key, pid] of Object.entries(_allProductIds)) {
      if (key.startsWith(CONFIG.targetPlan + '_')) {
        _capturedProductId = pid;
        log(`[回退] 同套餐匹配 productId=${pid} (${key})`);
        return pid;
      }
    }
    // 最后回退：任意可用
    const entries = Object.entries(_allProductIds);
    if (entries.length > 0) {
      _capturedProductId = entries[0][1];
      log(`[回退] 使用首个可用 productId=${_capturedProductId} (${entries[0][0]})`);
      return _capturedProductId;
    }
    return null;
  }

  // 统计对象中 soldOut 为 true 的数量
  function countSoldOut(obj) {
    if (obj === null || typeof obj !== 'object') return 0;
    if (Array.isArray(obj)) return obj.reduce((n, item) => n + countSoldOut(item), 0);
    let count = 0;
    for (const key of Object.keys(obj)) {
      if ((key === 'isSoldOut' || key === 'soldOut' || key === 'is_sold_out' || key === 'sold_out') && obj[key] === true) {
        count++;
      }
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        count += countSoldOut(obj[key]);
      }
    }
    return count;
  }

  function deepModifySoldOut(obj) {
    if (obj === null || typeof obj !== 'object') return obj;

    if (Array.isArray(obj)) {
      return obj.map(deepModifySoldOut);
    }

    for (const key of Object.keys(obj)) {
      if (
        key === 'isSoldOut' ||
        key === 'soldOut' ||
        key === 'is_sold_out' ||
        key === 'sold_out'
      ) {
        if (obj[key] === true) {
          obj[key] = false;
          log(`[拦截] 将 ${key} 从 true 改为 false`);
        }
      }
      if (key === 'isServerBusy' && obj[key] === true) {
        obj[key] = false;
        log('[拦截] 将 isServerBusy 从 true 改为 false');
      }
      // 解除 disabled (参考: 如果对象看起来是商品，则强制启用)
      if (key === 'disabled' && obj[key] === true && (obj.price !== undefined || obj.productId || obj.title)) {
        obj[key] = false;
      }
      // 库存为0也改大 (前端展示用)
      if (key === 'stock' && obj[key] === 0) {
        obj[key] = 999;
      }
      // 递归处理嵌套对象
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        obj[key] = deepModifySoldOut(obj[key]);
      }
    }
    return obj;
  }

  // ==================== 2. 拦截 fetch + XHR (自动重试 + soldOut修改) ====================

  // --- 2a. fetch 拦截 ---
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    // 请求指纹随机化 — 每次请求看起来不一样，降低被识别为脚本的概率
    if (isNearTargetTime() && args[1]) {
      const headers = new Headers(args[1].headers);
      headers.set('X-Request-Id', Math.random().toString(36).slice(2, 15));
      headers.set('X-Timestamp', String(Date.now()));
      const q = (0.5 + Math.random() * 0.5).toFixed(1);
      headers.set('Accept-Language', `zh-CN,zh;q=${q},en;q=${(q * 0.7).toFixed(1)}`);
      args[1] = { ...args[1], headers };
    }

    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

    // 所有包含 body 的请求: 捕获 productId + 注入缺失的 productId
    if (args[1]?.body && typeof args[1].body === 'string') {
      try {
        let bodyObj = JSON.parse(args[1].body);
        if (bodyObj && typeof bodyObj === 'object') {
          // 调试: 打印所有含 productId 或发往 membership 的请求
          if ('productId' in bodyObj || /membership|order|pay|subscribe|preview/i.test(url)) {
            log(`[请求调试] ${url.split('/').pop()} body.productId=${bodyObj.productId} _captured=${_capturedProductId}`);
          }
          // 捕获 productId
          if (bodyObj.productId) {
            _capturedProductId = bodyObj.productId;
            if (/preview/i.test(url)) log(`[捕获] productId=${_capturedProductId}`);
          }
          // 注入缺失的 productId (为空、为0、为null 都注入)
          if ('productId' in bodyObj && !bodyObj.productId && _capturedProductId) {
            bodyObj.productId = _capturedProductId;
            args[1] = { ...args[1], body: JSON.stringify(bodyObj) };
            log(`[注入] ✅ productId=${_capturedProductId} → ${url.split('/').pop()}`);
          }
        }
      } catch (e) { }
    }

    let response = await originalFetch.apply(this, args);

    // 抢购窗口内，失败请求自动重试
    if (isNearTargetTime() && [429, 500, 502, 503].includes(response.status)) {
      for (let retry = 1; retry <= 8; retry++) {
        console.log(`[GLM Sniper] fetch ${response.status}，重试${retry}: ${url}`);
        await new Promise(r => setTimeout(r, 300 * retry));
        try {
          response = await originalFetch.apply(this, args);
          if (response.ok) { console.log('[GLM Sniper] fetch 重试成功!'); break; }
        } catch (e) { }
      }
    }

    // 从产品列表 API 响应中捕获 productId
    if (!_capturedProductId && /coding|plan|product|package/i.test(url)) {
      try {
        const clone = response.clone();
        const text = await clone.text();
        // 匹配目标套餐的 productId
        const planKey = CONFIG.targetPlan.toLowerCase();
        const parsed = JSON.parse(text);
        const findProductId = (obj) => {
          if (!obj || typeof obj !== 'object') return null;
          if (Array.isArray(obj)) {
            for (const item of obj) {
              const name = (item.name || item.title || item.planName || item.planType || '').toLowerCase();
              if (name.includes(planKey) && (item.productId || item.id)) {
                return item.productId || item.id;
              }
              const found = findProductId(item);
              if (found) return found;
            }
          } else {
            for (const v of Object.values(obj)) {
              const found = findProductId(v);
              if (found) return found;
            }
          }
          return null;
        };
        const found = findProductId(parsed);
        if (found) {
          _capturedProductId = found;
          log(`[捕获] 从API响应获取 productId=${_capturedProductId}`);
        }
      } catch (e) { }
    }

    // soldOut 拦截 (testMode 下始终生效; 否则需在时间窗口内且未确认售罄)
    if (!(CONFIG.testMode || isNearTargetTime()) || (!CONFIG.testMode && _confirmedSoldOut)) return response;

    // preview 请求优先处理: productId 缺失检测 + bizId 校验 + soldOut 拦截
    // 注意: preview URL 通常包含 "plan" 字样，若放在 soldOut 块后面会被提前 return 跳过
    if (/preview/i.test(url)) {
      try {
        const text = await response.clone().text();

        // productId 缺失检测 — 收到此错误后立即恢复并自动重试购买
        if (text.includes('productId') && text.includes('不能为空')) {
          log('[拦截] 检测到 "productId 不能为空"，启动恢复+重试...');
          ensureProductId();
          selectBillingPeriod();
          // 恢复后自动重新触发购买流程
          setTimeout(() => {
            if (!state.orderCreated) {
              log('[拦截] productId 已恢复，自动重新点击购买...');
              removeAllDisabled();
              tryClickPurchaseButton();
            }
          }, 300);
        }

        // bizId 校验
        try {
          const data = originalParse(text);
          if (data?.code === 200 && data?.data?.bizId) {
            const valid = await checkBizId(data.data.bizId);
            if (!valid) {
              return new Response(JSON.stringify({ code: -1, msg: 'bizId expired' }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
              });
            }
          }
        } catch (e) { }

        // soldOut 拦截统一由 JSON.parse 层处理（确保 countSoldOut 能看到原始值）
        return new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (e) { return response; }
    }

    // soldOut 拦截统一由 JSON.parse 层处理，fetch 层不再做字符串替换
    // 这样 countSoldOut 能看到原始 soldOut 值，confirmSoldOut 才能正确触发
    return response;
  };

  // --- 2a-2. check 校验: 验证 bizId 有效性 ---
  async function checkBizId(bizId) {
    try {
      const checkUrl = `${location.origin}/api/biz/pay/check?bizId=${encodeURIComponent(bizId)}`;
      const resp = await originalFetch(checkUrl, { credentials: 'include' });
      const data = await resp.json();
      if (data && data.data === 'EXPIRE') {
        log(`[check] bizId=${bizId} 已过期`);
        return false;
      }
      log(`[check] bizId=${bizId} 校验通过`);
      return true;
    } catch (e) {
      log(`[check] 校验异常: ${e.message}`);
      return true; // 异常时放行
    }
  }

  // --- 2b. XMLHttpRequest 拦截 (覆盖不走 fetch 的请求) ---
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
        let bodyObj = JSON.parse(args[0]);
        if (bodyObj && typeof bodyObj === 'object') {
          if (bodyObj.productId) {
            _capturedProductId = bodyObj.productId;
            if (/preview/i.test(url)) log(`[捕获] productId=${_capturedProductId} (XHR)`);
          }
          if ('productId' in bodyObj && !bodyObj.productId && _capturedProductId) {
            bodyObj.productId = _capturedProductId;
            args[0] = JSON.stringify(bodyObj);
            log(`[注入] 已补充 productId=${_capturedProductId} (XHR) → ${url.split('/').pop()}`);
          }
        }
      } catch (e) { }
    }

    this._sniperArgs = args;
    if (isNearTargetTime() && !this._sniperHasRetryHandler) {
      this._sniperHasRetryHandler = true;
      this._sniperRetryCount = 0;
      this.addEventListener('load', function xhrRetryHandler() {
        if ([429, 500, 502, 503].includes(this.status) && this._sniperRetryCount < 8) {
          this._sniperRetryCount++;
          console.log(`[GLM Sniper] XHR ${this.status}，重试${this._sniperRetryCount}/8: ${this._sniperUrl}`);
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

  // --- 2c. 弹窗保护：检测验证码/支付弹窗，一旦出现则冻结所有刷新逻辑 ---
  function setupModalProtector() {
    if (!document.body) {
      setTimeout(setupModalProtector, 200);
      return;
    }

    new MutationObserver(() => {
      // 只检测真正的验证码/支付弹窗，避免误判普通页面元素
      const modals = document.querySelectorAll(
        '[class*="modal"],[class*="dialog"],[class*="popup"],[role="dialog"]'
      );
      // 先扫描所有弹窗，验证码优先于支付 (两者可能同时存在)
      let captchaModal = null, paymentModal = null;
      for (const modal of modals) {
        if (modal.offsetParent === null || modal.offsetHeight < 30) continue;
        const text = modal.textContent || '';
        const hasCaptchaWidget = modal.querySelector('[class*="captcha"],[class*="tcaptcha"],[class*="slider-"]');
        const isPaymentContent = text.includes('实付金额') || text.includes('支付宝') || text.includes('扫码支付') || text.includes('连续包') || text.includes('账号使用规范');
        if (!isPaymentContent && (text.includes('点击') || text.includes('验证') || text.includes('滑动') || text.includes('拖动') || hasCaptchaWidget)) {
          captchaModal = modal;
        }
        const hasQrImg = !!modal.querySelector('img[src*="qr"], img[src*="pay"]');
        if (text.includes('扫码') || text.includes('支付') || text.includes('付款') || hasQrImg) {
          paymentModal = modal;
        }
      }
      // 如果付款弹窗已出现（含实付金额/扫码支付等），说明验证码已通过，优先付款
      if (captchaModal && paymentModal) {
        const payText = paymentModal.textContent || '';
        if (payText.includes('实付金额') || payText.includes('扫码支付') || payText.includes('连续包') || payText.includes('支付宝')) {
          captchaModal = null; // 验证码已完成，清除引用
        }
      }
      const activeModal = captchaModal || paymentModal;
      const isCaptcha = !!captchaModal;
      const isPayment = !captchaModal && !!paymentModal;
      // 付款页面可见时，强制切换到支付状态，不再触发任何验证码逻辑
      const paymentVisible = isPaymentModalVisible();
      if (paymentVisible && state._lastModalType !== '支付') {
        state.modalVisible = true;
        state._lastModalType = '支付';
        _captchaCompleted = true;
        stopCaptchaWatch(paymentModal || activeModal);
        _captchaSolving = false;
        _captchaRetryCount = 0;
        log('验证码通过，进入支付页');
        setStatus('请扫码支付!', '#00ff88');
        playAlert();
      } else if (_captchaCompleted && !paymentVisible) {
        // 验证码已完成且付款弹窗已关闭 → 恢复正常状态（不被残留验证码DOM卡住）
        if (state.modalVisible) {
          state.modalVisible = false;
          state._lastModalType = null;
          log('验证码/支付流程结束，恢复正常');
          recoverAfterCaptcha();
        }
      } else if (paymentVisible) {
        // 付款中，静默等待
      } else if (activeModal) {
        const type = isCaptcha ? '验证码' : '支付';
        if (!state.modalVisible) {
          state.modalVisible = true;
          state._lastModalType = type;
          console.log(`[GLM Sniper] 检测到${type}弹窗! 冻结刷新`);
          log(`检测到${type}弹窗，已冻结刷新`);
          setStatus(isCaptcha ? '⚡ 自动识别验证码...' : '请扫码支付!', isCaptcha ? '#ffcc00' : '#00ff88');
          playAlert();
          highlightCaptcha(activeModal, isCaptcha);
        } else if (isCaptcha && state._lastModalType !== '验证码') {
          state._lastModalType = '验证码';
          log('检测到验证码弹窗，重新识别');
          setStatus('⚡ 再次检测到验证码，自动识别...', '#ff0');
          highlightCaptcha(captchaModal, true);
        }
      }
      // 没有真正的弹窗了
      if (!activeModal && state.modalVisible) {
        state.modalVisible = false;
        state._lastModalType = null;
        console.log('[GLM Sniper] 弹窗已消失，恢复正常');
        log('弹窗已消失，恢复自动抢购');
        // 验证码完成后: 多轮恢复 productId，防止数据丢失导致 "productId 不能为空"
        recoverAfterCaptcha();
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  // --- 2d. 错误页面 DOM 抑制：检测到错误渲染时隐藏并触发重新加载数据 ---
  function setupErrorSuppressor() {
    if (!document.body) {
      setTimeout(setupErrorSuppressor, 200);
      return;
    }

    new MutationObserver(() => {
      if (!isNearTargetTime()) return;
      // 有弹窗时不做任何操作，保护验证码/支付弹窗
      if (state.modalVisible) return;

      const bodyText = document.body.textContent || '';
      if (!bodyText.includes('访问人数较多') && !bodyText.includes('请刷新重试') && !bodyText.includes('服务繁忙')) return;

      // 找到包含错误信息的容器并隐藏
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

  // ==================== 3. UI 覆盖层 ====================
  function createOverlay() {
    // 等待 body 存在 (SPA 框架可能延迟创建)
    if (!document.body) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createOverlay);
      } else {
        // body 还没出现，轮询等待
        setTimeout(createOverlay, 100);
      }
      return;
    }

    // 避免重复创建
    if (document.getElementById('glm-sniper-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'glm-sniper-overlay';

    // 读取上次保存的位置
    let savedX = localStorage.getItem('glm_overlay_x');
    let savedY = localStorage.getItem('glm_overlay_y');
    // 防止窗口缩小后面板超出屏幕
    if (savedX !== null) savedX = Math.min(parseInt(savedX), window.innerWidth - 300);
    if (savedY !== null) savedY = Math.min(parseInt(savedY), window.innerHeight - 60);
    if (savedX !== null && savedX < 0) savedX = 0;
    if (savedY !== null && savedY < 0) savedY = 0;
    const posRight = savedX === null ? '10px' : 'auto';
    const posTop = savedY === null ? '10px' : savedY + 'px';
    const posLeft = savedX === null ? 'auto' : savedX + 'px';

    overlay.innerHTML = `
      <div id="glm-panel" style="
        position: fixed;
        top: ${posTop};
        right: ${posRight};
        left: ${posLeft};
        z-index: 999999;
        background: rgba(0, 0, 0, 0.85);
        color: #00ff88;
        padding: 0;
        border-radius: 12px;
        font-family: 'Consolas', 'Monaco', monospace;
        font-size: 14px;
        min-width: 280px;
        max-width: 340px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        backdrop-filter: blur(10px);
        border: 1px solid rgba(0, 255, 136, 0.3);
        user-select: none;
        transition: width 0.2s, min-width 0.2s, padding 0.2s;
      ">
        <div id="glm-header" style="
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 14px 8px;
          cursor: grab;
          border-bottom: 1px solid rgba(255,255,255,0.08);
        ">
          <span style="font-size: 14px; font-weight: bold;">GLM Sniper</span>
          <div style="display:flex;gap:6px;">
            <button id="glm-min-btn" title="最小化" style="
              background: none; border: 1px solid rgba(255,255,255,0.2); color: #aaa;
              border-radius: 4px; width: 22px; height: 22px; cursor: pointer;
              font-size: 14px; line-height: 1; display: flex; align-items: center; justify-content: center;
            ">−</button>
            <button id="glm-close-btn" title="隐藏 (双击页面右上角恢复)" style="
              background: none; border: 1px solid rgba(255,255,255,0.2); color: #aaa;
              border-radius: 4px; width: 22px; height: 22px; cursor: pointer;
              font-size: 12px; line-height: 1; display: flex; align-items: center; justify-content: center;
            ">×</button>
          </div>
        </div>
        <div id="glm-body" style="padding: 8px 14px 12px;">
          <div id="glm-target" style="color: #ffcc00; margin-bottom: 4px; font-size: 12px;">
            目标: ${CONFIG.targetPlan.toUpperCase()} / ${{ monthly: '包月', quarterly: '包季', yearly: '包年' }[CONFIG.billingPeriod] || '包季'}
          </div>
          <div id="glm-countdown" style="font-size: 20px; margin: 4px 0; color: #fff;">
            --:--:--
          </div>
          <div id="glm-status" style="color: #aaa; font-size: 12px;">
            等待初始化...
          </div>
          <div style="color:#f44;font-size:11px;margin-top:6px;font-weight:bold;line-height:1.4;">
            ⚠ 订单没显示金额时不要扫码付款!
          </div>
          <div id="glm-log" style="
            margin-top: 8px;
            max-height: 100px;
            overflow-y: auto;
            font-size: 11px;
            color: #888;
            border-top: 1px solid rgba(255,255,255,0.1);
            padding-top: 6px;
          "></div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // --- 拖拽移动 ---
    const panel = document.getElementById('glm-panel');
    const header = document.getElementById('glm-header');
    let isDragging = false, dragOffX = 0, dragOffY = 0;

    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      const rect = panel.getBoundingClientRect();
      dragOffX = e.clientX - rect.left;
      dragOffY = e.clientY - rect.top;
      header.style.cursor = 'grabbing';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      let x = e.clientX - dragOffX;
      let y = e.clientY - dragOffY;
      // 限制不超出视口
      x = Math.max(0, Math.min(x, window.innerWidth - panel.offsetWidth));
      y = Math.max(0, Math.min(y, window.innerHeight - panel.offsetHeight));
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      header.style.cursor = 'grab';
      // 保存位置
      const rect = panel.getBoundingClientRect();
      localStorage.setItem('glm_overlay_x', String(Math.round(rect.left)));
      localStorage.setItem('glm_overlay_y', String(Math.round(rect.top)));
    });

    // --- 最小化/展开 ---
    const minBtn = document.getElementById('glm-min-btn');
    const body = document.getElementById('glm-body');
    let minimized = false;
    minBtn.addEventListener('click', () => {
      minimized = !minimized;
      body.style.display = minimized ? 'none' : 'block';
      panel.style.minWidth = minimized ? 'auto' : '280px';
      minBtn.textContent = minimized ? '+' : '−';
      minBtn.title = minimized ? '展开' : '最小化';
    });

    // --- 隐藏 (双击右上角恢复) ---
    const closeBtn = document.getElementById('glm-close-btn');
    closeBtn.addEventListener('click', () => {
      panel.style.display = 'none';
    });
    document.addEventListener('dblclick', (e) => {
      if (e.clientX > window.innerWidth - 80 && e.clientY < 80) {
        panel.style.display = '';
      }
    });

    startCountdown();
  }

  function log(msg) {
    console.log(`[GLM Sniper] ${msg}`);
    const logEl = document.getElementById('glm-log');
    if (logEl) {
      const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      const entry = document.createElement('div');
      entry.textContent = `${time} ${msg}`;
      logEl.insertBefore(entry, logEl.firstChild);
      // 限制日志条数
      if (logEl.children.length > 20) {
        logEl.removeChild(logEl.lastChild);
      }
    }
  }

  function setStatus(msg, color = '#aaa') {
    const el = document.getElementById('glm-status');
    if (el) {
      el.textContent = msg;
      el.style.color = color;
    }
  }

  // ==================== 4. 倒计时 ====================
  function getTargetTime() {
    const now = new Date();
    const target = new Date(now);
    target.setHours(CONFIG.targetHour, CONFIG.targetMinute, CONFIG.targetSecond, 0);

    // 如果今天已过目标时间，设为明天
    if (now >= target) {
      target.setDate(target.getDate() + 1);
    }
    return target;
  }

  function startCountdown() {
    const update = () => {
      const now = new Date();
      const target = getTargetTime();
      const diff = target - now;

      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      const ms = diff % 1000;

      const el = document.getElementById('glm-countdown');
      if (el) {
        // 正在抢购时段 (isRunning 或在窗口期内) 不显示倒计时
        if (state.isRunning || isNearTargetTime()) {
          el.textContent = '抢购中...';
          el.style.color = '#00ff88';
        } else if (diff <= 60000) {
          // 最后60秒显示毫秒
          el.textContent = `${s}.${String(ms).padStart(3, '0')}s`;
          el.style.color = '#ff4444';
        } else {
          el.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
          el.style.color = diff <= 300000 ? '#ffcc00' : '#fff';
        }
      }

      // 自动刷新 (提前N秒)
      if (CONFIG.autoRefresh && !state.isRunning) {
        const refreshTime = CONFIG.autoRefreshSecondsBefore * 1000;
        if (diff <= refreshTime && diff > refreshTime - 1000) {
          log('自动刷新页面以获取最新状态...');
          setStatus('刷新中...', '#ffcc00');
          // 延迟一点再刷新，避免刷新太早
          location.reload();
          return;
        }
      }

      // TCP 预热 (提前3秒建立连接池)
      if (diff <= 3000 && diff > 2000 && !state.preheated) {
        state.preheated = true;
        preheat();
      }

      // 到点开始抢购 (测试模式下等 productId 捕获后启动)
      if ((CONFIG.testMode || diff <= CONFIG.advanceMs) && !state.isRunning) {
        if (CONFIG.testMode && !_capturedProductId) {
          // 测试模式: 等 API 数据加载 (最多等3秒，之后不管有没有都继续)
          getProductId();
          if (!_capturedProductId) {
            if (!state._testWaitStart) state._testWaitStart = Date.now();
            if (Date.now() - state._testWaitStart < 3000) return; // 最多等3秒
            log('[测试] 等待3秒仍无 productId，继续启动');
          }
        }
        state.isRunning = true;
        log(CONFIG.testMode ? `测试模式: 立即开始抢购! (pid=${_capturedProductId})` : `开始抢购! (提前${CONFIG.advanceMs}ms)`);
        setStatus(CONFIG.testMode ? '测试模式: 抢购中...' : '正在抢购...', '#00ff88');
        startSnipe();
      }
    };

    state.countdownId = setInterval(update, 50);
    update();

    log('倒计时已启动');
    setStatus('等待抢购时间...', '#aaa');
  }

  // ==================== 4b. TCP 预热 ====================
  async function preheat() {
    // 只在目标站点执行，避免跨域 CSP 错误
    if (location.hostname !== 'open.bigmodel.cn') return;
    log('TCP 预热中...');
    try {
      const paths = ['/favicon.ico', '/api/biz/pay/check?bizId=preheat', '/'];
      for (const p of paths) {
        originalFetch(location.origin + p, { method: 'HEAD', cache: 'no-cache', credentials: 'include' }).catch(() => { });
      }
      log('预热完成 (3条连接已建立)');
    } catch (e) {
      log('预热失败，不影响使用');
    }
  }

  // ==================== 5. 核心抢购逻辑 ====================
  function selectBillingPeriod() {
    const periodKeywords = {
      monthly: { match: '包月', exclude: ['包季', '包年'], label: '连续包月' },
      quarterly: { match: '包季', exclude: ['包月', '包年'], label: '连续包季' },
      yearly: { match: '包年', exclude: ['包月', '包季'], label: '连续包年' },
    };
    const period = periodKeywords[CONFIG.billingPeriod] || periodKeywords.quarterly;

    const tabs = document.querySelectorAll('div, span, button, a, li, label');
    for (const tab of tabs) {
      const text = (tab.textContent || '').trim();
      if (text.includes(period.match) && period.exclude.every(ex => !text.includes(ex)) && text.length < 20) {
        tab.click();
        tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        log('已选择: ' + period.label);
        return true;
      }
    }
    log('未找到' + period.label + '选项，使用页面默认');
    return false;
  }

  function startSnipe() {
    _captchaCompleted = false; // 新一轮抢购，重置验证码状态
    // 已确认售罄时不启动抢购
    if (_confirmedSoldOut) {
      log('已确认售罄，不启动抢购');
      setStatus('已售罄，明日再抢', '#ff4444');
      state.isRunning = false;
      return;
    }

    // 先选择计费周期
    selectBillingPeriod();
    // 移除所有disabled属性
    removeAllDisabled();

    // 防止重复创建定时器（泄漏旧定时器）
    if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }

    // 开始循环尝试点击
    state.timerId = setInterval(() => {
      // 运行中确认售罄 → 立即停止
      if (_confirmedSoldOut) {
        clearInterval(state.timerId);
        state.timerId = null;
        state.isRunning = false;
        log('已确认售罄，停止抢购');
        setStatus('已售罄，明日再抢', '#ff4444');
        return;
      }
      if (state.orderCreated) {
        clearInterval(state.timerId);
        return;
      }
      if (state.retryCount >= CONFIG.maxRetries) {
        clearInterval(state.timerId);
        // 重置状态，允许 setupAutoSnipeOnReady 重新触发
        state.isRunning = false;
        state.retryCount = 0;
        log('本轮重试结束，等待页面恢复后重新触发...');
        setStatus('等待页面恢复...', '#ffcc00');
        return;
      }

      state.retryCount++;
      if (state.retryCount % 10 === 1) {
        log(`第 ${state.retryCount} 次尝试...`);
      }

      // 有弹窗时不操作，保护验证码/支付弹窗
      if (state.modalVisible) return;

      // 移除disabled (弹窗关闭后才执行，避免破坏验证码SDK)
      removeAllDisabled();

      // 每次点击前确保 Vue 组件的 productId 已设置
      // (关键! 前端验证在请求发出前检查，fetch拦截器来不及)
      if (_capturedProductId && Date.now() - _ensureThrottle > 500) {
        _ensureThrottle = Date.now();
        ensureProductId();
      }

      // 尝试查找并点击购买按钮
      const clicked = tryClickPurchaseButton();
      if (clicked) {
        log('已点击购买按钮!');
        setStatus('已点击购买按钮，等待响应...', '#00ff88');
      }

      // 尝试点击确认按钮 (如果弹出了确认对话框)
      tryClickConfirmButton();
    }, CONFIG.retryInterval);
  }

  function removeAllDisabled() {
    // 移除所有按钮的disabled属性
    document.querySelectorAll('button[disabled], a[disabled], input[disabled]').forEach((el) => {
      el.removeAttribute('disabled');
      el.disabled = false;
      el.classList.remove('disabled', 'is-disabled', 'btn-disabled');
      // 移除内联样式中的禁用
      if (el.style.pointerEvents === 'none') {
        el.style.pointerEvents = 'auto';
      }
      if (el.style.opacity === '0.5' || el.style.opacity === '0.6') {
        el.style.opacity = '1';
      }
    });

    // 处理通过 CSS class 禁用的元素
    document
      .querySelectorAll('.disabled, .is-disabled, .btn-disabled, .sold-out')
      .forEach((el) => {
        el.classList.remove('disabled', 'is-disabled', 'btn-disabled', 'sold-out');
        el.style.pointerEvents = 'auto';
        el.style.opacity = '1';
      });
  }

  // 缓存目标套餐区域，避免每100ms全页面查询
  let _cachedTargetSection = null;
  let _cacheExpiry = 0;

  function tryClickPurchaseButton() {
    // 策略1: 通过文字内容查找按钮
    const keywords = ['购买', '订阅', '订购', '立即购买', '立即订阅', 'Subscribe', 'Buy', 'Purchase'];
    const planKeywords = {
      lite: ['lite', 'Lite', 'LITE', '基础', '轻量'],
      pro: ['pro', 'Pro', 'PRO', '专业', '进阶'],
      max: ['max', 'Max', 'MAX', '旗舰', '高级'],
    };

    const targetPlanKeys = planKeywords[CONFIG.targetPlan] || [];

    // 先找到目标套餐区域 (缓存2秒，避免每100ms全页面querySelectorAll)
    let targetSection = null;
    const now = Date.now();
    if (_cachedTargetSection && _cachedTargetSection.isConnected && now < _cacheExpiry) {
      targetSection = _cachedTargetSection;
    } else {
      const allElements = document.querySelectorAll('[class*="card"], [class*="plan"], [class*="price"], div, section, article, li');
      for (const el of allElements) {
        const text = el.textContent || '';
        if (targetPlanKeys.some((k) => text.includes(k))) {
          if (el.offsetHeight < 800 && el.offsetWidth < 600) {
            targetSection = el;
            _cachedTargetSection = el;
            _cacheExpiry = now + 2000;
            break;
          }
        }
      }
    }

    // 在目标区域内查找购买按钮
    const searchRoot = targetSection || document;
    const buttons = searchRoot.querySelectorAll('button, a[role="button"], [class*="btn"], [class*="button"]');

    for (const btn of buttons) {
      const btnText = (btn.textContent || '').trim();
      const isActionButton = keywords.some((kw) => btnText.includes(kw));

      if (isActionButton) {
        // 如果有目标区域，直接点击
        // 如果没有目标区域，检查按钮附近是否有套餐标识
        if (targetSection || hasNearbyPlanText(btn, targetPlanKeys)) {
          btn.click();
          // 同时触发各种事件以确保被前端框架捕获
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          return true;
        }
      }
    }

    // 策略2: 直接通过data属性或id查找
    const specificSelectors = [
      `[data-plan="${CONFIG.targetPlan}"]`,
      `[data-type="${CONFIG.targetPlan}"]`,
      `#${CONFIG.targetPlan}-buy-btn`,
      `#buy-${CONFIG.targetPlan}`,
      `.${CONFIG.targetPlan}-purchase`,
      `[data-plan-type="${CONFIG.targetPlan}"]`,
    ];

    for (const selector of specificSelectors) {
      try {
        const el = document.querySelector(selector);
        if (el) {
          el.click();
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return true;
        }
      } catch (e) {
        // 选择器可能无效，跳过
      }
    }

    return false;
  }

  function hasNearbyPlanText(btn, planKeys) {
    // 向上查找3层父元素，看是否包含套餐标识
    let el = btn;
    for (let i = 0; i < 5; i++) {
      el = el.parentElement;
      if (!el) break;
      const text = el.textContent || '';
      if (planKeys.some((k) => text.includes(k))) {
        return true;
      }
    }
    return false;
  }

  function tryClickConfirmButton() {
    // 查找确认对话框中的按钮
    const confirmKeywords = ['确认', '确定', '立即支付', '去支付', '提交订单', 'Confirm', 'OK', 'Submit'];

    // 查找模态框/对话框
    const modals = document.querySelectorAll(
      '[class*="modal"], [class*="dialog"], [class*="popup"], [class*="overlay"], [role="dialog"]'
    );

    for (const modal of modals) {
      if (modal.offsetParent === null) continue; // 不可见的跳过

      const buttons = modal.querySelectorAll('button, a[role="button"]');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim();
        if (confirmKeywords.some((kw) => text.includes(kw))) {
          btn.click();
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          log(`点击确认按钮: "${text}"`);
          state.orderCreated = true;
          setStatus('订单已创建! 请扫码支付', '#00ff88');
          // 延迟检查支付弹窗是否弹出，没有则直接操作 Vue
          setTimeout(forcePayDialog, 1500);
          return true;
        }
      }
    }

    return false;
  }

  // ==================== 6. 监控DOM变化，及时响应 ====================
  function setupMutationObserver() {
    if (!document.body) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupMutationObserver);
      } else {
        setTimeout(setupMutationObserver, 100);
      }
      return;
    }

    const observer = new MutationObserver((mutations) => {
      // 只在抢购启动后才检测二维码，避免误判页面已有的文字
      if (!state.isRunning) return;

      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            // 必须是新弹出的模态框/弹窗内的内容，且包含canvas或qr图片
            const hasQR = node.querySelector?.('canvas, img[src*="qr"], img[src*="pay"]');
            const isModal = node.matches?.('[class*="modal"], [class*="dialog"], [role="dialog"]') ||
              node.closest?.('[class*="modal"], [class*="dialog"], [role="dialog"]');
            const text = node.textContent || '';
            const hasPayText = text.includes('扫码') || text.includes('支付宝') || text.includes('微信支付');

            if (hasQR || (isModal && hasPayText)) {
              log('检测到支付二维码!');
              setStatus('支付二维码已出现! 快扫码!', '#00ff88');
              state.orderCreated = true;
              clearInterval(state.timerId);
              playAlert();
              setTimeout(forcePayDialog, 1500);
            }
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    log('DOM 监控已启动');
  }

  function playAlert() {
    try {
      if (!state._audioCtx) state._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = state._audioCtx;
      // 播放急促的5声"嘟"提示，越来越高频，引起注意
      const freqs = [660, 880, 1100, 880, 1100];
      freqs.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = freq;
        gain.gain.value = 0.4;
        const t = ctx.currentTime + i * 0.18;
        osc.start(t);
        osc.stop(t + 0.12);
      });
    } catch (e) {
      // 音频播放失败不影响功能
    }
  }

  // ==================== 验证码加速辅助 ====================
  function highlightCaptcha(modal, isCaptcha) {
    try {
      // 1. 滚动到弹窗可见位置
      modal.scrollIntoView({ behavior: 'instant', block: 'center' });

      // 2. 添加高亮脉冲边框
      modal.style.outline = '3px solid #ff0';
      modal.style.outlineOffset = '2px';
      modal.style.boxShadow = '0 0 30px rgba(255,255,0,0.6)';
      // 注入脉冲动画
      if (!document.getElementById('glm-captcha-pulse')) {
        const style = document.createElement('style');
        style.id = 'glm-captcha-pulse';
        style.textContent = `
          @keyframes glm-pulse {
            0%, 100% { outline-color: #ff0; box-shadow: 0 0 20px rgba(255,255,0,0.4); }
            50% { outline-color: #f80; box-shadow: 0 0 40px rgba(255,128,0,0.7); }
          }
          .glm-captcha-highlight {
            animation: glm-pulse 0.8s ease-in-out infinite !important;
            outline: 3px solid #ff0 !important;
            outline-offset: 2px !important;
          }
        `;
        document.head.appendChild(style);
      }
      modal.classList.add('glm-captcha-highlight');

      // 3. 如果是验证码，尝试自动识别 + 监听刷新
      if (isCaptcha) {
        setStatus('⚡ 检测到验证码，尝试自动识别...', '#ff0');
        // 延迟 500ms 等验证码图片完全加载
        setTimeout(() => tryAutoSolveCaptcha(modal), 500);
        // 监听图片 src 变化 (用户点刷新按钮时自动重试)
        watchCaptchaRefresh(modal);
      }

      // 4. 弹窗消失后清除高亮
      const cleanup = () => {
        if (!state.modalVisible) {
          modal.classList.remove('glm-captcha-highlight');
          modal.style.outline = '';
          modal.style.outlineOffset = '';
          modal.style.boxShadow = '';
        } else {
          setTimeout(cleanup, 500);
        }
      };
      setTimeout(cleanup, 500);
    } catch (e) {
      console.log('[GLM Sniper] 验证码高亮失败:', e);
    }
  }

  // ==================== 6b. 文字点选验证码自动识别 ====================
  // 原理: 截取验证码图片 → 发送给本地 OCR 服务器识别 → 自动按顺序点击
  // 需要运行本地 OCR 服务: cd captcha-server && python server.py
  const CAPTCHA_API = 'http://127.0.0.1:9898/solve';
  let _captchaSolving = false; // 防止并发请求
  let _captchaRetryCount = 0; // 刷新重试计数
  let _captchaCompleted = false; // 验证码已通过，不再重新进入验证码模式
  const MAX_CAPTCHA_RETRIES = 5; // 最多自动刷新5次
  let _lastCaptchaImgKey = ''; // 上次发送的图片标识，避免重复 OCR 同一张图

  function isPaymentModalVisible() {
    const modals = document.querySelectorAll('[class*="modal"],[class*="dialog"],[class*="popup"],[role="dialog"]');
    for (const m of modals) {
      if (m.offsetParent === null || m.offsetHeight < 30) continue;
      const t = m.textContent || '';
      if ((t.includes('实付金额') || t.includes('扫码支付') || t.includes('连续包')) && !m.querySelector('[class*="tcaptcha"]')) return true;
    }
    return false;
  }

  async function tryAutoSolveCaptcha(modal) {
    if (_captchaSolving) { log('[自动验证码] 上一次识别还在进行中，跳过'); return false; }
    if (isPaymentModalVisible()) {
      log('[自动验证码] 检测到付款页面，停止OCR');
      stopCaptchaWatch(modal);
      _captchaSolving = false;
      _captchaRetryCount = 0;
      state._lastModalType = '支付';
      setStatus('请扫码支付!', '#00ff88');
      return false;
    }
    _captchaSolving = true;
    try {
      log('[自动验证码] 开始识别文字点选...');

      // 1. 查找验证码图片 — 必须足够大（排除小图标）
      let imgEl = findCaptchaImage(modal);
      if (!imgEl) {
        log('[自动验证码] 未找到验证码图片，请手动完成');
        setStatus('⚠ 未找到验证码图片，请手动点击', '#f44');
        return false;
      }
      log(`[自动验证码] 找到图片: ${imgEl.tagName} ${imgEl.offsetWidth}x${imgEl.offsetHeight}`);

      // 2. 提取目标文字 ("请依次点击: X X X")
      const promptText = extractTargetChars(modal);
      log(`[自动验证码] 目标文字: "${promptText}"`);

      // 3. 获取图片数据 (优先 canvas，跨域时让服务器下载)
      let imgBase64 = await getCaptchaImageBase64(imgEl);
      let imgUrl = '';
      if (!imgBase64) {
        imgUrl = imgEl.src || imgEl.currentSrc || '';
        if (!imgUrl) {
          log('[自动验证码] 无法获取图片数据，也没有 URL');
          return false;
        }
        log(`[自动验证码] 跨域图片，将 URL 发给 OCR 服务器下载: ${imgUrl.substring(0, 60)}...`);
      }

      // 检测是否与上次是同一张图，避免重复 OCR
      const imgKey = imgUrl || (imgBase64 ? imgBase64.substring(0, 100) : '');
      if (imgKey && imgKey === _lastCaptchaImgKey) {
        log('[自动验证码] 图片未变化，跳过重复 OCR，等待刷新...');
        clickCaptchaRefresh(modal);
        return false;
      }
      _lastCaptchaImgKey = imgKey;

      // 4. 提取提示文字图片 (有些验证码的提示是图片)
      let promptImgBase64 = '';
      if (!promptText) {
        const promptImg = modal.querySelector(
          'img[class*="tip"], img[class*="prompt"], img[class*="word"], img[class*="title"]'
        );
        if (promptImg) promptImgBase64 = await getCaptchaImageBase64(promptImg) || '';
      }

      // 5. 发送给 OCR 服务器
      log('[自动验证码] 发送给 OCR 服务器...');
      setStatus('⏳ OCR 识别中...', '#ff0');

      let solveResult;
      try {
        const resp = await originalFetch(CAPTCHA_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image: imgBase64 || '',
            image_url: imgUrl,
            target: promptText,
            prompt_image: promptImgBase64,
          }),
        });
        solveResult = await resp.json();
      } catch (e) {
        log('[自动验证码] ⚠ OCR 服务未启动! 请运行: cd captcha-server && python3 server.py');
        setStatus('⚠ OCR 服务未连接，请手动点击', '#f44');
        return false;
      }

      if (!solveResult.success || !solveResult.points || solveResult.points.length === 0) {
        if (++_captchaRetryCount > MAX_CAPTCHA_RETRIES) {
          log(`[自动验证码] 已刷新 ${MAX_CAPTCHA_RETRIES} 次仍失败，请手动操作`);
          setStatus('⚠ 自动识别失败，请手动点击', '#f44');
          _captchaRetryCount = 0;
          return false;
        }
        log(`[自动验证码] OCR 未能识别出文字位置，自动刷新换图 (${_captchaRetryCount}/${MAX_CAPTCHA_RETRIES})...`);
        setStatus(`⚠ 识别失败，刷新重试 (${_captchaRetryCount}/${MAX_CAPTCHA_RETRIES})`, '#ff0');
        clickCaptchaRefresh(modal);
        return false;
      }

      const targetLen = promptText ? promptText.length : 3;
      const confidence = solveResult.confidence || 'medium';
      log(`[自动验证码] 识别到 ${solveResult.points.length}/${targetLen} 个点位 (${solveResult.time_ms}ms) 置信度=${confidence}`);

      // 置信度=low (纯猜，正确率≈17%) → 直接刷新换一张更容易的图
      if (confidence === 'low') {
        if (++_captchaRetryCount > MAX_CAPTCHA_RETRIES) {
          log(`[自动验证码] 置信度太低且已刷新 ${MAX_CAPTCHA_RETRIES} 次，尝试点击碰运气`);
          // 超过次数就赌一把，不再刷新
        } else {
          log(`[自动验证码] 置信度太低，刷新换图 (${_captchaRetryCount}/${MAX_CAPTCHA_RETRIES})`);
          setStatus(`⚠ 识别不确定，换图重试 (${_captchaRetryCount}/${MAX_CAPTCHA_RETRIES})`, '#ff0');
          clickCaptchaRefresh(modal);
          return false;
        }
      }

      if (solveResult.points.length < targetLen) {
        if (solveResult.points.length >= 2) {
          log(`[自动验证码] 识别到 ${solveResult.points.length}/${targetLen} 个，尝试点击...`);
        } else {
          if (++_captchaRetryCount > MAX_CAPTCHA_RETRIES) {
            log(`[自动验证码] 已刷新 ${MAX_CAPTCHA_RETRIES} 次仍不完整，请手动操作`);
            setStatus('⚠ 自动识别失败，请手动点击', '#f44');
            _captchaRetryCount = 0;
            return false;
          }
          log(`[自动验证码] 只识别到 ${solveResult.points.length}/${targetLen} 个，刷新换图 (${_captchaRetryCount}/${MAX_CAPTCHA_RETRIES})...`);
          setStatus(`⚠ 识别不完整，刷新重试 (${_captchaRetryCount}/${MAX_CAPTCHA_RETRIES})`, '#ff0');
          clickCaptchaRefresh(modal);
          return false;
        }
      }

      // 6. 计算图片在页面上的实际位置和缩放比例
      const posEl = imgEl._bgDiv || imgEl;
      const imgRect = posEl.getBoundingClientRect();
      // 优先用服务器返回的图片尺寸 (最准确，无需等虚拟 img 加载)
      const naturalW = solveResult.image_width || imgEl.naturalWidth || imgRect.width;
      const naturalH = solveResult.image_height || imgEl.naturalHeight || imgRect.height;
      const scaleX = imgRect.width / naturalW;
      const scaleY = imgRect.height / naturalH;
      log(`[自动验证码] 坐标映射: 原图 ${naturalW}x${naturalH} → 显示 ${Math.round(imgRect.width)}x${Math.round(imgRect.height)}, 缩放 ${scaleX.toFixed(3)}x${scaleY.toFixed(3)}`);

      // 7. 按顺序模拟点击每个目标文字
      for (let i = 0; i < solveResult.points.length; i++) {
        const pt = solveResult.points[i];
        const clickX = imgRect.left + pt.x * scaleX;
        const clickY = imgRect.top + pt.y * scaleY;

        if (i > 0) await new Promise(r => setTimeout(r, 100 + Math.random() * 100));

        log(`[自动验证码] 点击第${i + 1}个: "${pt.char}" (${Math.round(clickX)}, ${Math.round(clickY)})`);
        const jX = (Math.random() - 0.5) * 6;
        const jY = (Math.random() - 0.5) * 6;
        simulateCaptchaClick(clickX + jX, clickY + jY);
      }

      // 8. 点完后查找并点击「确认」按钮
      await new Promise(r => setTimeout(r, 150 + Math.random() * 100));
      const allBtns = modal.querySelectorAll('button, [class*="confirm"], [class*="submit"]');
      for (const btn of allBtns) {
        const t = (btn.textContent || '').trim();
        if ((t.includes('确') || t.includes('提交')) && !t.includes('取消') && !t.includes('关闭')) {
          log(`[自动验证码] 点击确认: "${t}"`);
          btn.click();
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          break;
        }
      }

      // 9. 等待验证结果
      await new Promise(r => setTimeout(r, 800));
      // 检查验证码是否还在 (可能已通过，弹窗变成支付页)
      const stillCaptcha = isCaptchaModal(modal);
      if (stillCaptcha && modal.offsetParent !== null && modal.offsetHeight > 30) {
        log('[自动验证码] 未通过，等待新验证码后重试...');
        setTimeout(() => {
          if (state.modalVisible && isCaptchaModal(modal)) tryAutoSolveCaptcha(modal);
        }, 800);
        return false;
      }

      stopCaptchaWatch(modal);
      state._lastModalType = '支付';
      _captchaRetryCount = 0; // 验证通过，重置计数
      log('[自动验证码] ✅ 验证通过!');
      return true;
    } catch (e) {
      log('[自动验证码] 异常: ' + e.message);
      return false;
    } finally {
      _captchaSolving = false;
    }
  }

  // 查找验证码背景大图
  function findCaptchaImage(modal) {
    // 辅助: 判断 img 是不是真正的大图 (排除占位透明图)
    const isRealImage = (el) => {
      if (el.tagName !== 'IMG') return el.offsetWidth >= 200 && el.offsetHeight >= 100;
      // 关键: 检查图片 naturalWidth，占位图通常很小 (如 7x5)
      const nw = el.naturalWidth || 0;
      const nh = el.naturalHeight || 0;
      if (nw < 50 || nh < 50) return false; // 真实像素太小 = 占位图
      return el.offsetWidth >= 200 && el.offsetHeight >= 100;
    };

    // 策略1 (优先): 检查 CSS background-image (验证码图常用 div 背景)
    const allEls = modal.querySelectorAll('div, span, img');
    for (const el of allEls) {
      if (el.offsetWidth < 200 || el.offsetHeight < 100) continue;
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none' && bg.includes('url(')) {
        const url = bg.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
        if (url.startsWith('data:') && url.length < 200) continue; // 跳过小的 data URL
        log(`[自动验证码] 找到 background-image: ${el.tagName} ${el.offsetWidth}x${el.offsetHeight}`);
        const img = new Image();
        img.src = url;
        img._bgDiv = el; // 保存关联的元素以获取位置和尺寸
        return img;
      }
    }

    // 策略2: 按 class/src 精确匹配 (必须是真实大图)
    const selectors = [
      'img[class*="captcha"]', 'img[class*="bg"]', 'img[class*="pic"]',
      'img[class*="verify"]', 'img[src*="captcha"]', 'img[src*="verify"]',
      'canvas[class*="captcha"]', 'canvas[class*="bg"]',
    ];
    for (const sel of selectors) {
      const el = modal.querySelector(sel);
      if (el && isRealImage(el)) return el;
    }

    // 策略3: 找 modal 内最大的真实 img
    const imgs = [...modal.querySelectorAll('img')].filter(isRealImage);
    if (imgs.length > 0) {
      imgs.sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight));
      return imgs[0];
    }

    // 策略4: 找 canvas (>= 200x100)
    const canvases = [...modal.querySelectorAll('canvas')]
      .filter(el => el.offsetWidth >= 200 && el.offsetHeight >= 100);
    if (canvases.length > 0) {
      canvases.sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight));
      return canvases[0];
    }

    return null;
  }

  // 获取验证码图片 base64 — 优先 canvas 绘制，跨域时才 fetch
  async function getCaptchaImageBase64(el) {
    // 策略1: canvas 直接绘制 (最可靠 — 用的是浏览器已渲染好的图片)
    try {
      const b64 = await elementToBase64(el);
      if (b64 && b64.length > 500) { // 有效图片 base64 至少几百字符
        log(`[自动验证码] 图片获取成功 (canvas, ${b64.length} chars)`);
        return b64;
      }
    } catch (e) { }

    // 策略2: 跨域图片 — 用 fetch 重新下载
    const src = el.src || el.currentSrc || '';
    if (src && src.startsWith('http')) {
      try {
        log('[自动验证码] canvas 跨域失败，尝试 fetch 下载...');
        const resp = await originalFetch(src, { credentials: 'include' });
        if (resp.ok) {
          const blob = await resp.blob();
          // 校验下载到的图片大小
          if (blob.size < 1000) {
            log(`[自动验证码] fetch 图片太小 (${blob.size}B)，可能是错误响应`);
            return null;
          }
          return new Promise(resolve => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.readAsDataURL(blob);
          });
        }
      } catch (e) {
        log('[自动验证码] fetch 下载失败: ' + e.message);
      }
    }
    return null;
  }

  // 监听验证码弹窗内的图片变化 (用户点刷新 / 验证失败换新图)
  let _captchaRefreshTimer = null;
  function watchCaptchaRefresh(modal) {
    if (modal._captchaObserver) return; // 已经在监听
    const observer = new MutationObserver(() => {
      if (!state.modalVisible || !isCaptchaModal(modal)) {
        stopCaptchaWatch(modal);
        return;
      }
      if (_captchaSolving) return; // 正在识别中不重复触发
      // 防抖: 多次 mutation 合并为一次
      if (_captchaRefreshTimer) clearTimeout(_captchaRefreshTimer);
      _captchaRefreshTimer = setTimeout(() => {
        _captchaRefreshTimer = null;
        if (!state.modalVisible || _captchaSolving) return;
        log('[自动验证码] 检测到验证码刷新，等待新图加载后重新识别...');
        tryAutoSolveCaptcha(modal);
      }, 1500);
    });
    observer.observe(modal, {
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
      childList: true,
    });
    modal._captchaObserver = observer;
  }

  // 停止验证码监听
  function stopCaptchaWatch(modal) {
    if (modal._captchaObserver) {
      modal._captchaObserver.disconnect();
      modal._captchaObserver = null;
      log('[自动验证码] 已停止监听');
    }
    if (_captchaRefreshTimer) {
      clearTimeout(_captchaRefreshTimer);
      _captchaRefreshTimer = null;
    }
  }

  // 判断弹窗是否仍然是验证码 (而非支付页等)
  function isCaptchaModal(modal) {
    const text = modal.textContent || '';
    // 排除支付页
    if (text.includes('扫码') || text.includes('支付') || text.includes('付款')) return false;
    // 含验证码特征
    const hasWidget = !!modal.querySelector('[class*="captcha"],[class*="tcaptcha"]');
    return text.includes('验证') || text.includes('点击') || text.includes('滑动') || hasWidget;
  }

  // 点击验证码刷新按钮换一张图
  function clickCaptchaRefresh(modal) {
    // 查找刷新按钮/图标 (通常是 🔄 图标或 class 含 refresh/reload)
    const candidates = modal.querySelectorAll(
      '[class*="refresh"], [class*="reload"], [class*="retry"], ' +
      '[class*="icon-refresh"], [class*="icon-reload"], ' +
      'a[title*="刷新"], a[title*="换一"], img[class*="refresh"]'
    );
    for (const el of candidates) {
      log(`[自动验证码] 点击刷新按钮: ${el.tagName}.${el.className}`);
      el.click();
      return;
    }
    // 兜底: 找 "安全验证" 附近的可点击小元素 (刷新图标通常在底部)
    const allEls = modal.querySelectorAll('a, span, i, svg, img, div');
    for (const el of allEls) {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      // 刷新图标通常是 16-32px 的小元素
      if (w >= 12 && w <= 40 && h >= 12 && h <= 40) {
        const style = getComputedStyle(el);
        if (style.cursor === 'pointer' || el.tagName === 'A' || el.tagName === 'SVG' || el.tagName === 'I') {
          // 确认在弹窗下半部分 (刷新按钮通常在底部)
          const rect = el.getBoundingClientRect();
          const modalRect = modal.getBoundingClientRect();
          if (rect.top > modalRect.top + modalRect.height * 0.5) {
            log(`[自动验证码] 点击疑似刷新图标: ${el.tagName} ${w}x${h} (${el.className})`);
            el.click();
            return;
          }
        }
      }
    }
    log('[自动验证码] 未找到刷新按钮');
  }

  // 从弹窗文本中提取目标文字 ("请依次点击: 植 株" → "植株")
  function extractTargetChars(modal) {
    const allText = modal.textContent || '';
    const patterns = [
      /请[依按]?[次顺]?[序]?点击[：:\s]*[「【""]?([^\n」】""]{1,10})[」】"""]?/,
      /点击[：:\s]*[「【""]?([^\n」】""]{1,10})[」】"""]?/,
      /请[依按]?[次顺]?[序]?选择[：:\s]*[「【""]?([^\n」】""]{1,10})[」】"""]?/,
    ];
    for (const pat of patterns) {
      const m = allText.match(pat);
      if (m && m[1]) return m[1].replace(/[^\u4e00-\u9fff]/g, '');
    }
    // 退而求其次: 找独立的中文字符 span
    let chars = '';
    for (const el of modal.querySelectorAll('span, em, b, strong')) {
      const t = (el.textContent || '').trim();
      if (t.length === 1 && /[\u4e00-\u9fff]/.test(t)) chars += t;
    }
    return chars;
  }

  // 将 img/canvas 转 base64
  async function elementToBase64(el) {
    try {
      if (el.tagName === 'CANVAS') {
        return el.toDataURL('image/png').split(',')[1];
      }
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!el.complete) await new Promise(r => { el.onload = r; setTimeout(r, 3000); });
      canvas.width = el.naturalWidth || el.width;
      canvas.height = el.naturalHeight || el.height;
      ctx.drawImage(el, 0, 0);
      return canvas.toDataURL('image/png').split(',')[1];
    } catch (e) {
      // 跨域图片: 用 fetch 重新下载
      try {
        const src = el.src || el.currentSrc;
        if (!src) return null;
        const resp = await originalFetch(src, { credentials: 'include' });
        const blob = await resp.blob();
        return new Promise(resolve => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result.split(',')[1]);
          reader.readAsDataURL(blob);
        });
      } catch (e2) { return null; }
    }
  }

  // 模拟真实点击 (pointer + mouse + click 全链路)
  function simulateCaptchaClick(x, y) {
    const target = document.elementFromPoint(x, y);
    if (!target) return;
    const opts = { clientX: x, clientY: y, bubbles: true, cancelable: true };
    target.dispatchEvent(new PointerEvent('pointerdown', opts));
    target.dispatchEvent(new MouseEvent('mousedown', opts));
    target.dispatchEvent(new PointerEvent('pointerup', opts));
    target.dispatchEvent(new MouseEvent('mouseup', opts));
    target.dispatchEvent(new MouseEvent('click', opts));
  }

  // ==================== 7. 时间校准 (使用服务器时间) ====================
  async function calibrateTime() {
    // 只在目标站点执行，避免跨域 CSP 错误
    if (location.hostname !== 'open.bigmodel.cn') return;
    try {
      const res = await originalFetch(location.origin + '/', {
        method: 'HEAD',
        cache: 'no-cache',
      });
      const serverDate = res.headers.get('date');
      if (serverDate) {
        const serverTime = new Date(serverDate);
        const localTime = new Date();
        const offset = serverTime - localTime;
        log(`时间偏差: ${offset}ms (${offset > 0 ? '本地慢' : '本地快'})`);
        if (Math.abs(offset) > 100) {
          const oldAdvance = CONFIG.advanceMs;
          CONFIG.advanceMs = Math.max(50, Math.min(CONFIG.advanceMs + offset, 10000));
          log(`已自动补偿 advanceMs: ${oldAdvance}ms → ${CONFIG.advanceMs}ms`);
        }
        if (Math.abs(offset) > 1000) {
          log(`警告: 本地时间偏差较大 (${offset}ms)，建议校准系统时间`);
          setStatus(`时间偏差: ${offset}ms (已补偿)`, '#ffcc00');
        }
      }
    } catch (e) {
      log('时间校准失败，使用本地时间');
    }
  }

  // ==================== 8. 页面加载失败自动恢复 ====================
  let _refreshCount = 0;

  function setupAutoRetryRefresh() {
    function checkAndRecover() {
      const now = new Date();
      const h = now.getHours(), m = now.getMinutes();
      // 10:00 ~ 10:30 窗口内持续尝试恢复
      const inWindow = h === CONFIG.targetHour && m <= 30;
      if (!inWindow) return;
      // 有弹窗时绝不刷新（保护验证码/支付弹窗）
      if (state.modalVisible) return;

      const bodyText = document.body?.textContent || '';
      const errorKeywords = ['访问人数较多', '请刷新重试', '请稍后再试', '服务繁忙', '网络错误', '加载失败'];
      const isError = errorKeywords.some(kw => bodyText.includes(kw));

      // 页面 HTML 都没加载出来（完全空白 / 502 / 503 纯文本）
      const pageBlank = document.body && document.body.children.length < 3 && bodyText.trim().length < 100;

      if (!isError && !pageBlank) {
        // 页面正常，重置计数器
        _refreshCount = 0;
        return;
      }

      _refreshCount++;
      console.log(`[GLM Sniper] 页面异常 (第${_refreshCount}次)，尝试恢复...`);

      // 限制刷新频率：至少间隔5秒
      const lastRefresh = parseInt(sessionStorage.getItem('glm_last_refresh') || '0');
      if (Date.now() - lastRefresh < 5000) return;
      sessionStorage.setItem('glm_last_refresh', String(Date.now()));

      // 如果当前在限流页 (rate-limit.html)，复用头部的重定向计数器保护
      if (window.location.pathname.includes('rate-limit')) {
        const rc = parseInt(sessionStorage.getItem('glm_redirect_count') || '0');
        if (rc >= 10) {
          console.log('[GLM Sniper] 重定向次数过多，冷却30秒...');
          sessionStorage.setItem('glm_redirect_count', '0');
          setTimeout(() => window.location.replace('https://open.bigmodel.cn/glm-coding'), 30000);
          return;
        }
        sessionStorage.setItem('glm_redirect_count', String(rc + 1));
        console.log(`[GLM Sniper] 检测到限流页，跳回购买页... (第${rc + 1}次)`);
        setTimeout(() => window.location.replace('https://open.bigmodel.cn/glm-coding'), 1000 + rc * 500);
        return;
      }

      // 正常页面异常：带 cache-busting 强刷
      const url = new URL(window.location.href);
      url.searchParams.set('_t', Date.now());
      window.location.replace(url.toString());
    }

    // 页面加载完后检查
    if (document.readyState === 'complete') {
      setTimeout(checkAndRecover, 1500);
    } else {
      window.addEventListener('load', () => setTimeout(checkAndRecover, 2000));
    }

    // 持续监控（每2秒检查一次）
    setInterval(checkAndRecover, 2000);
  }

  // ==================== 9. 页面恢复后自动触发抢购 ====================
  function setupAutoSnipeOnReady() {
    // 每2秒检测：如果在抢购窗口内，页面正常，且还没开始抢购，就自动开始
    setInterval(() => {
      const now = new Date();
      const h = now.getHours(), m = now.getMinutes();
      if (h !== CONFIG.targetHour || m > 30) return;
      if (state.isRunning || state.orderCreated || state.modalVisible || _confirmedSoldOut) return;

      // 检测页面是否有购买按钮（说明页面正常加载了）
      const bodyText = document.body?.textContent || '';
      const hasError = ['访问人数较多', '请刷新重试', '服务繁忙'].some(kw => bodyText.includes(kw));
      if (hasError) return;

      const hasBuyButton = ['购买', '订阅', '订购', '特惠订阅', '特惠购买'].some(kw => bodyText.includes(kw));
      if (!hasBuyButton) return;

      // 页面正常且有购买按钮，自动触发抢购
      log('页面恢复正常，自动触发抢购!');
      setStatus('页面恢复，正在抢购...', '#00ff88');
      state.isRunning = true;
      startSnipe();
    }, 2000);
  }

  // ==================== 10. Vue 组件直接操作 ====================

  // ==================== 验证码完成后恢复流程 ====================
  // 验证码完成后，页面 Vue 组件的 productId 经常被重置为空
  // 需要多轮、多策略恢复，确保后续购买请求不会报 "productId 不能为空"
  function recoverAfterCaptcha() {
    log('[恢复] 验证码完成，开始多轮恢复 productId...');

    // 第1轮: 立即恢复 (0ms)
    selectBillingPeriod();
    ensureProductId();

    // 第2轮: 200ms 后再试 (等待 Vue 重新渲染)
    setTimeout(() => {
      ensureProductId();
      removeAllDisabled();
    }, 200);

    // 第3轮: 500ms 后，如果仍然没有 productId，主动重新请求产品数据
    setTimeout(() => {
      ensureProductId();
      if (!_capturedProductId) {
        log('[恢复] productId 仍为空，尝试重新获取产品数据...');
        refetchProductData();
      }
    }, 500);

    // 第4轮: 1500ms 后最终检查，如果还是空则强制刷新一次页面数据
    setTimeout(() => {
      ensureProductId();
      if (!_capturedProductId) {
        log('[恢复] productId 持续为空，触发 SPA 路由重载...');
        const currentUrl = window.location.href;
        window.history.pushState(null, '', currentUrl);
        window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
      } else {
        log(`[恢复] productId 已恢复: ${_capturedProductId}`);
      }
    }, 1500);
  }

  // 主动重新请求产品列表 API 以获取 productId
  async function refetchProductData() {
    try {
      // 尝试请求产品列表 API (常见路径)
      const paths = [
        '/api/biz/product/batch-preview',
        '/api/biz/product/list',
        '/api/glm-coding/product',
      ];
      for (const path of paths) {
        try {
          const resp = await originalFetch(location.origin + path, {
            method: 'GET',
            credentials: 'include',
            headers: { 'Accept': 'application/json' },
          });
          if (resp.ok) {
            const text = await resp.text();
            // 使用拦截后的 JSON.parse，以触发 captureProductIdFromData
            try { JSON.parse(text); } catch (e) { }
            if (_capturedProductId) {
              log(`[恢复] 从 ${path} 重新获取到 productId=${_capturedProductId}`);
              ensureProductId();
              return;
            }
          }
        } catch (e) { }
      }
      log('[恢复] 所有 API 路径均未获取到 productId');
    } catch (e) {
      log('[恢复] 重新获取产品数据失败: ' + e.message);
    }
  }

  // 确保 Vue 组件/Store 中 productId 存在，防止脚本点击时数据为空
  let _ensureThrottle = 0;
  function ensureProductId() {
    const pid = getProductId();
    if (!pid) return;

    const app = document.querySelector('#app');
    const vue = app?.__vue__;
    if (!vue) return;

    let fixed = 0;

    // === 策略1: 在匿名页面组件中填充 selectCardData ===
    // 手动点击时 Vue 自动填充此字段；脚本点击时为空
    const findPageComp = (vm, depth) => {
      if (depth > 5 || fixed > 0) return;
      if (vm.$data && vm.$data.selectCardData !== undefined && vm.$data.allCurrentProducts !== undefined) {
        // 找到了页面主组件
        const products = vm.$data.allCurrentProducts;
        if (Array.isArray(products)) {
          // 从 allCurrentProducts 找到目标产品
          const target = products.find(p => p && p.productId === pid);
          if (target) {
            if (vm.$set) {
              vm.$set(vm.$data, 'selectCardData', target);
              vm.$set(vm.$data, 'currentCardData', target);
            } else {
              vm.selectCardData = target;
              vm.currentCardData = target;
            }
            fixed++;
            log(`[ensureProductId] ✅ 注入 selectCardData (productId=${pid})`);
          } else {
            // allCurrentProducts 里没找到，直接设 productId
            const cardData = { ...vm.$data.selectCardData, productId: pid };
            if (vm.$set) vm.$set(vm.$data, 'selectCardData', cardData);
            else vm.selectCardData = cardData;
            fixed++;
            log(`[ensureProductId] ✅ 强制设置 selectCardData.productId=${pid}`);
          }
        } else {
          // allCurrentProducts 不是数组，直接注入
          const cardData = { ...vm.$data.selectCardData, productId: pid };
          if (vm.$set) vm.$set(vm.$data, 'selectCardData', cardData);
          else vm.selectCardData = cardData;
          fixed++;
          log(`[ensureProductId] ✅ 强制设置 selectCardData.productId=${pid}`);
        }
      }
      for (const child of (vm.$children || [])) findPageComp(child, depth + 1);
    };
    findPageComp(vue, 0);

    // === 策略2: Vuex Store Pay 模块注入 ===
    if (vue.$store && vue.$store.state.Pay) {
      const payState = vue.$store.state.Pay;
      const payKeys = Object.keys(payState);
      for (const key of payKeys) {
        if (/product.?id/i.test(key) && !payState[key]) {
          payState[key] = pid;
          fixed++;
          log(`[ensureProductId] ✅ 注入 $store.state.Pay.${key}=${pid}`);
        }
      }
      // 检查嵌套对象
      for (const key of payKeys) {
        const val = payState[key];
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          for (const subKey of Object.keys(val)) {
            if (/product.?id/i.test(subKey) && !val[subKey]) {
              val[subKey] = pid;
              fixed++;
              log(`[ensureProductId] ✅ 注入 $store.state.Pay.${key}.${subKey}=${pid}`);
            }
          }
        }
      }
    }

    // === 策略3: PayComponent 的 priceData 注入 ===
    const findPayComp = (vm, depth) => {
      if (depth > 8) return;
      const name = vm.$options?.name || '';
      if (name === 'PayComponent' && vm.$data) {
        if (vm.$data.priceData && typeof vm.$data.priceData === 'object') {
          if (!vm.$data.priceData.productId) {
            if (vm.$set) vm.$set(vm.$data.priceData, 'productId', pid);
            else vm.$data.priceData.productId = pid;
            fixed++;
            log(`[ensureProductId] ✅ 注入 PayComponent.priceData.productId=${pid}`);
          }
        }
      }
      for (const child of (vm.$children || [])) findPayComp(child, depth + 1);
    };
    findPayComp(vue, 0);

    if (fixed === 0) {
      log(`[ensureProductId] ⚠ 未找到注入点 (pid=${pid})`);
    }
  }

  // 抢购成功后，如果支付弹窗没自动弹出，直接操作 Vue 组件
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

  // 定时 patch Vue 组件的 isServerBusy
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
        log(`[Vue] 已解除 isServerBusy (${patched}个组件)`);
        clearInterval(tid);
      }
    }, 500);
  }

  // ==================== 11. 启动 ====================
  function init() {
    // 启动错误恢复
    setupAutoRetryRefresh(); // 全页面级别的强刷兜底
    setupErrorSuppressor(); // DOM级别的错误抑制 + SPA路由重试
    setupModalProtector(); // 弹窗保护（验证码/支付）

    createOverlay();
    setupMutationObserver();
    setupAutoSnipeOnReady(); // 页面恢复后自动触发抢购

    // 延迟校准时间 + patch Vue isServerBusy + 定期捕获 productId
    setTimeout(calibrateTime, 2000);
    patchVueServerBusy();
    // 定期检查 productId 是否已捕获（直到成功）
    const pidTimer = setInterval(() => {
      if (_capturedProductId) { clearInterval(pidTimer); return; }
      getProductId();
    }, 3000);

    log(`脚本已启动 - 目标: ${CONFIG.targetPlan.toUpperCase()}`);
    log(`抢购时间: 每天 ${CONFIG.targetHour}:${String(CONFIG.targetMinute).padStart(2, '0')}:${String(CONFIG.targetSecond).padStart(2, '0')}`);
    log('提前10秒自动刷新，到点自动抢购');
    log('页面加载失败会自动强刷');
    log('检测到验证码/支付弹窗会冻结刷新');

    // 如果当前已经是10:00附近 (比如刚好打开页面)
    const now = new Date();
    if (
      now.getHours() === CONFIG.targetHour &&
      now.getMinutes() <= 30
    ) {
      // 延迟2秒等待 API 数据加载，以便售罄检测生效
      setTimeout(() => {
        if (_confirmedSoldOut) {
          log('已确认售罄，不启动抢购');
          setStatus('已售罄，明日再抢', '#ff4444');
          return;
        }
        log('当前正是抢购时间! 立即开始!');
        state.isRunning = true;
        startSnipe();
      }, 2000);
    }
  }

  init();
})();
