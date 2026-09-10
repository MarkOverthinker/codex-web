@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class, kotlinx.coroutines.DelicateCoroutinesApi::class)

package app.codexweb.mobile

import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.*
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import okhttp3.RequestBody
import okhttp3.Response
import okio.Buffer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.Closeable
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger

private class DraftFailureStore : NativeStore {
    private val values = java.util.concurrent.ConcurrentHashMap<String, String>()
    val draftWriteFailures = AtomicInteger()
    var failDraftWrites = false
    var draftWriteGate: CountDownLatch? = null

    override fun read(key: String): String? = values[key]

    override fun write(key: String, value: String?) {
        if (key.startsWith("draft:")) {
            draftWriteGate?.await()
            if (failDraftWrites) {
                draftWriteFailures.incrementAndGet()
                throw IOException("draft storage full")
            }
        }
        if (value == null) values.remove(key) else values[key] = value
    }
}

class ModelGateway : Gateway {
    override var csrf = ""
    val calls = java.util.concurrent.CopyOnWriteArrayList<Pair<String, JSONObject?>>()
    var draft: JSONObject? = null
    var failSend = false
    var acceptBeforeFailure = false
    var messageFailure: Exception? = null
    var failDraft = false
    var draftFailure: Exception? = null
    var logoutFailure: Exception? = null
    var logoutGate: CompletableDeferred<Unit>? = null
    var draftGate: CompletableDeferred<Unit>? = null
    var messageGate: CompletableDeferred<Unit>? = null
    var detailGate: CompletableDeferred<Unit>? = null
    var detailFailure: Exception? = null
    var nextDetailFailure: Exception? = null
    var nextAuthSessionFailure: Exception? = null
    var loginGate: CompletableDeferred<Unit>? = null
    var clearCredentialsCalls = 0
    var logoutCalls = 0
    var messages = emptyList<JSONObject>()
    var sequenceCallback: ((JSONObject, Long) -> Unit)? = null
    var eventFailures: ((String) -> Unit)? = null
    var active: JSONObject? = null
    var after = 0L
    var opens = 0
    var loginUser = "test-user"
    private fun multipartField(body: RequestBody?, name: String): String {
        val buffer = Buffer()
        body?.writeTo(buffer)
        val raw = buffer.readUtf8()
        val header = raw.indexOf("name=\"$name\"")
        if (header < 0) return ""
        val valueStart = raw.indexOf("\r\n\r\n", header).let { if (it >= 0) it + 4 else raw.indexOf("\n\n", header).let { fallback -> if (fallback >= 0) fallback + 2 else -1 } }
        if (valueStart < 0) return ""
        val valueEnd = raw.indexOf("\r\n--", valueStart).let { if (it >= 0) it else raw.indexOf("\n--", valueStart) }
        return raw.substring(valueStart, if (valueEnd >= 0) valueEnd else raw.length)
    }

