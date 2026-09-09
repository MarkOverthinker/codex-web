# 本地多模型语音输入

## 使用方式

主输入框和侧边聊天均有“语音模型”选择器，可在录音前选择：

- **SenseVoiceSmall INT8**：低延迟、低内存。
- **Qwen3-ASR-0.6B**：本部署也使用 INT8 ONNX 权重，作为中文识别质量对照。
- **Fun-ASR-Nano FP32**：可额外启用的对照模型，占用更多内存；不取代上述两个模型，也不保证更快或更准。

语音选择菜单内可设置“上下文标点”或“保留模型原标点”，并填写常用术语。侧边聊天在设置区提供相同选项，网页按用户名在当前浏览器保存。Qwen和Nano支持术语提示，SenseVoice不支持；提示不保证拼写正确。原生客户端不传新选项时仍可使用默认上下文标点，但没有新增术语编辑界面。

识别先合并间隔不超过2秒、合并长度允许的语音段，再按最长16秒的有界窗口识别；不再把每个音频块强制插成一行。短暂停顿不等于句号。合并文本后使用本地CT-Punc INT8恢复标点；如果结果改动原字符或英文词边界则回退，路径、版本号、负数等敏感技术文本也保留原样。不使用生成式润色，不删除口头语，不保证断句完全符合说话意图。旧离线安装没有标点权重时保留原标点。

推理缓存最多两组识别器，初始预热两个旧模型；首次选择Nano或更换其术语表可能触发重新加载。录音仍在用户停止后识别，本轮没有加入边录边识别。

桌面主输入框的“语音”选择框与模型、思考等级等选项放在同一行；App/窄屏将它收进“任务选项”面板，输入栏仅保留一个语音按钮。侧边聊天的语音模型放在上方模型设置区。麦克风按钮位于发送按钮旁。

点击麦克风开始录音后，可以选择两种结束方式：再次点击语音按钮，只识别并追加到当前草稿；或者点击发送按钮，依次结束录音、识别、合并最新草稿并发送一次。识别失败、空结果或取消均不发送。等待识别时发送按钮禁用，避免重复请求。

录音、识别或麦克风授权等待期间均可取消。模型在本次录音开始时固定，识别中不可切换；切换会话、编辑目标或关闭侧边聊天会取消旧录音/回填及待发送意图，避免把迟到结果写入其他草稿。当前浏览器按用户名保存选项，不改变编码模型的选择。

目前不是边说边显示文字。前端最长录音5分钟，上传上限15 MiB。识别期间可以继续编辑草稿，合并基于识别完成时最新的草稿。只有录音中主动触发发送才在识别后发送；普通停止、到达录音时限或App切入后台仅转写到草稿。手机Enter保持换行；桌面Enter与发送按钮行为一致。

## 架构与边界

浏览器录音 → 已登录且通过CSRF验证的 `/api/transcriptions` → 权限受限的 Unix socket → 独立低权限 Python 服务。

本地模式只将音频及白名单模型ID传给服务，不发送草稿、图片、附件或消息上下文。它不使用Codex任务执行器，不在Express进程内加载模型，不改变web UID与tenant worker UID的分离。失败时不切换云API。

Python服务在无外部网络的命名空间运行，只监听Unix socket。它使用随wheel安装的FFmpeg将录音转为16 kHz单声道PCM，输入/输出只允许pipe协议；不接受用户提供的文件路径或下载地址。Silero VAD过滤静音并按停顿分段，连续语音约18秒强制分段以约束Qwen上下文长度。强制切分可能影响边界词，不承诺无损长录音转写。检测到有声片段却得到空结果时，返回错误而不是悄悄丢掉该片段。

VAD片段前后保留最多200毫秒上下文，邻接片段在间隙中点限制扩展，避免重复音频。它可减少词首被切掉的情况，但不保证所有边界词都正确。

两个旧模型在独立进程启动时预热，之后按两项LRU缓存加载；并发识别串行化，忙时返回429，不创建无界队列。请求超时、每段生成长度、音频时长和转换超时均有上限。VAD不是百分之百准确的“无幻觉保证”；低音量、纯噪声、术语及真实口述仍需用户检查。

## 准备模型与依赖

需要 Linux x86_64、Python 3.12、uv、curl、允许非特权user/network namespace的`unshare`。现有包固定在 `requirements.txt`；模型来源与SHA-256固定在 `models.json`。安装器不修改共享Python，而是在ASR目录创建专用`runtime/`。

默认配置 `services/local-asr/deployment.toml` 将数据放在项目的 `data/local-asr/`；可改 `root`。**解析后的socket绝对路径必须不超过107字节**。CPU线程默认为6，服务只需要CPU，不需要GPU。只用旧模型建议预留至少4 GiB可用内存，启用Nano建议8 GiB；安装时同时保留压缩包、展开权重、wheels和运行环境，需预留相应磁盘空间。

在Codex Web任务环境中准备：

```bash
"$CWW_PYTHON_RUNNER" --mode temporary --with pip \
  --script services/local-asr/setup.py -- services/local-asr/deployment.toml
```

