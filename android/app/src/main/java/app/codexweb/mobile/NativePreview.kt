package app.codexweb.mobile

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream

fun InputStream.readLimited(limit: Int): ByteArray {
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    while (true) {
        val count = read(buffer)
        if (count < 0) break
        require(output.size() + count <= limit) { "文件较大，请下载到系统文件后打开。" }
        output.write(buffer, 0, count)
    }
    return output.toByteArray()
}

data class PreviewContent(val text: String = "", val bitmap: Bitmap? = null, val pages: Int = 0, val error: String? = null)

@Composable
fun NativePreview(model: ClientModel, page: ToolPage, download: (FileRequest) -> Unit, confirm: (String, () -> Unit) -> Unit) {
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val path = page.args.text("downloadPath")
    val mime = page.args.text("mime", "application/octet-stream")
    var pageIndex by remember(page) { mutableIntStateOf(0) }
    var retry by remember(page) { mutableIntStateOf(0) }
    val preview by produceState<PreviewContent?>(null, path, pageIndex, retry, model.state.server) {
        value = null
        value = withContext(Dispatchers.IO) {
            try {
                if (page.args.text("snippetPath").isNotBlank()) {
                    val snippet = model.get(page.args.text("snippetPath"))
                    PreviewContent(text = snippet.text("content").ifBlank { snippet.strings("lines").joinToString("\n") })
                } else model.download(path).use { response ->
                    val actualMime = response.header("Content-Type").orEmpty().substringBefore(';').ifBlank { mime }
                    val bytes = requireNotNull(response.body).byteStream().use { it.readLimited(24 * 1024 * 1024) }
                    when {
                        actualMime.startsWith("image/") && actualMime != "image/svg+xml" -> {
                            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                            val options = BitmapFactory.Options().apply { inSampleSize = (maxOf(bounds.outWidth, bounds.outHeight) / 1600).coerceAtLeast(1) }
                            PreviewContent(bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options), error = if (bounds.outWidth <= 0) "无法解码图片，请下载后打开。" else null)
                        }
                        actualMime == "application/pdf" -> {
                            val cache = File.createTempFile("preview-", ".pdf", context.cacheDir)
                            try {
                                cache.writeBytes(bytes)
                                ParcelFileDescriptor.open(cache, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
                                    PdfRenderer(descriptor).use { renderer ->
                                        renderer.openPage(pageIndex.coerceIn(0, (renderer.pageCount - 1).coerceAtLeast(0))).use { pdf ->
                                            val width = 1000
                                            val height = (width.toLong() * pdf.height / pdf.width.coerceAtLeast(1)).coerceIn(1, 2400).toInt()
                                            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                                            bitmap.eraseColor(android.graphics.Color.WHITE)
                                            pdf.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                                            PreviewContent(bitmap = bitmap, pages = renderer.pageCount)
                                        }
                                    }
                                }
                            } finally { cache.delete() }
                        }
                        actualMime.startsWith("text/") || actualMime.contains("json") || actualMime.contains("xml") ||
                            page.title.substringAfterLast('.').lowercase() in listOf("md", "kt", "java", "ts", "tsx", "py", "sh", "log", "yaml", "yml", "toml", "csv") ->
                            PreviewContent(text = bytes.toString(Charsets.UTF_8).take(150_000), error = if (bytes.size > 150_000) "仅预览前 150000 字符，完整内容请下载。" else null)
                        else -> PreviewContent(error = "此格式请下载后用系统应用打开。")
                    }
                }
            } catch (reason: Exception) {
                if (reason is kotlinx.coroutines.CancellationException) throw reason
                PreviewContent(error = friendlyIoMessage(reason.message ?: "预览失败"))
            }
        }
    }
    ToolColumn {
        if (path.isNotBlank()) Button(onClick = { download(FileRequest(path, page.title, mime)) }) { Text("保存到系统文件") }
        if (page.args.text("fileId").isNotEmpty()) OutlinedButton(onClick = { confirm("创建任何持有链接的人均可访问的临时分享链接？链接有效期由服务器决定。") {
            model.mutate("/files/${page.args.text("fileId").segment()}/share", after = { result ->
                clipboard.setText(AnnotatedString(result.text("url")))
                model.note("分享链接已复制，有效期至 ${result.text("expiresAt")}")
            })
        } }) { Text("创建分享链接") }
        if (preview == null) CircularProgressIndicator(Modifier.size(26.dp), strokeWidth = 2.dp)
        preview?.error?.let { message ->
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(message, Modifier.padding(top = 8.dp), color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                // 重试只重新读取内容，不重放任何写请求；“此格式请下载”属于确定性结论，不提供重试
                if (!message.startsWith("此格式")) TextButton(onClick = { retry++ }) { Text("重试") }
            }
        }
        preview?.bitmap?.let { bitmap -> Image(bitmap.asImageBitmap(), page.title, Modifier.fillMaxWidth().heightIn(max = 650.dp)) }
        if ((preview?.pages ?: 0) > 1) Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton(onClick = { pageIndex-- }, enabled = pageIndex > 0) { Text("上一页") }
            Text("${pageIndex + 1}/${preview?.pages}", Modifier.padding(top = 16.dp))
            OutlinedButton(onClick = { pageIndex++ }, enabled = pageIndex < (preview?.pages ?: 1) - 1) { Text("下一页") }
        }
        if (preview?.text?.isNotEmpty() == true) {
            if (page.title.endsWith(".md")) MarkdownText(preview!!.text, model.state.fontSize)
            else CodeBlock(preview!!.text)
        }
    }
}
