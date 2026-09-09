package app.codexweb.mobile

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okio.BufferedSink
import okio.source
import java.io.File
import java.io.IOException

class MainActivity : ComponentActivity() {
    private lateinit var model: ClientModel
    private var recording by mutableStateOf(false)
    private var recorder: MediaRecorder? = null
    private var audio: File? = null
    private var recordingId: String? = null
    private var recordingIdentity: String? = null
    private var uploadId: String? = null
    private var uploadIdentity: String? = null
    private var downloadRequest: FileRequest? = null
    private var downloadIdentity: String? = null

    private fun identity() = "${model.state.server}:${model.state.session?.text("username")}"

    private val files = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        val id = uploadId
        if (uris.isNotEmpty() && id != null) {
            if (uploadIdentity != identity() || model.state.selectedId != id) { model.note("会话或账户已改变，请重新选择附件"); return@registerForActivityResult }
            if (uris.size + model.state.composer.files.size > 12) { model.note("一个草稿最多 12 个附件"); return@registerForActivityResult }
            val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            uris.map { nativeUpload(this, it) }.forEach { body.addFormDataPart("files", it.name, it.body) }
            model.upload(body.build(), id)
        }
    }

    private val save = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val uri = result.data?.data
        val request = downloadRequest
        downloadRequest = null
        if (result.resultCode == RESULT_OK && uri != null && request != null) {
            if (downloadIdentity != identity()) { model.note("账号已改变，下载已取消"); return@registerForActivityResult }
            lifecycleScope.launch {
                try {
                    withContext(Dispatchers.IO) {
                        model.download(request.path).use { response ->
                            contentResolver.openOutputStream(uri, "wt").use { output ->
                                requireNotNull(output) { "无法写入选择的位置" }
                                requireNotNull(response.body).byteStream().use { input -> input.copyTo(output) }
                            }
                        }
                    }
                    model.note("已保存 ${request.name}")
                } catch (reason: Exception) { model.note("下载失败：${reason.message}。目标位置可能有不完整文件，请删除后重试。") }
            }
        }
    }

    private val microphone = registerForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        if (allowed) startRecording() else model.note("未授予麦克风权限，仍可输入文字或选择附件")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        model = ViewModelProvider(this, object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = ClientModel(SessionVault(applicationContext)) as T
        })[ClientModel::class.java]
        uploadId = savedInstanceState?.getString("uploadId")
        uploadIdentity = savedInstanceState?.getString("uploadIdentity")
        downloadIdentity = savedInstanceState?.getString("downloadIdentity")
        savedInstanceState?.getString("downloadPath")?.let { downloadRequest = FileRequest(it, savedInstanceState.getString("downloadName").orEmpty(), savedInstanceState.getString("downloadMime").orEmpty()) }
        lifecycleScope.launch(Dispatchers.IO) {
            cacheDir.listFiles()?.filter { (it.name.startsWith("recording-") || it.name.startsWith("preview-")) && it.lastModified() < System.currentTimeMillis() - 86400000 }
                ?.forEach { it.delete() }
        }
        setContent { CodexApp(model, pickFiles = {
            uploadId = model.state.selectedId
            uploadIdentity = identity()
            files.launch(arrayOf("*/*"))
        }, download = { request ->
            downloadRequest = request
            downloadIdentity = identity()
            save.launch(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(request.mime.ifBlank { "application/octet-stream" })
                .putExtra(Intent.EXTRA_TITLE, request.name.substringAfterLast('/')))
        }, voice = {
            if (recording) finishRecording()
            else if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) startRecording()
            else microphone.launch(Manifest.permission.RECORD_AUDIO)
        }, recording = recording, openLink = ::openLink) }
    }

    override fun onStart() { super.onStart(); if (::model.isInitialized) model.foreground(true) }
    override fun onStop() {
        if (recording) finishRecording()
        model.foreground(false)
        super.onStop()
    }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("uploadId", uploadId)
        outState.putString("uploadIdentity", uploadIdentity)
        outState.putString("downloadIdentity", downloadIdentity)
        downloadRequest?.let { outState.putString("downloadPath", it.path); outState.putString("downloadName", it.name); outState.putString("downloadMime", it.mime) }
        super.onSaveInstanceState(outState)
    }

    @Suppress("DEPRECATION")
    private fun startRecording() {
        if (model.state.selectedId == null || !model.state.authenticated || recording) return
        try {
            val file = File.createTempFile("recording-", ".m4a", cacheDir)
            audio = file
            recordingId = model.state.selectedId
            recordingIdentity = identity()
            recorder = (if (Build.VERSION.SDK_INT >= 31) MediaRecorder(this) else MediaRecorder()).apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioSamplingRate(16000)
                setAudioEncodingBitRate(64000)
                setMaxDuration(300000)
                setMaxFileSize(14 * 1024 * 1024L)
                setOutputFile(file.absolutePath)
                setOnInfoListener { _, _, _ -> runOnUiThread { if (recording) finishRecording() } }
                prepare()
                start()
            }
            recording = true
        } catch (reason: Exception) {
            recorder?.release(); recorder = null
            audio?.delete(); audio = null
            model.note("录音未开始：${reason.message}")
        }
    }

    private fun finishRecording() {
        if (!recording) return
        recording = false
        val file = audio
        val id = recordingId
        try {
            recorder?.stop()
            if (file != null && id != null) {
                if (model.state.selectedId != id || recordingIdentity != identity()) {
                    file.delete()
                    model.note("录音期间会话发生变化，已取消上传，避免混入其他任务。")
                    return
                }
                val body = MultipartBody.Builder().setType(MultipartBody.FORM)
                    .addFormDataPart("audio", "voice.m4a", file.asRequestBody("audio/mp4".toMediaTypeOrNull()))
                    .addFormDataPart("conversationId", id)
                    .addFormDataPart("draftText", model.state.composer.content.take(2000))
                    .addFormDataPart("attachmentNames", model.state.composer.files.map { it.text("original_name") }.jsonArray().toString())
                    .apply { if (model.state.voiceModel.isNotEmpty()) addFormDataPart("model", model.state.voiceModel) }.build()
                model.transcribe(body, id, cleanup = { file.delete() })
            }
        } catch (_: RuntimeException) { file?.delete(); model.note("录音过短或被系统中断，请重试。") }
        finally { recorder?.release(); recorder = null; audio = null; recordingId = null; recordingIdentity = null }
    }

    private fun openLink(raw: String) {
        val uri = Uri.parse(raw)
        val server = model.state.server
        val resolved = runCatching { java.net.URI(server).resolve(raw).toString() }.getOrNull().orEmpty()
        val basePath = Uri.parse(server).path.orEmpty() + "api"
        if (ServerPolicy.sameOrigin(server, resolved) && Uri.parse(resolved).path.orEmpty().startsWith("$basePath/files/")) {
            val id = Uri.parse(resolved).lastPathSegment.orEmpty()
            model.navigate(ToolPage("附件", "preview", "", json("downloadPath" to "/files/${id.segment()}")))
            return
        }
        if (uri.scheme in listOf("https", "http", "mailto", "tel")) {
            android.app.AlertDialog.Builder(this).setTitle("在系统应用中打开链接？").setMessage(raw)
                .setPositiveButton("打开") { _, _ -> runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }.onFailure { model.note("没有可打开此链接的应用") } }
                .setNegativeButton("取消", null).show()
        } else if (model.state.selectedId != null && (uri.scheme == null || uri.scheme == "file")) {
            val path = if (uri.scheme == "file") uri.path.orEmpty() else raw.substringBefore('#')
            val line = raw.substringAfter("#L", "1").substringBefore('-').toIntOrNull() ?: 1
            model.navigate(ToolPage(path.substringAfterLast('/'), "preview", "", json("snippetPath" to "${model.state.conversationPath}/code-snippet?path=${path.segment()}&line=$line&before=10&after=60")))
        } else model.note("不支持此链接协议，已阻止打开。")
    }
}
