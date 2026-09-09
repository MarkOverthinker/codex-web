# 离线便携部署升级

适用于 Linux x86_64 上已有 `start.sh`、`app/` 的便携安装。源码宿主部署和 Docker
部署不能直接套用本脚本；请先确认目标部署类型。目标机需 bash、tar、zstd、sha256sum、
git，内置 Node 22 要求 glibc 2.28+。打包机需要联网准备依赖，目标机安装无需 npm/pip 下载。

## 构建与交付

在干净且依赖已安装的仓库运行 `scripts/package-offline.sh --output-dir /path/to/output`。
脚本从 Git HEAD 导出固定提交快照，构建 Web/服务端、裁剪生产依赖，内置 Node、Codex CLI、
relay（含许可/SBOM）与共享 Python。未提交的代码不进入快照；本地环境文件、
Android 构建缓存、用户附件和数据不从工作区收集。包内 `REVISION` 记录 HEAD，正式发包前须提交变更。
Python 按锁文件同步并验证离线重建，包内不保留不可迁移的虚拟环境。

交付 `.tar.zst`、同名 `.sha256`、独立 `upgrade.sh` 和 `README-OFFLINE.md`。
SHA256 文件只记录文件名，支持复制到其他目录/机器后校验。归档所有者统一为数字 0，
不携带打包机用户名或 UID/GID；升级解压采用目标机执行用户，不沿用归档所有者。

## 在目标机升级

先等待运行中的任务结束。将全部交付文件放到旧部署根之外，用**新包附带的脚本**运行：

```bash
cd /path/to/upgrade-files
sha256sum -c codex-web-offline-linux-x64-node-YYYYMMDD.tar.zst.sha256
bash ./upgrade.sh ./codex-web-offline-linux-x64-node-YYYYMMDD.tar.zst /path/to/codex-web
```

需要手动启动时追加 `--no-start`。脚本先解压并验证程序结构，再停服务；systemd 服务的
WorkingDirectory 必须匹配目标 `app/`，避免停止同机其他源码实例。
程序解压不继承打包机 UID/GID，已有数据目录不被程序同步覆盖。
完整旧部署备份在同级 `codex-web-backups/`，包含旧代码、数据库、配置与 Python，权限受限。
需预留新包解压、旧部署备份、替换程序的空间；数据量大时备份时间与空间随之增加。
外置 DATA_ROOT / TENANT_ROOT / WORKSPACE_ROOT、符号链接指向的数据和系统配置需另行备份。

升级保留 `app/.env`、数据库、会话、附件、输出和工作区；整体替换构建产物、node_modules
及包管理的 `app/data/python`，避免旧依赖残留。首次启动会用包内缓存离线重建 Python。
自装 Python 依赖应单独管理，不能放入包管理的共享环境并期待升级保留。
新配置项对照 `.env.example` 手动补充，不覆盖已有配置。
若旧 `.env` 显式设置 CODEX_RUNTIME_PATH / CODEX_RELAY_PATH，仍优先使用该外部路径，
不会自动改为包内版本；需要使用包内版本时，在备份后手动移除旧路径配置。

失败时停止原启动方式的服务，将失败目录改名、重建原目录，再解压完整备份并按原方式启动；
脚本输出具体恢复命令。恢复旧数据库会撤销升级后的新写入，不能仅回滚代码而继续使用已迁移数据库。

## 功能边界

Web 启动和升级不需要公网，但 Codex 任务需要可达模型端点（可以是内网端点）及目标机自己的凭据。
不打包或修改用户的 `~/.codex`，不改变现有 Web/worker 用户隔离配置；便携启动器仍使用原有 host mode。
独立本地 ASR 服务、模型权重、ASR Python 环境和 Android APK 不属于 Web 升级包。
已有 ASR 保持原部署，新装/迁移参见 `LOCAL_VOICE.md`；未部署时不要启用 local 转写。
