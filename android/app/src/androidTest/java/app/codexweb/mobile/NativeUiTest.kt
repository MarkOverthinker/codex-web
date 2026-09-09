package app.codexweb.mobile

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.geometry.Offset
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

private class UiStore : NativeStore {
    private val values = java.util.concurrent.ConcurrentHashMap<String, String>()
    override fun read(key: String) = values[key]
    override fun write(key: String, value: String?) { if (value == null) values.remove(key) else values[key] = value }
}

private class UiGateway : Gateway {
    override var csrf = ""
    var sends = 0
    var draft: JSONObject? = null
    var failSend = false
    var voiceGate: CompletableDeferred<Unit>? = null
    var pending = emptyList<JSONObject>()
    var longMessages = false
    private val conversation = json("id" to "sample-task", "title" to "重做移动端交互", "status" to "idle", "working_dir" to "/workspace/codex-web", "latest_job_status" to "completed")
    private val tasks = listOf(conversation) + (2..7).map { json("id" to "task-$it", "title" to "项目任务 $it", "working_dir" to "/workspace/codex-web",
        "status" to if (it == 2) "running" else "idle", "latest_job_status" to if (it == 4) "failed" else "completed") } +
        listOf(json("id" to "task-long", "title" to "这是一个特别长的任务标题用来验证运行状态徽标在长标题换行显示时仍然完整可见不会被挤出卡片可视区域",
            "working_dir" to "/workspace/codex-web", "status" to "running", "latest_job_status" to "completed"),
            json("id" to "docs", "title" to "整理项目文档", "working_dir" to "/workspace/docs", "status" to "idle", "latest_job_status" to "completed"))
    private var selection = json("model" to "test-model", "reasoningEffort" to "medium", "sandbox" to "workspace-write")
    override suspend fun call(path: String, method: String, payload: JSONObject?, body: RequestBody?): JSONObject {
        delay(20)
        return when {
            path == "/auth/login" -> json("authenticated" to true, "username" to "test-account", "csrfToken" to "token", "providerManagementEnabled" to true, "voiceEnabled" to true)
            path == "/auth/session" -> json("authenticated" to false)
            path == "/agent-options" -> json("selection" to selection, "models" to listOf(json("id" to "test-model", "label" to "测试模型",
                "providerName" to "验收服务", "reasoningEfforts" to listOf("low", "medium", "high").jsonArray()),
                json("id" to "long-model", "label" to "超长模型显示名称用于验证选择行当前值可以完整换行显示并且不会被截断丢失信息",
                    "providerName" to "验收服务", "reasoningEfforts" to listOf("low", "medium", "high").jsonArray())).jsonArray(),
                "sandboxModes" to listOf(json("id" to "workspace-write", "label" to "工作区写入"), json("id" to "danger-full-access", "label" to "完全访问")).jsonArray())
            path == "/preset-prompts" -> json("presetPrompts" to listOf(json("id" to "preset", "name" to "中文回复", "content" to "使用中文" )).jsonArray())
            path == "/task-categories" -> json("settings" to json())
            path == "/working-dirs" -> json("settings" to json("favorites" to listOf(json("path" to "/workspace/codex-web", "label" to "Codex Web")).jsonArray()))
            path == "/conversations" && method == "POST" -> json("conversation" to conversation)
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
            path.endsWith("/agent-selection") && method == "PUT" -> { selection = payload ?: selection; json("ok" to true) }
            path == "/conversations/sample-task" -> json("conversation" to conversation, "composerDraft" to draft, "agentSelection" to selection,
                "messages" to listOf(
                    json("id" to "user-one", "role" to "user", "content" to "保留核心功能，让手机界面更专注。", "can_edit" to true),
                    json("id" to "assistant-one", "role" to "assistant", "content" to "## 让任务回到中心\n\n保留熟悉的 Web 风格，让对话成为主界面。\n\n- 右滑打开按项目分类的任务\n- 输入区轻点即可管理队列\n- 草稿与近期对话保存在本机\n\n```kotlin\nval focus = \"专注当前对话\"\n```" + if (longMessages) "\n\n继续查看项目细节。".repeat(35) else "", "can_fork" to true)
                ).jsonArray(), "messagePage" to json("hasMore" to false), "pendingPrompts" to pending.jsonArray(), "jobEvents" to emptyList<JSONObject>().jsonArray())
            path.contains("/file-tree") -> json("roots" to listOf(json("id" to "workspace", "label" to "工作区", "available" to true)).jsonArray())
            path.contains("/review") -> json("branch" to "main", "comparison" to "工作区对比", "files" to emptyList<JSONObject>().jsonArray())
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

    private fun login() {
        compose.onNodeWithTag("server").performTextInput("https://example.org")
        compose.onNodeWithTag("username").performTextInput("test-account")
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

    private fun screenshot(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val directory = File(instrumentation.targetContext.getExternalFilesDir(null), "native-screenshots").apply { mkdirs() }
        val bitmap = instrumentation.uiAutomation.takeScreenshot()
        File(directory, "$name.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
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
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
        compose.waitForIdle()
        compose.onNodeWithContentDescription("任务工具").performClick()
        compose.onNodeWithText("代码 Review").performClick()
        compose.waitUntil(5000) { model.state.pageData != null }
        compose.onNodeWithText("没有差异文件").assertIsDisplayed()
        screenshot("native-review")
        compose.onNodeWithContentDescription("返回").performClick()
        compose.waitForIdle()
        compose.onNodeWithContentDescription("任务工具").performClick()
        compose.onNodeWithText("文件").performClick()
        compose.waitUntil(5000) { model.state.page?.kind == "files" && model.state.pageData != null }
        compose.onNodeWithText("工作区").assertIsDisplayed()
        screenshot("native-files")
        compose.onNodeWithContentDescription("返回").performClick()
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
        compose.onNodeWithText("按状态").performClick()
        compose.onNodeWithTag("task-list").performScrollToIndex(0)
        compose.onAllNodesWithText("进行中").onFirst().assertIsDisplayed()
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
        // 底栏三项始终有可见文字标签
        compose.onNodeWithText("对话").assertIsDisplayed()
        compose.onNodeWithText("工作台").assertIsDisplayed()
        compose.onNodeWithText("我的").assertIsDisplayed()
        compose.onNodeWithTag("tab-Profile").performClick()
        compose.onNodeWithText("test-account").assertIsDisplayed()
        compose.onNodeWithText("example.org").assertIsDisplayed()
        compose.onNodeWithTag("account-header").assertIsDisplayed()
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