    override suspend fun call(path: String, method: String, payload: JSONObject?, body: RequestBody?): JSONObject {
        calls += path to payload
        return when {
            path == "/auth/logout" -> {
                logoutCalls++
                logoutGate?.await()
                logoutFailure?.let { throw it }
                json("ok" to true)
            }
            path == "/auth/login" -> {
                loginGate?.await()
                loginUser = payload?.text("username", "test-user").orEmpty()
                json("authenticated" to true, "username" to loginUser, "csrfToken" to "csrf")
            }
            path == "/auth/session" -> {
                nextAuthSessionFailure?.let { failure -> nextAuthSessionFailure = null; throw failure }
                json("authenticated" to true, "username" to "test-user", "csrfToken" to "csrf")
            }
            path.startsWith("/auth/") -> json("authenticated" to true, "username" to "test-user", "csrfToken" to "csrf")
            path == "/agent-options" -> json("models" to emptyList<JSONObject>().jsonArray())
            path == "/preset-prompts" -> json("presetPrompts" to emptyList<JSONObject>().jsonArray())
            path == "/task-categories" -> json("settings" to json())
            path == "/conversations" && method == "POST" -> json("conversation" to json("id" to "one"))
            path == "/conversations" -> json("conversations" to listOf(json("id" to "one", "title" to "Test task")).jsonArray())
            path.endsWith("/seen") -> json()
            path.endsWith("/draft") && method == "PUT" -> {
                draftGate?.await()
                if (failDraft) throw IOException("offline")
                draftFailure?.let { throw it }
                draft = json("content" to payload?.text("content"), "quote_excerpt" to payload?.text("quoteExcerpt"),
                    "source_reference" to payload?.optJSONObject("sourceReference"), "files" to (draft?.rows("files").orEmpty()).jsonArray())
                json("composerDraft" to draft)
            }
            path.endsWith("/messages") && method == "POST" -> {
                messageGate?.await()
                messageFailure?.let { throw it }
                if (!failSend || acceptBeforeFailure) {
                    messages = messages + json("id" to "sent-${messages.size}", "role" to "user",
                        "content" to multipartField(body, "message").ifBlank { draft?.text("content") },
                        "quote_excerpt" to multipartField(body, "quoteExcerpt"))
                    draft = null
                }
                if (failSend) throw IOException("response lost")
                json("queued" to true)
            }
            path == "/conversations/one" -> {
                val owner = loginUser
                if (owner == "test-user") detailGate?.await()
                (nextDetailFailure.also { nextDetailFailure = null } ?: detailFailure)?.let { throw it }
                json("conversation" to json("id" to "one", "title" to "Test task", "owner" to owner), "composerDraft" to draft,
                "messages" to messages.jsonArray(), "messagePage" to json("hasMore" to false), "activeJob" to active,
                "jobEvents" to emptyList<JSONObject>().jsonArray())
            }
            else -> json()
        }
    }
    override suspend fun download(path: String): Response = throw UnsupportedOperationException()
    override fun events(jobId: String, after: Long, receive: (JSONObject, Long) -> Unit, failure: (String) -> Unit): Closeable {
        this.after = after
        opens++
        sequenceCallback = receive
        eventFailures = failure
        return Closeable {}
    }
    override fun clearCredentials() { clearCredentialsCalls++ }
    override fun close() {}
}

class ClientModelTest {
    private val dispatcher = newSingleThreadContext("native-model-test")
    private lateinit var model: ClientModel
    private lateinit var api: ModelGateway
    private lateinit var storage: DraftFailureStore
    private val owner = ViewModelStore()

    @Before fun setup() = runBlocking {
        Dispatchers.setMain(dispatcher)
        api = ModelGateway()
        storage = DraftFailureStore()
        withContext(dispatcher) { model = ClientModel(storage) { api }; owner.put("client", model) }
        delay(50)
        withContext(dispatcher) { model.connect("https://example.org", "test-user", "test-password") }
        await { model.state.authenticated && !model.state.connecting }
        withContext(dispatcher) { model.openConversation("one") }
        await { !model.state.busy && model.state.selectedId == "one" }
    }

    @After fun cleanup() = runBlocking {
        withContext(dispatcher) { owner.clear() }
        Dispatchers.resetMain()
        dispatcher.close()
    }

    private suspend fun await(condition: () -> Boolean) {
        withTimeout(5000) { while (!withContext(dispatcher) { condition() }) delay(10) }
    }

    @Test fun sendFlushesServerDraftBeforeMessageAndClearsOnlyAfterSuccess() = runBlocking {
        withContext(dispatcher) { model.changeText("native\nmessage"); model.send() }
        await { !model.state.busy }
        val relevant = api.calls.map { it.first }.filter { it.endsWith("/draft") || it.endsWith("/messages") }
        assertEquals(listOf("/conversations/one/draft", "/conversations/one/messages"), relevant)
        assertEquals("native\nmessage", api.messages.single().text("content"))
        assertEquals("", model.state.composer.content)
        assertEquals("csrf", api.csrf)
    }

    @Test fun ambiguousSendKeepsLocalTextAndCannotAutomaticallyReplay() = runBlocking {
        api.failSend = true
        api.acceptBeforeFailure = true
        withContext(dispatcher) { model.changeText("must not execute twice"); model.send() }
        await { !model.state.busy }
        assertEquals("must not execute twice", model.state.composer.content)
        assertTrue(model.state.sendUncertain)
        withContext(dispatcher) { model.send(); model.refresh() }
        await { !model.state.busy }
        assertEquals(1, api.calls.count { it.first.endsWith("/messages") })
        assertEquals(1, api.messages.size)
        withContext(dispatcher) { model.resolveUncertainSend(true) }
        await { !model.state.busy }
        assertFalse(model.state.sendUncertain)
        assertEquals("", model.state.composer.content)
    }

