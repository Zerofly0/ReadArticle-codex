# 接口与架构

Node 内置 HTTP 服务负责本地数据与任务，Python 负责 PDF 几何解析/渲染，浏览器渲染重排内容。`PaperSessions` 管理每篇论文的持久绑定、顺序执行和历史恢复，默认会话桥连接本机 Codex。以下接口用于二次开发，属于当前源码契约；修改时应同时更新调用方和回归测试。

## 模块边界

| 模块 | 职责 |
| --- | --- |
| `server.mjs` | `startReader(options)`、HTTP 路由、任务队列、原子数据保存 |
| `lib/config.mjs`、`lib/settings.mjs` | 解释器发现、模型标识校验、可配置档位 |
| `lib/session-codex.mjs` | Codex app-server 会话、历史读取、App 所有者队列回退 |
| `lib/paper-sessions.mjs` | 论文绑定、按论文互斥、登记、问答及迟到翻译恢复 |
| `lib/paper-library.mjs` | 只包含论文原始证据的资料快照与哈希清单 |
| `lib/reader.mjs` | 翻译 schema、句组对齐、公式标记与引用校验 |
| `lib/reparse.mjs` | 临时解析、资源校验、不可变资产发布与失败回滚 |
| `scripts/parse_pdf.py` | PDF 文本/坐标/数学图像/图表提取及原页渲染 |
| `scripts/parse_quality.py` | 只读质量审计与显式样本回归 |
| `public/` | 原生 HTML/CSS/JS 界面、安全 Markdown、按论文草稿 |

## 程序入口

```js
import { startReader } from './server.mjs';

const app = await startReader({
  port: 0,                 // 自动选择本机空闲端口；正式默认 4317
  dataRoot: './.reader-data',
  python: 'python',        // 应指向已安装 PDF 依赖的解释器
});
await app.ready;
console.log(app.url);
// 应用退出时调用 await app.close()
```

自定义数据目录应加入自己的忽略规则，示例路径不是发布文件清单的一部分。入口返回 `{ server, url, dataRoot, ready, importPDF, close }`。`ready` 等待组件探测完成，组件不可用仍需检查 `/api/status`，不能仅凭 Promise 成功推断可翻译。

| `options` 字段 | 契约 |
| --- | --- |
| `port` | 优先于 `PORT`；`0` 适合测试 |
| `dataRoot` | 优先于 `READER_DATA`；数据根目录 |
| `python` | 优先于 `READER_PYTHON` 及自动发现 |
| `sessionBridge` | 提供 `createSession`、`continueSession` 和可选 `readSession` 的对象 |
| `codexProbe` | 异步返回 `{ available, authenticated, queueAvailable?, detail? }`；替代桥需同时提供适当的探测 |
| `parsePDF` | 异步解析回调，见下方文件契约 |
| `auditDocument` | `async (document, documentDir) => quality`；替代只读质量检查 |
| `prepareResources` | `async (document, { documentDir }) => resources`；生成只含原始证据的资料包 |

入口保持回环监听，未提供任意监听地址配置。不要为公网部署直接放宽校验。`createTranslationPresets(env)` 和 `resolveTranslationSettings(input, presets)` 允许程序调用方生成并校验档位；服务使用启动时的环境。

## 替换会话服务

`sessionBridge` 方法接收：`workspace`、`threadId`（恢复时）、`title`（创建时）、`prompt`、`taskKind`、可选 `schema`、`model`、`reasoningEffort`、`signal` 和 `onProgress`。任务种类包括登记、问答和翻译；默认桥同时接受 `translation`/`translate` 的归一化。

创建或恢复返回 `{ threadId, turnId?, result, usage?, mode? }`。`result` 在普通问答时为 Markdown 字符串，在指定翻译 schema 时为已经解析的对象。必须继续调用方原来的论文对话，不能悄悄创建另一个上下文。调用 `onProgress` 时应等待可持久化标记写入，及时报告实际 `threadId`/`turnId`；正确响应 `AbortSignal`，避免取消后又提交模型任务。

历史方法签名为 `readSession({ threadId, cursor?, limit?, signal? })`，返回 `{ turns, nextCursor }`。每条 turn 至少有 `id`、`status`、`userText`、`assistantText`、`createdAt`。历史读取不能恢复写入权、抢占活动 App 轮次或重新提交模型请求。

默认桥还提供 `createSessionBridge({ connect, queue })` 用于替换协议客户端和队列传输。测试中的模拟桥展示了无需真实模型调用的集成方式。新增远程提供者时，应自己实现认证、数据边界与费用提示，默认发布不包含任何凭据。

