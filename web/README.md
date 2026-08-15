# Meridian Web

Meridian Web 是与 CLI 平级的本地浏览器入口：上传公告、提出问题，然后阅读带逐条原文溯源和验证 gate 的研究 memo。它是单进程 Node HTTP 服务，页面只使用原生 HTML、CSS 和少量 JavaScript，没有前端框架或构建链，也不连接 Periscope。

## 启动

需要 Node.js `22.19+`（或 `24+`）。先配置与 Meridian CLI 完全相同的模型环境变量：

```sh
cd meridian/web
npm install

export DEEPSEEK_API_KEY=你的密钥
npm start
```

浏览器打开 `http://127.0.0.1:4317`。也可以从 `meridian/` 目录直接运行：

```sh
node web/bin/serve.ts --port 4317
```

使用其他 OpenAI 兼容模型时：

```sh
export MERIDIAN_MODEL_API_KEY=你的密钥
export MERIDIAN_MODEL_BASE_URL=https://你的服务.example/v1
export MERIDIAN_MODEL=你的模型名
npm start
```

`MERIDIAN_MODEL_*` 优先于 `DEEPSEEK_*`。上传区接受多个 `.txt`、`.md`、`.pdf` 文件，每个文件最大 10MB；扫描版 PDF 需要先做 OCR。

## 浏览器画面

> 截图位（文字描述）：米白色的 Meridian Local 首页，上方是 “EVIDENCE-FIRST RESEARCH” 与大标题；中间卡片依次展示文件拖放区、研究问题输入框和三语选择。生成后的 memo 页以“结论 / 关键发现 / 风险与反证”为主轴，绿色或红色 gate 横幅置顶；点击每条引文会展开原文，并可跳到上传文档中的对应段落。页面下半部完整列出派生数字链、claims、出处段落与审计记录。

## 怎么读 memo

- 正文按结论、关键发现、风险与反证分节。
- 每个“出处原文”可点击展开；“跳到上传文档对应段落”会定位到带高亮的原文上下文。
- “派生链”展开每个公式、输入、上游派生值、误差与叶子证据，能够从结果一直追到公告数字。
- 红色“验证拒绝”不是普通警告：该页不能视为已验证 memo。gate 的契约、合规、数字拒绝原因和完整审计记录会保留供排查。
- 历史链接只属于当前浏览器会话，存在进程内存中；服务重启后全部清除。

## 安全说明

服务默认只监听 `127.0.0.1`，其他机器不能连接。上传文件不落盘，memo 和原文只保存在当前 Node 进程内存里；页面设置了 CSP、同源表单检查、禁止缓存、点击劫持防护与 `HttpOnly; SameSite=Strict` 会话 cookie。

不要在不可信网络上直接暴露此服务。确实需要远程访问时可显式覆盖监听地址：

```sh
node bin/serve.ts --host 0.0.0.0 --port 4317
```

启动日志会打印暴露警告。远程部署必须自行在前面配置身份验证和 TLS；本包不提供账号体系。API key 只从服务进程环境变量读取，不会发送到浏览器。

## 开发与验收

```sh
npm run typecheck
npm test
npm run check:dsh-boundary
```

离线测试用 fixture 管线和 MockKernel 缝覆盖上传、multipart、渲染、引文锚点、派生链、会话历史、gate 拒绝、大文件、超时和安全默认。真实 MB-001 e2e 仅在环境中存在 `DEEPSEEK_API_KEY` 时运行。

