# Android 下载页与发布流程

下载页模板在 `releases/android/index.html`，发布工具为 `scripts/publish-android.mjs`。页面无框架、无外部字体或统计请求，适配手机和浅深色。只发布明确指定的 APK、公开版本说明及 SHA-256，不暴露会话目录、账号、签名私钥或服务器配置。

## 每次版本更新必须执行

1. 更新 `android/app/build.gradle.kts` 的版本号和递增 versionCode，同步 Android 文档。保持用户预览渠道签名不变。
2. 完成单元测试、lint、签名 Preview 构建及适用的界面/覆盖升级验收；记录没有验证的项目，不能把模拟器当真机。
3. 复制 `releases/android/release.example.json` 为本机忽略目录中的配置。所有路径相对配置文件解析；填入 APK、实际发布日期、简短更新说明、剩余限制、发布目录和预先保存的可信证书 SHA-256。不要从待验证 APK 临时取证书作为信任来源。
4. 在 JDK/Android SDK 已配置的环境执行 `node scripts/publish-android.mjs path/to/release.json`。它先校验签名、包名、SDK、ARM64、安装标记、ZIP/16KB 对齐及 APK versionName，再写入版本化文件、独立校验文件、公开 `releases.json` 和首页。同版本不同二进制会拒绝，必须递增版本。
5. 首次将生成目录挂到现有静态服务器的固定 URL。后续对同一持久目录发布；不要清空、覆盖整个目录或让下载页依赖会话附件的授权 URL。首页原子替换，旧版本文件保留；失败的校验不会修改线上首页。不可并发发布；进程异常留下 `.publish.lock` 时先确认没有发布进程再由维护者清理。
6. 检查手机/桌面页面、HTTPS 公网地址、APK GET 与范围下载；重新下载 APK 并比对本地 SHA-256。发布必须验证，不只生成 HTML。
7. 提交发布工具/模板/文档变更并推送；按项目要求运行 `npm test`。涉及服务代码时按宿主约定重载；静态下载页本身无需重启 Codex Web。

## 现有 Caddy 主机部署

复用 Caddy `/html/` 静态站点空间，固定 slug `codex-native`，相对路径 `/html/codex-native/`。公网 origin 沿用已有 frp/Caddy 配置，不在公共仓库硬编码私人域名。

首次可用 caddy-html-mount 技能的 `mount_html.py` 将发布目录复制到 `/srv/html-mounts/codex-native`。之后本机发布配置的 `output` 指向此持久目录，直接更新；不要重复使用 `--force` 清空历史。

本地检查 `http://127.0.0.1:8088/html/codex-native/`，frp 继续只转发已有 `127.0.0.1:8088`。APK 及校验文件使用相对链接，可在其他静态主机部署；仓库不依赖某个个人主机。公开页面和包可被任何知道链接的人读取，不要在版本说明中写私密数据。

## 发布数据

`releases.json` 是公开发布历史，保存版本、日期、文件名、大小、SHA-256、说明和限制；不保存本机路径或证书配置。最新版本按数字版本号排序，补发旧版不会降级首页。保持该文件和历史 APK 的持久备份。需要撤回版本时由维护者明确处理，自动发布工具不会删除历史。
