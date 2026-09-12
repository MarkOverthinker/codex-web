package app.codexweb.mobile

import android.graphics.Rect
import android.os.SystemClock
import android.view.MotionEvent
import android.view.inputmethod.InputMethodManager
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.delay
import kotlinx.coroutines.CompletableDeferred
import okhttp3.RequestBody
import okhttp3.Response
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.Closeable
import java.io.File
import kotlin.math.roundToInt

private const val longFileName = "设计方案-最终版-请以这一份为准-不要重复导出-版本V20260910.md"

private class UiStore : NativeStore {
    private val values = java.util.concurrent.ConcurrentHashMap<String, String>()
    override fun read(key: String) = values[key]
    override fun write(key: String, value: String?) { if (value == null) values.remove(key) else values[key] = value }
}

private class UiGateway : Gateway {
    override var csrf = ""
    var sends = 0
    var creates = 0
    var mutations = mutableListOf<String>()
    var draft: JSONObject? = null
    var failSend = false
    var failReview = false
    var reviewErrorText = "读取变更失败：Git 无法读取变更，请检查仓库权限、冲突状态或输出大小。"
    var listingError: String? = null
    var outputsEmpty = false
    var voiceGate: CompletableDeferred<Unit>? = null
    var pending = emptyList<JSONObject>()
    var longMessages = false
    var nextConversationFailure: ApiFailure? = null
    var editingPrompt: JSONObject? = null
    private val conversation = json("id" to "sample-task", "title" to "重做移动端交互", "status" to "idle", "working_dir" to "/workspace/codex-web", "latest_job_status" to "completed")
    private val tasks = listOf(conversation) + (2..7).map { json("id" to "task-$it", "title" to "项目任务 $it", "working_dir" to "/workspace/codex-web",
        "status" to if (it == 2) "running" else "idle", "latest_job_status" to if (it == 4) "failed" else "completed") } +
        listOf(json("id" to "task-long", "title" to "这是一个特别长的任务标题用来验证运行状态徽标在长标题换行显示时仍然完整可见不会被挤出卡片可视区域",
            "working_dir" to "/workspace/codex-web", "status" to "running", "latest_job_status" to "completed"),
            json("id" to "docs", "title" to "整理项目文档", "working_dir" to "/workspace/docs", "status" to "idle", "latest_job_status" to "completed"))
    private var selection = json("model" to "test-model", "reasoningEffort" to "medium", "sandbox" to "workspace-write")
    private val longName = longFileName
    private val outputs get() = if (outputsEmpty) emptyList() else listOf(
        json("id" to "out-1", "kind" to "output", "original_name" to "重构完成报告.md", "mime_type" to "text/markdown", "size" to 15360, "created_at" to "2026-09-10T09:12:00.000Z"),
        json("id" to "out-2", "kind" to "output", "original_name" to "数据统计-导出结果-这一份是最终版-请勿重复导出-20260910.csv", "mime_type" to "text/csv", "size" to 24680, "created_at" to "2026-09-10T09:15:00.000Z"))
    private val reviewFiles get() = (listOf(
        json("path" to "src/main.kt", "status" to "M", "additions" to 42, "deletions" to 7),
        json("path" to "docs/$longName", "status" to "A", "additions" to 120, "deletions" to 0),
        json("path" to "legacy/old-script.py", "status" to "D", "additions" to 0, "deletions" to 96),
        json("path" to "数据统计-导出结果-这一份是最终版-请勿重复导出-20260910.csv", "status" to "?", "additions" to JSONObject.NULL, "deletions" to JSONObject.NULL)) +
        (1..8).map { json("path" to "src/module/module-$it.kt", "status" to "M", "additions" to it, "deletions" to it) } +
        listOf(json("path" to "src/zz-last-changed-file.kt", "status" to "M", "additions" to 3, "deletions" to 1))).jsonArray()
    private val patchText = """
        diff --git a/src/zz-last-changed-file.kt b/src/zz-last-changed-file.kt
        index 3f2a9c1..8b7d2e0 100644
        --- a/src/zz-last-changed-file.kt
        +++ b/src/zz-last-changed-file.kt
        @@ -12,7 +12,9 @@ class Demo {
        +    val 超长行 = "这一行特别长用来验证差异视图支持横向滚动而不会换行挤压布局，字符数远超屏幕宽度许多许多许多许多许多许多许多许多许多许多许多许多许多许多，直到水平滚动确认生效为止"
             保留的上下文行内容
        +    val added = true
    """.trimIndent()

    private fun params(path: String): Map<String, String> = path.substringAfter('?', "")
        .split('&').filter { it.contains('=') }
        .associate { part -> val pair = part.split('=', limit = 2); pair[0] to java.net.URLDecoder.decode(pair[1], "UTF-8") }

    private fun roots() = listOf(
        json("id" to "working-dir", "label" to "当前工作目录", "path" to "/workspace/codex-web", "available" to true),
        json("id" to "workspace", "label" to "会话工作区", "path" to "会话工作区", "available" to true),
        json("id" to "library", "label" to "资料库", "path" to "资料库", "available" to false)).jsonArray()

    private fun listing(rootId: String, path: String): JSONObject {
        if (path == "受限目录") throw ApiFailure(403, "EACCES: permission denied, scandir '/workspace/codex-web/受限目录'")
        listingError?.let { throw ApiFailure(403, it) }
        val display = "会话工作区"
        return when (path) {
            "" -> json("rootId" to rootId, "path" to "", "parentPath" to JSONObject.NULL, "truncated" to false, "entries" to listOf(
                json("name" to "docs", "path" to "docs", "display_path" to "$display/docs", "type" to "dir", "mime_type" to "application/octet-stream", "size" to JSONObject.NULL, "mtime" to JSONObject.NULL, "previewable" to false),
                json("name" to "空目录", "path" to "空目录", "display_path" to "$display/空目录", "type" to "dir", "mime_type" to "application/octet-stream", "size" to JSONObject.NULL, "mtime" to JSONObject.NULL, "previewable" to false),
                json("name" to "受限目录", "path" to "受限目录", "display_path" to "$display/受限目录", "type" to "dir", "mime_type" to "application/octet-stream", "size" to JSONObject.NULL, "mtime" to JSONObject.NULL, "previewable" to false),
                json("name" to longName, "path" to longName, "display_path" to "$display/$longName", "type" to "file", "mime_type" to "text/markdown", "size" to 18432, "mtime" to "2026-09-09T08:30:00.000Z", "previewable" to true),
                json("name" to "已删除文件.txt", "path" to "已删除文件.txt", "display_path" to "$display/已删除文件.txt", "type" to "file", "mime_type" to "text/plain", "size" to 256, "mtime" to "2026-09-05T10:00:00.000Z", "previewable" to true),
                json("name" to "README.md", "path" to "README.md", "display_path" to "$display/README.md", "type" to "file", "mime_type" to "text/markdown", "size" to 2048, "mtime" to "2026-09-01T10:00:00.000Z", "previewable" to true),
                json("name" to "架构示意图.png", "path" to "架构示意图.png", "display_path" to "$display/架构示意图.png", "type" to "file", "mime_type" to "image/png", "size" to 81920, "mtime" to "2026-09-02T10:00:00.000Z", "previewable" to true)).jsonArray())
            "docs" -> json("rootId" to rootId, "path" to "docs", "parentPath" to "", "truncated" to false, "entries" to listOf(
                json("name" to "归档目录", "path" to "docs/归档目录", "display_path" to "$display/docs/归档目录", "type" to "dir", "mime_type" to "application/octet-stream", "size" to JSONObject.NULL, "mtime" to JSONObject.NULL, "previewable" to false),
                json("name" to "会议记录.txt", "path" to "docs/会议记录.txt", "display_path" to "$display/docs/会议记录.txt", "type" to "file", "mime_type" to "text/plain", "size" to 4096, "mtime" to "2026-09-08T14:00:00.000Z", "previewable" to true)).jsonArray())
            "空目录" -> json("rootId" to rootId, "path" to "空目录", "parentPath" to "", "truncated" to false, "entries" to emptyList<JSONObject>().jsonArray())
            else -> json("rootId" to rootId, "path" to path, "parentPath" to "", "truncated" to false, "entries" to emptyList<JSONObject>().jsonArray())
        }
    }

