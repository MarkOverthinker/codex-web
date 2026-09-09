package app.codexweb.mobile

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody
import okio.BufferedSink
import okio.source
import java.io.IOException

data class UploadPart(val name: String, val body: RequestBody)

fun nativeUpload(context: Context, uri: Uri): UploadPart {
    val resolver = context.applicationContext.contentResolver
    val name = runCatching {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }
    }.getOrNull()?.substringAfterLast('/')?.take(180)?.replace("\n", " ")?.replace("\r", " ") ?: "attachment"
    val mime = runCatching { resolver.getType(uri) }.getOrNull()?.toMediaTypeOrNull() ?: "application/octet-stream".toMediaTypeOrNull()
    return UploadPart(name, object : RequestBody() {
        override fun contentType() = mime
        override fun isOneShot() = true
        override fun writeTo(sink: BufferedSink) {
            try {
                (resolver.openInputStream(uri) ?: throw IOException("附件已不可读取，请重新选择")).use { input -> input.source().use { sink.writeAll(it) } }
            } catch (reason: SecurityException) { throw IOException("附件权限已失效，请重新选择", reason) }
        }
    })
}