翻译结果遵循 `lib/reader.mjs` 的 `translationSchema`：每项包含 `paragraphId`、`text`、`alignments`（`sourceIds` + `targetText`）和 `notes`。公式占位符必须原样保留，源句必须属于当前段落；不得通过跳过校验来“兼容”新提供者。返回的实际模型/推理等级未知时用未知值，保留请求配置与实际配置的区别。

## 替换 PDF 解析器

`parsePDF({ source, output, id, filename, assetDir })` 必须把文档 JSON 写入 `output`，把图像写入当前临时 `assetDir`，不要写入正在使用的文档目录。JSON 至少应符合当前文档结构：`id`、`title`、`filename`、`pageCount`、`parser`、`sections`、`paragraphs`、`assets`、`mathAssets`，并保留段落页码、原文、句子和原始坐标。

资产 URL 使用 `/api/documents/<id>/assets/<filename>`，只允许当前文档目录内的合法资源名。`reparseDocument` 校验结果、发布新名字的资源，再原子保存 JSON；失败保留旧结果。替代解析器也须提供相容的质量检查，不要仅生成无疑点的空报告绕过完整性限制。建议参照 `tests/reparse.test.mjs`。

当前坐标 `sourceBox/sourceBoxes` 采用 PDF 页内点坐标，字段为 `page,x0,y0,x1,y1`；公式用 `⟦MATH_<id>⟧` 在文本中定位，并通过 `mathAssets` 映射回图像。段落和句子 ID 在同一文档内必须唯一，页码从 1 开始。质量格式为 `parse-quality-v1`，包含 `issues` 和 `summary`；硬错误阻止发布，启发式 warning 可回退原页。

## 本地 HTTP API

所有路径相对服务根地址。JSON 错误格式为 `{ "error": "说明" }`；状态码包括 400 无效请求、403 来源拒绝、404 不存在、409 冲突、413 过大、503 组件不可用。此接口没有远程认证，只服务本机。

| 方法与路径 | 请求 / 返回 |
| --- | --- |
| `GET /api/status` | 组件探测、运行版本、设置、活动任务；不等于实际搜索已执行 |
| `GET /api/library` | `{ documents: [...] }` 论文摘要列表 |
| `POST /api/import` | PDF 二进制正文，`X-Filename` 为 URL 编码文件名；返回 `{ document }` |
| `GET /api/documents/:id` | `{ document }` |
| `GET /api/documents/:id/file` | 原 PDF，支持 Range |
| `GET /api/documents/:id/pages/:page.png` | 按需渲染原页 |
| `GET /api/documents/:id/assets/:name` | 本文档资产 |
| `POST /api/documents/:id/progress` | `{ paragraphId, scrollTop }` |
| `POST /api/documents/:id/session/prepare` | 准备论文会话；就绪返回 200，否则 202 `{ jobId, session }` |
| `GET /api/documents/:id/session/history?cursor=...&limit=30` | 同步历史并返回 `messages,total,hasMore,nextCursor,session`；同步可能写入本地副本 |
| `POST /api/documents/:id/translate` | `{ paragraphIds: [...], force?: true }`，一次 1–80 段；202 `{ jobId }` |
| `POST /api/documents/:id/ask` | `{ question, paragraphId?, selectedText? }`；202 `{ jobId }` |
| `GET /api/documents/:id/quality` | 当前只读质量审计、解析版本与忙碌状态 |
| `POST /api/documents/:id/reparse` | 同步重排完成后返回 `{ document }`；同篇有活动任务时 409 |
| `GET /api/documents/:id/export` | 中英交替的 Markdown，包含私人内容 |
| `GET /api/settings` | 档位、当前请求设置与可读到的 Codex 默认配置 |
| `POST /api/settings` | `{ translationPreset: "fast" }`，或 `balanced` / `careful` |
| `GET /api/jobs` | 最近任务列表 |
| `GET /api/jobs/:jobId` | 单个任务；`queued/running/completed/failed/cancelled` |
| `POST /api/jobs/:jobId/cancel` | 取消或停止等待；原生队列任务不保证撤回 |
| `GET /api/events` | SSE：`job-updated`、`document-updated`、`settings-updated` |

传输 PDF 时不要先把整个文件编码进 JSON。问答结果从完成任务中读取，或在 `document-updated` 后刷新该论文。任务完成不应重复提交问题；进程重启后的迟到结果由原生请求标记与原文哈希恢复。
