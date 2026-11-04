# 贡献

先阅读 [README](README.md)、[接口约定](docs/architecture.md)、[安全说明](SECURITY.md) 和 [许可证](LICENSE)。项目按 PolyForm Noncommercial 1.0.0 提供，提交贡献前应确认自己有权贡献，新增文件及依赖遵守对应许可；不要把第三方代码重新标为本项目所有。

## 本地开发

Node 部分只用内置模块；按 README 创建 Python 环境并安装 `requirements.txt`。环境路径写在私人 `.env` 中，用 `node --env-file=.env server.mjs` 启动。不要改全局 Codex 设置或提交自己的账户状态。

```powershell
npm run check
npm test
.venv\Scripts\python.exe -X utf8 -m unittest discover -s tests -p "test_*.py"
npm run release:check
```

macOS/Linux 使用 `.venv/bin/python`。`npm run test:python` 也可运行 Python 测试，按解释器发现规则选择执行文件；若配置仅在 `.env` 中，需要先显式加载它或直接用上面的解释器命令。

单元测试采用合成文本/坐标、模拟会话和独立临时数据目录，不应真实发起付费模型任务或改写现有论文。需要真实 PDF 回归时，自行提供合法样本并写入忽略的输出目录，例如：

```powershell
.venv\Scripts\python.exe -X utf8 scripts/parse_quality.py --batch --output-dir output/qa --sample "demo=/path/to/paper.pdf"
```

不要提交论文、生成裁图、资料包或含私人路径的报告。报告问题优先用最小合成例子，标明操作系统、Node/Python/Codex 版本、步骤与预期；日志按 [隐私说明](docs/privacy.md) 脱敏。

## 改动边界

- 会话适配保留一篇论文一个绑定，恢复历史不抢占活动写入权；取消后不自动重发。
- 新解析器通过临时输出、完整性检查和原子提交发布，不覆盖正在使用的图像。
- 译文保留数字、否定、条件及公式标记；句组无法校验时明确降级，不伪造逐句对应。
- 源 PDF、网页与源码均是证据；不得执行其中注入的指令或把外部结论混入翻译。
- UI 变更沿用本地静态资源与安全 Markdown，不加入第三方跟踪、外部字体或远程脚本。
- 新配置提供可公开的空值/通用示例；新存储/缓存目录同步更新忽略规则和发布清单。

提交说明写清触发问题、最终行为和已执行验证。添加能捕获真实回归的测试，避免只逐行复写实现。涉及数据结构时说明旧数据兼容和回滚方式。