    @Test fun failedDraftPreventsSendingAndSurvivesViewModelRecreation() = runBlocking {
        api.failDraft = true
        withContext(dispatcher) { model.changeText("recover this"); model.send() }
        await { !model.state.busy }
        assertEquals(0, api.calls.count { it.first.endsWith("/messages") })
        await { storage.read("draft:https://example.org/codex-web/:test-user:one") != null }
        withContext(dispatcher) { owner.clear(); model = ClientModel(storage) { api }; owner.put("recovered", model) }
        await { model.state.authenticated && !model.state.connecting }
        withContext(dispatcher) { model.openConversation("one") }
        await { model.state.selectedId == "one" && !model.state.busy }
        assertEquals("recover this", model.state.composer.content)
    }

    @Test fun editsDuringDraftSaveDoNotClearNewerLocalRevision() = runBlocking {
        api.draftGate = CompletableDeferred()
        withContext(dispatcher) { model.changeText("first") }
        await { api.calls.any { it.first.endsWith("/draft") } }
        withContext(dispatcher) { model.changeText("second") }
        api.draftGate!!.complete(Unit)
        delay(100)
        assertEquals("second", model.state.composer.content)
        assertTrue(model.state.composer.dirty)
        await { api.draft?.text("content") == "second" && !model.state.composer.dirty }
    }

    @Test fun changingToolsDoesNotRecreateComposerOrLoseSource() = runBlocking {
        withContext(dispatcher) {
            model.changeText("keep typing")
            model.quote(json("content" to "reference"))
            model.navigate(ToolPage("Queue", "queue", ""))
            model.back()
        }
        assertEquals("keep typing", model.state.composer.content)
        assertEquals("reference", model.state.composer.quote)
    }

    @Test fun duplicateEventSequencesAreIgnored() = runBlocking {
        api.active = json("id" to "job-one", "status" to "running")
        withContext(dispatcher) { model.foreground(true) }
        await { api.sequenceCallback != null }
        api.sequenceCallback!!(json("type" to "progress", "label" to "run"), 1)
        api.sequenceCallback!!(json("type" to "progress", "label" to "duplicate"), 1)
        await { model.state.detail?.rows("jobEvents")?.isNotEmpty() == true }
        assertEquals(1, model.state.detail!!.rows("jobEvents").size)
        assertEquals("run", model.state.detail!!.rows("jobEvents").single().text("label"))
        withContext(dispatcher) { model.foreground(false) }
    }

    @Test fun cachedConversationIsVisibleBeforeSlowNetworkReturns() = runBlocking {
        api.detailGate = CompletableDeferred()
        withContext(dispatcher) { model.openConversation("one") }
        await { model.state.detailFromCache }
        assertEquals("Test task", model.state.conversation.text("title"))
        assertTrue(model.state.busy)
        api.detailGate!!.complete(Unit)
        await { !model.state.busy }
        assertFalse(model.state.detailFromCache)
    }

    @Test fun offlineCacheAllowsLocalDraftButNotUnverifiedSending() = runBlocking {
        api.detailFailure = IOException("offline")
        withContext(dispatcher) { model.openConversation("one") }
        await { !model.state.busy }
        assertTrue(model.state.detailFromCache)
        assertNull(model.state.error)
        withContext(dispatcher) { model.changeText("离线补充内容"); model.send() }
        assertEquals(0, api.calls.count { it.first.endsWith("/messages") })
        api.detailFailure = null
        withContext(dispatcher) { model.refresh() }
        await { !model.state.busy }
        assertEquals("离线补充内容", model.state.composer.content)
        assertFalse(model.state.detailFromCache)
    }

    @Test fun revokedConversationDoesNotRemainVisibleFromCache() = runBlocking {
        api.detailFailure = ApiFailure(403, "permission revoked")
        withContext(dispatcher) { model.openConversation("one") }
        await { !model.state.busy }
        assertNull(model.state.selectedId)
        assertNull(model.state.detail)
        assertNotNull(model.state.error)
    }

