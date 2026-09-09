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
        listOf(json("id" to "docs", "title" to "整理项目文档", "working_dir" to "/workspace/docs", "status" to "idle", "latest_job_status" to "completed"))
    private val selection = json("model" to "test-model", "reasoningEffort" to "medium", "sandbox" to "workspace-write")
    override suspend fun call(path: String, method: String, payload: JSONObject?, body: RequestBody?): JSONObject {
        delay(20)
        return when {
            path == "/auth/login" -> json("authenticated" to true, "username" to "test-account", "csrfToken" to "token", "providerManagementEnabled" to true, "voiceEnabled" to true)
            path == "/auth/session" -> json("authenticated" to false)
            path == "/agent-options" -> json("selection" to selection, "models" to listOf(json("id" to "test-model", "label" to "测试模型",
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
        screenshot("native-options")
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
        compose.waitForIdle()
        compose.onNodeWithContentDescription("任务工具").performClick()
        compose.onNodeWithText("代码 Review").performClick()
        compose.waitUntil(5000) { model.state.pageData != null }
        compose.onNodeWithText("没有差异文件").assertIsDisplayed()
        screenshot("native-review")
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
        compose.onNodeWithText("知道了").performClick()
        compose.onNodeWithTag("composer").assertTextContains("网络失败也不能丢失")
        compose.onNodeWithTag("send").assertIsNotEnabled()
        assertEquals(1, gateway.sends)
        screenshot("native-recovery")
    }

    @Test fun swipeOpensProjectDrawerWithLimitedGroupsAndStatusSwitch() {
        login()
        compose.onNodeWithTag("mobile-shell").performTouchInput {
            swipe(Offset(width * .12f, height * .2f), Offset(width * .9f, height * .2f), 500)
        }
        compose.onNodeWithTag("drawer-content").assertIsDisplayed()
        compose.onNodeWithText("Codex Web").assertIsDisplayed()
        compose.onNodeWithTag("task-task-7").assertDoesNotExist()
        screenshot("native-project-drawer")
        compose.onNodeWithTag("expand-auto:dir:%2Fworkspace%2Fcodex-web").performClick()
        compose.onNodeWithTag("task-list").performScrollToNode(hasTestTag("task-task-7"))
        compose.onNodeWithTag("task-task-7").assertIsDisplayed()
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
        compose.onNodeWithTag("tab-Profile").performClick()
        compose.onNodeWithText("test-account").assertIsDisplayed()
        screenshot("native-profile")
        compose.onNodeWithTag("tab-Workspace").performClick()
        compose.onNodeWithText("让工具围绕当前对话").assertIsDisplayed()
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
        compose.onNodeWithContentDescription("关闭队列").performClick()
        compose.onNodeWithTag("composer").assertTextContains("继续写当前草稿")
        assertNull(model.state.page)
        assertEquals("sample-task", model.state.selectedId)
    }

    @Test fun voiceLoadingStaysOnItsButtonAndKeepsTypingAvailable() {
        login()
        gateway.voiceGate = CompletableDeferred()
        compose.runOnUiThread { model.transcribe("test-audio".toRequestBody(), "sample-task") }
        compose.waitUntil(5000) { model.state.operation == "voice" }
        compose.onNodeWithTag("voice-progress").assertIsDisplayed()
        compose.onNodeWithTag("request-progress").assertDoesNotExist()
        screenshot("native-voice-loading")
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
