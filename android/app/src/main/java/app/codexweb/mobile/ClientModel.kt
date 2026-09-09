package app.codexweb.mobile

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.MultipartBody
import okhttp3.RequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable

class ClientModel(
    private val store: NativeStore,
    private val apiFactory: (String) -> Gateway = { NativeApi(it, TrustedCookies(it, store)) },
) : ViewModel() {
    var state by mutableStateOf(NativeState())
        private set
    private var api: Gateway? = null
    private val draftMutex = Mutex()
    private var debounce: Job? = null
    private var backupJob: Job? = null
    private var polling: Job? = null
    private var stream: Closeable? = null
    private var streamJob = ""
    private var streamGeneration = 0
    private var lastSequence = 0L
    private var foreground = false
    private var epoch = 0
    private var pageGeneration = 0
    private val pages = ArrayDeque<ToolPage>()
    private val parents = ArrayDeque<String>()
    private val cache = SnapshotCache(store)
    private fun accountKey() = "${state.server}:${state.session?.text("username")}"
    private fun lastConversationKey() = "last-conversation:${accountKey()}"

    private suspend fun cached(account: String, key: String): JSONObject? = try { cache.get(account, key) }
    catch (reason: Exception) { if (reason is CancellationException) throw reason; null }

    private suspend fun saveCache(account: String, key: String, value: JSONObject) {
        try { cache.put(account, key, value) }
        catch (reason: Exception) { if (reason is CancellationException) throw reason }
    }

    private suspend fun discardCache(account: String, key: String) {
        try { cache.remove(account, key) }
        catch (reason: Exception) { if (reason is CancellationException) throw reason }
    }

    init {
        viewModelScope.launch {
            val saved = withContext(Dispatchers.IO) { Triple(store.read("server"), store.read("theme"), store.read("font")) }
            state = state.copy(theme = saved.second ?: "system", fontSize = saved.third?.toIntOrNull() ?: 16)
            saved.first?.let { connect(it) }
        }
    }

    private fun error(reason: Throwable) {
        if (reason is CancellationException) throw reason
        state = state.copy(error = if (reason is ApiFailure) reason.message else reason.localizedMessage ?: "请求失败，请检查网络后重试。")
        if (reason is ApiFailure && reason.status == 401) {
            disconnectStream()
            state = state.copy(session = null, connection = "登录已失效，未发送内容保留在本机")
        }
    }

    fun dismissError() { state = state.copy(error = null, notice = null) }
    fun note(message: String) { state = state.copy(notice = message) }

    fun connect(server: String, username: String? = null, password: String? = null) {
        if (state.connecting || state.busy) return
        val normalized = try { ServerPolicy.normalize(server) } catch (reason: Exception) { error(reason); return }
        state = state.copy(connecting = true, error = null)
        viewModelScope.launch {
            try {
                val oldServer = state.server
                if (oldServer != normalized || api == null) {
                    epoch++
                    disconnectStream()
                    api?.close()
                    api = withContext(Dispatchers.IO) { apiFactory(normalized) }
                    state = state.copy(server = normalized, selectedId = null, detail = null, composer = Composer(), page = null)
                }
                val gateway = requireNotNull(api)
                val session = if (username != null) gateway.call("/auth/login", "POST", json("username" to username, "password" to password))
                    else gateway.call("/auth/session")
                gateway.csrf = session.text("csrfToken")
                state = state.copy(session = session, connection = if (session.optBoolean("authenticated")) "已连接" else "请登录")
                withContext(Dispatchers.IO) { store.write("server", normalized) }
                if (session.optBoolean("authenticated")) {
                    state = state.copy(selectedId = null, detail = null, page = null, composer = Composer(), conversations = emptyList(),
                        options = JSONObject(), presets = emptyList(), categorySettings = JSONObject(), workingDirs = JSONObject(), homeTab = HomeTab.Chat)
                    val account = accountKey()
                    cached(account, "conversations")?.let { state = state.copy(conversations = it.rows("conversations")) }
                    state = state.copy(options = cached(account, "options") ?: JSONObject(), presets = cached(account, "presets")?.rows("presetPrompts").orEmpty(),
                        categorySettings = cached(account, "categories")?.objectValue("settings") ?: JSONObject(), workingDirs = cached(account, "directories")?.objectValue("settings") ?: JSONObject())
                    val last = withContext(Dispatchers.IO) { store.read(lastConversationKey()) }
                    val cachedId = last?.takeIf { it != "_new" } ?: state.conversations.firstOrNull()?.text("id").takeIf { last != "_new" }
                    if (cachedId != null) cached(account, "detail:$cachedId")?.let { detail ->
                        state = state.copy(selectedId = cachedId, detail = detail, detailFromCache = true, connection = "本机缓存 · 正在更新")
                    }
                    refreshCatalogs()
                    runCatching { refreshList() }.onFailure { if (it is CancellationException || it is ApiFailure && it.status == 401) throw it }
                    val saved = withContext(Dispatchers.IO) { store.read(lastConversationKey()) }
                    val selected = saved?.takeIf { it != "_new" && state.conversations.any { row -> row.text("id") == it } }
                        ?: state.conversations.firstOrNull()?.text("id").takeIf { saved != "_new" }
                    if (selected != null) openInternal(selected) else restoreNewChat()
                    startPolling()
                }
            } catch (reason: Exception) { error(reason) }
            finally { state = state.copy(connecting = false) }
        }
    }

    suspend fun get(path: String): JSONObject = requireNotNull(api).call(path)

    private suspend fun refreshCatalogs() {
        state = state.copy(options = catalog("options", "/agent-options"))
        state = state.copy(presets = catalog("presets", "/preset-prompts").rows("presetPrompts"))
        state = state.copy(categorySettings = catalog("categories", "/task-categories").objectValue("settings"))
        state = state.copy(workingDirs = catalog("directories", "/working-dirs").objectValue("settings"))
    }

    private suspend fun catalog(key: String, path: String): JSONObject {
        val account = accountKey()
        return try { get(path).also { saveCache(account, key, it) } }
        catch (reason: Exception) {
            if (reason is CancellationException || reason is ApiFailure && reason.status == 401) throw reason
            cached(account, key) ?: throw reason
        }
    }

    private suspend fun refreshList() {
        val generation = epoch
        val account = accountKey()
        val result = get("/conversations")
        if (generation == epoch) {
            state = state.copy(conversations = result.rows("conversations"))
            saveCache(account, "conversations", result)
        }
    }

    fun refresh() = action("refresh") {
        refreshList()
        state.selectedId?.let { reconcile(it) }
        if (state.page != null) loadPage()
    }

    fun action(operation: String = "request", block: suspend () -> Unit) {
        if (state.busy || state.connecting) return
        state = state.copy(busy = true, error = null, operation = operation)
        viewModelScope.launch {
            try { block() } catch (reason: Exception) { error(reason) }
            finally { state = state.copy(busy = false, operation = null) }
        }
    }

    fun createConversation(workingDir: String? = null) = action("new") {
        flushDraft()
        val value = requireNotNull(api).call("/conversations", "POST", if (workingDir == null) JSONObject() else json("workingDir" to workingDir))
        openInternal(value.objectValue("conversation").text("id"))
        refreshList()
    }

    fun openConversation(id: String) = action("open") { flushDraft(); parents.clear(); openInternal(id) }

    fun selectTab(tab: HomeTab) {
        pages.clear()
        pageGeneration++
        state = state.copy(homeTab = tab, page = null, pageData = null, pageLoading = false)
    }

    private suspend fun restoreNewChat() {
        val saved = withContext(Dispatchers.IO) { store.read(draftKey("_new")) }?.let { runCatching { JSONObject(it) }.getOrNull() }
        disconnectStream()
        pages.clear()
        parents.clear()
        pageGeneration++
        state = state.copy(selectedId = null, detail = null, page = null, pageData = null, pageLoading = false,
            homeTab = HomeTab.Chat, detailFromCache = false, parentAvailable = false, sendUncertain = false,
            composer = Composer(content = saved?.text("content").orEmpty(), dirty = saved != null),
            draftStatus = if (saved != null) "本机草稿" else "")
    }

    fun startNewChat() = action("new") {
        flushDraft()
        backupJob?.join()
        restoreNewChat()
        withContext(Dispatchers.IO) { store.write(lastConversationKey(), "_new") }
    }

    private suspend fun ensureConversation(): String {
        state.selectedId?.let { return it }
        val snapshot = state.composer
        val created = requireNotNull(api).call("/conversations", "POST", JSONObject()).objectValue("conversation").text("id")
        require(created.isNotBlank())
        backupJob?.join()
        withContext(Dispatchers.IO) {
            store.write(draftKey(created), snapshot.payload().changed("revision" to snapshot.revision).toString())
            store.write(lastConversationKey(), created)
            store.write(draftKey("_new"), null)
        }
        openInternal(created)
        refreshList()
        return created
    }

    fun withConversation(callback: () -> Unit) = action("prepare") { ensureConversation(); callback() }

    fun clearCache() = action("cache") { cache.clear(accountKey()); note("浏览缓存已清理，未发送草稿保留") }

    private suspend fun openInternal(id: String) {
        require(id.isNotBlank())
        backupJob?.join()
        val account = accountKey()
        val cached = cached(account, "detail:$id")
        val backup = withContext(Dispatchers.IO) { store.read(draftKey(id)) }?.let { runCatching { JSONObject(it) }.getOrNull() }
        disconnectStream()
        pages.clear()
        pageGeneration++
        val cachedComposer = Composer.from(cached?.optJSONObject("composerDraft"))
        if (cached != null) state = state.copy(selectedId = id, detail = cached, page = null, pageData = null, pageLoading = false,
            homeTab = HomeTab.Chat, detailFromCache = true, parentAvailable = parents.isNotEmpty(),
            composer = if (backup == null) cachedComposer else cachedComposer.copy(content = backup.text("content"), quote = backup.text("quoteExcerpt"), source = backup.optJSONObject("sourceReference"), dirty = true, revision = backup.optLong("revision") + 1),
            connection = "本机缓存 · 正在更新", sendUncertain = backup?.optBoolean("sendUncertain") == true)
        val detail = try { get("/conversations/${id.segment()}").also { saveCache(account, "detail:$id", it) } }
        catch (reason: Exception) {
            if (reason is CancellationException) throw reason
            if (reason is ApiFailure && reason.status in listOf(401, 403, 404)) {
                state = state.copy(selectedId = null, detail = null, composer = Composer(), detailFromCache = false)
                discardCache(account, "detail:$id")
                throw reason
            }
            if (cached == null) throw reason
            state = state.copy(connection = "离线 · 浏览缓存", draftStatus = "仅存本机 · 联网后可发送")
            return
        }
        val composer = Composer.from(detail.optJSONObject("composerDraft"))
        disconnectStream()
        pages.clear()
        pageGeneration++
        val recovered = backup?.let { composer.copy(content = it.text("content"), quote = it.text("quoteExcerpt"),
            source = it.optJSONObject("sourceReference"), dirty = true, revision = it.optLong("revision") + 1) } ?: composer
        state = state.copy(selectedId = id, detail = detail, composer = recovered, page = null, pageData = null,
            draftStatus = if (backup != null) "已恢复本机未同步草稿" else "", connection = "已连接", sendUncertain = backup?.optBoolean("sendUncertain") == true,
            homeTab = HomeTab.Chat, detailFromCache = false, pageLoading = false, parentAvailable = parents.isNotEmpty())
        if (parents.isEmpty()) withContext(Dispatchers.IO) { store.write(lastConversationKey(), id) }
        runCatching { requireNotNull(api).call("/conversations/${id.segment()}/seen", "POST") }
        connectStream()
        if (recovered.dirty) scheduleDraft()
    }

    private fun draftKey(id: String) = "draft:${state.server}:${state.session?.text("username")}:$id"

    fun changeText(value: String) {
        state = state.copy(composer = state.composer.copy(content = value, dirty = true, revision = state.composer.revision + 1), draftStatus = "未同步")
        scheduleDraft()
    }

    fun quote(message: JSONObject, excerpt: String = message.text("content")) {
        state = state.copy(composer = state.composer.copy(quote = excerpt, dirty = true, revision = state.composer.revision + 1))
        scheduleDraft()
    }

    fun clearQuote() {
        state = state.copy(composer = state.composer.copy(quote = "", source = null, dirty = true, revision = state.composer.revision + 1))
        scheduleDraft()
    }

    private fun scheduleDraft() {
        debounce?.cancel()
        val id = state.selectedId ?: "_new"
        val snapshot = state.composer
        val key = draftKey(id)
        queueBackup(key, snapshot.payload().changed("revision" to snapshot.revision, "sendUncertain" to state.sendUncertain).toString())
        if (id == "_new" || state.detailFromCache) { state = state.copy(draftStatus = "本机草稿"); return }
        debounce = viewModelScope.launch {
            delay(700)
            viewModelScope.launch {
                try { flushDraft() }
                catch (reason: Exception) {
                    if (reason is CancellationException) throw reason
                    state = state.copy(draftStatus = "仅存本机 · 等待重连", connection = "离线或登录过期")
                }
            }
        }
    }

    private fun queueBackup(key: String, value: String?) {
        val preceding = backupJob
        backupJob = viewModelScope.launch {
            preceding?.join()
            try { withContext(Dispatchers.IO) { store.write(key, value) } }
            catch (reason: Exception) {
                if (reason is CancellationException) throw reason
                state = state.copy(draftStatus = "本机保存失败，请勿退出", error = "本机草稿保存失败：${reason.message}")
            }
        }
    }

    private suspend fun flushDraft() = draftMutex.withLock {
        if (state.detailFromCache) { backupJob?.join(); return@withLock }
        val id = state.selectedId ?: return@withLock
        val snapshot = state.composer
        if (!snapshot.dirty || state.sendUncertain) return@withLock
        val key = draftKey(id)
        state = state.copy(draftStatus = "正在同步…")
        val response = requireNotNull(api).call("/conversations/${id.segment()}/draft", "PUT", snapshot.payload())
        if (state.selectedId == id && state.composer.revision == snapshot.revision) {
            state = state.copy(composer = snapshot.copy(dirty = false,
                files = response.optJSONObject("composerDraft")?.rows("files").orEmpty()), draftStatus = "已同步")
            queueBackup(key, null)
        }
    }

    fun send() {
        if (state.detailFromCache) { note("当前为本机缓存，请联网刷新后发送。"); return }
        if (state.sendUncertain) { note("上次发送结果尚未确认，请先核对消息和队列。 "); return }
        if (state.composer.content.isBlank() && state.composer.files.isEmpty()) return
        action("send") {
            val id = ensureConversation()
            flushDraft()
            draftMutex.withLock {
                val snapshot = state.composer
                val body = MultipartBody.Builder().setType(MultipartBody.FORM)
                    .addFormDataPart("message", snapshot.content).addFormDataPart("quoteExcerpt", snapshot.quote)
                    .addFormDataPart("useComposerDraft", "true")
                    .apply { snapshot.source?.let { addFormDataPart("sourceReference", it.toString()) } }.build()
                val result = try { requireNotNull(api).call("/conversations/${id.segment()}/messages", "POST", body = body) }
                catch (reason: Exception) {
                    runCatching { reconcile(id) }
                    if (reason is CancellationException) throw reason
                    if (reason is ApiFailure && reason.status in 400..499) throw reason
                    state = state.copy(composer = snapshot.copy(dirty = true), sendUncertain = true, draftStatus = "发送结果待确认 · 仅存本机")
                    queueBackup(draftKey(id), snapshot.payload().changed("revision" to snapshot.revision, "sendUncertain" to true).toString())
                    throw java.io.IOException("发送未确认：${reason.message}。请先刷新核对消息和队列，避免重复发送。")
                }
                if (result.optBoolean("needsInstruction")) {
                    note(result.text("guidance", "请补充指令"))
                } else if (state.selectedId == id && snapshot.revision == state.composer.revision) {
                    state = state.copy(composer = Composer(), draftStatus = "")
                    queueBackup(draftKey(id), null)
                }
            }
            reconcile(id)
            refreshList()
        }
    }

    fun resolveUncertainSend(received: Boolean) = action {
        val id = state.selectedId ?: return@action
        val draft = if (received) Composer.from(state.detail?.optJSONObject("composerDraft")) else state.composer.copy(dirty = true)
        state = state.copy(sendUncertain = false, composer = draft, draftStatus = "")
        if (received) queueBackup(draftKey(id), null) else scheduleDraft()
    }

    fun upload(body: RequestBody, id: String) = action("upload") {
        if (state.selectedId != id) { note("会话已切换，请重新选择附件"); return@action }
        flushDraft()
        draftMutex.withLock {
            val result = requireNotNull(api).call("/conversations/${id.segment()}/draft/files", "POST", body = body)
            if (state.selectedId == id) state = state.copy(composer = state.composer.copy(files = result.objectValue("composerDraft").rows("files")))
        }
        note("附件已保存到服务器草稿")
    }

    fun transcribe(body: RequestBody, id: String, cleanup: () -> Unit = {}) {
        if (state.busy || state.connecting) { cleanup(); note("当前操作尚未结束，请稍后重新录音"); return }
        action("voice") {
            val value = try { requireNotNull(api).call("/transcriptions", "POST", body = body) } finally { cleanup() }
            if (state.selectedId != id) { note("会话已切换，转写结果：${value.text("text")}"); return@action }
            changeText(listOf(state.composer.content, value.text("text")).filter { it.isNotBlank() }.joinToString("\n"))
            note("转写已回填，请确认后发送")
        }
    }

    fun removeAttachment(fileId: String) = action {
        val result = requireNotNull(api).call("${state.conversationPath}/draft/files/${fileId.segment()}", "DELETE")
        state = state.copy(composer = state.composer.copy(files = result.optJSONObject("composerDraft")?.rows("files").orEmpty()))
    }

    private suspend fun reconcile(id: String, syncDraft: Boolean = false) {
        val generation = epoch
        val account = accountKey()
        val detail = try { get("/conversations/${id.segment()}") }
        catch (reason: Exception) {
            if (reason is ApiFailure && reason.status in listOf(401, 403, 404)) {
                if (state.selectedId == id && generation == epoch) {
                    disconnectStream()
                    state = state.copy(selectedId = null, detail = null, composer = Composer(), detailFromCache = false)
                }
                discardCache(account, "detail:$id")
            }
            throw reason
        }
        if (state.selectedId != id || generation != epoch) return
        saveCache(accountKey(), "detail:$id", detail)
        val oldMessages = state.detail?.rows("messages").orEmpty()
        val fresh = detail.rows("messages")
        val first = fresh.firstOrNull()
        val older = if (first != null && oldMessages.any { it.text("id") == first.text("id") })
            oldMessages.takeWhile { it.text("id") != first.text("id") } else emptyList()
        val messages = if (older.isNotEmpty()) older + fresh else fresh
        val previousPage = state.detail?.objectValue("messagePage")
        val previousJob = state.detail?.optJSONObject("activeJob")?.text("id") ?: state.detail?.optJSONObject("latestJob")?.text("id")
        val freshJob = detail.optJSONObject("activeJob")?.text("id") ?: detail.optJSONObject("latestJob")?.text("id")
        val events = if (previousJob != null && previousJob == freshJob) mergeEvents(state.detail?.rows("jobEvents").orEmpty(), detail.rows("jobEvents"))
            else detail.rows("jobEvents").takeLast(200)
        val nextDetail = detail.changed("jobEvents" to events.jsonArray())
        val serverDraft = Composer.from(detail.optJSONObject("composerDraft"))
        val composer = if (state.sendUncertain || state.busy && !syncDraft) state.composer
            else if (state.composer.dirty) state.composer.copy(files = serverDraft.files)
            else serverDraft.copy(revision = state.composer.revision)
        state = state.copy(detail = if (messages === fresh) nextDetail else nextDetail.changed("messages" to messages.jsonArray(), "messagePage" to previousPage),
            composer = composer, connection = "已连接", detailFromCache = false)
        connectStream()
    }

    fun loadOlder() = action {
        val id = state.selectedId ?: return@action
        val cursor = state.detail?.objectValue("messagePage")?.text("nextCursor").orEmpty()
        if (cursor.isBlank()) return@action
        val result = get("${state.conversationPath}/messages?before=${cursor.segment()}")
        if (state.selectedId == id) state = state.copy(detail = state.detail?.changed(
            "messages" to (result.rows("messages") + state.detail?.rows("messages").orEmpty()).distinctBy { it.text("id") }.jsonArray(),
            "messagePage" to result.objectValue("messagePage")))
    }

    fun mutate(path: String, method: String = "POST", payload: JSONObject? = null, body: RequestBody? = null,
               after: (suspend (JSONObject) -> Unit)? = null) = action {
        val result = requireNotNull(api).call(path, method, payload, body)
        if (path.startsWith("/preset-prompts") || path.startsWith("/providers") || path.startsWith("/task-categories")) refreshCatalogs()
        if (path == "/user-settings/provider-management") {
            state = state.copy(session = get("/auth/session"))
        }
        if (path == "/auth/account") {
            api?.csrf = result.text("csrfToken")
            state = state.copy(session = result)
        }
        if (after != null) after(result) else {
            state.selectedId?.let { id -> reconcile(id, syncDraft = true) }
            if (state.page != null) loadPage()
            refreshList()
        }
    }

    fun updateSelection(value: JSONObject) = action {
        requireNotNull(api).call("${state.conversationPath}/agent-selection", "PUT", value)
        state.selectedId?.let { reconcile(it) }
    }

    fun editPrompt(prompt: JSONObject, text: String, pending: Boolean, removedIds: List<String> = emptyList(), newFiles: List<UploadPart> = emptyList()) = action {
        require(prompt.rows("files").size - removedIds.size + newFiles.size <= 12) { "一条指令最多 12 个附件" }
        val path = if (pending) "pending-prompts" else "messages"
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("message", text).addFormDataPart("removedFileIds", removedIds.jsonArray().toString())
            .addFormDataPart("quoteExcerpt", prompt.text("quote_excerpt"))
            .addFormDataPart("sourceReference", prompt.optJSONObject("source_reference")?.toString() ?: "null")
            .apply { newFiles.forEach { addFormDataPart("files", it.name, it.body) } }.build()
        val result = requireNotNull(api).call("${state.conversationPath}/$path/${prompt.text("id").segment()}", "PUT", body = body)
        if (result.optBoolean("needsInstruction")) note(result.text("guidance", "请补充指令"))
        state.selectedId?.let { id ->
            state = state.copy(detail = null)
            reconcile(id)
        }
        if (state.page != null) loadPage()
    }

    fun beginPendingEdit(prompt: JSONObject, ready: (JSONObject) -> Unit) = action {
        val result = requireNotNull(api).call("${state.conversationPath}/pending-prompts/${prompt.text("id").segment()}/edit", "POST")
        state.selectedId?.let { reconcile(it) }
        ready(result.objectValue("editingPrompt"))
    }

    fun reorder(promptId: String, direction: Int) = action {
        val ids = state.detail?.rows("pendingPrompts").orEmpty().map { it.text("id") }.toMutableList()
        val position = ids.indexOf(promptId)
        val target = position + direction
        if (position < 0 || target !in ids.indices) return@action
        java.util.Collections.swap(ids, position, target)
        requireNotNull(api).call("${state.conversationPath}/pending-prompts/order", "PUT", json("ids" to ids.jsonArray()))
        state.selectedId?.let { reconcile(it) }
    }

    fun navigate(page: ToolPage) {
        state.page?.let { pages.addLast(it) }
        state = state.copy(page = page, pageData = null, error = null)
        viewModelScope.launch { try { loadPage() } catch (reason: Exception) { error(reason) } }
    }

    private suspend fun loadPage() {
        val page = state.page ?: return
        val generation = ++pageGeneration
        state = state.copy(pageLoading = true)
        try {
            val result = if (page.path.isEmpty()) JSONObject() else get(page.path)
            if (generation == pageGeneration && state.page == page) state = state.copy(pageData = result)
        } finally { if (generation == pageGeneration) state = state.copy(pageLoading = false) }
    }

    fun back(): Boolean {
        if (state.busy) return true
        if (state.page != null) {
            pageGeneration++
            val previous = pages.removeLastOrNull()
            state = state.copy(page = previous, pageData = null, pageLoading = false)
            if (previous != null) viewModelScope.launch { try { loadPage() } catch (reason: Exception) { error(reason) } }
            return true
        }
        if (state.selectedId != null) {
            action {
                try { withTimeout(2500) { flushDraft() } }
                catch (reason: Exception) {
                    if (reason is CancellationException && reason !is TimeoutCancellationException) throw reason
                    backupJob?.join()
                    note("草稿已留在本机，重新打开任务后同步")
                }
                val parent = parents.removeLastOrNull()
                if (parent != null) openInternal(parent)
                else { disconnectStream(); state = state.copy(selectedId = null, detail = null, composer = Composer(), sendUncertain = false); runCatching { refreshList() } }
            }
            return true
        }
        return false
    }

    fun openSide(id: String) = action {
        flushDraft()
        requireNotNull(api).call("/side-chats/${id.segment()}/open", "POST")
        state.selectedId?.let { parents.addLast(it) }
        openInternal(id)
    }

    fun createSide(path: String, payload: JSONObject? = null) = action {
        flushDraft()
        val result = requireNotNull(api).call(path, "POST", payload)
        state.selectedId?.let { parents.addLast(it) }
        openInternal(result.objectValue("conversation").text("id"))
    }

    fun archiveOrDelete(delete: Boolean) = action {
        flushDraft()
        requireNotNull(api).call(state.conversationPath + if (delete) "" else "/archive", if (delete) "DELETE" else "POST")
        state.selectedId?.let { discardCache(accountKey(), "detail:$it") }
        disconnectStream()
        pages.clear()
        state = state.copy(selectedId = null, detail = null, composer = Composer(), page = null)
        refreshList()
    }

    fun logout() = action {
        flushDraft()
        requireNotNull(api).call("/auth/logout", "POST")
        api?.clearCredentials()
        epoch++
        disconnectStream()
        polling?.cancel()
        state = NativeState(server = state.server, theme = state.theme, fontSize = state.fontSize)
    }

    fun changeServer() = action {
        flushDraft()
        requireNotNull(api).call("/auth/logout", "POST")
        api?.clearCredentials()
        api?.close()
        api = null
        epoch++
        disconnectStream()
        polling?.cancel()
        withContext(Dispatchers.IO) { store.write("server", null) }
        state = NativeState(theme = state.theme, fontSize = state.fontSize)
    }

    fun appearance(theme: String = state.theme, font: Int = state.fontSize) {
        state = state.copy(theme = theme, fontSize = font.coerceIn(12, 24))
        viewModelScope.launch(Dispatchers.IO) { store.write("theme", theme); store.write("font", font.toString()) }
    }
    fun voiceModel(value: String) { state = state.copy(voiceModel = value) }

    suspend fun download(path: String) = requireNotNull(api).download(path)

    fun foreground(active: Boolean) {
        foreground = active
        if (active) startPolling()
        else {
            polling?.cancel()
            disconnectStream()
            viewModelScope.launch { runCatching { flushDraft() } }
        }
    }

    private fun startPolling() {
        polling?.cancel()
        if (!foreground || !state.authenticated) return
        polling = viewModelScope.launch {
            while (foreground && state.authenticated) {
                try {
                    if (!state.busy) {
                        state.selectedId?.let { reconcile(it) }
                        refreshList()
                        flushDraft()
                    }
                } catch (reason: Exception) {
                    if (reason is CancellationException) throw reason
                    if (reason is ApiFailure && reason.status == 401) error(reason)
                    else state = state.copy(connection = "连接中断 · 自动重试中")
                }
                delay(if (state.activeJob != null) 5000 else 15000)
            }
        }
    }

    private fun disconnectStream() {
        streamGeneration++
        streamJob = ""
        stream?.close()
        stream = null
        lastSequence = 0
    }

    private fun connectStream() {
        if (!foreground) return
        val job = state.activeJob?.text("id").orEmpty()
        if (job == streamJob && stream != null) return
        disconnectStream()
        if (job.isBlank()) return
        streamJob = job
        lastSequence = state.detail?.rows("jobEvents").orEmpty().maxOfOrNull { it.optLong("seq") } ?: 0
        val generation = epoch
        val connectionGeneration = streamGeneration
        stream = api?.events(job, lastSequence, { event, sequence ->
            viewModelScope.launch {
                if (generation != epoch || connectionGeneration != streamGeneration || streamJob != job || sequence > 0 && sequence <= lastSequence) return@launch
                lastSequence = maxOf(lastSequence, sequence)
                val events = (state.detail?.rows("jobEvents").orEmpty() + event.changed("seq" to sequence)).takeLast(200)
                state = state.copy(detail = state.detail?.changed("jobEvents" to events.jsonArray()), connection = "实时已连接")
                if (event.text("type") == "context_usage") state = state.copy(detail = state.detail?.changed("contextUsage" to json("usedTokens" to event.optLong("usedTokens"), "contextWindow" to event.opt("contextWindow"))))
                if (event.text("type") in listOf("done", "failed")) {
                    disconnectStream()
                    try { state.selectedId?.let { reconcile(it) }; refreshList() } catch (reason: Exception) { error(reason) }
                }
            }
        }, { message -> viewModelScope.launch {
            if (generation == epoch && connectionGeneration == streamGeneration && streamJob == job) { disconnectStream(); state = state.copy(connection = message) }
        } })
    }

    override fun onCleared() { disconnectStream(); api?.close() }
}
