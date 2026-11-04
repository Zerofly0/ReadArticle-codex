# 配置

配置在进程启动时读取。`.env.example` 只包含可公开的示例，不会自动加载；复制为被忽略的 `.env` 后，通过 Node 的 `--env-file=.env` 显式加载。已有进程环境变量优先于 `.env` 中的同名值。不要把登录信息或真实对话编号写进样例。

```powershell
node --env-file=.env server.mjs
```

| 环境变量 | 用途 | 未设置时 |
| --- | --- | --- |
| `PORT` | 本机 HTTP 端口 | `4317`，监听地址固定为 `127.0.0.1` |
| `READER_DATA` | 论文、译文、聊天副本与设置目录 | 项目目录下 `.reader-data/` |
| `READER_PYTHON` | 安装 PDF 依赖的 Python 可执行文件 | 尝试当前用户的 Windows Codex bundled Python，然后使用系统 `python` / `python3` |
| `CODEX_EXECUTABLE` | Codex 可执行文件 | 先从 `PATH` 发现，Windows 下再尝试当前用户的桌面安装目录 |
| `CODEX_HOME` | Codex 自身的配置和登录目录 | 沿用使用者既有环境；READ 不创建或复制认证 |
| `READER_MODEL_FAST` | 快速档位的模型名 | 源码中该档位的默认值 |
| `READER_MODEL_BALANCED` | 稳妥档位的模型名 | 源码中该档位的默认值 |
| `READER_MODEL_CAREFUL` | 深入档位的模型名 | 源码中该档位的默认值 |
| `READER_EFFORT_FAST` | 快速档位的推理等级 | `low` |
| `READER_EFFORT_BALANCED` | 稳妥档位的推理等级 | `low` |
| `READER_EFFORT_CAREFUL` | 深入档位的推理等级 | `medium` |

相对路径按相关进程/接口的工作目录解析。为避免从不同终端启动时指向不同位置，解释器与外置数据目录建议使用绝对路径，只放在私人配置中。若使用项目外的数据目录，也要在其所属仓库/同步服务中单独排除，当前仓库的 `.gitignore` 不能保护其他目录。

模型/等级覆盖设为 `inherit` 表示不强制指定该项，交由所连接 Codex 会话处理。空值或未设置沿用 READ 档位默认值。模型名可使用安全的模型标识或提供者别名，实际可用性由自己的账户决定；覆盖仅配置请求，不保证访问权限或不同模型支持相同的推理等级。HTTP 设置接口只选择预定义档位，不直接接收任意模型配置。修改环境变量后重启服务才会生效，网页选择的档位另存在数据目录的 `settings.json`。

READ 不修改全局 Codex 配置，不从 `CODEX_THREAD_ID` 或 `READER_THREAD_ID` 继承开发对话。新论文由阅读器创建专属对话，优先匹配工作目录一致的现有 App 项目，没有写死项目名称或用户项目编号。已有论文继续使用自身数据中的绑定。

当现有 App 会话持有写入权时，桥接器尝试排队至原对话，实际模型/工具沿用该会话配置。任务记录会区分请求配置、实际已知配置和未知值；环境覆盖不能强行替换 App 拥有的会话配置。

程序使用者还可通过 `startReader(options)` 指定数据目录、解释器及替代服务。其优先级与签名见 [接口与架构](architecture.md)。
