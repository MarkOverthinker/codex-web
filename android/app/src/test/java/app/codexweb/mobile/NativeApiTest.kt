package app.codexweb.mobile

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class MemoryStore : NativeStore {
    private val values = java.util.concurrent.ConcurrentHashMap<String, String>()
    override fun read(key: String) = values[key]
    override fun write(key: String, value: String?) { if (value == null) values.remove(key) else values[key] = value }
}

class NativeApiTest {
    private lateinit var server: MockWebServer
    private lateinit var api: NativeApi
    private lateinit var base: String
    private lateinit var cookies: TrustedCookies
    private val store = MemoryStore()

    @Before fun setup() {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val serverTls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        server = MockWebServer().apply { useHttps(serverTls.sslSocketFactory(), false); start() }
        val trust = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        base = server.url("/codex-web/").toString()
        cookies = TrustedCookies(base, store)
        api = NativeApi(base, cookies, OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).build())
    }

    @After fun cleanup() { api.close(); server.shutdown() }

    @Test fun loginCookieAndCsrfAreUsedWithoutLoadingAnyHtml() = runBlocking {
        server.enqueue(MockResponse().addHeader("Set-Cookie", "sid=test; Path=/codex-web; Secure; HttpOnly").setBody("{\"authenticated\":true,\"csrfToken\":\"csrf\"}"))
        val session = api.call("/auth/login", "POST", json("username" to "tester", "password" to "test-only"))
        api.csrf = session.text("csrfToken")
        server.enqueue(MockResponse().setBody("{\"conversation\":{\"id\":\"one\"}}"))
        api.call("/conversations", "POST", json())
        val login = server.takeRequest()
        val create = server.takeRequest()
        assertEquals("/codex-web/api/auth/login", login.path)
        assertNull(login.getHeader("X-CSRF-Token"))
        assertEquals("csrf", create.getHeader("X-CSRF-Token"))
        assertEquals("sid=test", create.getHeader("Cookie"))
        assertEquals("CodexNativeAndroid/0.2.0", create.getHeader("User-Agent"))
    }

    @Test fun cookiesStayOnExactServiceOriginAndClearOnLogout() {
        cookies.saveFromResponse(base.toHttpUrl(), listOf(Cookie.parse(base.toHttpUrl(), "sid=test; Path=/codex-web; Secure")!!))
        assertEquals(1, cookies.loadForRequest((base + "api/conversations").toHttpUrl()).size)
        assertTrue(cookies.loadForRequest("https://localhost:8443/codex-web/".toHttpUrl()).isEmpty())
        assertTrue(cookies.loadForRequest("https://example.net/codex-web/".toHttpUrl()).isEmpty())
        assertTrue(cookies.loadForRequest(server.url("/outside/")).isEmpty())
        assertEquals(1, TrustedCookies(base, store).loadForRequest(base.toHttpUrl()).size)
        api.clearCredentials()
        assertTrue(TrustedCookies(base, store).loadForRequest(base.toHttpUrl()).isEmpty())
    }

    @Test fun lateCookieResponseAfterClearCannotRestoreCredentials() {
        cookies.saveFromResponse(base.toHttpUrl(), listOf(Cookie.parse(base.toHttpUrl(), "sid=before; Path=/codex-web; Secure")!!))
        cookies.loadForRequest(base.toHttpUrl())
        cookies.clear()
        cookies.saveFromResponse(base.toHttpUrl(), listOf(Cookie.parse(base.toHttpUrl(), "sid=late; Path=/codex-web; Secure")!!))
        assertTrue(TrustedCookies(base, store).loadForRequest(base.toHttpUrl()).isEmpty())

        cookies.loadForRequest(base.toHttpUrl())
        cookies.saveFromResponse(base.toHttpUrl(), listOf(Cookie.parse(base.toHttpUrl(), "sid=fresh; Path=/codex-web; Secure")!!))
        assertEquals("fresh", TrustedCookies(base, store).loadForRequest(base.toHttpUrl()).single().value)
    }

    @Test fun delayedHttpCookieFromPreClearRequestIsIgnored() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(401).setHeadersDelay(250, TimeUnit.MILLISECONDS)
            .addHeader("Set-Cookie", "sid=late-http; Path=/codex-web; Secure").setBody("{\"error\":\"expired\"}"))
        val request = async(Dispatchers.IO) { runCatching { api.call("/auth/session") } }
        assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        api.clearCredentials()
        request.await()
        assertTrue(TrustedCookies(base, store).loadForRequest(base.toHttpUrl()).isEmpty())
    }

    @Test fun requestsCannotEscapeApiRoot() {
        listOf("//elsewhere/", "/../../outside", "/%2e%2e/%2e%2e/outside", "https://example.net/").forEach { path ->
            assertThrows(path, IllegalArgumentException::class.java) { api.request(path, "GET", null) }
        }
        assertEquals("/codex-web/api/files/id", api.request("/files/id", "GET", null).url.encodedPath)
    }

    @Test fun errorsAreNotRetriedAndRedirectsAreNotFollowed() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(403).setBody("{\"error\":\"csrf rejected\"}"))
        try { api.call("/conversations", "POST", json()); fail() } catch (reason: ApiFailure) { assertEquals(403, reason.status) }
        server.enqueue(MockResponse().setResponseCode(302).addHeader("Location", "https://example.net/download"))
        try { api.download("/files/id"); fail() } catch (reason: ApiFailure) { assertEquals(302, reason.status) }
        assertEquals(2, server.requestCount)
    }

    @Test fun multipartSendPreservesDraftAndSourceContract() = runBlocking {
        server.enqueue(MockResponse().setBody("{\"queued\":true}"))
        api.csrf = "token"
        val body = MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart("message", "中文\n第二行")
            .addFormDataPart("quoteExcerpt", "quote").addFormDataPart("useComposerDraft", "true")
            .addFormDataPart("sourceReference", json("sourceMessageId" to "message-one").toString()).build()
        assertTrue(api.call("/conversations/one/messages", "POST", body = body).optBoolean("queued"))
        val request = server.takeRequest()
        val encoded = request.body.readUtf8()
        assertEquals("token", request.getHeader("X-CSRF-Token"))
        assertTrue(encoded.contains("name=\"useComposerDraft\""))
        assertTrue(encoded.contains("\r\n\r\ntrue\r\n"))
        assertTrue(encoded.contains("中文\n第二行"))
        assertTrue(encoded.contains("sourceMessageId"))
    }

    @Test fun sseReplaysFromCursorAndReturnsSequence() {
        server.enqueue(MockResponse().addHeader("Content-Type", "text/event-stream")
            .setBody("id: 42\ndata: {\"type\":\"progress\",\"label\":\"working\"}\n\n"))
        val received = CountDownLatch(1)
        var sequence = 0L
        val stream = api.events("job-one", 41, { event, cursor ->
            if (event.text("type") == "progress") { sequence = cursor; received.countDown() }
        }, {})
        assertTrue(received.await(5, TimeUnit.SECONDS))
        assertEquals(42, sequence)
        assertEquals("/codex-web/api/jobs/job-one/events?after=41", server.takeRequest().path)
        stream.close()
    }

    @Test fun sseUnauthorizedResponseIsReportedAsSessionExpiry() {
        server.enqueue(MockResponse().setResponseCode(401).setBody("{\"error\":\"expired\"}"))
        val failed = CountDownLatch(1)
        var message = ""
        val stream = api.events("job-one", 0, { _, _ -> }, { value -> message = value; failed.countDown() })
        assertTrue(failed.await(5, TimeUnit.SECONDS))
        assertTrue(message.startsWith("401 "))
        stream.close()
    }

    @Test fun malformedSuccessIsNotTreatedAsEmptyData() = runBlocking {
        server.enqueue(MockResponse().setBody("<html>Login elsewhere</html>"))
        try { api.call("/auth/session"); fail() } catch (reason: java.io.IOException) { assertTrue(reason.message!!.contains("JSON")) }
        server.enqueue(MockResponse().setResponseCode(204))
        assertEquals(0, api.call("/files/one", "DELETE").length())
    }
}
