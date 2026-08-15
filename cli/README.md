# Meridian CLI

把公告交给 Meridian，用一条命令得到带原文溯源、数字验证和明确缺口的研究 memo。CLI 只负责人类入口、文件读取与 PDF 解析；研究流程仍由 `@meridian/agent` 的公开 API 执行。

## 安装

需要 Node.js `22.19+`（或 `24+`）。

```sh
cd meridian/cli
npm install
npm link
```

准备一个 DeepSeek key。Meridian 默认调用 OpenAI 兼容的 DeepSeek 接口，温度固定为 `0`：

```sh
export DEEPSEEK_API_KEY=你的密钥
```

## 第一条命令：3 分钟拿到 memo

从仓库根目录运行：

```sh
meridian ask --file meridian/bench/tasks/MB-001/context/announcement.txt "重整走到哪一步"
```

终端会显示结论段、验证/拒绝数量和信息缺口；完整 memo 同时写入当前目录的 `memo.md`。分析多份公告时重复传入 `--file`，PDF、TXT 和 Markdown 可以混用：

```sh
meridian ask "这家公司重整走到哪一步?" \
  --file 公告1.pdf \
  --file 公告2.txt \
  --out runs/restructuring-memo.md
```

PDF 解析依赖只安装在这个 CLI 包中，不会进入 agent 核心。扫描版 PDF 如果没有文本层，请先 OCR。

## 60 秒读懂 memo

1. 先读“结论”：每句话后的 `[C-A]` 是 claim 锚点，不是脚注装饰。
2. 再看“事实与分析”：原文引用会标出 `S-A` 等来源标识；来源表能把标识解析回具体文件或链接。
3. 数字只有两种：公告原文逐字出现的数字，或在“派生数字”中列明公式的确定性计算。
4. “风险与反方证据”说明什么材料会削弱推断；没有反方证据的推断不会发布。
5. “缺口”中的“无法核实/未披露”是有意输出，表示现有来源不足，而不是让模型猜答案。
6. 最后看 gate：只有内容契约、数字绑定和合规检查全部通过，命令才以退出码 `0` 完成。

## 自带模型（BYO-model）

任何提供 OpenAI 兼容 `/chat/completions` 的服务都可以接入：

```sh
export MERIDIAN_MODEL_API_KEY=你的密钥
export MERIDIAN_MODEL_BASE_URL=https://你的服务.example/v1
export MERIDIAN_MODEL=你的模型名
```

`MERIDIAN_MODEL_*` 优先于 `DEEPSEEK_*`；只设置 `DEEPSEEK_API_KEY` 时，默认地址是 `https://api.deepseek.com`，默认模型是 `deepseek-chat`。

## 从 Periscope 拉公告

```sh
export PERISCOPE_API_KEY=你的密钥
export PERISCOPE_BASE_URL=https://你的-periscope-服务.example

meridian ask "这家公司重整走到哪一步?" \
  --symbol 600491 \
  --source periscope
```

兼容已有部署使用的 `PERISCOPE_API_URL`，但新配置建议使用 `PERISCOPE_BASE_URL`。

## 本地跑一条 Bench 任务

`bench` 复用 agent 的 Bench fixture/任务契约，适合快速查看单题 memo：

```sh
meridian bench --tasks MB-001 --lang zh-CN --out runs/MB-001.md
```

`--tasks` 当前只接受一个 `MB-XXX`，以保证终端输出和 `--out` 一一对应。任务根目录默认是 `meridian/bench/tasks`，可用 `MERIDIAN_BENCH_TASKS` 覆盖。

## 给程序使用

加 `--json` 后，stdout 只输出一个 JSON 对象，包含 `status`、`exitCode`、输出路径、摘要、结构化 memo、Markdown 和完整 trace；`memo.md` 仍会落盘。

```sh
meridian ask "重整走到哪一步?" --file 公告.txt --json > result.json
```

退出码是稳定契约：

| 退出码 | 含义 |
|---:|---|
| `0` | 正常完成，验证 gate 通过 |
| `2` | 验证 gate 拒绝；memo 仍会写入，供审计 |
| `3` | 文件/数据取不到，或模型、密钥、配置不可用 |

常见错误会直接给出下一步：缺少 key 会列出需要设置的环境变量；文件不存在会回显路径；模型超时会提示检查网络和模型地址。

## 开发

```sh
npm run typecheck
npm test
npm run check:dsh-boundary
```

测试默认完全离线，覆盖本地 TXT/MD/PDF、Periscope fixture、Bench、JSON、输出文件和全部退出码。真实 DeepSeek e2e 仅在环境中存在 `DEEPSEEK_API_KEY` 时运行。
