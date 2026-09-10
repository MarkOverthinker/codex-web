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
    private data class DraftWriteId(val key: String, val generation: Int)
    private val draftWriteFailures = mutableMapOf<DraftWriteId, Throwable>()
    private var pageGeneration = 0
    private val pages = ArrayDeque<ToolPage>()
    private val parents = ArrayDeque<String>()
    private val cache = SnapshotCache(store)
    private val exitTimeoutMs = 2500L
    private fun accountKey() = "${state.server}:${state.session?.text("username")}"
    private fun draftKey(account: String, id: String) = "draft:$account:$id"
    private fun lastConversationKey() = "last-conversation:${accountKey()}"

    private fun draftBackup(composer: Composer, uncertain: Boolean = false, uncertainRevision: Long? = null): JSONObject =
        composer.payload().changed("files" to composer.files.jsonArray(), "revision" to composer.revision,
            "sendUncertain" to uncertain, "uncertainRevision" to uncertainRevision)

    private fun hasLocalDraft(composer: Composer, uncertain: Boolean = false): Boolean =
        uncertain || composer.dirty || composer.content.isNotEmpty() || composer.quote.isNotEmpty() ||
            composer.source != null || composer.files.isNotEmpty()

    private fun backupUncertainRevision(backup: JSONObject?): Long? = backup?.takeIf { it.optBoolean("sendUncertain") }?.let {
        if (it.has("uncertainRevision") && !it.isNull("uncertainRevision")) it.optLong("uncertainRevision")
        else it.optLong("revision")
    }

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

    private fun expireSession(reason: ApiFailure, expectedEpoch: Int) {
        if (expectedEpoch != epoch) return
        val account = accountKey()
        val server = state.server
        val id = state.selectedId ?: "_new"
        val composer = state.composer
        val keepDraft = hasLocalDraft(composer, state.sendUncertain)
        val localDraftKey = draftKey(account, id)
        val localDraftJob = if (keepDraft) queueBackup(localDraftKey,
            draftBackup(composer, state.sendUncertain, state.uncertainRevision).toString(), expectedEpoch) else null
        epoch++
        val expiredEpoch = epoch
        debounce?.cancel()
        debounce = null
        polling?.cancel()
        polling = null
        disconnectStream()
        val credentialFailure = runCatching { api?.clearCredentials() }.exceptionOrNull()
        pages.clear()
        parents.clear()
        pageGeneration++
        state = state.copy(
            session = null,
            connecting = false,
            conversations = emptyList(),
            selectedId = null,
            detail = null,
            composer = Composer(),
            options = JSONObject(),
            presets = emptyList(),
            categorySettings = JSONObject(),
            workingDirs = JSONObject(),
            page = null,
            pageData = null,
            pageLoading = false,
            pageError = null,
            busy = false,
            operation = null,
            connection = if (keepDraft) "登录已失效，本机草稿正在保存" else "登录已失效",
            draftStatus = if (keepDraft) "正在保存本机草稿…" else "",
            sendUncertain = false,
            uncertainRevision = null,
            detailFromCache = false,
            parentAvailable = false,
            notice = null,
            error = if (credentialFailure == null) reason.message
                else "${reason.message}；本机凭证清理未确认，请重启应用后重试。",
        )
        if (keepDraft) {
            viewModelScope.launch {
                localDraftJob?.join()
                val failure = draftWriteFailures.remove(DraftWriteId(localDraftKey, expectedEpoch))
                if (epoch != expiredEpoch || state.authenticated || state.server != server) return@launch
                state = if (failure == null) state.copy(draftStatus = "本机草稿已保留", connection = "登录已失效，未发送内容已保留在本机")
                else state.copy(draftStatus = "本机草稿保存失败，请勿退出", connection = "登录已失效，本机草稿保存失败",
                    error = "本机草稿保存失败：${failure.message}")
            }
        }
    }

    private fun error(reason: Throwable, expectedEpoch: Int = epoch) {
        if (reason is CancellationException) throw reason
        if (expectedEpoch != epoch) return
        if (reason is ApiFailure && reason.status == 401) {
            expireSession(reason, expectedEpoch)
            return
        }
        state = state.copy(error = if (reason is ApiFailure) reason.message else reason.localizedMessage ?: "请求失败，请检查网络后重试。")
    }

    fun dismissError() { state = state.copy(error = null, notice = null) }
    fun note(message: String) { state = state.copy(notice = message) }

    fun connect(server: String, username: String? = null, password: String? = null) {
        if (state.connecting || state.busy) return
        val normalized = try { ServerPolicy.normalize(server) } catch (reason: Exception) { error(reason); return }
        val generation = ++epoch
        debounce?.cancel()
        debounce = null
        polling?.cancel()
        polling = null
        disconnectStream()
        state = state.copy(connecting = true, error = null)
        viewModelScope.launch {
            try {
                val oldServer = state.server
                if (oldServer != normalized || api == null) {
                    api?.close()
                    val nextApi = withContext(Dispatchers.IO) { apiFactory(normalized) }
                    if (generation != epoch) { nextApi.close(); return@launch }
                    api = nextApi
                    state = state.copy(server = normalized, selectedId = null, detail = null, composer = Composer(), page = null)
                }
                if (generation != epoch) return@launch
                val gateway = requireNotNull(api)
                val session = if (username != null) gateway.call("/auth/login", "POST", json("username" to username, "password" to password))
                    else gateway.call("/auth/session")
                if (generation != epoch) return@launch
                gateway.csrf = session.text("csrfToken")
                state = state.copy(session = session, connection = if (session.optBoolean("authenticated")) "已连接" else "请登录")
                withContext(Dispatchers.IO) { store.write("server", normalized) }
                if (generation != epoch) return@launch
                if (session.optBoolean("authenticated")) {
                    state = state.copy(selectedId = null, detail = null, page = null, composer = Composer(), conversations = emptyList(),
                        options = JSONObject(), presets = emptyList(), categorySettings = JSONObject(), workingDirs = JSONObject(), homeTab = HomeTab.Chat)
                    val account = accountKey()
                    cached(account, "conversations")?.let { if (generation == epoch) state = state.copy(conversations = it.rows("conversations")) }
                    if (generation != epoch) return@launch
                    state = state.copy(options = cached(account, "options") ?: JSONObject(), presets = cached(account, "presets")?.rows("presetPrompts").orEmpty(),
                        categorySettings = cached(account, "categories")?.objectValue("settings") ?: JSONObject(), workingDirs = cached(account, "directories")?.objectValue("settings") ?: JSONObject())
                    if (generation != epoch) return@launch
                    val last = withContext(Dispatchers.IO) { store.read(lastConversationKey()) }
                    if (generation != epoch) return@launch
                    val cachedId = last?.takeIf { it != "_new" } ?: state.conversations.firstOrNull()?.text("id").takeIf { last != "_new" }
                    if (cachedId != null) cached(account, "detail:$cachedId")?.let { detail ->
                        if (generation == epoch) state = state.copy(selectedId = cachedId, detail = detail, detailFromCache = true, connection = "本机缓存 · 正在更新")
                    }
                    refreshCatalogs(generation)
                    if (generation != epoch) return@launch
                    runCatching { refreshList(generation) }.onFailure { if (it is CancellationException || it is ApiFailure && it.status == 401) throw it }
                    if (generation != epoch) return@launch
                    val saved = withContext(Dispatchers.IO) { store.read(lastConversationKey()) }
                    val selected = saved?.takeIf { it != "_new" && state.conversations.any { row -> row.text("id") == it } }
                        ?: state.conversations.firstOrNull()?.text("id").takeIf { saved != "_new" }
                    if (selected != null) openInternal(selected, generation) else restoreNewChat(generation)
                    if (generation == epoch) startPolling()
                }
            } catch (reason: Exception) { error(reason, generation) }
            finally { if (generation == epoch) state = state.copy(connecting = false) }
        }
    }

    suspend fun get(path: String): JSONObject {
        val generation = epoch
        return try { requireNotNull(api).call(path) }
        catch (reason: Exception) {
            if (reason is CancellationException) throw reason
            if (reason is ApiFailure && reason.status == 401) error(reason, generation)
            throw reason
        }
    }

    private suspend fun refreshCatalogs(generation: Int = epoch) {
        val nextOptions = catalog("options", "/agent-options", generation)
        if (generation != epoch) return
        state = state.copy(options = nextOptions)
        val nextPresets = catalog("presets", "/preset-prompts", generation).rows("presetPrompts")
        if (generation != epoch) return
        state = state.copy(presets = nextPresets)
        val nextCategories = catalog("categories", "/task-categories", generation).objectValue("settings")
        if (generation != epoch) return
        state = state.copy(categorySettings = nextCategories)
        val nextDirectories = catalog("directories", "/working-dirs", generation).objectValue("settings")
        if (generation == epoch) state = state.copy(workingDirs = nextDirectories)
    }

    private suspend fun catalog(key: String, path: String, generation: Int = epoch): JSONObject {
        val account = accountKey()
        return try { get(path).also { if (generation == epoch) saveCache(account, key, it) } }
        catch (reason: Exception) {
            if (reason is CancellationException || reason is ApiFailure && reason.status == 401) throw reason
            cached(account, key) ?: throw reason
        }
    }

    private suspend fun refreshList(generation: Int = epoch) {
        if (generation != epoch) return
        val account = accountKey()
        val result = get("/conversations")
        if (generation == epoch) {
            state = state.copy(conversations = result.rows("conversations"))
            saveCache(account, "conversations", result)
        }
    }

    fun refresh() = action("refresh") { generation ->
        refreshList(generation)
        if (generation != epoch) return@action
        state.selectedId?.let { reconcile(it, generation) }
        if (generation != epoch) return@action
        if (state.page != null) loadPage(generation)
    }

    fun action(operation: String = "request", block: suspend (Int) -> Unit) {
        if (state.busy || state.connecting) return
        val generation = epoch
        state = state.copy(busy = true, error = null, operation = operation)
        viewModelScope.launch {
            try { block(generation) } catch (reason: Exception) { error(reason, generation) }
            finally {
                if (generation == epoch && state.operation == operation) state = state.copy(busy = false, operation = null)
            }
        }
    }

    fun createConversation(workingDir: String? = null) = action("new") { generation ->
        flushDraft(generation)
        if (generation != epoch) return@action
        val value = requireNotNull(api).call("/conversations", "POST", if (workingDir == null) JSONObject() else json("workingDir" to workingDir))
        if (generation != epoch) return@action
        openInternal(value.objectValue("conversation").text("id"), generation)
        refreshList(generation)
    }

    fun openConversation(id: String) = action("open") { generation ->
        flushDraft(generation)
        if (generation != epoch) return@action
        parents.clear()
        openInternal(id, generation)
    }

    fun selectTab(tab: HomeTab) {
        pages.clear()
        pageGeneration++
        state = state.copy(homeTab = tab, page = null, pageData = null, pageLoading = false)
    }

    private suspend fun restoreNewChat(generation: Int = epoch) {
        if (generation != epoch) return
        val account = accountKey()
        val saved = withContext(Dispatchers.IO) { store.read(draftKey(account, "_new")) }?.let { runCatching { JSONObject(it) }.getOrNull() }
        if (generation != epoch) return
        disconnectStream()
        pages.clear()
        parents.clear()
        pageGeneration++
        val recovered = saved?.let { backup -> Composer(content = backup.text("content"), quote = backup.text("quoteExcerpt"),
            source = backup.optJSONObject("sourceReference"), files = backup.rows("files"), dirty = true,
            revision = backup.optLong("revision")) } ?: Composer()
        state = state.copy(selectedId = null, detail = null, page = null, pageData = null, pageLoading = false,
            homeTab = HomeTab.Chat, detailFromCache = false, parentAvailable = false, sendUncertain = false,
            uncertainRevision = null, composer = recovered,
            draftStatus = if (saved != null) "本机草稿" else "")
    }

    fun startNewChat() = action("new") { generation ->
        flushDraft(generation)
        backupJob?.join()
        if (generation != epoch) return@action
        restoreNewChat(generation)
        if (generation != epoch) return@action
        val lastKey = lastConversationKey()
        withContext(Dispatchers.IO) { store.write(lastKey, "_new") }
    }

    private suspend fun ensureConversation(expectedEpoch: Int = epoch): String {
        if (expectedEpoch != epoch) throw CancellationException("会话已改变")
        state.selectedId?.let { return it }
        val snapshot = state.composer
        val created = requireNotNull(api).call("/conversations", "POST", JSONObject()).objectValue("conversation").text("id")
        require(created.isNotBlank())
        if (expectedEpoch != epoch) throw CancellationException("会话已改变")
        val account = accountKey()
        val lastKey = lastConversationKey()
        backupJob?.join()
        withContext(Dispatchers.IO) {
            store.write(draftKey(account, created), draftBackup(snapshot).toString())
            store.write(lastKey, created)
            store.write(draftKey(account, "_new"), null)
        }
        openInternal(created, expectedEpoch)
        refreshList(expectedEpoch)
        return created
    }

    fun withConversation(callback: () -> Unit) = action("prepare") { generation ->
        ensureConversation(generation)
        if (generation == epoch) callback()
    }

    fun clearCache() = action("cache") { generation ->
        val account = accountKey()
        cache.clear(account)
        if (generation == epoch) note("浏览缓存已清理，未发送草稿保留")
    }

    private suspend fun openInternal(id: String, expectedEpoch: Int? = null) {
        require(id.isNotBlank())
        val generation = expectedEpoch ?: epoch
        if (generation != epoch) return
        backupJob?.join()
        if (generation != epoch) return
        val account = accountKey()
        val cached = cached(account, "detail:$id")
        val backup = withContext(Dispatchers.IO) { store.read(draftKey(account, id)) }?.let { runCatching { JSONObject(it) }.getOrNull() }
        if (generation != epoch) return
        disconnectStream()
        pages.clear()
        pageGeneration++
        val cachedComposer = Composer.from(cached?.optJSONObject("composerDraft"))
        if (cached != null) state = state.copy(selectedId = id, detail = cached, page = null, pageData = null, pageLoading = false,
            homeTab = HomeTab.Chat, detailFromCache = true, parentAvailable = parents.isNotEmpty(),
            composer = if (backup == null) cachedComposer else cachedComposer.copy(content = backup.text("content"), quote = backup.text("quoteExcerpt"),
                source = backup.optJSONObject("sourceReference"), files = if (backup.has("files")) backup.rows("files") else cachedComposer.files,
                dirty = true, revision = backup.optLong("revision") + 1), connection = "本机缓存 · 正在更新",
            sendUncertain = backup?.optBoolean("sendUncertain") == true,
            uncertainRevision = backupUncertainRevision(backup))
        val detail = try { get("/conversations/${id.segment()}") }
        catch (reason: Exception) {
            if (reason is CancellationException) throw reason
            if (generation != epoch) return
            if (reason is ApiFailure && reason.status in listOf(401, 403, 404)) {
                state = state.copy(selectedId = null, detail = null, composer = Composer(), detailFromCache = false)
                discardCache(account, "detail:$id")
                throw reason
            }
            if (cached == null) throw reason
            state = state.copy(connection = "离线 · 浏览缓存", draftStatus = "仅存本机 · 联网后可发送")
            return
        }
        if (generation != epoch) return
        saveCache(account, "detail:$id", detail)
        if (generation != epoch) return
        val composer = Composer.from(detail.optJSONObject("composerDraft"))
        disconnectStream()
        pages.clear()
        pageGeneration++
        val recovered = backup?.let { composer.copy(content = it.text("content"), quote = it.text("quoteExcerpt"),
            source = it.optJSONObject("sourceReference"), files = if (it.has("files")) it.rows("files") else composer.files,
            dirty = true, revision = it.optLong("revision") + 1) } ?: composer
        state = state.copy(selectedId = id, detail = detail, composer = recovered, page = null, pageData = null,
            draftStatus = if (backup != null) "已恢复本机未同步草稿" else "", connection = "已连接", sendUncertain = backup?.optBoolean("sendUncertain") == true,
            uncertainRevision = backupUncertainRevision(backup),
            homeTab = HomeTab.Chat, detailFromCache = false, pageLoading = false, parentAvailable = parents.isNotEmpty())
        if (parents.isEmpty()) withContext(Dispatchers.IO) { store.write(lastConversationKey(), id) }
        try { requireNotNull(api).call("/conversations/${id.segment()}/seen", "POST") }
        catch (reason: Exception) {
            if (reason is CancellationException) throw reason
            if (reason is ApiFailure && reason.status == 401) error(reason, generation) else Unit
            if (generation != epoch) return
        }
        if (generation != epoch) return
        connectStream()
        if (recovered.dirty) scheduleDraft()
    }

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
        val generation = epoch
        val account = accountKey()
        val id = state.selectedId ?: "_new"
        val snapshot = state.composer
        val key = draftKey(account, id)
        queueBackup(key, draftBackup(snapshot, state.sendUncertain, state.uncertainRevision).toString(), generation)
        if (id == "_new" || state.detailFromCache) { state = state.copy(draftStatus = "本机草稿"); return }
        debounce = viewModelScope.launch {
            delay(700)
            try { flushDraft(generation) }
            catch (reason: Exception) {
                if (reason is CancellationException) throw reason
                error(reason, generation)
                if (generation == epoch && !(reason is ApiFailure && reason.status == 401)) {
                    state = state.copy(draftStatus = "仅存本机 · 等待重连", connection = "离线或登录过期")
                }
            }
        }
    }

    private fun queueBackup(key: String, value: String?, generation: Int = epoch): Job {
        val preceding = backupJob
        val writeId = DraftWriteId(key, generation)
        val job = viewModelScope.launch {
            preceding?.join()
            try {
                withContext(Dispatchers.IO) { store.write(key, value) }
                draftWriteFailures.remove(writeId)
            }
            catch (reason: Exception) {
                if (reason is CancellationException) throw reason
                draftWriteFailures[writeId] = reason
                if (generation == epoch) state = state.copy(draftStatus = "本机保存失败，请勿退出", error = "本机草稿保存失败：${reason.message}")
            }
        }
        backupJob = job
        return job
    }

    private suspend fun syncDraftLocked(id: String, snapshot: Composer, generation: Int): JSONObject {
        if (generation != epoch) throw CancellationException("会话已改变")
        val account = accountKey()
        val key = draftKey(account, id)
        if (state.selectedId == id) state = state.copy(draftStatus = "正在同步…")
        val response = requireNotNull(api).call("/conversations/${id.segment()}/draft", "PUT", snapshot.payload())
        if (generation == epoch && state.selectedId == id && state.composer.revision == snapshot.revision) {
            state = state.copy(composer = snapshot.copy(dirty = false,
                files = response.optJSONObject("composerDraft")?.rows("files").orEmpty()), draftStatus = "已同步")
            queueBackup(key, null, generation)
        }
        return response
    }

    private suspend fun flushDraft(expectedEpoch: Int = epoch) = draftMutex.withLock {
        if (expectedEpoch != epoch) return@withLock
        if (state.detailFromCache) { backupJob?.join(); return@withLock }
        val id = state.selectedId ?: return@withLock
        val snapshot = state.composer
        if (!snapshot.dirty || state.sendUncertain) return@withLock
        syncDraftLocked(id, snapshot, expectedEpoch)
    }

    fun send() {
        if (state.detailFromCache) { note("当前为本机缓存，请联网刷新后发送。"); return }
        if (state.sendUncertain) { note("上次发送结果尚未确认，请先核对消息和队列。 "); return }
        if (state.composer.content.isBlank() && state.composer.files.isEmpty()) return
        action("send") { generation ->
            debounce?.cancel()
            debounce = null
            val id = ensureConversation(generation)
            draftMutex.withLock {
                if (generation != epoch) return@withLock
                val snapshot = state.composer
                if (snapshot.content.isBlank() && snapshot.files.isEmpty()) return@withLock
                val draftResponse = syncDraftLocked(id, snapshot, generation)
                val serverFiles = draftResponse.optJSONObject("composerDraft")?.rows("files").orEmpty()
                if (serverFiles.map { it.text("id") } != snapshot.files.map { it.text("id") }) {
                    throw java.io.IOException("附件状态已改变，请刷新后重试；未发送消息。")
                }
                val body = MultipartBody.Builder().setType(MultipartBody.FORM)
                    .addFormDataPart("message", snapshot.content).addFormDataPart("quoteExcerpt", snapshot.quote)
                    .addFormDataPart("useComposerDraft", "true")
                    .apply { snapshot.source?.let { addFormDataPart("sourceReference", it.toString()) } }.build()
                val result = try { requireNotNull(api).call("/conversations/${id.segment()}/messages", "POST", body = body) }
                catch (reason: Exception) {
                    if (reason is CancellationException) throw reason
                    if (reason is ApiFailure && reason.status == 401) throw reason
                    val account = accountKey()
                    val definitiveClientFailure = reason is ApiFailure && reason.status in 400..499
                    if (!definitiveClientFailure) {
                        val current = if (state.selectedId == id) state.composer else snapshot
                        val uncertain = current.copy(dirty = true)
                        state = state.copy(composer = uncertain, sendUncertain = true,
                            uncertainRevision = snapshot.revision, draftStatus = "发送结果待确认 · 仅存本机")
                        queueBackup(draftKey(account, id), draftBackup(uncertain, true, snapshot.revision).toString(), generation)
                    }
                    if (generation == epoch) runCatching { reconcile(id, generation) }
                    if (generation != epoch) throw reason
                    if (definitiveClientFailure) {
                        val current = if (state.selectedId == id) state.composer else snapshot
                        state = state.copy(composer = current.copy(dirty = true), sendUncertain = false, uncertainRevision = null,
                            draftStatus = "发送未完成，请检查后重试")
                        queueBackup(draftKey(account, id), draftBackup(state.composer).toString(), generation)
                        throw reason
                    }
                    throw java.io.IOException("发送未确认：${reason.message}。请先刷新核对消息和队列，避免重复发送。")
                }
                if (generation != epoch) return@withLock
                if (result.optBoolean("needsInstruction")) {
                    note(result.text("guidance", "请补充指令"))
                } else if (state.selectedId == id && snapshot.revision == state.composer.revision) {
                    state = state.copy(composer = Composer(), draftStatus = "", sendUncertain = false, uncertainRevision = null)
                    queueBackup(draftKey(accountKey(), id), null, generation)
                }
            }
            if (generation == epoch) {
                reconcile(id, generation)
                refreshList(generation)
            }
        }
    }

    fun resolveUncertainSend(received: Boolean) = action { generation ->
        if (generation != epoch) return@action
        val id = state.selectedId ?: return@action
        val current = state.composer
        val sentRevision = state.uncertainRevision
        val hasNewerInput = sentRevision != null && current.revision != sentRevision
        val draft = if (received && !hasNewerInput) Composer.from(state.detail?.optJSONObject("composerDraft")) else current.copy(dirty = true)
        state = state.copy(sendUncertain = false, uncertainRevision = null, composer = draft, draftStatus = "")
        if (generation != epoch) return@action
        if (received && !hasNewerInput) queueBackup(draftKey(accountKey(), id), null, generation)
        else scheduleDraft()
    }

    fun upload(body: RequestBody, id: String) = action("upload") { generation ->
        if (state.selectedId != id) { note("会话已切换，请重新选择附件"); return@action }
        flushDraft(generation)
        if (generation != epoch || state.selectedId != id) return@action
        draftMutex.withLock {
            val result = requireNotNull(api).call("/conversations/${id.segment()}/draft/files", "POST", body = body)
            if (generation != epoch || state.selectedId != id) return@withLock
            state = state.copy(composer = state.composer.copy(files = result.objectValue("composerDraft").rows("files")))
        }
        if (generation == epoch) note("附件已保存到服务器草稿")
    }

    fun transcribe(body: RequestBody, id: String, cleanup: () -> Unit = {}) {
        if (state.busy || state.connecting) { cleanup(); note("当前操作尚未结束，请稍后重新录音"); return }
        action("voice") { generation ->
            val value = try { requireNotNull(api).call("/transcriptions", "POST", body = body) } finally { cleanup() }
            if (generation != epoch) return@action
            if (state.selectedId != id) { note("会话已切换，转写结果：${value.text("text")}"); return@action }
            changeText(listOf(state.composer.content, value.text("text")).filter { it.isNotBlank() }.joinToString("\n"))
            note("转写已回填，请确认后发送")
        }
    }

    fun removeAttachment(fileId: String) = action { generation ->
        val id = state.selectedId ?: return@action
        val path = "${state.conversationPath}/draft/files/${fileId.segment()}"
        val result = requireNotNull(api).call(path, "DELETE")
        if (generation == epoch && state.selectedId == id) {
            state = state.copy(composer = state.composer.copy(files = result.optJSONObject("composerDraft")?.rows("files").orEmpty()))
        }
    }

    private suspend fun reconcile(id: String, expectedEpoch: Int = epoch, syncDraft: Boolean = false) {
        val generation = expectedEpoch
        if (generation != epoch) return
        val account = accountKey()
        val detail = try { get("/conversations/${id.segment()}") }
        catch (reason: Exception) {
            if (generation != epoch) return
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
        saveCache(account, "detail:$id", detail)
        if (state.selectedId != id || generation != epoch) return
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

    fun loadOlder() = action { generation ->
        val id = state.selectedId ?: return@action
        val cursor = state.detail?.objectValue("messagePage")?.text("nextCursor").orEmpty()
        if (cursor.isBlank()) return@action
        val result = get("${state.conversationPath}/messages?before=${cursor.segment()}")
        if (generation == epoch && state.selectedId == id) state = state.copy(detail = state.detail?.changed(
            "messages" to (result.rows("messages") + state.detail?.rows("messages").orEmpty()).distinctBy { it.text("id") }.jsonArray(),
            "messagePage" to result.objectValue("messagePage")))
    }

    fun mutate(path: String, method: String = "POST", payload: JSONObject? = null, body: RequestBody? = null,
               after: (suspend (JSONObject) -> Unit)? = null) = action { generation ->
        val result = requireNotNull(api).call(path, method, payload, body)
        if (generation != epoch) return@action
        if (path.startsWith("/preset-prompts") || path.startsWith("/providers") || path.startsWith("/task-categories")) refreshCatalogs(generation)
        if (generation != epoch) return@action
        if (path == "/user-settings/provider-management") {
            val session = get("/auth/session")
            if (generation != epoch) return@action
            state = state.copy(session = session)
        }
        if (path == "/auth/account") {
            api?.csrf = result.text("csrfToken")
            state = state.copy(session = result)
        }
        if (generation != epoch) return@action
        if (after != null) after(result) else {
            state.selectedId?.let { id -> reconcile(id, generation, syncDraft = true) }
            if (generation != epoch) return@action
            if (state.page != null) loadPage(generation)
            if (generation != epoch) return@action
            refreshList(generation)
        }
    }

    fun updateSelection(value: JSONObject) = action { generation ->
        val id = state.selectedId ?: return@action
        requireNotNull(api).call("${state.conversationPath}/agent-selection", "PUT", value)
        if (generation == epoch && state.selectedId == id) reconcile(id, generation)
    }

    fun editPrompt(prompt: JSONObject, text: String, pending: Boolean, removedIds: List<String> = emptyList(), newFiles: List<UploadPart> = emptyList()) = action { generation ->
        require(prompt.rows("files").size - removedIds.size + newFiles.size <= 12) { "一条指令最多 12 个附件" }
        val path = if (pending) "pending-prompts" else "messages"
        val id = state.selectedId ?: return@action
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("message", text).addFormDataPart("removedFileIds", removedIds.jsonArray().toString())
            .addFormDataPart("quoteExcerpt", prompt.text("quote_excerpt"))
            .addFormDataPart("sourceReference", prompt.optJSONObject("source_reference")?.toString() ?: "null")
            .apply { newFiles.forEach { addFormDataPart("files", it.name, it.body) } }.build()
        val result = requireNotNull(api).call("/conversations/${id.segment()}/$path/${prompt.text("id").segment()}", "PUT", body = body)
        if (generation != epoch || state.selectedId != id) return@action
        if (result.optBoolean("needsInstruction")) note(result.text("guidance", "请补充指令"))
        state = state.copy(detail = null)
        reconcile(id, generation)
        if (generation != epoch) return@action
        if (state.page != null) loadPage(generation)
    }

    fun beginPendingEdit(prompt: JSONObject, ready: (JSONObject) -> Unit) = action { generation ->
        val id = state.selectedId ?: return@action
        val result = requireNotNull(api).call("${state.conversationPath}/pending-prompts/${prompt.text("id").segment()}/edit", "POST")
        if (generation != epoch || state.selectedId != id) return@action
        reconcile(id, generation)
        if (generation == epoch && state.selectedId == id) ready(result.objectValue("editingPrompt"))
    }

    fun reorder(promptId: String, direction: Int) = action { generation ->
        val id = state.selectedId ?: return@action
        val ids = state.detail?.rows("pendingPrompts").orEmpty().map { it.text("id") }.toMutableList()
        val position = ids.indexOf(promptId)
        val target = position + direction
        if (position < 0 || target !in ids.indices) return@action
        java.util.Collections.swap(ids, position, target)
        requireNotNull(api).call("/conversations/${id.segment()}/pending-prompts/order", "PUT", json("ids" to ids.jsonArray()))
        if (generation == epoch && state.selectedId == id) reconcile(id, generation)
    }

    fun navigate(page: ToolPage, replace: Boolean = false) {
        // replace 用于“同一页面的筛选条件变化”（如 Review 范围/基准分支）：不压栈，返回时直接回到上一层
        if (!replace) state.page?.let { pages.addLast(it) }
        state = state.copy(page = page, pageData = null, pageError = null, error = null)
        viewModelScope.launch { loadPage() }
    }

    private suspend fun loadPage(expectedSessionGeneration: Int = epoch) {
        if (expectedSessionGeneration != epoch) return
        val page = state.page ?: return
        val generation = ++pageGeneration
        val sessionGeneration = expectedSessionGeneration
        state = state.copy(pageLoading = true, pageError = null)
        try {
            val result = if (page.path.isEmpty()) JSONObject() else get(page.path)
            if (sessionGeneration == epoch && generation == pageGeneration && state.page == page) state = state.copy(pageData = result)
        } catch (reason: Exception) {
            if (reason is CancellationException) throw reason
            // 401 表示登录整体失效，交给全局会话处理；其余页面读取失败在页内呈现，避免误当空数据。
            if (reason is ApiFailure && reason.status == 401) error(reason, sessionGeneration)
            else if (sessionGeneration == epoch && generation == pageGeneration) state = state.copy(pageError = reason.message ?: "读取失败，请检查网络后重试。")
        } finally { if (sessionGeneration == epoch && generation == pageGeneration) state = state.copy(pageLoading = false) }
    }

    fun back(): Boolean {
        if (state.busy) return true
        if (state.page != null) {
            pageGeneration++
            val previous = pages.removeLastOrNull()
            state = state.copy(page = previous, pageData = null, pageError = null, pageLoading = false)
            if (previous != null) viewModelScope.launch { loadPage() }
            return true
        }
        if (state.selectedId != null) {
            action { generation ->
                try { withTimeout(exitTimeoutMs) { flushDraft(generation) } }
                catch (reason: Exception) {
                    if (reason is CancellationException && reason !is TimeoutCancellationException) throw reason
                    if (reason is ApiFailure && reason.status == 401) throw reason
                    backupJob?.join()
                    note("草稿已留在本机，重新打开任务后同步")
                }
                if (generation != epoch) return@action
                val parent = parents.removeLastOrNull()
                if (parent != null) openInternal(parent, generation)
                else {
                    disconnectStream()
                    state = state.copy(selectedId = null, detail = null, composer = Composer(), sendUncertain = false, uncertainRevision = null)
                    runCatching { refreshList(generation) }
                }
            }
            return true
        }
        return false
    }

    fun openSide(id: String) = action { generation ->
        flushDraft(generation)
        if (generation != epoch) return@action
        requireNotNull(api).call("/side-chats/${id.segment()}/open", "POST")
        if (generation != epoch) return@action
        state.selectedId?.let { parents.addLast(it) }
        openInternal(id, generation)
    }

    fun createSide(path: String, payload: JSONObject? = null) = action { generation ->
        flushDraft(generation)
        if (generation != epoch) return@action
        val result = requireNotNull(api).call(path, "POST", payload)
        if (generation != epoch) return@action
        state.selectedId?.let { parents.addLast(it) }
        openInternal(result.objectValue("conversation").text("id"), generation)
    }

    fun archiveOrDelete(delete: Boolean) = action { generation ->
        val id = state.selectedId ?: return@action
        val account = accountKey()
        flushDraft(generation)
        if (generation != epoch || state.selectedId != id) return@action
        requireNotNull(api).call("/conversations/${id.segment()}" + if (delete) "" else "/archive", if (delete) "DELETE" else "POST")
        if (generation != epoch || state.selectedId != id) return@action
        discardCache(account, "detail:$id")
        if (generation != epoch || state.selectedId != id) return@action
        disconnectStream()
        pages.clear()
        state = state.copy(selectedId = null, detail = null, composer = Composer(), page = null, pageData = null, pageError = null,
            sendUncertain = false, uncertainRevision = null)
        refreshList(generation)
    }

    private suspend fun finishSessionExit(changeServer: Boolean, generation: Int) {
        val account = accountKey()
        val id = state.selectedId ?: "_new"
        val composer = state.composer
        var draftFailure: Throwable? = null
        var logoutFailure: Throwable? = null
        try { withTimeout(exitTimeoutMs) { flushDraft(generation) } }
        catch (reason: Exception) {
            if (reason is CancellationException && reason !is TimeoutCancellationException) throw reason
            draftFailure = reason
        }
        if (generation != epoch) return
        if (hasLocalDraft(state.composer, state.sendUncertain)) {
            queueBackup(draftKey(account, id), draftBackup(state.composer, state.sendUncertain, state.uncertainRevision).toString(), generation)
        } else if (hasLocalDraft(composer, state.sendUncertain)) {
            queueBackup(draftKey(account, id), draftBackup(composer, state.sendUncertain, state.uncertainRevision).toString(), generation)
        }
        backupJob?.join()
        val localDraftFailure = draftWriteFailures.remove(DraftWriteId(draftKey(account, id), generation))
        if (generation != epoch) return
        if (state.authenticated) {
            try { withTimeout(exitTimeoutMs) { requireNotNull(api).call("/auth/logout", "POST") } }
            catch (reason: Exception) {
                if (reason is CancellationException && reason !is TimeoutCancellationException) throw reason
                logoutFailure = reason
            }
        }
        if (generation != epoch) return
        val oldApi = api
        var credentialFailure: Throwable? = null
        try { oldApi?.clearCredentials() } catch (reason: Exception) {
            if (reason is CancellationException) throw reason
            credentialFailure = reason
        }
        disconnectStream()
        polling?.cancel()
        polling = null
        debounce?.cancel()
        debounce = null
        pages.clear()
        parents.clear()
        pageGeneration++
        val oldServer = state.server
        epoch++
        var serverStoreFailure: Throwable? = null
        if (changeServer) {
            oldApi?.close()
            api = null
            try { withContext(Dispatchers.IO) { store.write("server", null) } }
            catch (reason: Exception) {
                if (reason is CancellationException) throw reason
                serverStoreFailure = reason
            }
        }
        val message = when {
            credentialFailure != null -> "已退出本机；本机凭证清理未确认，请重启应用后重试。"
            localDraftFailure != null -> "已退出本机；本机草稿保存失败，无法确认重启后可恢复。"
            logoutFailure != null -> "已清除本机凭证；服务器注销未确认。未发送草稿已保留在本机。"
            serverStoreFailure != null -> "已清除本机状态，但服务器地址未能从本机设置中删除。"
            draftFailure != null -> "已退出本机；服务器会话已注销，但草稿仅保留在本机。"
            else -> null
        }
        state = NativeState(
            server = if (changeServer) "" else oldServer,
            theme = state.theme,
            fontSize = state.fontSize,
            error = message,
        )
    }

    fun logout() = action { generation ->
        finishSessionExit(changeServer = false, generation = generation)
    }

    fun changeServer() = action { generation ->
        finishSessionExit(changeServer = true, generation = generation)
    }

    fun appearance(theme: String = state.theme, font: Int = state.fontSize) {
        state = state.copy(theme = theme, fontSize = font.coerceIn(12, 24))
        viewModelScope.launch(Dispatchers.IO) { store.write("theme", theme); store.write("font", font.toString()) }
    }
    fun voiceModel(value: String) { state = state.copy(voiceModel = value) }

    suspend fun download(path: String): okhttp3.Response {
        val generation = epoch
        return try {
            val response = requireNotNull(api).download(path)
            if (generation != epoch) {
                response.close()
                throw CancellationException("会话已改变")
            }
            response
        }
        catch (reason: Exception) {
            if (reason is CancellationException) throw reason
            if (reason is ApiFailure && reason.status == 401) withContext(Dispatchers.Main.immediate) { error(reason, generation) }
            throw reason
        }
    }

    fun foreground(active: Boolean) {
        foreground = active
        if (active) startPolling()
        else {
            polling?.cancel()
            disconnectStream()
            val generation = epoch
            viewModelScope.launch {
                try { flushDraft(generation) }
                catch (reason: Exception) {
                    if (reason is CancellationException) throw reason
                    error(reason, generation)
                    if (generation == epoch && !(reason is ApiFailure && reason.status == 401)) {
                        state = state.copy(draftStatus = "仅存本机 · 等待重连", connection = "离线或登录过期")
                    }
                }
            }
        }
    }

    private fun startPolling() {
        polling?.cancel()
        if (!foreground || !state.authenticated) return
        polling = viewModelScope.launch {
            while (foreground && state.authenticated) {
                val generation = epoch
                try {
                    if (!state.busy) {
                        state.selectedId?.let { reconcile(it, generation) }
                        refreshList(generation)
                        flushDraft(generation)
                    }
                } catch (reason: Exception) {
                    if (reason is CancellationException) throw reason
                    error(reason, generation)
                    if (generation == epoch && !(reason is ApiFailure && reason.status == 401)) {
                        state = state.copy(connection = "连接中断 · 自动重试中")
                    }
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
                    try { state.selectedId?.let { reconcile(it, generation) }; refreshList(generation) }
                    catch (reason: Exception) { error(reason, generation) }
                }
            }
        }, { message -> viewModelScope.launch {
            if (generation == epoch && connectionGeneration == streamGeneration && streamJob == job) {
                if (message.startsWith("401 ")) error(ApiFailure(401, message.removePrefix("401 ")), generation)
                else { disconnectStream(); state = state.copy(connection = message) }
            }
        } })
    }

    override fun onCleared() { disconnectStream(); api?.close() }
}