普通主机可先创建专门的安装环境（Python3.12、pip），再运行：

```bash
python services/local-asr/setup.py services/local-asr/deployment.toml
```

此阶段联网下载固定权重和Python wheels，并校验模型压缩包/VAD散列。准备完成后会保存本地文件清单。推理阶段不会自动下载任何东西。

## 启动与配置网页

以非root用户安装用户级systemd服务：

```bash
python services/local-asr/install-user-service.py services/local-asr/deployment.toml
systemctl --user status codex-web-asr.service
```

安装器在ASR数据目录生成unit并链接到用户管理器，启用 `codex-web-asr.service`。若需要无人登录时随系统启动，应由管理员为该用户启用systemd lingering。unit设置CPU配额600%、MemoryMax=12G、UMask0077、NoNewPrivileges，并用`unshare`隔离网络。上限不是预分配；调线程时应同步调整unit中的OMP_NUM_THREADS和CPUQuota。不要以root运行这个安装器或把推理合并到web服务进程。

也可在终端前台验证：

```bash
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=6 \
unshare --user --map-root-user --net \
data/local-asr/runtime/bin/python services/local-asr/service.py services/local-asr/deployment.toml

curl --unix-socket data/local-asr/asr.sock http://localhost/health
```

不要同时启动前台实例和systemd实例。健康检查只在模型加载完成后返回成功。systemd启动失败时用 `journalctl --user -u codex-web-asr.service` 查看原因，不应移除网络隔离来“修复”。

在web服务器的私有环境中设置：

```dotenv
TRANSCRIPTION_PROVIDER=local
# Default: <projectRoot>/data/local-asr/asr.sock; set an absolute path when customized.
LOCAL_ASR_SOCKET=
LOCAL_ASR_MODELS=sensevoice-small-int8,qwen3-asr-0.6b,fun-asr-nano-fp32
```

随后重建并重启web服务。安装了reloader的host-mode部署使用 `npm run reload`；运行中的任务可能使重载排队等待。ASR服务不依赖web重载；后续修改Python服务或配置时，需单独 `systemctl --user restart codex-web-asr.service`。

socket默认0600，ASR根目录默认0700。web UID必须能够连接：root运行的host-mode web服务可以连接低权限服务的socket；非root web UID需由管理员配置严格的目录/套接字ACL，服务重启后需重新应用socket ACL。**不要使用0777，也不要为了省事合并web与tenant worker账户。** 容器场景需显式挂载socket目录并配置UID/权限；默认compose不会自动启动此用户级服务。

不需要 `DASHSCOPE_API_KEY` 或公网 `PUBLIC_BASE_URL`，但浏览器麦克风仍需HTTPS或localhost。离线局域网请准备浏览器信任的本地TLS证书。仅语音识别离线，不代表Codex的编码模型也能离线。

## 离线迁移

仓库的通用离线打包脚本默认不包含 `data/local-asr`，必须另外携带下列资产。TOML的 `models` 决定安装及加载哪些模型，网页的 `LOCAL_ASR_MODELS` 必须与其一致；环境变量省略时仍只展示两个旧模型。默认TOML包含三个模型，删除Nano项即可仅准备旧模型和标点模型。

复制本服务源文件、配置、`models.json`、`requirements.txt`，以及ASR目录的`models/`、`wheels/`、`manifest.json`。不要依赖Git保存权重，也不要直接复制venv当作跨机器可移植运行环境。

在兼容的Linux/Python基础环境下，将TOML的`offline`设为`true`，提供本地uv，重新运行安装器：不会下载模型，且依赖使用`--no-index --find-links`从wheelhouse安装。然后在目标机器重新生成systemd unit，并设置新的socket路径。系统Python、uv、curl/unshare、glibc和systemd不包含在模型包内；Windows、macOS、ARM或其他Python版本需要独立准备与验证。

模型/工具的许可证应随离线包保留；尤其FFmpeg wheel包含其自身许可证，分发时需遵守。不要将模型权重或部署私有路径提交到公共仓库。

## 验证与停用

```bash
npm test
npm run lint
OPENBLAS_NUM_THREADS=1 unshare --user --map-root-user --net \
data/local-asr/runtime/bin/python -m unittest discover -s services/local-asr -p 'test_*.py'
```

网页未出现模型选择器：检查登录session中的`voiceModels`、`TRANSCRIPTION_PROVIDER`及是否重载。出现503：检查独立服务、socket长度/权限；出现422：检查录音格式、音量或切换另一个模型；出现429：稍后重试。取消浏览器请求会阻止回填，但已开始的CPU识别不一定立即停止，仍受服务端限时约束。

设置 `TRANSCRIPTION_PROVIDER=disabled` 并重启web可隐藏功能；`systemctl --user disable --now codex-web-asr.service` 可停止常驻模型并释放内存。旧云端方案仍可显式选择 `TRANSCRIPTION_PROVIDER=dashscope`，本地模式不会自动切换过去。未设置provider时保留旧部署的云端配置兼容性；显式设置未知值时禁用语音，不把拼写错误当成云端模式。