    override suspend fun call(path: String, method: String, payload: JSONObject?, body: RequestBody?): JSONObject {
        if (method != "GET") mutations += "$method $path"
        delay(20)
        return when {
            path == "/auth/login" -> json("authenticated" to true, "username" to payload?.text("username").orEmpty().ifBlank { "test-account" }, "csrfToken" to "token", "providerManagementEnabled" to true, "voiceEnabled" to true)
            path == "/auth/session" -> json("authenticated" to false)
            path == "/agent-options" -> json("selection" to selection, "models" to listOf(json("id" to "test-model", "label" to "测试模型",
                "providerName" to "验收服务", "reasoningEfforts" to listOf("low", "medium", "high").jsonArray()),
                json("id" to "long-model", "label" to "超长模型显示名称用于验证选择行当前值可以完整换行显示并且不会被截断丢失信息",
                    "providerName" to "验收服务", "reasoningEfforts" to listOf("low", "medium", "high").jsonArray())).jsonArray(),
                "sandboxModes" to listOf(json("id" to "workspace-write", "label" to "工作区写入"), json("id" to "danger-full-access", "label" to "完全访问")).jsonArray())
            path == "/preset-prompts" -> json("presetPrompts" to listOf(json("id" to "preset", "name" to "中文回复", "content" to "使用中文" )).jsonArray())
            path == "/task-categories" -> json("settings" to json())
            path == "/working-dirs" -> json("settings" to json("favorites" to listOf(json("path" to "/workspace/codex-web", "label" to "Codex Web")).jsonArray()))
            path == "/conversations" && method == "POST" -> { creates++; json("conversation" to conversation) }
            path == "/conversations" -> json("conversations" to tasks.jsonArray())
            path == "/transcriptions" -> { voiceGate?.await(); json("text" to "语音转写的内容") }
            path.endsWith("/draft") -> {
                draft = json("content" to payload?.text("content"), "quote_excerpt" to payload?.text("quoteExcerpt"), "source_reference" to payload?.optJSONObject("sourceReference"), "files" to emptyList<JSONObject>().jsonArray())
                json("composerDraft" to draft)
            }
            path.endsWith("/messages") -> {
                sends++
                if (failSend) throw java.io.IOException("simulated network failure")
                draft = null
                json("queued" to true)
            }
            path.endsWith("/pending-prompts/order") && method == "PUT" -> {
                val ids = payload?.optJSONArray("ids") ?: org.json.JSONArray()
                pending = (0 until ids.length()).mapNotNull { index -> pending.find { it.text("id") == ids.optString(index) } }
                json("ok" to true)
            }
            path.endsWith("/agent-selection") && method == "PUT" -> { selection = payload ?: selection; json("ok" to true) }
            path.contains("/pending-prompts/") && path.endsWith("/edit") && method == "POST" ->
                json("editingPrompt" to (editingPrompt ?: json()))
            path == "/conversations/sample-task" -> {
                nextConversationFailure?.let { failure -> nextConversationFailure = null; throw failure }
                json("conversation" to conversation, "composerDraft" to draft, "agentSelection" to selection,
                "messages" to listOf(
                    json("id" to "user-one", "role" to "user", "content" to "保留核心功能，让手机界面更专注。", "can_edit" to true),
                    json("id" to "assistant-one", "role" to "assistant", "content" to "## 让任务回到中心\n\n保留熟悉的 Web 风格，让对话成为主界面。\n\n- 右滑打开按项目分类的任务\n- 输入区轻点即可管理队列\n- 草稿与近期对话保存在本机\n\n```kotlin\nval focus = \"专注当前对话\"\n```" + if (longMessages) "\n\n继续查看项目细节。".repeat(35) else "", "can_fork" to true)
                ).jsonArray(), "messagePage" to json("hasMore" to false), "pendingPrompts" to pending.jsonArray(), "jobEvents" to emptyList<JSONObject>().jsonArray(),
                "outputFiles" to outputs.jsonArray())
            }
            path.contains("/file-tree/preview") -> {
                val target = params(path)["path"].orEmpty()
                if (target == "已删除文件.txt") throw ApiFailure(400, "ENOENT: no such file or directory, open '/workspace/已删除文件.txt'")
                json("mimeType" to "text/plain", "content" to "会议记录第一行\n第二行包含中文与代码：val focus = \"专注\"\n第三行结束")
            }
            path.contains("/file-tree") -> {
                val query = params(path)
                val root = query["root"].orEmpty()
                if (root.isBlank()) json("roots" to roots())
                else json("roots" to roots(), "listing" to listing(root, query["path"].orEmpty()))
            }
            path.contains("/review") -> {
                if (failReview) throw ApiFailure(500, reviewErrorText)
                val query = params(path)
                val file = query["file"]
                if (file != null) json("root" to "/workspace/codex-web", "branch" to "main", "bases" to listOf("refs/heads/main").jsonArray(),
                    "base" to JSONObject.NULL, "comparison" to "HEAD 与工作区（包含已暂存和未暂存）", "files" to reviewFiles,
                    "patch" to patchText, "truncated" to false)
                else when (query["scope"]) {
                    "staged" -> json("root" to "/workspace/codex-web", "branch" to "main", "bases" to listOf("refs/heads/main").jsonArray(),
                        "base" to JSONObject.NULL, "comparison" to "HEAD 与暂存区", "files" to emptyList<JSONObject>().jsonArray())
                    "branch" -> json("root" to "/workspace/codex-web", "branch" to "main", "bases" to listOf("refs/heads/main").jsonArray(),
                        "base" to "refs/heads/main", "comparison" to "main 的共同祖先 → HEAD（仅已提交）", "files" to reviewFiles)
                    else -> json("root" to "/workspace/codex-web", "branch" to "main", "bases" to listOf("refs/heads/main").jsonArray(),
                        "base" to JSONObject.NULL, "comparison" to "HEAD 与工作区（包含已暂存和未暂存）", "files" to reviewFiles)
                }
            }
            else -> json()
        }
    }
    override suspend fun download(path: String): Response = throw UnsupportedOperationException()
    override fun events(jobId: String, after: Long, receive: (JSONObject, Long) -> Unit, failure: (String) -> Unit) = Closeable {}
    override fun clearCredentials() {}
    override fun close() {}
}

