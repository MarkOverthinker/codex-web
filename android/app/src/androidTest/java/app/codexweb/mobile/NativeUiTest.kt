package app.codexweb.mobile

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.delay
import okhttp3.RequestBody
import okhttp3.Response
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
    private val conversation = json("id" to "sample-task", "title" to "重做移动端交互", "status" to "idle", "working_dir" to null)
    private val selection = json("model" to "test-model", "reasoningEffort" to "medium", "sandbox" to "workspace-write")
    override suspend fun call(path: String, method: String, payload: JSONObject?, body: RequestBody?): JSONObject {
        delay(20)
        return when {
            path == "/auth/login" -> json("authenticated" to true, "username" to "test-account", "csrfToken" to "token", "providerManagementEnabled" to true)
            path == "/auth/session" -> json("authenticated" to false)
            path == "/agent-options" -> json("selection" to selection, "models" to listOf(json("id" to "test-model", "label" to "测试模型",
                "providerName" to "验收服务", "reasoningEfforts" to listOf("low", "medium", "high").jsonArray())).jsonArray(),
                "sandboxModes" to listOf(json("id" to "workspace-write", "label" to "工作区写入"), json("id" to "danger-full-access", "label" to "完全访问")).jsonArray())
            path == "/preset-prompts" -> json("presetPrompts" to listOf(json("id" to "preset", "name" to "中文回复", "content" to "使用中文" )).jsonArray())
            path == "/task-categories" -> json("settings" to json())
            path == "/conversations" && method == "POST" -> json("conversation" to conversation)
            path == "/conversations" -> json("conversations" to listOf(conversation).jsonArray())
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
                    json("id" to "assistant-one", "role" to "assistant", "content" to "## 让任务回到中心\n\n聊天、文件与执行过程分开呈现。\n\n- 输入区跟随键盘\n- 任务继续在服务器运行\n- 高级选项按需展开\n\n```kotlin\nval focus = \"原生交互\"\n```", "can_fork" to true)
                ).jsonArray(), "messagePage" to json("hasMore" to false), "pendingPrompts" to emptyList<JSONObject>().jsonArray(), "jobEvents" to emptyList<JSONObject>().jsonArray())
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
        compose.onNodeWithTag("login").performClick()
        compose.waitUntil(10000) { model.state.authenticated && !model.state.connecting }
        compose.onNodeWithText("重做移动端交互").performClick()
        compose.waitUntil(10000) { model.state.selectedId != null && !model.state.busy }
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
        compose.onNodeWithContentDescription("返回").performClick()
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
}
