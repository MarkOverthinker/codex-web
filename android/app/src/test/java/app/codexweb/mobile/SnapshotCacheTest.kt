package app.codexweb.mobile

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

private class CacheStore : NativeStore {
    val values = mutableMapOf<String, String>()
    override fun read(key: String) = values[key]
    override fun write(key: String, value: String?) { if (value == null) values.remove(key) else values[key] = value }
}

class SnapshotCacheTest {
    @Test fun cachePersistsAndIsolatesServerAndAccount() = runBlocking {
        val store = CacheStore()
        val cache = SnapshotCache(store)
        cache.put("server-a:alice", "detail:one", json("title" to "private"))
        assertNull(cache.get("server-a:bob", "detail:one"))
        assertNull(cache.get("server-b:alice", "detail:one"))
        assertEquals("private", SnapshotCache(store).get("server-a:alice", "detail:one")?.text("title"))
    }

    @Test fun expiredSnapshotsAreNotRead() = runBlocking {
        var time = 1L
        val cache = SnapshotCache(CacheStore()) { time }
        cache.put("account", "options", json("value" to "old"))
        time += 8L * 24 * 60 * 60 * 1000
        assertNull(cache.get("account", "options"))
    }

    @Test fun entryCountAndSizeAreBounded() = runBlocking {
        var time = 0L
        val cache = SnapshotCache(CacheStore()) { ++time }
        repeat(18) { cache.put("account", "detail:$it", json("index" to it)) }
        assertNull(cache.get("account", "detail:0"))
        assertNotNull(cache.get("account", "detail:17"))
        cache.put("account", "detail:large", json("content" to "x".repeat(513 * 1024)))
        assertNull(cache.get("account", "detail:large"))
    }

    @Test fun clearPreservesDraftsAndOtherAccounts() = runBlocking {
        val store = CacheStore()
        store.write("draft:account:one", "keep")
        val cache = SnapshotCache(store)
        cache.put("other", "options", json("value" to "keep"))
        cache.put("account", "options", json("value" to "delete"))
        cache.clear("account")
        assertNull(cache.get("account", "options"))
        assertNotNull(cache.get("other", "options"))
        assertEquals("keep", store.read("draft:account:one"))
    }

    @Test fun snapshotsAreDefensivelyCopiedAndRevocable() = runBlocking {
        val cache = SnapshotCache(CacheStore())
        val original = json("title" to "original")
        cache.put("account", "detail:one", original)
        original.put("title", "changed")
        cache.get("account", "detail:one")!!.put("title", "changed again")
        assertEquals("original", cache.get("account", "detail:one")!!.text("title"))
        cache.remove("account", "detail:one")
        assertNull(cache.get("account", "detail:one"))
    }
}
