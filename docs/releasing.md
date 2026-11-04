# 发布到 GitHub

发布脚本只准备本地文件，不创建仓库、不推送到 GitHub。请使用生成的干净目录，不要直接将日常阅读工作目录整体上传。

## 生成和检查

```powershell
npm run check
npm test
npm run test:python
npm run release:check
npm run release:pack
```

发布器按版本控制的文件白名单收集源码、测试、文档和配置样例，扫描可能的凭据/个人路径，再生成 `release/READ-<版本>-source-<内容摘要>/` 和同名 ZIP。目录中包含 `release-manifest.json`，列出相对路径和 SHA-256，便于审查实际打包内容。重新打包时按新的内容摘要区分产物。

生成的 `release-manifest.json` 默认不加入 Git，供此次发布产物核验使用，避免后续修改源码后留下过期哈希。ZIP 旁还会生成整个压缩包的 `.sha256` 文件。

`.reader-data/`、`.reader-runtime/`、`.env`、运行日志、论文 PDF、裁图、私人截图、缓存、虚拟环境和当前工作目录的 Git 历史不应进入发布包。白名单之外的新文件不会自动发布，新增必要源码时应更新发布清单。扫描器不是秘密检测的绝对保证，人工检查最终产物仍然必要。

可在干净目录中检查文件列表、运行检查及测试；先安装该目录的 Python 依赖或显式指定 `READER_PYTHON`。不要把用于验证的私人配置、测试输出或数据添加到仓库。

## 上传干净源码

1. 在 GitHub 创建自己的空仓库。
2. 进入打包器打印的干净源码目录，确认没有原论文、问答、日志和个人配置。
3. 在该目录新建 Git 历史，审查暂存列表，再连接自己的仓库。

```powershell
git init
git add .
git diff --cached --stat
git diff --cached
git commit -m "Prepare READ source release"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
git push -u origin main
```

替换 URL 中的通用占位符。命令应在生成的干净目录执行；不要在含私人阅读数据的工作目录中复制执行 `git add .`。如果仓库已有历史，先检查历史是否包含敏感数据，单靠本次干净文件无法清除过去的泄露。

若使用 GitHub 网页上传，应先解压源码 ZIP，并把干净目录内容作为仓库文件上传。ZIP 也可作为 Release 附件，但不能代替源码文件的审查。演示截图请使用人工合成样例或确认可公开的资料，另外检查浏览器地址栏、账号信息和右侧聊天。

## 发布前确认

- `LICENSE` 为本项目采用的 PolyForm Noncommercial 1.0.0，README 说明非商业用途；不要将项目标为 MIT 或无限制商用。
- 保留 `THIRD_PARTY_NOTICES.md`，第三方许可证不因项目非商业许可而改变。
- 配置样例没有自己的路径、认证、项目/对话编号；安装者使用自己的 Codex 登录。
- 测试、文件扫描和干净目录启动检查均完成；明确区分自动检查与实际执行过的验证。
- 仓库只发布源码和必要文档，个人阅读资料继续留在原数据目录。