    @Test fun newChatDraftSurvivesRecreationWithoutCreatingServerTask() = runBlocking {
        withContext(dispatcher) { model.startNewChat() }
        await { !model.state.busy }
        withContext(dispatcher) { model.changeText("尚未建立会话的草稿") }
        await { storage.read("draft:https://example.org/codex-web/:test-user:_new") != null }
        withContext(dispatcher) { owner.clear(); model = ClientModel(storage) { api }; owner.put("new-home", model) }
        await { model.state.authenticated && !model.state.connecting }
        assertNull(model.state.selectedId)
        assertEquals("尚未建立会话的草稿", model.state.composer.content)
        assertEquals(0, api.calls.count { it.first.endsWith("/messages") })
        withContext(dispatcher) { model.selectTab(HomeTab.Profile); model.selectTab(HomeTab.Chat) }
        assertEquals("尚未建立会话的草稿", model.state.composer.content)
        withContext(dispatcher) { model.send() }
        await { !model.state.busy }
        assertEquals("尚未建立会话的草稿", api.messages.last().text("content"))
        assertNull(storage.read("draft:https://example.org/codex-web/:test-user:_new"))
    }

    @Test fun offlineDraftDoesNotBlockLeavingAndReopeningCachedChat() = runBlocking {
        api.detailFailure = IOException("offline")
        api.failDraft = true
        withContext(dispatcher) { model.openConversation("one") }
        await { !model.state.busy }
        withContext(dispatcher) { model.changeText("离线草稿保留"); model.startNewChat() }
        await { !model.state.busy }
        assertNull(model.state.selectedId)
        assertNull(model.state.error)
        withContext(dispatcher) { model.openConversation("one") }
        await { !model.state.busy }
        assertEquals("离线草稿保留", model.state.composer.content)
        assertTrue(model.state.detailFromCache)
        assertEquals(0, api.calls.count { it.first.endsWith("/draft") })
    }

    @Test fun refreshRevocationClearsVisibleAndPersistedSnapshot() = runBlocking {
        api.detailFailure = ApiFailure(403, "permission revoked")
        withContext(dispatcher) { model.refresh() }
        await { !model.state.busy }
        assertNull(model.state.selectedId)
        assertNull(model.state.detail)
        val snapshots = SnapshotCache(storage)
        assertNull(snapshots.get("https://example.org/codex-web/:test-user", "detail:one"))
    }

    @Test fun offlineSnapshotRetainsServerDraftAndAttachmentReferences() = runBlocking {
        api.draft = json("content" to "已经同步的草稿", "quote_excerpt" to "引用内容", "files" to listOf(json("id" to "attachment-one")).jsonArray())
        withContext(dispatcher) { model.refresh() }
        await { !model.state.busy }
        api.detailFailure = IOException("offline")
        withContext(dispatcher) { model.openConversation("one") }
        await { !model.state.busy }
        assertTrue(model.state.detailFromCache)
        assertEquals("已经同步的草稿", model.state.composer.content)
        assertEquals("引用内容", model.state.composer.quote)
        assertEquals("attachment-one", model.state.composer.files.single().text("id"))
    }

    @Test fun offlineLogoutClearsLocalSessionAndKeepsDraftWithoutClaimingServerLogout() = runBlocking {
        api.draft = json("content" to "服务器附件草稿", "files" to listOf(json("id" to "keep-file", "original_name" to "keep.md")).jsonArray())
        withContext(dispatcher) { model.openConversation("one") }
        await { !model.state.busy }
        api.failDraft = true
        api.logoutFailure = IOException("offline")
        withContext(dispatcher) { model.changeText("退出时必须保留") ; model.logout() }
        await { !model.state.busy }
        await { storage.read("draft:https://example.org/codex-web/:test-user:one") != null }
        assertEquals("keep-file", JSONObject(storage.read("draft:https://example.org/codex-web/:test-user:one")!!).rows("files").single().text("id"))
        assertFalse(model.state.authenticated)
        assertNull(model.state.selectedId)
        assertNull(model.state.detail)
        assertEquals(1, api.clearCredentialsCalls)
        assertEquals(1, api.logoutCalls)
        assertTrue(model.state.error.orEmpty().contains("未确认"))
    }