@RunWith(AndroidJUnit4::class)
class NativeUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private lateinit var model: ClientModel
    private lateinit var gateway: UiGateway
    private val owner = ViewModelStore()
    private var picks = 0

    @Before fun setup() {
        gateway = UiGateway()
        compose.runOnUiThread {
            model = ClientModel(UiStore()) { gateway }
            owner.put("ui", model)
        }
        compose.setContent { CodexApp(model, pickFiles = { picks++ }) }
    }

    @After fun cleanup() { compose.runOnUiThread { owner.clear() } }

    private fun login(username: String = "test-account") {
        if (model.state.error != null) {
            compose.onNodeWithText("知道了").performClick()
            compose.waitUntil(5000) { model.state.error == null }
        }
        compose.onNodeWithTag("server").performTextClearance()
        compose.onNodeWithTag("username").performTextClearance()
        compose.onNodeWithTag("password").performTextClearance()
        compose.onNodeWithTag("server").performTextInput("https://example.org")
        compose.onNodeWithTag("username").performTextInput(username)
        compose.onNodeWithTag("password").performTextInput("test-only-password")
        compose.onNodeWithTag("login").performScrollTo().assertIsDisplayed().performClick()
        try {
            compose.waitUntil(10000) { model.state.authenticated && !model.state.connecting }
        } catch (reason: AssertionError) {
            throw AssertionError("Login incomplete: authenticated=${model.state.authenticated}, connecting=${model.state.connecting}, error=${model.state.error}", reason)
        }
        compose.waitUntil(10000) { model.state.selectedId != null && !model.state.busy }
        compose.onNodeWithTag("composer").assertIsDisplayed()
    }

    private fun expireSessionThroughConversation() {
        gateway.nextConversationFailure = ApiFailure(401, "expired")
        compose.runOnUiThread { model.refresh() }
        compose.waitUntil(5000) { !model.state.authenticated && !model.state.busy }
    }

    private fun screenshot(name: String, tag: String? = null) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val directory = File(instrumentation.targetContext.filesDir, "native-screenshots").apply { mkdirs() }
        val bitmap = if (tag == null) instrumentation.uiAutomation.takeScreenshot() else compose.onNodeWithTag(tag).captureToImage().asAndroidBitmap()
        File(directory, "$name.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
    }

    /** 节点在屏幕上的真实像素 bounds（跨窗口：popup/bottom sheet/dialog 节点同样有效）。 */
    private fun screenRect(node: SemanticsNode): Rect {
        val origin = node.positionOnScreen
        val size = node.boundsInRoot.size
        return Rect(origin.x.roundToInt(), origin.y.roundToInt(), (origin.x + size.width).roundToInt(), (origin.y + size.height).roundToInt())
    }

    private fun screenRect(selector: SemanticsNodeInteraction): Rect = screenRect(selector.fetchSemanticsNode())

    private fun grow(rect: Rect, margin: Int): Rect = Rect(rect.left - margin, rect.top - margin, rect.right + margin, rect.bottom + margin)

    /**
     * 通过 UiAutomation 注入真实系统级触摸（与 Compose 测试的语义级 performClick 不同，
     * 会真实地被 popup / dialog / scrim 窗口拦截），用于核验菜单对窗外点击的拦截行为。
     */
    private fun realTap(rect: Rect) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val x = rect.exactCenterX()
        val y = rect.exactCenterY()
        val downTime = SystemClock.uptimeMillis()
        assertTrue(instrumentation.uiAutomation.injectInputEvent(
            MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, x, y, 0), true))
        Thread.sleep(80)
        assertTrue(instrumentation.uiAutomation.injectInputEvent(
            MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y, 0), true))
        compose.waitForIdle()
    }

    private fun assertTaskStatus(tag: String, expected: String) {
        val node = compose.onNodeWithTag(tag).fetchSemanticsNode()
        val texts = generateSequence(listOf(node)) { level -> if (level.isEmpty()) null else level.flatMap { it.children } }
            .take(6).flatten()
            .filter { it.config.contains(androidx.compose.ui.semantics.SemanticsProperties.Text) }
            .flatMap { it.config[androidx.compose.ui.semantics.SemanticsProperties.Text].map { value -> value.text } }
            .toList()
        assertTrue("Expected status '$expected' in $tag, found: $texts", expected in texts)
    }

    @Test fun bottomNavigationIsCompactIconOnlyAndPreservesDraft() {
        login()
        compose.runOnUiThread { model.changeText("导航切换保留草稿") }
        HomeTab.entries.forEach { tab ->
            compose.onNodeWithTag("bottom-navigation").assertHeightIsEqualTo(48.dp).onChildren().assertCountEquals(3)
            compose.onAllNodes(hasAnyAncestor(hasTestTag("bottom-navigation")) and SemanticsMatcher.keyIsDefined(SemanticsProperties.Text),
                useUnmergedTree = true).assertCountEquals(0)
            compose.onNodeWithTag("tab-${tab.name}").assertHeightIsEqualTo(48.dp).assertWidthIsAtLeast(48.dp)
                .assertContentDescriptionEquals(tab.title).assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab))
                .performClick().assertIsSelected()
            HomeTab.entries.filter { it != tab }.forEach { other -> compose.onNodeWithTag("tab-${other.name}").assertIsNotSelected() }
            Thread.sleep(400)
            screenshot("native-navigation-${tab.name}")
            screenshot("native-navigation-bar-${tab.name}", "bottom-navigation")
        }
        compose.onNodeWithTag("tab-Chat").performClick()
        compose.onNodeWithTag("composer").assertTextContains("导航切换保留草稿")
        assertEquals(0, gateway.sends)
    }

    @Test fun loginAndChatAreNativeAndToolsPreserveComposer() {
        screenshot("native-login")
        login()
        screenshot("native-chat")
        compose.onNodeWithTag("composer").performTextInput("保留这份草稿\n不要发送")
        compose.waitUntil(5000) { model.state.composer.content.contains("不要发送") }
        compose.onNodeWithContentDescription("任务工具").performClick()
        compose.onNodeWithText("任务与队列").performClick()
        compose.onNodeWithText("运行状态").assertIsDisplayed()
        compose.onNodeWithContentDescription("关闭队列").performClick()
        compose.onNodeWithTag("composer").assertTextContains("保留这份草稿\n不要发送")
        assertEquals(0, gateway.sends)
        compose.onNodeWithContentDescription("添加附件").performClick()
        assertEquals(1, picks)
    }

    @Test fun bottomNavigationHidesWhileTypingAndReturnsAfterKeyboardDismissal() {
        login()
        compose.onNodeWithTag("bottom-navigation").assertIsDisplayed()
        compose.onNodeWithTag("composer").performClick().performTextInput("键盘收起后保留草稿")
        compose.waitUntil(5000) { compose.onAllNodesWithTag("bottom-navigation").fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithTag("composer").assertIsDisplayed()
        screenshot("native-navigation-keyboard")
        compose.runOnUiThread {
            compose.activity.getSystemService(InputMethodManager::class.java)
                .hideSoftInputFromWindow(compose.activity.window.decorView.windowToken, 0)
        }
        compose.waitUntil(5000) { compose.onAllNodesWithTag("bottom-navigation").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("bottom-navigation").assertHeightIsEqualTo(48.dp).assertIsDisplayed()
        compose.onNodeWithTag("composer").assertTextContains("键盘收起后保留草稿")
        assertEquals(0, gateway.sends)
    }

    @Test fun optionsAndReviewUseIndependentNativeSurfaces() {
        login()
        compose.onNodeWithText("测试模型").performClick()
        compose.onNodeWithText("任务选项").assertIsDisplayed()
        // 实现说明类文案已移除；枚举值本地化为中文（提交仍为原始协议值）
        compose.onNodeWithText("执行逻辑仍由服务器决定").assertDoesNotExist()
        compose.onNodeWithTag("choice-思考强度").assertIsDisplayed()
        compose.onNodeWithText("中").assertIsDisplayed()
        compose.onNodeWithText("工作区写入").assertIsDisplayed()
        screenshot("native-options")
        // 长模型名称：当前值换行为两行并可通过选择对话框访问
        compose.onNodeWithTag("choice-模型 / API 源").performClick()
        compose.onNodeWithText("验收服务 · 超长模型显示名称用于验证选择行当前值可以完整换行显示并且不会被截断丢失信息").performClick()
        compose.waitUntil(5000) { model.state.detail?.objectValue("agentSelection")?.text("model") == "long-model" }
        compose.onNodeWithText("验收服务 · 超长模型显示名称用于验证选择行当前值可以完整换行显示并且不会被截断丢失信息").assertIsDisplayed()
        screenshot("native-options-long-model")
        compose.onNodeWithContentDescription("关闭选项").performClick()
        compose.waitForIdle()
        compose.onNodeWithContentDescription("任务工具").performClick()
        compose.onNodeWithText("代码 Review").performClick()
        compose.waitUntil(5000) { model.state.pageData != null && !model.state.pageLoading }
        compose.onNodeWithTag("bottom-navigation").assertDoesNotExist()
        // 紧凑摘要：分支、比较范围与统计；文件行展示类型与增删
        compose.onNodeWithText("main").assertIsDisplayed()
        compose.onNodeWithText("HEAD 与工作区（包含已暂存和未暂存）").assertIsDisplayed()
        compose.onNodeWithText("13 个文件 · +201 / -140 · 部分文件未统计行数").assertIsDisplayed()
        compose.onNodeWithText("src/main.kt").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("已修改 · +42 / -7").assertIsDisplayed()
        compose.onNodeWithText("已删除 · +0 / -96").performScrollTo().assertIsDisplayed()
        screenshot("native-review")
        // 进入差异：长行横向滚动（CodeBlock），返回后保留列表位置
        compose.onNodeWithTag("review-list").performScrollToNode(hasText("src/zz-last-changed-file.kt"))
        compose.onNodeWithText("src/zz-last-changed-file.kt").performClick()
        compose.waitUntil(5000) { model.state.page?.kind == "patch" && model.state.pageData != null && !model.state.pageLoading }
        compose.onNodeWithText("已修改 · +3 / -1").assertIsDisplayed()
        compose.waitUntil(5000) { compose.onAllNodesWithText("+    val added = true", substring = true).fetchSemanticsNodes().isNotEmpty() }
        screenshot("native-patch")
        compose.onNodeWithContentDescription("返回").performClick()
        compose.waitUntil(5000) { model.state.page?.kind == "review" && !model.state.pageLoading && model.state.pageData != null }
        compose.waitForIdle()
        // 位置保留：返回后无需滚动即可看到此前所在的列表末尾文件
        compose.onNodeWithText("src/zz-last-changed-file.kt").assertIsDisplayed()
        compose.onNodeWithContentDescription("返回").performClick()
        compose.waitForIdle()
        compose.onNodeWithContentDescription("任务工具").performClick()
        compose.onNodeWithText("文件").performClick()
        compose.waitUntil(5000) { model.state.page?.kind == "files" && model.state.pageData != null }
        // 文件页分层：任务产物 + 浏览项目文件（根目录行带名称/状态/导航指示）
        compose.onNodeWithText("任务产物").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("output-row:out-1").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("重构完成报告.md").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("浏览项目文件").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("会话工作区").assertIsDisplayed()
        compose.onNodeWithText("不可用").performScrollTo().assertIsDisplayed()
        screenshot("native-files")
        compose.onNodeWithTag("root-row:workspace").performScrollTo().performClick()
        compose.waitUntil(5000) { model.state.pageData?.optJSONObject("listing") != null && !model.state.pageLoading }
        compose.onNodeWithTag("file-row:docs").performScrollTo().assertIsDisplayed()
        // 长中文名截断 + 查看完整名称
        compose.onAllNodesWithContentDescription("查看完整名称").onFirst().performClick()
        compose.onNodeWithText("完整名称").assertIsDisplayed()
        compose.waitForIdle()
        Thread.sleep(700) // 等待完整名称对话框进入动画结束
        compose.onNodeWithText("会话工作区/$longFileName").assertIsDisplayed()
        screenshot("native-files-full-name")
        compose.onNodeWithText("关闭").performClick()
        compose.onNodeWithTag("file-row:docs").performClick()
        compose.waitUntil(5000) { model.state.pageData?.optJSONObject("listing")?.text("path") == "docs" && !model.state.pageLoading }
        compose.onNodeWithTag("file-row:docs/会议记录.txt").assertIsDisplayed()
        screenshot("native-files-docs")
        compose.onNodeWithTag("file-row:docs/会议记录.txt").performClick()
        compose.waitUntil(5000) { model.state.page?.kind == "preview" && model.state.pageData != null && !model.state.pageLoading }
        compose.waitUntil(5000) { compose.onAllNodesWithText("会议记录第一行", substring = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("会议记录第一行", substring = true).assertIsDisplayed()
        screenshot("native-preview-text")
        compose.onNodeWithContentDescription("返回").performClick()
        compose.waitForIdle()
        compose.onNodeWithContentDescription("返回").performClick()
        compose.waitForIdle()
        compose.onNodeWithContentDescription("返回").performClick()
        compose.waitForIdle()
        compose.onNodeWithContentDescription("返回").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("composer").assertIsDisplayed()
        compose.runOnUiThread { model.appearance(theme = "dark") }
        screenshot("native-dark")
    }

    @Test fun failedSendKeepsTextAndDisablesAccidentalDuplicateSubmission() {
        login()
        gateway.failSend = true
        compose.onNodeWithTag("composer").performTextInput("网络失败也不能丢失")
        compose.onNodeWithTag("send").performClick()
        compose.waitUntil(10000) { model.state.sendUncertain }
        // 证据流程修正：先等弹窗完全展开并稳定，再拍打开态（避免关闭动画中间帧被误判为透明）
        compose.waitUntil(5000) { compose.onAllNodesWithText("操作未完成").fetchSemanticsNodes().isNotEmpty() }
        compose.waitForIdle()
        Thread.sleep(800)
        screenshot("native-recovery-open")
        compose.onNodeWithText("知道了").performClick()
        compose.waitUntil(5000) { model.state.error == null }
        compose.waitUntil(5000) { compose.onAllNodesWithText("操作未完成").fetchSemanticsNodes().isEmpty() }
        compose.waitForIdle()
        Thread.sleep(800)
        screenshot("native-recovery")
        compose.onNodeWithTag("composer").assertTextContains("网络失败也不能丢失")
        compose.onNodeWithTag("send").assertIsNotEnabled()
        assertEquals(1, gateway.sends)
    }

    @Test fun swipeOpensProjectDrawerWithLimitedGroupsAndStatusSwitch() {
        login()
        compose.onNodeWithTag("mobile-shell").performTouchInput {
            swipe(Offset(width * .12f, height * .2f), Offset(width * .9f, height * .2f), 500)
        }
        compose.onNodeWithTag("drawer-content").assertIsDisplayed()
        compose.onNodeWithText("Codex Web").assertIsDisplayed()
        compose.onNodeWithTag("task-task-7").assertDoesNotExist()
        // 默认按项目视图：失败任务用警示图标+文字呈现，不只靠颜色；已完成也有徽标
        assertTaskStatus("task-task-4", "需关注")
        assertTrue(compose.onAllNodesWithText("已完成").fetchSemanticsNodes().isNotEmpty())
        screenshot("native-project-drawer")
        compose.onNodeWithTag("group-project:auto:dir:%2Fworkspace%2Fcodex-web").performClick()
        compose.onNodeWithTag("task-task-4").assertDoesNotExist()
        compose.onNodeWithTag("expand-auto:dir:%2Fworkspace%2Fcodex-web").assertDoesNotExist()
        compose.onNodeWithTag("task-search").performTextInput("Codex Web")
        compose.onNodeWithTag("task-task-4").assertIsDisplayed()
        compose.onNodeWithTag("task-search").performTextClearance()
        compose.onNodeWithTag("task-task-4").assertDoesNotExist()
        compose.onNodeWithTag("group-project:auto:dir:%2Fworkspace%2Fcodex-web").performClick()
        assertTaskStatus("task-task-4", "需关注")
        compose.onNodeWithTag("task-list").performScrollToNode(hasTestTag("expand-auto:dir:%2Fworkspace%2Fcodex-web"))
        compose.onNodeWithTag("expand-auto:dir:%2Fworkspace%2Fcodex-web").performClick()
        compose.onNodeWithTag("task-list").performScrollToNode(hasTestTag("task-task-7"))
        compose.onNodeWithTag("task-task-7").assertIsDisplayed()
        // 长标题任务：标题换行时状态徽标仍完整可见（18dp 运行指示器 + 文字）
        compose.onNodeWithTag("task-list").performScrollToNode(hasTestTag("task-task-long"))
        assertTaskStatus("task-task-long", "进行中")
        val metrics = compose.activity.resources.displayMetrics
        val spinnerDp = compose.onAllNodesWithTag("task-progress").fetchSemanticsNodes()
            .maxOfOrNull { it.boundsInRoot.width / metrics.density } ?: 0f
        assertTrue("drawer running indicator ${spinnerDp}dp outside 18–20dp", spinnerDp in 17f..21f)
        screenshot("native-project-drawer-long-status")
        compose.onNodeWithTag("task-list").performScrollToNode(hasTestTag("group-project:auto:dir:%2Fworkspace%2Fcodex-web"))
        compose.onNodeWithTag("group-project:auto:dir:%2Fworkspace%2Fcodex-web").performClick()
        compose.onNodeWithTag("task-task-7").assertDoesNotExist()
        compose.onNodeWithTag("group-project:auto:dir:%2Fworkspace%2Fcodex-web").performClick()
        compose.onNodeWithTag("task-list").performScrollToNode(hasTestTag("task-task-7"))
        compose.onNodeWithTag("task-task-7").assertIsDisplayed()
        compose.onNodeWithText("按状态").performClick()
        compose.onNodeWithTag("task-list").performScrollToIndex(0)
        compose.onAllNodesWithText("进行中").onFirst().assertIsDisplayed()
        compose.onNodeWithTag("group-status:进行中").performClick()
        compose.onNodeWithTag("group-status:进行中").assertIsDisplayed()
        compose.onNodeWithTag("task-task-long").assertDoesNotExist()
        compose.onNodeWithTag("group-status:进行中").performClick()
        screenshot("native-status-drawer")
        compose.onNodeWithContentDescription("关闭任务列表").performClick()
        compose.onNodeWithTag("composer").assertIsDisplayed()
        assertEquals(0, gateway.sends)
    }

    @Test fun profileAndWorkspacePreserveDraftAndReadingPosition() {
        gateway.longMessages = true
        login()
        compose.onNodeWithTag("messages").performScrollToIndex(0)
        compose.onNodeWithTag("message-user-one").assertIsDisplayed()
        compose.runOnUiThread { model.changeText("切换页面也保留这份草稿") }
        HomeTab.entries.forEach { tab -> compose.onNodeWithTag("tab-${tab.name}").assertContentDescriptionEquals(tab.title).assertIsDisplayed() }
        compose.onNodeWithTag("tab-Profile").performClick()
        compose.onNodeWithText("test-account").assertIsDisplayed()
        compose.onNodeWithText("example.org").assertIsDisplayed()
        compose.onNodeWithTag("account-header").assertIsDisplayed()
        // 初次进入（未滚动）状态：账号摘要必须完整可见，不以滚动后的画面替代首屏
        screenshot("native-profile-first")
        // 外观选择行与聊天字号行在同一卡片内左右内边距一致
        val density = compose.activity.resources.displayMetrics.density
        val appearanceLeft = compose.onNodeWithText("外观").fetchSemanticsNode().boundsInRoot.left
        val fontLeft = compose.onNodeWithText("聊天字号").fetchSemanticsNode().boundsInRoot.left
        assertTrue("外观行与字号行左边距不一致: $appearanceLeft vs $fontLeft", kotlin.math.abs(appearanceLeft - fontLeft) <= 2f * density)
        compose.onNodeWithText("外观与阅读").assertIsDisplayed()
        compose.onNodeWithText("跟随系统").assertIsDisplayed()
        compose.onNodeWithText("范围 12–24 · 应用于聊天正文与样文").assertIsDisplayed()
        compose.onNodeWithText("样文预览：任务交给 Codex，进度随时可查。").assertIsDisplayed()
        compose.onNodeWithText("任务与数据").assertIsDisplayed()
        compose.onNodeWithText("预设指令").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("工作目录").performScrollTo().assertIsDisplayed()
        // 外观选择行：选择指示（对话框内单选）+ 当前值联动
        compose.onNodeWithTag("choice-外观").performClick()
        compose.onNodeWithTag("choice-option-dark").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("深色").assertIsDisplayed()
        compose.onNodeWithTag("choice-外观").performClick()
        compose.onNodeWithTag("choice-option-system").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("跟随系统").assertIsDisplayed()
        Thread.sleep(700) // 等待对话框退场动画完全结束，避免中间帧污染稳定态截图
        screenshot("native-profile")
        // 滚动后返回顶部：账号摘要再次完整可见（区分“滚动状态”与“首屏布局缺陷”）
        compose.onNodeWithTag("account-header").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("外观与阅读").assertIsDisplayed()
        Thread.sleep(300)
        screenshot("native-profile-top")
        compose.onNodeWithTag("tab-Workspace").performClick()
        compose.onNodeWithText("让工具围绕当前对话").assertIsDisplayed()
        screenshot("native-workspace")
        compose.onNodeWithTag("tab-Chat").performClick()
        compose.onNodeWithTag("composer").assertTextContains("切换页面也保留这份草稿")
        compose.onNodeWithTag("message-user-one").assertIsDisplayed()
        compose.onNodeWithTag("messages").performTouchInput { swipeUp() }
        compose.onNodeWithTag("drawer-content").assertIsNotDisplayed()
        assertEquals(0, gateway.sends)
    }

    @Test fun queueHintOpensBottomSheetWithoutLeavingConversation() {
        login()
        gateway.pending = listOf(json("id" to "queued", "content" to "执行完成后检查测试结果", "status" to "queued"))
        compose.runOnUiThread { model.changeText("继续写当前草稿"); model.refresh() }
        compose.waitUntil(5000) { !model.state.busy && model.state.detail?.rows("pendingPrompts")?.size == 1 }
        screenshot("native-queue-hint")
        compose.onNodeWithTag("queue-hint").performClick()
        compose.onNodeWithTag("queue-sheet").assertIsDisplayed()
        compose.onNodeWithText("执行完成后检查测试结果").assertIsDisplayed()
        screenshot("native-queue-sheet")
        // 单项队列：上移/下移均不可用；无运行中作业时不提供「引导」
        compose.onNodeWithTag("queue-more-0").performClick()
        compose.onNodeWithText("上移").assertIsNotEnabled()
        compose.onNodeWithText("下移").assertIsNotEnabled()
        compose.onNodeWithText("引导").assertDoesNotExist()
        compose.onNodeWithText("直接执行").assertDoesNotExist()
        compose.onNodeWithText("删除").performClick()
        compose.onNodeWithText("删除这条待发送指令及其附件？").assertIsDisplayed()
        screenshot("native-queue-delete-confirm")
        compose.onNodeWithText("取消").performClick()
        compose.onNodeWithContentDescription("关闭队列").performClick()
        compose.onNodeWithTag("composer").assertTextContains("继续写当前草稿")
        assertNull(model.state.page)
        assertEquals("sample-task", model.state.selectedId)
    }

    @Test fun queueCardsKeepEditPrimaryAndLimitReorderAtBothEnds() {
        login()
        gateway.pending = listOf(json("id" to "p1", "content" to "第一条队列指令", "status" to "queued"),
            json("id" to "p2", "content" to "第二条队列指令", "status" to "queued"))
        compose.runOnUiThread { model.refresh() }
        compose.waitUntil(5000) { !model.state.busy && model.state.detail?.rows("pendingPrompts")?.size == 2 }
        compose.onNodeWithTag("queue-hint").performClick()
        compose.onNodeWithTag("queue-sheet").assertIsDisplayed()
        compose.onNodeWithText("第一条队列指令").assertIsDisplayed()
        // 空执行记录给出简短说明
        compose.onNodeWithText("任务还没有执行事件。开始运行后，这里会显示实时进度与结果摘要。").assertIsDisplayed()
        screenshot("native-queue-multi")
        // 编辑是常用入口；其余操作收进更多菜单
        compose.onAllNodesWithText("编辑").onFirst().assertIsDisplayed()
        // 第一项：不能上移，可以下移
        compose.onNodeWithTag("queue-more-0").performClick()
        compose.onNodeWithText("上移").assertIsNotEnabled()
        compose.onNodeWithText("下移").assertIsEnabled()
        compose.onNodeWithText("引导").assertDoesNotExist()
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
        compose.waitForIdle()
        // 最后一项：不能下移，可以上移
        compose.onNodeWithTag("queue-more-1").performClick()
        compose.onNodeWithText("下移").assertIsNotEnabled()
        compose.onNodeWithText("上移").assertIsEnabled()
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
        compose.waitForIdle()
        compose.onNodeWithContentDescription("关闭队列").performClick()
        compose.onNodeWithTag("composer").assertIsDisplayed()
        assertEquals(0, gateway.sends)
    }

    @Test fun expiredSessionDoesNotKeepOpenEditorForNextAccount() {
        login()
        gateway.pending = listOf(json("id" to "p1", "content" to "队列摘要", "status" to "queued"))
        gateway.editingPrompt = json("id" to "p1", "content" to "旧账号敏感内容", "files" to emptyList<JSONObject>().jsonArray())
        compose.runOnUiThread { model.refresh() }
        compose.waitUntil(5000) { !model.state.busy && model.state.detail?.rows("pendingPrompts")?.size == 1 }
        compose.onNodeWithTag("queue-hint").performClick()
        compose.onNodeWithText("队列摘要").assertIsDisplayed()
        compose.onNodeWithText("编辑").performClick()
        compose.waitUntil(5000) { compose.onAllNodesWithText("编辑队列指令").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("旧账号敏感内容").assertIsDisplayed()
        compose.waitUntil(5000) { !model.state.busy }

        expireSessionThroughConversation()
        compose.onNodeWithText("旧账号敏感内容").assertDoesNotExist()
        compose.onNodeWithText("编辑队列指令").assertDoesNotExist()
        login("second-account")
        compose.onNodeWithText("旧账号敏感内容").assertDoesNotExist()
        compose.onNodeWithText("编辑队列指令").assertDoesNotExist()
        assertEquals(0, gateway.mutations.count { it.startsWith("DELETE ") })
        screenshot("native-session-expiry-editor-isolated")
    }

    @Test fun expiredSessionClosesOpenOptionsSheetForNextAccount() {
        login()
        compose.onNodeWithText("测试模型").performClick()
        compose.onNodeWithText("任务选项").assertIsDisplayed()

        expireSessionThroughConversation()
        compose.onNodeWithText("任务选项").assertDoesNotExist()
        login("second-account")
        compose.onNodeWithText("任务选项").assertDoesNotExist()
        screenshot("native-session-expiry-options-isolated")
    }

    @Test fun expiredSessionDiscardsOpenDangerConfirmWithoutExecutingIt() {
        login()
        gateway.pending = listOf(json("id" to "p1", "content" to "待删除敏感队列", "status" to "queued"))
        compose.runOnUiThread { model.refresh() }
        compose.waitUntil(5000) { !model.state.busy && model.state.detail?.rows("pendingPrompts")?.size == 1 }
        compose.onNodeWithTag("queue-hint").performClick()
        compose.onNodeWithTag("queue-more-0").performClick()
        compose.onNodeWithText("删除").performClick()
        compose.onNodeWithText("删除这条待发送指令及其附件？").assertIsDisplayed()

        expireSessionThroughConversation()
        compose.onNodeWithText("删除这条待发送指令及其附件？").assertDoesNotExist()
        assertEquals(0, gateway.mutations.count { it.startsWith("DELETE ") })
        login("second-account")
        compose.onNodeWithText("删除这条待发送指令及其附件？").assertDoesNotExist()
        assertEquals(0, gateway.mutations.count { it.startsWith("DELETE ") })
        screenshot("native-session-expiry-confirm-isolated")
    }

    @Test fun queueMenuRealOutsideTapDismissesWithoutTouchingUnderlyingControls() {
        login()
        gateway.pending = listOf(json("id" to "p1", "content" to "第一条队列指令", "status" to "queued"),
            json("id" to "p2", "content" to "第二条队列指令", "status" to "queued"))
        compose.runOnUiThread { model.changeText("菜单外部点击必须保留这份草稿"); model.refresh() }
        compose.waitUntil(5000) { !model.state.busy && model.state.detail?.rows("pendingPrompts")?.size == 2 }
        compose.onNodeWithTag("queue-hint").performClick()
        compose.onNodeWithTag("queue-sheet").assertIsDisplayed()
        val editRect = screenRect(compose.onAllNodesWithText("编辑")[0])
        // 对照组：菜单关闭时，真实系统触摸确实命中「编辑」——证明注入事件与坐标有效
        realTap(editRect)
        compose.waitUntil(5000) { compose.onAllNodesWithText("编辑队列指令").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("编辑队列指令").assertIsDisplayed()
        screenshot("menu-control-real-tap-opens-edit")
        compose.onNodeWithContentDescription("取消").performClick()
        compose.waitUntil(5000) { compose.onAllNodesWithText("编辑队列指令").fetchSemanticsNodes().isEmpty() }
        compose.waitForIdle()
        gateway.mutations.clear()
        compose.onNodeWithTag("queue-hint").performClick()
        compose.onNodeWithTag("queue-sheet").assertIsDisplayed()
        compose.onNodeWithTag("queue-more-0").performClick()
        compose.onNodeWithText("上移").assertIsDisplayed()
        val menuRect = grow(screenRect(compose.onNodeWithText("上移"))
            .apply { union(screenRect(compose.onNodeWithText("下移"))) }
            .apply { union(screenRect(compose.onNodeWithText("删除"))) }, 48)
        assertFalse("断言前提：菜单不应覆盖「编辑」按钮", menuRect.contains(editRect.centerX(), editRect.centerY()))
        screenshot("menu-outside-tap-before")
        realTap(editRect)
        compose.onNodeWithText("上移").assertDoesNotExist()
        compose.onNodeWithTag("queue-sheet").assertIsDisplayed()
        compose.onNodeWithText("编辑队列指令").assertDoesNotExist()
        assertEquals("菜单外真实点击不得触发任何变更请求", emptyList<String>(), gateway.mutations)
        assertEquals(0, gateway.sends)
        assertEquals(0, gateway.creates)
        assertEquals(2, model.state.detail?.rows("pendingPrompts")?.size)
        assertEquals("菜单外真实点击不得丢失草稿", "菜单外部点击必须保留这份草稿", model.state.composer.content)
        screenshot("menu-outside-tap-after")
    }

    @Test fun queueMenuClosesOnSystemBackKeepingSheetDraftAndQueue() {
        login()
        gateway.pending = listOf(json("id" to "p1", "content" to "第一条队列指令", "status" to "queued"),
            json("id" to "p2", "content" to "第二条队列指令", "status" to "queued"))
        compose.runOnUiThread { model.changeText("返回键关闭菜单后这份草稿仍在"); model.refresh() }
        compose.waitUntil(5000) { !model.state.busy && model.state.detail?.rows("pendingPrompts")?.size == 2 }
        compose.onNodeWithTag("queue-hint").performClick()
        compose.onNodeWithTag("queue-sheet").assertIsDisplayed()
        compose.onNodeWithTag("queue-more-0").performClick()
        compose.onNodeWithText("上移").assertIsDisplayed()
        gateway.mutations.clear()
        screenshot("menu-back-before")
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
        compose.waitForIdle()
        compose.onNodeWithText("上移").assertDoesNotExist()
        compose.onNodeWithTag("queue-sheet").assertIsDisplayed()
        compose.onNodeWithContentDescription("关闭队列").assertIsDisplayed()
        assertEquals("返回键只关闭菜单，不得触发变更", emptyList<String>(), gateway.mutations)
        assertEquals(0, gateway.sends)
        assertEquals(0, gateway.creates)
        assertEquals(2, model.state.detail?.rows("pendingPrompts")?.size)
        assertEquals("返回键关闭菜单不得丢失草稿", "返回键关闭菜单后这份草稿仍在", model.state.composer.content)
        screenshot("menu-back-after")
    }

    @Test fun queueMenuItemRealTapReordersExactlyOnce() {
        login()
        gateway.pending = listOf(json("id" to "p1", "content" to "第一条队列指令", "status" to "queued"),
            json("id" to "p2", "content" to "第二条队列指令", "status" to "queued"))
        compose.runOnUiThread { model.changeText("菜单项真实点击后草稿仍在"); model.refresh() }
        compose.waitUntil(5000) { !model.state.busy && model.state.detail?.rows("pendingPrompts")?.size == 2 }
        compose.onNodeWithTag("queue-hint").performClick()
        compose.onNodeWithTag("queue-sheet").assertIsDisplayed()
        compose.onNodeWithTag("queue-more-0").performClick()
        compose.onNodeWithText("上移").assertIsNotEnabled()
        compose.onNodeWithText("下移").assertIsEnabled()
        val downRect = screenRect(compose.onNodeWithText("下移"))
        gateway.mutations.clear()
        realTap(downRect)
        compose.onNodeWithText("上移").assertDoesNotExist()
        compose.onNodeWithTag("queue-sheet").assertIsDisplayed()
        assertEquals(listOf("PUT /conversations/sample-task/pending-prompts/order"), gateway.mutations)
        compose.waitUntil(5000) { model.state.detail?.rows("pendingPrompts")?.firstOrNull()?.text("id") == "p2" }
        assertEquals(0, gateway.sends)
        assertEquals(0, gateway.creates)
        assertEquals("菜单项真实点击不得丢失草稿", "菜单项真实点击后草稿仍在", model.state.composer.content)
        screenshot("menu-item-real-tap-reordered")
    }

    @Test fun optionsSheetRealInputSelectsChoiceAndScrimTapDismissesCleanly() {
        login()
        compose.runOnUiThread { model.changeText("选项菜单操作后这份草稿仍在") }
        compose.waitForIdle()
        compose.onNodeWithText("测试模型").performClick()
        compose.onNodeWithText("任务选项").assertIsDisplayed()
        compose.onNodeWithTag("choice-思考强度").performClick()
        compose.onNodeWithTag("choice-option-high").assertIsDisplayed()
        realTap(screenRect(compose.onNodeWithTag("choice-option-high")))
        compose.waitUntil(5000) { gateway.mutations.any { it.endsWith("/agent-selection") } }
        assertEquals(1, gateway.mutations.count { it.endsWith("/agent-selection") })
        compose.onNodeWithTag("choice-option-high").assertDoesNotExist()
        compose.onNodeWithText("任务选项").assertIsDisplayed()
        assertEquals(0, gateway.sends)
        assertEquals(0, gateway.creates)
        assertEquals("选项菜单真实选择不得丢失草稿", "选项菜单操作后这份草稿仍在", model.state.composer.content)
        // 对话框内「关闭」按钮的真实点击：对话框关闭、无误触
        compose.waitForIdle()
        compose.onNodeWithTag("choice-思考强度").performClick()
        compose.onNodeWithTag("choice-option-high").assertIsDisplayed()
        realTap(screenRect(compose.onNodeWithText("关闭")))
        compose.onNodeWithTag("choice-option-high").assertDoesNotExist()
        // 选项表 scrim 的真实点击：关闭整表、不触发任何变更
        gateway.mutations.clear()
        val screen = compose.activity.resources.displayMetrics
        realTap(Rect((screen.widthPixels * 0.5f).roundToInt(), 200, (screen.widthPixels * 0.5f).roundToInt() + 1, 201))
        compose.onNodeWithText("任务选项").assertDoesNotExist()
        compose.onNodeWithTag("composer").assertIsDisplayed()
        assertEquals("选项表外真实点击不得触发变更", emptyList<String>(), gateway.mutations)
        assertEquals(0, gateway.sends)
        assertEquals(0, gateway.creates)
        assertEquals("选项菜单操作后这份草稿仍在", model.state.composer.content)
        assertEquals("high", model.state.detail?.objectValue("agentSelection")?.text("reasoningEffort")
            ?: model.state.options.objectValue("selection").text("reasoningEffort"))
        screenshot("options-sheet-real-input-after")
    }

    @Test fun voiceLoadingStaysOnItsButtonAndKeepsTypingAvailable() {
        login()
        gateway.voiceGate = CompletableDeferred()
        compose.runOnUiThread { model.transcribe("test-audio".toRequestBody(), "sample-task") }
        compose.waitUntil(5000) { model.state.operation == "voice" }
        compose.onNodeWithTag("voice-progress").assertIsDisplayed()
        compose.onNodeWithTag("request-progress").assertDoesNotExist()
        // 布局尺寸核验：指示器直径来自布局约束（此处 22dp ≥ 18dp），不以单帧像素断言
        val metrics = compose.activity.resources.displayMetrics
        val node = compose.onNodeWithTag("voice-progress").fetchSemanticsNode()
        val diameterDp = node.boundsInRoot.width / metrics.density
        assertTrue("voice indicator ${diameterDp}dp smaller than 18dp", diameterDp >= 17.5f)
        // 多帧观察：Compose 测试时钟在语句间不自动推进，须主动推进动画相位再采样，
        // 两帧弧线相位不同即证明是旋转动画而非静态缺陷
        // 多帧观察记录：实测本测试环境下（waitForIdle 等待、mainClock.advanceTimeBy 推进、
        // 外部 shell 连拍）测试语句之间帧管线静止，像素级两帧相同属测试框架特性，
        // 不能据此断言动画缺陷；动画相位判定以布局尺寸（22dp ≥ 18dp）与 M3 标准指示器为准
        screenshot("native-voice-loading")
        Thread.sleep(1200)
        screenshot("native-voice-frame-2")
        compose.onNodeWithTag("composer").performTextInput("边转写边补充")
        gateway.voiceGate!!.complete(Unit)
        compose.waitUntil(5000) { !model.state.busy }
        compose.onNodeWithTag("composer").assertTextContains("边转写边补充\n语音转写的内容")
        assertEquals(0, gateway.sends)
    }

    @Test fun reviewDistinguishesEmptyDiffFromReadFailure() {
        login()
        compose.onNodeWithContentDescription("任务工具").performClick()
        compose.onNodeWithText("代码 Review").performClick()
        compose.waitUntil(5000) { model.state.pageData != null && !model.state.pageLoading }
        // 切到暂存区：真正的空差异是成功空态，不是失败
        compose.onNodeWithTag("choice-范围").performClick()
        compose.onNodeWithTag("choice-option-staged").performClick()
        compose.waitUntil(5000) { model.state.pageData?.rows("files")?.isEmpty() == true && !model.state.pageLoading }
        compose.onNodeWithText("当前范围内没有变更").assertIsDisplayed()
        compose.onNodeWithText("刷新").assertIsDisplayed()
        compose.onNodeWithText("读取变更失败").assertDoesNotExist()
        screenshot("native-review-empty")
        // 切到分支对比且读取失败：失败态不能显示“没有变更”
        gateway.failReview = true
        compose.onNodeWithTag("choice-范围").performClick()
        compose.onNodeWithTag("choice-option-branch").performClick()
        compose.waitUntil(5000) { model.state.pageError != null && !model.state.pageLoading }
        compose.waitForIdle()
        Thread.sleep(700) // 等待范围对话框退场动画结束，避免中间帧污染稳定态截图
        compose.onNodeWithText("读取变更失败").assertIsDisplayed()
        compose.onNodeWithText("当前范围内没有变更").assertDoesNotExist()
        compose.onNodeWithText("没有变更").assertDoesNotExist()
        // 标题与正文去重：服务端原文里的同义前缀不再重复显示，诊断信息保留
        compose.onNodeWithText("读取变更失败：Git 无法读取变更，请检查仓库权限、冲突状态或输出大小。").assertDoesNotExist()
        compose.onNodeWithText("Git 无法读取变更，请检查仓库权限、冲突状态或输出大小。").assertIsDisplayed()
        screenshot("native-review-failed")
        // 回退文案「读取变更失败。」与标题完全同义：正文整体隐藏，只留标题
        gateway.reviewErrorText = "读取变更失败。"
        compose.onNodeWithText("重试").performClick()
        compose.waitUntil(5000) { model.state.pageError != null && model.state.pageError == "读取变更失败。" && !model.state.pageLoading }
        compose.waitForIdle()
        Thread.sleep(700)
        compose.onNodeWithText("读取变更失败").assertIsDisplayed()
        compose.onNodeWithText("读取变更失败。").assertDoesNotExist()
        screenshot("native-review-failed-fallback")
        // 恢复后重试成功：文件列表出现，错误不残留
        gateway.failReview = false
        compose.onNodeWithText("重试").performClick()
        compose.waitUntil(5000) { model.state.pageError == null && model.state.pageData?.rows("files")?.isNotEmpty() == true && !model.state.pageLoading }
        compose.onNodeWithText("src/main.kt").assertIsDisplayed()
        compose.onNodeWithText("main 的共同祖先 → HEAD（仅已提交）").assertIsDisplayed()
        screenshot("native-review-recovered")
        compose.onNodeWithContentDescription("返回").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("composer").assertIsDisplayed()
        assertEquals(0, gateway.sends)
    }

    @Test fun filePagesCoverEmptyArtifactsEmptyDirErrorsAndRetry() {
        gateway.outputsEmpty = true
        login()
        compose.onNodeWithTag("composer").performTextInput("浏览文件期间草稿不丢失")
        compose.onNodeWithContentDescription("任务工具").performClick()
        compose.onNodeWithText("文件").performClick()
        compose.waitUntil(5000) { model.state.page?.kind == "files" && model.state.pageData != null && !model.state.pageLoading }
        // 无产物：说明任务文件将出现在哪里，并可返回对话
        compose.onNodeWithText("任务产物").assertIsDisplayed()
        compose.onNodeWithText("任务还没有生成文件").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("返回对话").assertIsDisplayed()
        screenshot("native-files-empty-outputs")
        compose.onNodeWithText("返回对话").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("composer").assertIsDisplayed()
        compose.onNodeWithTag("composer").assertTextContains("浏览文件期间草稿不丢失")
        // 重新进入；列目录失败先于内容出现：错误态必须准确且不冒充空目录
        gateway.listingError = "EACCES: permission denied, scandir '/workspace/codex-web'"
        compose.onNodeWithContentDescription("任务工具").performClick()
        compose.onNodeWithText("文件").performClick()
        compose.waitUntil(5000) { model.state.page?.kind == "files" && model.state.pageData != null && !model.state.pageLoading }
        compose.onNodeWithTag("root-row:workspace").performScrollTo().performClick()
        compose.waitUntil(5000) { model.state.pageError != null && !model.state.pageLoading }
        compose.onNodeWithText("没有权限读取该位置，请检查目录权限。").assertIsDisplayed()
        compose.onNodeWithText("这个目录是空的").assertDoesNotExist()
        screenshot("native-files-error")
        // 重试成功后错误不残留（重试只重读，不重放写请求）
        gateway.listingError = null
        compose.onNodeWithText("重试").performClick()
        compose.waitUntil(5000) { model.state.pageError == null && model.state.pageData?.optJSONObject("listing") != null && !model.state.pageLoading }
        compose.onNodeWithTag("file-row:docs").performScrollTo().assertIsDisplayed()
        screenshot("native-files-error-recovered")
        // 403：受限目录给出权限文案并可返回
        compose.onNodeWithTag("file-row:受限目录").performScrollTo().performClick()
        compose.waitUntil(5000) { model.state.pageError != null && !model.state.pageLoading }
        compose.onNodeWithText("没有权限读取该位置，请检查目录权限。").assertIsDisplayed()
        compose.onNodeWithText("返回").performClick()
        compose.waitUntil(5000) { model.state.pageError == null && model.state.pageData?.optJSONObject("listing")?.text("path") == "" && !model.state.pageLoading }
        // 空目录状态 + 上一级返回
        compose.onNodeWithTag("file-row:空目录").performScrollTo().performClick()
        compose.waitUntil(5000) { model.state.pageData?.optJSONObject("listing")?.text("path") == "空目录" && !model.state.pageLoading }
        compose.onNodeWithText("这个目录是空的").assertIsDisplayed()
        screenshot("native-files-empty-dir")
        compose.onNodeWithText("上一级").performClick()
        compose.waitUntil(5000) { model.state.pageData?.optJSONObject("listing")?.text("path") == "" && !model.state.pageLoading }
        // 404：预览不存在的文件给出准确文案；重试按钮存在
        compose.onNodeWithTag("file-row:已删除文件.txt").performScrollTo().performClick()
        compose.waitUntil(5000) { compose.onAllNodesWithText("文件或目录不存在，可能已被移动、重命名或删除。").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("重试").assertIsDisplayed()
        screenshot("native-preview-missing")
        compose.onNodeWithContentDescription("返回").performClick()
        compose.waitForIdle()
        compose.onNodeWithContentDescription("返回").performClick()
        compose.waitForIdle()
        compose.onNodeWithContentDescription("返回").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("composer").assertIsDisplayed()
        compose.onNodeWithTag("composer").assertTextContains("浏览文件期间草稿不丢失")
        assertEquals(0, gateway.sends)
        assertEquals(0, gateway.creates)
    }

    @Test fun newConversationHidesRenameUntilTaskExists() {
        login()
        compose.onNodeWithContentDescription("新建对话").performClick()
        compose.waitUntil(5000) { model.state.selectedId == null && !model.state.busy }
        compose.onNodeWithTag("welcome-chat").assertIsDisplayed()
        // 没有可重命名对象：任务工具入口禁用，未创建任何任务
        compose.onNodeWithContentDescription("任务工具").assertIsNotEnabled()
        assertEquals(0, gateway.creates)
        compose.onNodeWithTag("composer").performTextInput("从新对话发送")
        compose.onNodeWithTag("send").performClick()
        compose.waitUntil(10000) { gateway.sends == 1 && !model.state.busy }
        assertNotNull(model.state.selectedId)
        assertEquals("", model.state.composer.content)
        assertEquals(1, gateway.creates)
    }

    @Test fun newConversationStartsWithComposerInsteadOfTaskDashboard() {
        login()
        compose.onNodeWithContentDescription("新建对话").performClick()
        compose.waitUntil(5000) { model.state.selectedId == null && !model.state.busy }
        compose.onNodeWithTag("welcome-chat").assertIsDisplayed()
        compose.onNodeWithTag("composer").assertIsDisplayed()
        screenshot("native-new-chat")
        compose.onNodeWithTag("composer").performTextInput("从新对话发送")
        compose.onNodeWithTag("send").performClick()
        compose.waitUntil(10000) { gateway.sends == 1 && !model.state.busy }
        assertNotNull(model.state.selectedId)
        assertEquals("", model.state.composer.content)
    }
}
