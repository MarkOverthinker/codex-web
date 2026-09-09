package app.codexweb.mobile

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class ApiFailure(val status: Int, override val message: String, val code: String = "") : IOException(message)

interface Gateway : Closeable {
    var csrf: String
    suspend fun call(path: String, method: String = "GET", payload: JSONObject? = null, body: RequestBody? = null): JSONObject
    suspend fun download(path: String): Response
    fun events(jobId: String, after: Long, receive: (JSONObject, Long) -> Unit, failure: (String) -> Unit): Closeable
    fun clearCredentials()
}

class TrustedCookies(private val server: String, private val store: NativeStore) : CookieJar {
    private val storageKey = "cookies:$server"
    private var cookies: List<Cookie> = runCatching {
        val saved = JSONArray(store.read(storageKey) ?: "[]")
        (0 until saved.length()).mapNotNull { Cookie.parse(server.toHttpUrl(), saved.getString(it)) }
    }.getOrDefault(emptyList())

    @Synchronized override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        if (!ServerPolicy.sameOrigin(server, url.toString())) return
        this.cookies = (this.cookies.filter { old -> cookies.none { it.name == old.name } } + cookies)
            .filter { it.expiresAt > System.currentTimeMillis() && it.matches(server.toHttpUrl()) }
        store.write(storageKey, this.cookies.map { it.toString() }.jsonArray().toString())
    }
    @Synchronized override fun loadForRequest(url: HttpUrl): List<Cookie> =
        if (!ServerPolicy.sameOrigin(server, url.toString())) emptyList()
        else cookies.filter { it.expiresAt > System.currentTimeMillis() && it.matches(url) }

    @Synchronized fun clear() { cookies = emptyList(); store.write(storageKey, null) }
}

class NativeApi(
    server: String,
    private val cookies: TrustedCookies,
    client: OkHttpClient = OkHttpClient(),
) : Gateway {
    private val base = ServerPolicy.normalize(server)
    private val http = client.newBuilder().cookieJar(cookies)
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .connectTimeout(20, TimeUnit.SECONDS).readTimeout(90, TimeUnit.SECONDS)
        .callTimeout(120, TimeUnit.SECONDS).build()
    @Volatile override var csrf = ""

    fun request(path: String, method: String, body: RequestBody?): Request {
        require(path.startsWith("/") && !path.startsWith("//"))
        val url = (base + "api" + path).toHttpUrl()
        val root = (base + "api/").toHttpUrl()
        require(ServerPolicy.sameOrigin(base, url.toString()) && url.encodedPath.startsWith(root.encodedPath))
        return Request.Builder().url(url).header("Accept", "application/json")
            .header("User-Agent", "CodexNativeAndroid/0.2.0")
            .apply { if (method != "GET" && method != "HEAD" && csrf.isNotEmpty()) header("X-CSRF-Token", csrf) }
            .method(method, body ?: if (method in listOf("POST", "PUT", "PATCH")) ByteArray(0).toRequestBody() else null).build()
    }

    private suspend fun execute(request: Request): Response = suspendCancellableCoroutine { continuation ->
        val call = http.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, error: IOException) {
                if (continuation.isActive) continuation.resumeWithException(error)
            }
            override fun onResponse(call: Call, response: Response) {
                continuation.resume(response) { _, resource, _ -> resource.close() }
            }
        })
    }

    override suspend fun call(path: String, method: String, payload: JSONObject?, body: RequestBody?): JSONObject = withContext(Dispatchers.IO) {
        val content = body ?: payload?.toString()?.toRequestBody("application/json; charset=utf-8".toMediaType())
        execute(request(path, method, content)).use { response ->
            val raw = response.body?.string().orEmpty()
            val value = runCatching { JSONObject(raw) }.getOrNull()
            if (!response.isSuccessful) throw ApiFailure(response.code, value?.text("error")?.ifEmpty { null }
                ?: "请求失败 (${response.code})；未自动重试", value?.text("code").orEmpty())
            if (response.code == 204) JSONObject()
            else value ?: throw IOException("服务没有返回 JSON，请检查服务地址是否指向 codex-web。")
        }
    }

    override suspend fun download(path: String): Response {
        val response = execute(request(path, "GET", null))
        if (!response.isSuccessful) {
            val status = response.code
            response.close()
            throw ApiFailure(status, "文件获取失败 ($status)，不跟随重定向。")
        }
        return response
    }

    override fun events(jobId: String, after: Long, receive: (JSONObject, Long) -> Unit, failure: (String) -> Unit): Closeable {
        val client = http.newBuilder().callTimeout(0, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS).build()
        val source = EventSources.createFactory(client).newEventSource(
            request("/jobs/${jobId.segment()}/events?after=$after", "GET", null),
            object : EventSourceListener() {
                override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                    runCatching { JSONObject(data) }.onSuccess { receive(it, id?.toLongOrNull() ?: it.optLong("seq")) }
                        .onFailure { failure("事件解析失败，正在同步服务器状态") }
                }
                override fun onFailure(eventSource: EventSource, error: Throwable?, response: Response?) {
                    response?.close()
                    failure("实时连接中断，正在重新同步")
                }
                override fun onClosed(eventSource: EventSource) { failure("实时连接已关闭，正在同步") }
            })
        return Closeable { source.cancel() }
    }
    override fun clearCredentials() { csrf = ""; cookies.clear() }
    override fun close() { http.dispatcher.cancelAll(); http.connectionPool.evictAll() }
}