    @Test fun logoutDraftWriteFailureIsReportedInsteadOfClaimingLocalRetention() = runBlocking {
        storage.failDraftWrites = true
        withContext(dispatcher) { model.changeText("退出时无法保存") ; model.logout() }
        await { !model.state.busy }
        await { storage.draftWriteFailures.get() > 0 }
        assertTrue(model.state.error.orEmpty().contains("草稿保存失败"))
        assertFalse(model.state.error.orEmpty().contains("草稿已保留"))
    }

    @Test fun expiredSessionSuccessfulDraftWriteReportsRetentionAfterWrite() = runBlocking {
        api.draftFailure = ApiFailure(401, "expired")
        withContext(dispatcher) { model.changeText("失效前成功保存") }
        await { !model.state.authenticated }
        await { storage.read("draft:https://example.org/codex-web/:test-user:one") != null }
        assertEquals("失效前成功保存", JSONObject(storage.read("draft:https://example.org/codex-web/:test-user:one")!!).text("content"))
        assertEquals("本机草稿已保留", model.state.draftStatus)
    }

    @Test fun expiredSessionDelayedDraftWriteFailureIsNotReportedAsRetention() = runBlocking {
        storage.failDraftWrites = true
        storage.draftWriteGate = CountDownLatch(1)
        api.draftFailure = ApiFailure(401, "expired")
        withContext(dispatcher) { model.changeText("失效时延迟保存") }
        await { !model.state.authenticated }
        assertNotEquals("本机草稿已保留", model.state.draftStatus)
        storage.draftWriteGate!!.countDown()
        await { storage.draftWriteFailures.get() > 0 }
        delay(100)
        assertTrue(model.state.error.orEmpty().contains("草稿保存失败"))
        assertFalse(model.state.draftStatus == "本机草稿已保留")
    }

    @Test fun serverChangeOnUnauthorizedLogoutClearsCredentialsAndForgetsServer() = runBlocking {
        api.logoutFailure = ApiFailure(401, "expired")
        withContext(dispatcher) { model.changeServer() }
        await { !model.state.busy }
        assertFalse(model.state.authenticated)
        assertEquals("", model.state.server)
        assertEquals(1, api.clearCredentialsCalls)
        assertTrue(model.state.error.orEmpty().contains("未确认"))
    }

    @Test fun logoutTimeoutStillClearsLocalSessionAndReportsUnknownServerState() = runBlocking {
        api.logoutGate = CompletableDeferred()
        withContext(dispatcher) { model.logout() }
        await { !model.state.busy }
        assertFalse(model.state.authenticated)
        assertEquals(1, api.clearCredentialsCalls)
        assertTrue(model.state.error.orEmpty().contains("未确认"))
    }

    @Test fun backgroundDraftUnauthorizedResponseExpiresSessionAndPreservesLocalDraft() = runBlocking {
        api.draftFailure = ApiFailure(401, "expired")
        withContext(dispatcher) { model.changeText("后台同步遇到过期会话") }
        await { api.calls.any { it.first.endsWith("/draft") } }
        await { !model.state.authenticated }
        await { storage.read("draft:https://example.org/codex-web/:test-user:one") != null }
        assertNull(model.state.selectedId)
        assertNull(model.state.detail)
        assertEquals(1, api.clearCredentialsCalls)
    }

    @Test fun delayedOldPageUnauthorizedResponseCannotClearNewLogin() = runBlocking {
        api.detailGate = CompletableDeferred()
        api.nextDetailFailure = ApiFailure(401, "expired")
        withContext(dispatcher) { model.navigate(ToolPage("旧页", "detail", "/conversations/one")) }
        await { api.calls.count { it.first == "/conversations/one" } >= 3 }
        withContext(dispatcher) { model.logout() }
        await { !model.state.busy && !model.state.authenticated }
        api.loginGate = CompletableDeferred()
        withContext(dispatcher) { model.connect("https://example.org", "new-user", "new-password") }
        await { model.state.connecting && api.calls.any { it.first == "/auth/login" } }
        api.loginGate!!.complete(Unit)
        await { model.state.session?.text("username") == "new-user" }
        api.detailGate!!.complete(Unit)
        await { !model.state.connecting }
        assertTrue(model.state.authenticated)
        assertEquals("new-user", model.state.session?.text("username"))
    }

