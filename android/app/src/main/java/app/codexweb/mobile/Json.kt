package app.codexweb.mobile

import org.json.JSONArray
import org.json.JSONObject

fun json(vararg values: Pair<String, Any?>): JSONObject = JSONObject().apply {
    values.forEach { (key, value) -> put(key, value ?: JSONObject.NULL) }
}

fun JSONObject.text(key: String, fallback: String = ""): String =
    if (isNull(key)) fallback else optString(key, fallback)

fun JSONObject.objectValue(key: String): JSONObject = optJSONObject(key) ?: JSONObject()
fun JSONObject.rows(key: String): List<JSONObject> = optJSONArray(key)?.objects().orEmpty()
fun JSONObject.strings(key: String): List<String> = optJSONArray(key)?.let { array ->
    (0 until array.length()).map { array.optString(it) }
}.orEmpty()
fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }
fun JSONObject.changed(vararg values: Pair<String, Any?>): JSONObject = JSONObject(toString()).apply {
    values.forEach { (key, value) -> put(key, value ?: JSONObject.NULL) }
}
fun List<*>.jsonArray(): JSONArray = JSONArray(this)
fun String.segment(): String = java.net.URLEncoder.encode(this, "UTF-8").replace("+", "%20")

fun mergeEvents(previous: List<JSONObject>, incoming: List<JSONObject>): List<JSONObject> =
    (previous + incoming).associateBy { if (it.optLong("seq") > 0) it.optLong("seq").toString() else it.toString() }
        .values.sortedBy { it.optLong("seq") }.takeLast(200)

data class Composer(
    val content: String = "",
    val quote: String = "",
    val source: JSONObject? = null,
    val files: List<JSONObject> = emptyList(),
    val dirty: Boolean = false,
    val revision: Long = 0,
) {
    fun payload(): JSONObject = json("content" to content, "quoteExcerpt" to quote, "sourceReference" to source)
    companion object {
        fun from(value: JSONObject?) = Composer(
            content = value?.text("content").orEmpty(),
            quote = value?.text("quote_excerpt").orEmpty(),
            source = value?.optJSONObject("source_reference"),
            files = value?.rows("files").orEmpty(),
        )
    }
}

data class ToolPage(val title: String, val kind: String, val path: String, val args: JSONObject = JSONObject())

enum class HomeTab(val title: String) { Chat("对话"), Workspace("工作台"), Profile("我的") }

data class NativeState(
    val server: String = "",
    val session: JSONObject? = null,
    val connecting: Boolean = false,
    val conversations: List<JSONObject> = emptyList(),
    val selectedId: String? = null,
    val detail: JSONObject? = null,
    val composer: Composer = Composer(),
    val options: JSONObject = JSONObject(),
    val presets: List<JSONObject> = emptyList(),
    val page: ToolPage? = null,
    val pageData: JSONObject? = null,
    val pageLoading: Boolean = false,
    val pageError: String? = null,
    val busy: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
    val connection: String = "未连接",
    val draftStatus: String = "",
    val sendUncertain: Boolean = false,
    val uncertainRevision: Long? = null,
    val categorySettings: JSONObject = JSONObject(),
    val theme: String = "system",
    val fontSize: Int = 16,
    val voiceModel: String = "",
    val homeTab: HomeTab = HomeTab.Chat,
    val operation: String? = null,
    val detailFromCache: Boolean = false,
    val parentAvailable: Boolean = false,
    val workingDirs: JSONObject = JSONObject(),
) {
    val authenticated get() = session?.optBoolean("authenticated") == true
    val conversation get() = detail?.objectValue("conversation") ?: JSONObject()
    val activeJob get() = detail?.optJSONObject("activeJob")
    val editingPrompt get() = detail?.optJSONObject("editingPrompt")
    val conversationPath get() = "/conversations/${selectedId.orEmpty().segment()}"
}
