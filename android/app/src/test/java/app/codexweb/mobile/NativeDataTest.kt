package app.codexweb.mobile

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NativeDataTest {
    @Test fun composerRoundtripKeepsQuotesSourcesAndAttachmentIdentifiers() {
        val draft = JSONObject("""{"content":"你好\nworld","quote_excerpt":"quote","source_reference":{"sourceMessageId":"source"},"files":[{"id":"attachment"}]}""")
        val composer = Composer.from(draft)
        val body = composer.payload()
        assertEquals("你好\nworld", body.text("content"))
        assertEquals("quote", body.text("quoteExcerpt"))
        assertEquals("source", body.objectValue("sourceReference").text("sourceMessageId"))
        assertEquals("attachment", composer.files.single().text("id"))
        assertFalse(body.has("files"))
    }

    @Test fun nullFieldsStayEmptyInsteadOfStringNull() {
        assertEquals("", json("title" to null).text("title"))
        assertEquals("fallback", json("title" to null).text("title", "fallback"))
        assertTrue(Composer().payload().isNull("sourceReference"))
    }

    @Test fun nativeFormsUseTypedNumbersBooleansAndArrays() {
        val fields = listOf(FormField("cost", "cost", kind = "number"), FormField("enabled", "enabled", kind = "bool"),
            FormField("levels", "levels", kind = "lines"), FormField("secret", "secret", kind = "secret"))
        val body = parseForm(fields, mapOf("cost" to "1.25", "enabled" to "true", "levels" to "low,medium\nhigh", "secret" to ""))
        assertEquals(1.25, body.getDouble("cost"), 0.001)
        assertTrue(body.getBoolean("enabled"))
        assertEquals(listOf("low", "medium", "high"), body.strings("levels"))
        assertFalse(body.has("secret"))
        assertThrows(IllegalArgumentException::class.java) { parseForm(fields, mapOf("cost" to "Infinity")) }
    }

    @Test fun previewReadLimitStopsUnboundedFiles() {
        assertEquals(4, byteArrayOf(1, 2, 3, 4).inputStream().readLimited(4).size)
        assertThrows(IllegalArgumentException::class.java) { ByteArray(100).inputStream().readLimited(12) }
    }

    @Test fun reconciliationDoesNotRollBackNewerStreamEvents() {
        val previous = listOf(json("seq" to 1, "label" to "first"), json("seq" to 2, "label" to "newer"))
        val merged = mergeEvents(previous, listOf(json("seq" to 1, "label" to "first")))
        assertEquals(listOf(1L, 2L), merged.map { it.optLong("seq") })
        assertEquals(200, mergeEvents(emptyList(), (1..240).map { json("seq" to it) }).size)
    }
}