    @Test fun delayedOldConversationSuccessCannotReplaceNewLoginState() = runBlocking {
        api.detailGate = CompletableDeferred()
        withContext(dispatcher) { model.openConversation("one") }
        await { api.calls.count { it.first == "/conversations/one" } >= 2 }

        api.nextAuthSessionFailure = ApiFailure(401, "expired")
        val expiry = CoroutineScope(dispatcher).launch { runCatching { model.get("/auth/session") } }
        await { !model.state.authenticated && !model.state.busy }

        withContext(dispatcher) { model.connect("https://example.org", "new-user", "new-password") }
        await { model.state.session?.text("username") == "new-user" }
        api.detailGate!!.complete(Unit)
        expiry.join()
        await { !model.state.connecting }
        assertTrue(model.state.authenticated)
        assertEquals("new-user", model.state.session?.text("username"))
        assertEquals("one", model.state.selectedId)
        assertEquals("new-user", model.state.conversation.text("owner"))
    }

    @Test fun sendUsesOneSnapshotAndRetainsTextChangedWhileDraftSyncIsDelayed() = runBlocking {
        api.draftGate = CompletableDeferred()
        withContext(dispatcher) { model.changeText("发送的原始内容"); model.quote(json("content" to "原始引用")); model.send() }
        await { api.calls.any { it.first.endsWith("/draft") } }
        withContext(dispatcher) { model.changeText("发送后继续输入") ; model.quote(json("content" to "后续引用")) }
        api.draftGate!!.complete(Unit)
        await { !model.state.busy }
        assertEquals("发送的原始内容", api.messages.single().text("content"))
        assertEquals("原始引用", api.messages.single().text("quote_excerpt"))
        assertEquals("发送后继续输入", model.state.composer.content)
        assertEquals("后续引用", model.state.composer.quote)
        assertTrue(model.state.composer.dirty)
    }

    @Test fun uncertainSendDoesNotOverwriteNewerInput() = runBlocking {
        api.failSend = true
        api.acceptBeforeFailure = true
        api.messageGate = CompletableDeferred()
        withContext(dispatcher) { model.changeText("可能已发送"); model.send() }
        await { api.calls.any { it.first.endsWith("/messages") } }
        withContext(dispatcher) { model.changeText("发送期间新增内容") }
        api.messageGate!!.complete(Unit)
        await { !model.state.busy }
        assertTrue(model.state.sendUncertain)
        assertEquals("发送期间新增内容", model.state.composer.content)
    }

    @Test fun ambiguousSendUnauthorizedReconcileRetainsProtectionAcrossRelogin() = runBlocking {
        api.failSend = true
        api.nextDetailFailure = ApiFailure(401, "expired while checking send")
        withContext(dispatcher) { model.changeText("结果未知的旧发送"); model.send() }
        await { !model.state.authenticated && !model.state.busy }
        await { storage.read("draft:https://example.org/codex-web/:test-user:one") != null }
        val backup = JSONObject(storage.read("draft:https://example.org/codex-web/:test-user:one")!!)
        assertTrue(backup.optBoolean("sendUncertain"))
        assertEquals(1, api.calls.count { it.first.endsWith("/messages") })

        withContext(dispatcher) { model.connect("https://example.org", "test-user", "test-password") }
        await { model.state.authenticated && model.state.selectedId == "one" && !model.state.busy }
        assertTrue(model.state.sendUncertain)
        withContext(dispatcher) { model.send() }
        delay(100)
        assertEquals(1, api.calls.count { it.first.endsWith("/messages") })
    }

    @Test fun clientFailureUnauthorizedReconcileDoesNotWriteNullAccountDraft() = runBlocking {
        api.messageFailure = ApiFailure(422, "invalid request")
        api.nextDetailFailure = ApiFailure(401, "expired while checking client failure")
        withContext(dispatcher) { model.changeText("明确失败的旧草稿"); model.send() }
        await { !model.state.authenticated && !model.state.busy }
        await { storage.read("draft:https://example.org/codex-web/:test-user:one") != null }
        assertNull(storage.read("draft:https://example.org/codex-web/:null:one"))
        assertEquals("明确失败的旧草稿", JSONObject(storage.read("draft:https://example.org/codex-web/:test-user:one")!!).text("content"))
        assertFalse(JSONObject(storage.read("draft:https://example.org/codex-web/:test-user:one")!!).optBoolean("sendUncertain"))
    }
}
