# READ

在本地浏览器中精读英文论文：左侧显示英文与中文译文，右侧保留论文专属聊天。翻译与问答连接使用者自己已登录的 Codex，阅读器可以独立运行。

## 功能

- 按段或按节翻译，结合已登记的论文上下文；悬停联动高亮中英对应句组。
- 划选论文内容后提问，每篇论文绑定独立的持久 Codex 对话；切换论文同步切换聊天。
- 保留公式、作者单位与图表的原始图像，支持查看原页、图片缩放和平移。
- 单栏、双栏重排；排版检查展示问题页码，手动更新时备份并保留可复用的译文。
- 本地保存译文、问答、阅读进度，浏览器按论文保存未发送的草稿。
- 问答按需查找可靠的外部资料；回答区分论文证据、外部来源和辅助解释。
- 简洁浅色与深色界面，可调字体、阅读宽度和聊天面板宽度。

## 安装和启动

需要 Node.js 20.6+、Python 3.10+，以及已安装并登录的 Codex CLI。桌面项目归属、原生历史和队列接入取决于安装版本支持的协议；不保证任意旧版 Codex 都可使用。先在普通用户终端确认 `node --version`、`python --version` 与 `codex --version` 可运行。缺少 Codex 时仍可打开界面、解析和阅读 PDF，翻译与问答需要连接恢复。

Node 部分仅使用内置模块，不需要安装 npm 运行依赖。Python 使用独立虚拟环境：

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

macOS/Linux 将第二行的解释器替换为 `.venv/bin/python`。复制配置样例：

```powershell
Copy-Item .env.example .env
```

在 `.env` 中把 `READER_PYTHON` 设置为刚创建的虚拟环境解释器路径，然后启动：

```powershell
node --env-file=.env server.mjs
```

macOS/Linux 可用 `cp .env.example .env` 复制配置。打开 [http://127.0.0.1:4317](http://127.0.0.1:4317)。前台服务用 `Ctrl+C` 停止。

也可让启动器在后台运行并打开浏览器：

```powershell
node --env-file=.env scripts/launch.mjs
```

已在终端设置环境变量时，可直接运行 `npm start`，或在 Windows 双击 `start.cmd`。`.env` 不会被这两种方式自动读取。启动器复用现有服务；`--no-open` 只启动服务，`--restart --no-open` 在无活动任务且 PID 匹配时重启它。日志与 PID 保存在 `.reader-runtime/`。

## 使用

1. 导入含文本的英文 PDF，限制为 40 MB、200 页。首次连接会为论文创建持久对话并登记本地资料。
2. 点击“翻译本段”或“翻译本节”。在右上角连接状态中选择档位；实际可用模型由自己的账户与 Codex 安装决定，可在本地配置中替换档位模型。
3. 悬停查看中英对应，划选后在右侧继续提问，也可不选文字直接询问整篇论文。
4. 点击页码核对原页；通过“排版检查”查看解析问题，并按需手动更新。旧论文不会被自动重排。
5. 翻译记录显示耗时与执行情况。App 已持有对话写入权时，队列沿用该对话的配置，阅读器不会把请求档位冒充实际模型；取消队列等待也不代表已提交的原生任务被撤回。

登记时生成可回查的 PDF、原文索引与图像资料包，并把资料清单交给该论文对话。后续问题发送问题、选文/位置和清单路径，模型按需读取原文。它不是把 PDF 作为聊天附件上传，也不保证上下文压缩后模型仍记得全文。

## 配置、数据与扩展

| 文档 | 内容 |
| --- | --- |
| [配置](docs/configuration.md) | 端口、数据路径、解释器、模型档位与环境变量 |
| [接口与架构](docs/architecture.md) | HTTP API、解析器约定、会话桥接与程序注入接口 |
| [隐私与备份](docs/privacy.md) | 本地数据、Codex 历史、联网边界、迁移和脱敏 |
| [发布](docs/releasing.md) | 检查、生成干净发布包与 GitHub 上传流程 |
| [贡献](CONTRIBUTING.md) | 测试、代码边界与提交要求 |

论文、译文、聊天副本和绑定保存在 `.reader-data/`；草稿保存在当前浏览器的站点数据中。Codex 另行保存自己的对话历史。复制源码不会复制这些私人资料；公开仓库和发布包应始终排除数据、认证、日志、真实论文和私人截图。详见 [安全说明](SECURITY.md)。

## 验证与发布

```powershell
npm run check
npm test
npm run test:python
npm run release:check
npm run release:pack
```

如果使用的 Node 环境未包含 npm，也可直接运行 `node scripts/check.mjs`、`node scripts/test.mjs`、`node scripts/test-python.mjs`、`node scripts/release.mjs --check` 和 `node scripts/release.mjs --pack`。

Python 测试通过 `READER_PYTHON` 或解释器发现规则运行；使用 `.env` 时先显式加载配置，或按 [贡献指南](CONTRIBUTING.md) 直接调用虚拟环境。测试使用合成数据和模拟会话，不要求公开个人论文或登录凭据。真实论文回归由维护者自行准备有使用权限的 PDF，在被忽略的输出目录中执行。

`release:pack` 生成 `release/` 下带内容摘要的干净源码目录、ZIP 及文件哈希清单。请从该干净目录创建 Git 仓库并上传，具体步骤见 [发布文档](docs/releasing.md)。

## 当前边界

这是面向单用户本机的阅读器，服务仅监听 `127.0.0.1`，未提供远程部署所需的账户、鉴权或多租户隔离。扫描件 OCR、任意复杂表格重建和可编辑 LaTeX 尚未实现。数学保真采用 PDF 原区域图像；复杂版式无法可靠裁剪时明确回退原页。结构校验与排版检查不能保证译文语义绝对正确。

## 许可

项目源码采用 [PolyForm Noncommercial 1.0.0](LICENSE)，仅按许可证允许的非商业用途使用；这不是 OSI 开源许可证。未经权利人另行授权，不得进行许可证范围之外的商业使用。具体权利、限制与终止条款以 [完整许可文本](LICENSE) 为准。第三方组件保留各自许可证，见 [第三方说明](THIRD_PARTY_NOTICES.md)。
