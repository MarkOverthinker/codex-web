@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class, kotlinx.coroutines.DelicateCoroutinesApi::class)

package app.codexweb.mobile

import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.*
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import okhttp3.RequestBody
import okhttp3.Response
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.Closeable
import java.io.IOException

class ModelGateway : Gateway {
    override var csrf = ""
    val calls = java.util.concurrent.CopyOnWriteArrayList<Pair<String, JSONObject?>>()
    var draft: JSONObject? = null
    var failSend = false
    var acceptBeforeFailure = false
    var failDraft = false
    var draftGate: CompletableDeferred<Unit>? = null
    var detailGate: CompletableDeferred<Unit>? = null
    var detailFailure: Exception? = null
    var messages = emptyList<JSONObject>()
    var sequenceCallback: ((JSONObject, Long) -> Unit)? = null
    var eventFailures: ((String) -> Unit)? = null
    var active: JSONObject? = null
    var after = 0L
    var opens = 0
    override suspend fun call(path: String, method: String, payload: JSONObject?, body: RequestBody?): JSONObject {
        calls += path to payload
        return when {
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
                draft = json("content" to payload?.text("content"), "quote_excerpt" to payload?.text("quoteExcerpt"),
                    "source_reference" to payload?.optJSONObject("sourceReference"), "files" to (draft?.rows("files").orEmpty()).jsonArray())
                json("composerDraft" to draft)
            }
            path.endsWith("/messages") && method == "POST" -> {
                if (!failSend || acceptBeforeFailure) {
                    messages = messages + json("id" to "sent-${messages.size}", "role" to "user", "content" to draft?.text("content"))
                    draft = null
                }
                if (failSend) throw IOException("response lost")
                json("queued" to true)
            }
            path == "/conversations/one" -> {
                detailGate?.await()
                detailFailure?.let { throw it }
                json("conversation" to json("id" to "one", "title" to "Test task"), "composerDraft" to draft,
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
    override fun clearCredentials() {}
    override fun close() {}
}

class ClientModelTest {
    private val dispatcher = newSingleThreadContext("native-model-test")
    private lateinit var model: ClientModel
    private lateinit var api: ModelGateway
    private lateinit var storage: MemoryStore
    private val owner = ViewModelStore()

    @Before fun setup() = runBlocking {
        Dispatchers.setMain(dispatcher)
        api = ModelGateway()
        storage = MemoryStore()
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
}
