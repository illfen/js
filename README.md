# GLM Coding Plan 自动抢购脚本

智谱 GLM Coding Plan 自动抢购 + 验证码自动识别，每天 10:00 自动下单。

## 功能

- **售罄拦截** — 抢购窗口期自动将 `soldOut` 改为 `false`，按钮始终可点
- **自动选择套餐** — 默认 Pro + 连续包季（可配置）
- **精准定时** — 10:00:00 自动点击购买，100ms 重试，每轮 30 秒
- **验证码自动识别** — 本地 OCR 服务（ddddocr + PaddleOCR）自动识别文字点选验证码
- **智能弹窗保护** — 验证码/支付弹窗出现时冻结刷新，防止误操作
- **API 自动重试** — 429/5xx 自动重试最多 8 次
- **错误页面恢复** — "访问人数较多"三级恢复（DOM 抑制 → SPA 重载 → 强刷）
- **productId 自动捕获** — 从 API 响应自动提取并注入 productId，防止下单失败
- **支付提醒** — 二维码出现后播放提示音

## 快速开始

### 第一步：安装油猴脚本

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 点击 👉 [**安装脚本**](https://github.com/illfen/js/raw/master/glm-coding-sniper.user.js)
3. Tampermonkey 弹出安装页面，点击「安装」

### 第二步：启动验证码识别服务（可选，推荐）

验证码识别需要本地 Python 服务，不启动则需手动完成验证码。

```bash
# 安装依赖
cd captcha-server
pip install -r requirements.txt

# 启动服务（默认端口 9898）
python server.py
```

> 需要 Python 3.8+，首次运行会自动下载 OCR 模型。

### 第三步：抢购

1. **9:55** 左右打开 https://open.bigmodel.cn/glm-coding ，确保已登录
2. 右上角出现黑色悬浮窗 = 脚本运行中
3. 10:00 脚本自动点击购买 → 自动过验证码 → 弹出支付二维码
4. 听到提示音后**立即扫码付款**


## 配置

修改脚本顶部 `CONFIG` 对象：

```javascript
const CONFIG = {
  targetPlan: 'pro',           // 'lite' | 'pro' | 'max'
  billingPeriod: 'quarterly',  // 'monthly' | 'quarterly' | 'yearly'
  targetHour: 10,              // 抢购小时
  targetMinute: 0,             // 抢购分钟
  advanceMs: 200,              // 提前多少ms开始
  retryInterval: 100,          // 重试间隔ms
  maxRetries: 300,             // 每轮最大重试次数
  testMode: false,             // true = 随时可测试，不限时间窗口
};
```

## 工作原理

```
页面加载 → 拦截 soldOut → 10:00 自动点"特惠订阅"
→ 弹出验证码 → OCR 自动识别并点击 → 弹出支付二维码 → 扫码付款
```

- 脚本**不直接调用后端 API**，只自动化页面上的点击操作
- 验证码由本地 OCR 识别，不上传任何数据到外部服务器
- 本轮超时（30 秒）后自动重试，持续到 10:30

## 项目结构

```
├── glm-coding-sniper.user.js      # 油猴脚本（主文件）
└── captcha-server/
    ├── server.py                   # 验证码 OCR 服务
    └── requirements.txt            # Python 依赖
```

## 注意事项

- **不要开多个标签页** — 一个就够
- **提前准备支付** — 二维码有效期很短
- **订单无金额不要付款** — 异常情况请不要扫码
- **脚本只改前端** — 后端库存校验不受影响

## License

MIT
