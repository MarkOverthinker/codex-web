package app.codexweb.mobile

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject

class SnapshotCache(private val store: NativeStore, private val clock: () -> Long = System::currentTimeMillis) {
    private val mutex = Mutex()
    private var identity = ""
    private var entries = JSONObject()

    private suspend fun load(account: String) {
        if (identity == account) return
        entries = withContext(Dispatchers.IO) {
            store.read("snapshots:$account")?.let { runCatching { JSONObject(it) }.getOrNull() } ?: JSONObject()
        }
        identity = account
    }

    suspend fun get(account: String, key: String): JSONObject? = withContext(Dispatchers.IO) { mutex.withLock {
        load(account)
        val entry = entries.optJSONObject(key) ?: return@withLock null
        if (clock() - entry.optLong("savedAt") > 7L * 24 * 60 * 60 * 1000) return@withLock null
        entry.optJSONObject("data")?.let { JSONObject(it.toString()) }
    } }

    suspend fun put(account: String, key: String, data: JSONObject) = withContext(Dispatchers.IO) { mutex.withLock {
        require(key in listOf("conversations", "options", "presets", "categories", "directories") || key.startsWith("detail:"))
        val serialized = data.toString()
        if (serialized.toByteArray().size > 512 * 1024) return@withLock
        load(account)
        val previous = entries.optJSONObject(key)
        if (previous?.optJSONObject("data")?.toString() == serialized && clock() - previous.optLong("savedAt") < 300000) return@withLock
        entries.put(key, json("savedAt" to clock(), "data" to JSONObject(serialized)))
        val ordered = entries.keys().asSequence().toList().sortedBy { entries.objectValue(it).optLong("savedAt") }.toMutableList()
        while (entries.length() > 16 || entries.toString().toByteArray().size > 4 * 1024 * 1024) entries.remove(ordered.removeAt(0))
        val snapshot = entries.toString()
        withContext(Dispatchers.IO) { store.write("snapshots:$account", snapshot) }
    } }

    suspend fun remove(account: String, key: String) = mutex.withLock {
        load(account)
        entries.remove(key)
        val snapshot = entries.toString()
        withContext(Dispatchers.IO) { store.write("snapshots:$account", snapshot) }
    }

    suspend fun clear(account: String) = mutex.withLock {
        if (identity == account) entries = JSONObject()
        withContext(Dispatchers.IO) { store.write("snapshots:$account", null) }
    }
}
