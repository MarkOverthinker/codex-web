@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package app.codexweb.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONObject

@Composable
fun ToolsScreen(model: ClientModel, download: (FileRequest) -> Unit, editPending: (JSONObject) -> Unit,
                confirm: (String, () -> Unit) -> Unit, rootPage: ToolPage? = null) {
    val state = model.state
    val page = state.page ?: rootPage ?: return
    val data = state.pageData ?: JSONObject()
    var form by remember(page) { mutableStateOf<FormRequest?>(null) }
    var submitting by remember(page) { mutableStateOf(false) }
    // Review 文件列表的滚动状态提升到 ToolsScreen：进入差异再返回时保留所选范围与列表位置。
    // 用普通 remember（而非 rememberSaveable）：页面分支切换不销毁 ToolsScreen，位置得以保留。
    val reviewListState = remember { LazyListState() }
    var reviewSeenPath by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(state.busy, submitting) {
        if (submitting && !state.busy) {
            if (state.error == null) form = null
            submitting = false
        }
    }
    val openForm: (FormRequest) -> Unit = { form = it }
    when (page.kind) {
        "queue" -> QueueScreen(model, editPending, confirm)
        "files" -> FileTreeScreen(model, data)
        "preview" -> NativePreview(model, page, download, confirm)
        "review" -> {
            LaunchedEffect(page.path) {
                if (reviewSeenPath != null && reviewSeenPath != page.path) reviewListState.scrollToItem(0)
                reviewSeenPath = page.path
            }
            ReviewScreen(model, data, reviewListState)
        }
        "patch" -> PatchScreen(model, page, data)
        else -> when {
            state.pageLoading && state.pageData == null -> PageLoadingView("正在读取…")
            state.pageError != null && state.pageData == null -> PageErrorView(model)
            page.kind == "side" -> ToolColumn {
                Text("线程独占一个页面，与主任务互不挤占。", style = MaterialTheme.typography.bodyMedium)
                Button(onClick = { model.createSide("${state.conversationPath}/side-chats") }, enabled = !state.busy) { Text("新建侧边线程") }
                OutlinedButton(onClick = { model.createSide("${state.conversationPath}/side-chat/context") }, enabled = !state.busy) { Text("携带主任务上下文") }
                data.rows("sideChats").forEach { item -> val conversation = item.objectValue("conversation")
                    ToolRow(conversation.text("title"), conversation.text("updated_at")) { model.openSide(conversation.text("id")) }
                    TextButton(onClick = { confirm("将这个侧边线程提升为独立主任务？") { model.mutate("/side-chats/${conversation.text("id").segment()}/promote") } }) { Text("提升为主任务") }
                }
                if (data.rows("sideChats").isEmpty() && !state.pageLoading) Text("还没有侧边线程")
            }
            page.kind == "directories" -> DirectoriesScreen(model, data, openForm, confirm)
            page.kind == "host" -> HostScreen(model, data, confirm)
            page.kind == "settings" -> SettingsScreen(model, openForm, confirm)
            page.kind == "presets" -> PresetsScreen(model, data, openForm, confirm)
            page.kind == "providers" -> ProvidersScreen(model, data, openForm, confirm)
            page.kind == "models" -> ModelsScreen(model, data, openForm, confirm)
            page.kind == "billing" -> BillingScreen(model, data, openForm, confirm)
            page.kind == "categories" -> CategoriesScreen(model, data, openForm, confirm)
            page.kind == "category-tasks" -> CategoryTasks(model, page)
            page.kind == "archived" -> ToolColumn {
                if (data.rows("conversations").isEmpty()) Text("没有已归档任务")
                data.rows("conversations").forEach { item ->
                    ToolRow(item.text("title"), "恢复后返回任务列表查看") { model.mutate("/conversations/${item.text("id").segment()}/restore") }
                }
            }
            page.kind == "import" -> ImportScreen(model, data)
            else -> EmptyState("未识别的页面", "请返回任务列表重试。")
        }
    }
    form?.let { request -> NativeForm(request.title, request.fields, request.explanation, busy = state.busy, onDismiss = { form = null }) { payload ->
        submitting = true
        request.submit(payload)
    } }
}

@Composable
fun ToolColumn(content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)) {
        content()
        Spacer(Modifier.height(32.dp))
    }
}

@Composable
private fun PageLoadingView(hint: String) {
    Column(Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Spacer(Modifier.height(88.dp))
        CircularProgressIndicator(Modifier.size(26.dp), strokeWidth = 2.dp)
        Text(hint, Modifier.padding(top = 14.dp), fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** 页内读取失败：只提供只读的重试（刷新）与返回，不重放任何发送/上传请求。 */
@Composable
private fun PageErrorView(model: ClientModel, title: String = "读取失败") {
    val raw = friendlyIoMessage(model.state.pageError.orEmpty())
    // 服务端错误原文可能与标题同义（如回退文案「读取变更失败。」），去掉与标题重复的前缀，保留其余诊断
    val body = when {
        raw.startsWith("$title：") -> raw.removePrefix("$title：")
        raw.startsWith("$title:") -> raw.removePrefix("$title:").trimStart()
        raw == "$title。" || raw == title -> ""
        else -> raw
    }
    Column(Modifier.fillMaxSize().padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Icon(Icons.Outlined.ErrorOutline, null, Modifier.size(40.dp), tint = MaterialTheme.colorScheme.error)
        Text(title, Modifier.padding(top = 16.dp), style = MaterialTheme.typography.titleMedium)
        if (body.isNotBlank()) Text(body, Modifier.padding(top = 8.dp),
            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        Row(Modifier.padding(top = 22.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton(onClick = { model.back() }) { Text("返回") }
            Button(onClick = { model.refresh() }, enabled = !model.state.busy) { Text("重试") }
        }
    }
}

@Composable
private fun InlineError(message: String, retry: () -> Unit, back: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(vertical = 28.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(Icons.Outlined.ErrorOutline, null, Modifier.size(36.dp), tint = MaterialTheme.colorScheme.error)
        Text(friendlyIoMessage(message), Modifier.padding(top = 12.dp), fontSize = 14.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        Row(Modifier.padding(top = 18.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton(onClick = back) { Text("返回") }
            Button(onClick = retry) { Text("重试") }
        }
    }
}

/** 服务端 4xx 错误信息可能带 errno 原文（含绝对路径），客户端转换为准确的用户文案。 */
internal fun friendlyIoMessage(message: String): String = when {
    message.isBlank() -> "读取失败，请检查网络后重试。"
    message.contains("ENOENT") || message.contains("no such file", true) -> "文件或目录不存在，可能已被移动、重命名或删除。"
    message.contains("EACCES") || message.contains("EPERM") || message.contains("permission denied", true) -> "没有权限读取该位置，请检查目录权限。"
    else -> message
}

@Composable
private fun BreadcrumbRow(rootLabel: String, relativePath: String) {
    val segments = listOf(rootLabel) + relativePath.split("/").filter { it.isNotBlank() }
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) {
        segments.forEachIndexed { index, segment ->
            if (index > 0) Text(" / ", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(segment.trim(), maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, fontSize = 12.sp,
                fontWeight = if (index == segments.lastIndex) androidx.compose.ui.text.font.FontWeight.SemiBold else androidx.compose.ui.text.font.FontWeight.Normal,
                color = if (index == segments.lastIndex) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun SectionHeader(title: String, description: String) {
    Column(Modifier.padding(top = 10.dp, bottom = 6.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
        Text(description, Modifier.padding(top = 2.dp), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun EmptyHint(title: String, description: String, actionLabel: String? = null, action: () -> Unit = {}) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 22.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(Icons.Outlined.FolderOpen, null, Modifier.size(32.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(title, Modifier.padding(top = 12.dp), fontSize = 15.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
        Text(description, Modifier.padding(top = 6.dp), fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        if (actionLabel != null) OutlinedButton(onClick = action, modifier = Modifier.padding(top = 14.dp)) { Text(actionLabel) }
    }
}

@Composable
private fun RootEntryRow(root: JSONObject, onOpen: () -> Unit) {
    val available = root.optBoolean("available")
    ListItem(modifier = Modifier.clickable(enabled = available, onClick = onOpen).heightIn(min = 60.dp).testTag("root-row:${root.text("id")}"),
        leadingContent = { Icon(if (available) Icons.Outlined.FolderOpen else Icons.Outlined.FolderOff, null, Modifier.size(22.dp),
            tint = if (available) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant) },
        headlineContent = { Text(root.text("label")) },
        supportingContent = {
            Text(if (available) root.text("path").ifBlank { "可浏览" } else "当前不可用，无法浏览此目录",
                maxLines = 2, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, fontSize = 12.sp)
        },
        trailingContent = {
            if (available) Icon(Icons.Outlined.ChevronRight, "浏览此目录", tint = MaterialTheme.colorScheme.onSurfaceVariant)
            else Text("不可用", fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
        })
}

@Composable
private fun FileEntryRow(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, meta: String,
                         tint: Color = MaterialTheme.colorScheme.primary, needsFull: Boolean = false,
                         onShowFull: (() -> Unit)? = null, rowTag: String = "", onClick: () -> Unit) {
    ListItem(modifier = Modifier.clickable(onClick = onClick).heightIn(min = 56.dp)
        .then(if (rowTag.isBlank()) Modifier else Modifier.testTag(rowTag)),
        leadingContent = { Icon(icon, null, Modifier.size(22.dp), tint = tint) },
        headlineContent = { Text(title, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis) },
        supportingContent = if (meta.isBlank()) null else ({ Text(meta, maxLines = 1,
            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, fontSize = 12.sp) }),
        trailingContent = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (needsFull && onShowFull != null) IconButton(onClick = onShowFull, modifier = Modifier.size(48.dp)) {
                    Icon(Icons.Outlined.Info, "查看完整名称", Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Icon(Icons.Outlined.ChevronRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        })
}

private fun fileIcon(mime: String, isDir: Boolean): androidx.compose.ui.graphics.vector.ImageVector = when {
    isDir -> Icons.Outlined.Folder
    mime.startsWith("image/") -> Icons.Outlined.Image
    mime == "application/pdf" -> Icons.Outlined.PictureAsPdf
    mime.startsWith("text/") || mime.contains("json") || mime.contains("xml") -> Icons.Outlined.Description
    else -> Icons.Outlined.InsertDriveFile
}

private fun fileSizeLabel(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> String.format(java.util.Locale.US, "%.1f KB", bytes / 1024.0)
    else -> String.format(java.util.Locale.US, "%.1f MB", bytes / 1048576.0)
}

private fun fileMeta(size: Long, mtime: String): String =
    listOf(if (size >= 0) fileSizeLabel(size) else "", mtime.takeIf { it.length >= 10 }?.take(10) ?: "").filter { it.isNotBlank() }.joinToString(" · ")

private fun queryValues(path: String): Map<String, String> = path.substringAfter('?', "")
    .split('&').filter { it.contains('=') }
    .associate { part -> val pair = part.split('=', limit = 2)
        pair[0] to java.net.URLDecoder.decode(pair[1], "UTF-8") }

private fun reviewStatusLabel(status: String): String = when (status) {
    "M" -> "已修改"; "A" -> "新增"; "D" -> "已删除"; "R" -> "重命名"; "C" -> "复制"; "?" -> "未跟踪"
    else -> status.ifBlank { "变更" }
}

@Composable
private fun reviewStatusColor(status: String): Color = when (status) {
    "D" -> MaterialTheme.colorScheme.error
    "A" -> MaterialTheme.colorScheme.primary
    "?" -> BrandAmber
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}

private fun reviewStatusIcon(status: String): androidx.compose.ui.graphics.vector.ImageVector = when (status) {
    "M" -> Icons.Outlined.Edit
    "A" -> Icons.Outlined.AddCircle
    "D" -> Icons.Outlined.Delete
    "R", "C" -> Icons.Outlined.SwapHoriz
    "?" -> Icons.Outlined.HelpOutline
    else -> Icons.Outlined.InsertDriveFile
}

@Composable
private fun QueueScreen(model: ClientModel, edit: (JSONObject) -> Unit, confirm: (String, () -> Unit) -> Unit) {
    val state = model.state
    val queue = state.detail?.rows("pendingPrompts").orEmpty()
    val running = state.activeJob?.text("status") == "running"
    val events = state.detail?.rows("jobEvents").orEmpty().takeLast(200).reversed()
    LazyColumn(contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text("运行状态", style = MaterialTheme.typography.titleMedium)
            Text(if (state.activeJob == null) "当前没有运行任务" else "状态：${jobStatusLabel(state.activeJob?.text("status").orEmpty())} · 前方 ${state.activeJob?.optInt("queuePosition") ?: 0}")
            state.detail?.optJSONObject("contextUsage")?.let { Text("上下文 ${it.optLong("usedTokens")} / ${it.text("contextWindow", "未知")}", fontSize = 12.sp) }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (state.activeJob != null) OutlinedButton(onClick = { confirm("停止当前任务？已产生的文件不会自动回滚。") {
                    model.mutate("/jobs/${state.activeJob?.text("id").orEmpty().segment()}/cancel")
                } }, enabled = !state.busy) { Text("停止当前任务") }
                if (state.activeJob?.text("status") == "queued") OutlinedButton(onClick = { confirm("跳过队列立即执行？同工作目录中的任务可能相互影响。") {
                    model.mutate("/jobs/${state.activeJob?.text("id").orEmpty().segment()}/skip-queue")
                } }, enabled = !state.busy) { Text("直接执行") }
            }
        }
        state.editingPrompt?.let { prompt -> item {
            OutlinedCard {
                Column(Modifier.padding(16.dp)) {
                    Text("有一条暂停编辑的指令")
                    Text(prompt.text("content"), maxLines = 4)
                    FlowRow {
                        TextButton(onClick = { edit(prompt) }) { Text("继续编辑") }
                        TextButton(onClick = { model.mutate("${state.conversationPath}/pending-prompts/${prompt.text("id").segment()}/restore") }) { Text("恢复队列") }
                    }
                }
            }
        } }
        item { Text("待发送 · ${queue.size}", style = MaterialTheme.typography.titleMedium) }
        itemsIndexed(queue, key = { _, prompt -> prompt.text("id") }) { index, prompt ->
            QueueCard(model, prompt, index, queue.size, running, edit, confirm)
        }
        item { Text("执行过程 · 最近 200 条实时事件", style = MaterialTheme.typography.titleMedium) }
        if (events.isEmpty()) item {
            Text("任务还没有执行事件。开始运行后，这里会显示实时进度与结果摘要。", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        items(events) { event ->
            var expanded by remember(event.toString()) { mutableStateOf(false) }
            OutlinedCard(onClick = { expanded = !expanded }) {
                Column(Modifier.fillMaxWidth().padding(14.dp)) {
                    Text(event.text("label").ifBlank { event.text("kind").ifBlank { event.text("type", "事件") } })
                    Text(event.text("created_at"), fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (expanded) {
                        SelectionContainer { Text(event.text("detail").ifBlank { event.text("message") }) }
                        event.rows("steps").forEach { Text("${it.text("title")}\n${it.text("detail")}") }
                        event.rows("items").forEach { Text("${if (it.optBoolean("completed")) "✓" else "○"} ${it.text("text")}") }
                        event.strings("files").forEach { Text(it) }
                        listOf("riskLevel", "userAuthorization", "reviewStatus", "subagentStatus", "subagentActivity").forEach { key ->
                            if (event.text(key).isNotBlank()) Text("$key · ${event.text(key)}", fontSize = 12.sp)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun QueueCard(model: ClientModel, prompt: JSONObject, index: Int, total: Int, running: Boolean,
                      edit: (JSONObject) -> Unit, confirm: (String, () -> Unit) -> Unit) {
    val state = model.state
    var menu by remember { mutableStateOf(false) }
    OutlinedCard {
        Column(Modifier.fillMaxWidth().padding(start = 16.dp, top = 12.dp, end = 16.dp, bottom = 2.dp)) {
            Text(prompt.text("content").ifBlank { "附件任务" })
            prompt.rows("files").forEach { file -> FileChip(file) { model.previewFile(file) } }
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { model.beginPendingEdit(prompt, edit) }, enabled = !state.busy) {
                    Icon(Icons.Outlined.Edit, null, Modifier.size(16.dp))
                    Text("编辑", Modifier.padding(start = 6.dp))
                }
                Spacer(Modifier.weight(1f))
                IconButton(onClick = { menu = true }, enabled = !state.busy, modifier = Modifier.size(48.dp).testTag("queue-more-$index")) {
                    Icon(Icons.Outlined.MoreVert, "更多队列操作")
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text("上移") }, leadingIcon = { Icon(Icons.Outlined.ArrowUpward, null, Modifier.size(18.dp)) },
                        enabled = index > 0 && !state.busy, onClick = { menu = false; model.reorder(prompt.text("id"), -1) })
                    DropdownMenuItem(text = { Text("下移") }, leadingIcon = { Icon(Icons.Outlined.ArrowDownward, null, Modifier.size(18.dp)) },
                        enabled = index < total - 1 && !state.busy, onClick = { menu = false; model.reorder(prompt.text("id"), 1) })
                    if (running) DropdownMenuItem(text = { Text("引导") }, leadingIcon = { Icon(Icons.Outlined.Podcasts, null, Modifier.size(18.dp)) },
                        enabled = !state.busy, onClick = { menu = false
                            confirm("把这条指令作为当前运行任务的引导？") {
                                model.mutate("${state.conversationPath}/pending-prompts/${prompt.text("id").segment()}/steer")
                            } })
                    HorizontalDivider(Modifier.padding(vertical = 4.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .5f))
                    DropdownMenuItem(text = { Text("删除", color = MaterialTheme.colorScheme.error) },
                        leadingIcon = { Icon(Icons.Outlined.Delete, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.error) },
                        enabled = !state.busy, onClick = { menu = false
                            confirm("删除这条待发送指令及其附件？") {
                                model.mutate("${state.conversationPath}/pending-prompts/${prompt.text("id").segment()}", "DELETE")
                            } })
                }
            }
        }
    }
}

@Composable
private fun FileTreeScreen(model: ClientModel, data: JSONObject) {
    val state = model.state
    val listing = data.optJSONObject("listing")
    val page = state.page ?: return
    var nameInfo by remember(page) { mutableStateOf<Pair<String, String>?>(null) }
    when {
        state.pageLoading && state.pageData == null -> ToolColumn {
            page.args.text("rootLabel").takeIf { it.isNotBlank() }?.let { label ->
                BreadcrumbRow(label, page.args.text("path"))
                Spacer(Modifier.height(24.dp))
            }
            PageLoadingView("正在读取文件…")
        }
        state.pageError != null && state.pageData == null -> ToolColumn {
            page.args.text("rootLabel").takeIf { it.isNotBlank() }?.let { label -> BreadcrumbRow(label, page.args.text("path")) }
            Spacer(Modifier.height(12.dp))
            InlineError(model.state.pageError.orEmpty(), retry = { model.refresh() }, back = { model.back() })
        }
        else -> LazyColumn(Modifier.fillMaxSize().testTag("files-list"), contentPadding = PaddingValues(horizontal = 18.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp)) {
            if (listing == null) {
                item(key = "section-output") { SectionHeader("任务产物", "任务运行生成的结果文件，点击预览或下载") }
                val outputs = state.detail?.rows("outputFiles").orEmpty()
                items(outputs, key = { "output:${it.text("id")}" }) { file ->
                    FileEntryRow(fileIcon(file.text("mime_type"), false), file.text("original_name", file.text("name")),
                        fileMeta(file.optLong("size", -1), file.text("created_at")), rowTag = "output-row:${file.text("id")}") { model.previewFile(file) }
                }
                if (outputs.isEmpty()) item(key = "output-empty") {
                    EmptyHint("任务还没有生成文件", "任务完成后，生成的文件会出现在这里。可以返回对话继续描述你需要的产物。",
                        "返回对话") { model.back() }
                }
                item(key = "divider") { HorizontalDivider(Modifier.padding(vertical = 10.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .5f)) }
                item(key = "section-browse") { SectionHeader("浏览项目文件", "按根目录查看任务工作目录、会话工作区和资料库") }
                items(data.rows("roots"), key = { "root:${it.text("id")}" }) { root ->
                    RootEntryRow(root) {
                        model.navigate(ToolPage(root.text("label"), "files",
                            "${state.conversationPath}/file-tree?root=${root.text("id").segment()}&path=",
                            json("rootId" to root.text("id"), "rootLabel" to root.text("label"), "path" to "")))
                    }
                }
                item(key = "attach") {
                    FileEntryRow(Icons.Outlined.AttachFile, "从服务器添加附件", "浏览服务器目录并加入草稿", tint = MaterialTheme.colorScheme.onSurfaceVariant) {
                        model.navigate(ToolPage("服务器文件", "host", "/path-browser", json("attach" to true)))
                    }
                }
            } else {
                val rootId = listing.text("rootId")
                val rootLabel = data.rows("roots").find { it.text("id") == rootId }?.text("label")
                    ?: page.args.text("rootLabel", "文件")
                item(key = "breadcrumb") {
                    Column(Modifier.padding(bottom = 6.dp)) {
                        BreadcrumbRow(rootLabel, listing.text("path"))
                        if (!listing.isNull("parentPath")) TextButton(onClick = { model.back() }, contentPadding = PaddingValues(horizontal = 4.dp)) {
                            // 上一层目录就在页面栈中：返回弹出而不是再压入一层，避免返回链越退越长
                            Icon(Icons.Outlined.ArrowUpward, null, Modifier.size(16.dp))
                            Text("上一级", Modifier.padding(start = 6.dp), fontSize = 13.sp)
                        }
                    }
                }
                val entries = listing.rows("entries")
                items(entries, key = { "entry:${it.text("path")}" }) { entry ->
                    val isDir = entry.text("type") == "dir"
                    val name = entry.text("name")
                    val needsFull = name.length > 18 || entry.text("display_path").length > 34
                    FileEntryRow(fileIcon(entry.text("mime_type"), isDir), name, fileMeta(entry.optLong("size", -1), entry.text("mtime"))
                        .ifBlank { if (isDir) "目录" else "" },
                        needsFull = needsFull, rowTag = "file-row:${entry.text("path")}",
                        onShowFull = if (needsFull) ({ nameInfo = name to entry.text("display_path") }) else null) {
                        val query = "root=${rootId.segment()}&path=${entry.text("path").segment()}"
                        if (isDir) model.navigate(ToolPage(name, "files", "${state.conversationPath}/file-tree?$query",
                            json("rootId" to rootId, "rootLabel" to rootLabel, "path" to entry.text("path"))))
                        else {
                            val mime = entry.text("mime_type")
                            val args = json("downloadPath" to "${state.conversationPath}/file-tree/file?$query", "mime" to mime)
                            if (entry.optBoolean("previewable") && !mime.startsWith("image/") && mime != "application/pdf") {
                                args.put("snippetPath", "${state.conversationPath}/file-tree/preview?$query")
                            }
                            model.navigate(ToolPage(name, "preview", "", args))
                        }
                    }
                }
                if (entries.isEmpty()) item(key = "empty-dir") {
                    EmptyHint("这个目录是空的", "子目录和文件会显示在这里，也可以返回上一级查看其他内容。")
                }
                if (listing.optBoolean("truncated")) item(key = "truncated") {
                    Text("目录内容较多已截断，请进入更具体的子目录查看。", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            item(key = "bottom-space") { Spacer(Modifier.height(24.dp)) }
        }
    }
    nameInfo?.let { (name, fullPath) ->
        AlertDialog(onDismissRequest = { nameInfo = null }, title = { Text("完整名称") },
            text = { Column { Text(name, Modifier.horizontalScroll(rememberScrollState())); Text(fullPath, Modifier.padding(top = 8.dp), fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) } },
            confirmButton = { TextButton(onClick = { nameInfo = null }) { Text("关闭") } })
    }
}

@Composable
private fun ReviewScreen(model: ClientModel, data: JSONObject, listState: LazyListState) {
    val state = model.state
    val page = state.page ?: return
    val query = queryValues(page.path)
    val scope = page.args.text("scope", query["scope"] ?: "working")
    val navigateScope: (String) -> Unit = { value ->
        model.navigate(ToolPage("代码 Review", "review", "${state.conversationPath}/review?scope=$value", json("scope" to value)), replace = true)
    }
    if (state.pageLoading && state.pageData == null) { PageLoadingView("正在读取变更…"); return }
    // 读取失败必须与“真正的空差异”区分：失败态给错误、重试与返回，不显示“没有变更”
    if (state.pageError != null && state.pageData == null) { PageErrorView(model, "读取变更失败"); return }
    val files = data.rows("files")
    val counted = files.filter { it.optLong("additions", -1) >= 0 }
    val additions = counted.sumOf { it.optLong("additions", 0) }
    val deletions = counted.sumOf { it.optLong("deletions", 0) }
    val summaryLine = when {
        files.isEmpty() -> ""
        counted.size < files.size -> "${files.size} 个文件 · +$additions / -$deletions · 部分文件未统计行数"
        else -> "${files.size} 个文件 · +$additions / -$deletions"
    }
    LazyColumn(state = listState, modifier = Modifier.fillMaxSize().testTag("review-list"),
        contentPadding = PaddingValues(horizontal = 18.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        item(key = "summary") {
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(Modifier.fillMaxWidth().padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.AccountTree, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary)
                        Text(data.text("branch").ifBlank { "未知分支" }, Modifier.padding(start = 8.dp),
                            fontSize = 15.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
                    }
                    Text(data.text("comparison").ifBlank { "读取变更范围失败" }, Modifier.padding(top = 2.dp), fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (summaryLine.isNotBlank()) Text(summaryLine, Modifier.padding(top = 2.dp), fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    ChoiceField("范围", scope, listOf("working" to "工作区", "staged" to "暂存区", "branch" to "分支对比"),
                        Modifier.padding(top = 8.dp, start = 16.dp, end = 16.dp)) { navigateScope(it) }
                    if (scope == "branch") ChoiceField("基准分支", data.text("base"), data.strings("bases").map { it to it },
                        Modifier.padding(top = 4.dp, start = 16.dp, end = 16.dp)) { base ->
                        model.navigate(ToolPage("代码 Review", "review", "${state.conversationPath}/review?scope=branch&base=${base.segment()}", json("scope" to "branch")), replace = true)
                    }
                }
            }
        }
        state.pageError?.let { message -> item(key = "stale-error") {
            Surface(color = MaterialTheme.colorScheme.errorContainer, shape = RoundedCornerShape(12.dp)) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("刷新失败：${friendlyIoMessage(message)}", Modifier.weight(1f), fontSize = 12.sp, maxLines = 3)
                    TextButton(onClick = { model.refresh() }, enabled = !state.busy) { Text("重试") }
                }
            }
        } }
        if (files.isEmpty()) item(key = "empty-diff") {
            Column(Modifier.fillMaxWidth().padding(vertical = 36.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(Icons.Outlined.TaskAlt, null, Modifier.size(40.dp), tint = MaterialTheme.colorScheme.primary)
                Text("当前范围内没有变更", Modifier.padding(top = 16.dp), style = MaterialTheme.typography.titleMedium)
                Text("对比已完成且没有差异。可切换范围或刷新后查看其他变更。", Modifier.padding(top = 8.dp),
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                OutlinedButton(onClick = { model.refresh() }, enabled = !state.busy, modifier = Modifier.padding(top = 18.dp)) { Text("刷新") }
            }
        }
        items(files, key = { "file:${it.text("path")}" }) { file ->
            val status = file.text("status")
            ListItem(modifier = Modifier.clickable {
                model.navigate(ToolPage(file.text("path"), "patch",
                    "${state.conversationPath}/review?scope=$scope&base=${data.text("base").segment()}&file=${file.text("path").segment()}",
                    json("scope" to scope)))
            }.heightIn(min = 56.dp),
                leadingContent = { Icon(reviewStatusIcon(status), null, Modifier.size(20.dp), tint = reviewStatusColor(status)) },
                headlineContent = { Text(file.text("path"), fontFamily = FontFamily.Monospace, fontSize = 13.sp, maxLines = 2,
                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis) },
                supportingContent = {
                    val stat = file.optLong("additions", -1)
                    Text("${reviewStatusLabel(status)}" + if (stat >= 0) " · +${file.optLong("additions", 0)} / -${file.optLong("deletions", 0)}" else " · 行数未统计",
                        fontSize = 12.sp)
                },
                trailingContent = { Icon(Icons.Outlined.ChevronRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant) })
        }
        item(key = "bottom-space") { Spacer(Modifier.height(24.dp)) }
    }
}

@Composable
private fun PatchScreen(model: ClientModel, page: ToolPage, data: JSONObject) {
    val state = model.state
    when {
        state.pageLoading && state.pageData == null -> PageLoadingView("正在读取差异…")
        state.pageError != null && state.pageData == null -> PageErrorView(model, "读取差异失败")
        else -> ToolColumn {
            data.rows("files").find { it.text("path") == page.title }?.let { file ->
                val stat = file.optLong("additions", -1)
                Text("${reviewStatusLabel(file.text("status"))}" + if (stat >= 0) " · +${file.optLong("additions", 0)} / -${file.optLong("deletions", 0)}" else "",
                    fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (data.optBoolean("truncated")) Text("差异过长已截断，这里仅显示前一部分。", color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
            val patch = data.text("patch")
            when {
                patch == "二进制文件，不提供文本 diff。" || patch == "符号链接或特殊文件，不提供内容预览。" -> Surface(
                    shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.Info, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
                        Text(patch, Modifier.padding(start = 10.dp), fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                patch.isBlank() -> Text("此文件没有可显示的文本差异。", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                else -> CodeBlock(patch)
            }
        }
    }
}

@Composable
fun CodeBlock(text: String) {
    SelectionContainer {
        Text(text, modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).background(MaterialTheme.colorScheme.surfaceContainer).padding(12.dp),
            fontFamily = FontFamily.Monospace, fontSize = 13.sp, softWrap = false)
    }
}

@Composable
private fun DirectoriesScreen(model: ClientModel, data: JSONObject, form: (FormRequest) -> Unit, confirm: (String, () -> Unit) -> Unit) {
    val state = model.state
    val settings = data.objectValue("settings")
    ToolColumn {
        Text("当前：${state.conversation.text("working_dir", "独立工作区")}")
        if (!settings.optBoolean("enabled")) Text("此服务未启用宿主目录功能。")
        else {
            Text("默认新任务目录：${settings.text("defaultWorkingDir", "独立工作区")}", fontSize = 13.sp)
            OutlinedButton(onClick = { model.navigate(ToolPage("浏览工作目录", "host", "/path-browser")) }) { Text("浏览目录") }
            OutlinedButton(onClick = { form(FormRequest("添加收藏目录", listOf(FormField("path", "绝对路径", required = true), FormField("label", "显示名称"))) {
                model.mutate("/working-dirs/favorites", "PUT", it.changed("action" to "add"))
            }) }) { Text("添加收藏") }
            settings.rows("favorites").forEach { favorite ->
                val path = favorite.text("path")
                Text(favorite.text("label", path), style = MaterialTheme.typography.titleMedium)
                Text(path, fontSize = 12.sp)
                FlowRow {
                    TextButton(onClick = { if (state.selectedId == null) model.createConversation(path)
                        else confirm("把此任务工作目录切换为 $path？如果该目录还有其他任务，它们可能相互影响文件。") {
                            model.mutate("${state.conversationPath}/working-dir", "PUT", json("workingDir" to path, "confirm" to true))
                        }
                    }) { Text(if (state.selectedId == null) "在此新建" else "切换到此目录") }
                    TextButton(onClick = { model.mutate("/working-dirs/default", "PUT", json("path" to path)) }) { Text("设为默认") }
                    TextButton(onClick = { form(FormRequest("重命名收藏", listOf(FormField("label", "名称", favorite.text("label")))) {
                        model.mutate("/working-dirs/favorites", "PUT", it.changed("action" to "rename", "path" to path))
                    }) }) { Text("重命名") }
                    TextButton(onClick = { model.mutate("/working-dirs/favorites", "PUT", json("action" to "move", "path" to path, "direction" to "up")) }) { Text("上移") }
                    TextButton(onClick = { confirm("移除目录收藏？不会删除目录内容。") {
                        model.mutate("/working-dirs/favorites", "PUT", json("action" to "remove", "path" to path))
                    } }) { Text("移除") }
                }
            }
            TextButton(onClick = { model.mutate("/working-dirs/default", "PUT", json("path" to null)) }) { Text("新任务默认使用独立工作区") }
        }
        if (state.selectedId != null) TextButton(onClick = { confirm("将当前任务切换回独立工作区？") {
            model.mutate("${state.conversationPath}/working-dir", "PUT", json("workingDir" to null))
        } }) { Text("当前任务使用独立工作区") }
    }
}

@Composable
private fun HostScreen(model: ClientModel, data: JSONObject, confirm: (String, () -> Unit) -> Unit) {
    val listing = data.objectValue("listing")
    val state = model.state
    val attach = state.page?.args?.optBoolean("attach") == true
    ToolColumn {
        SelectionContainer { Text(listing.text("path")) }
        if (!listing.isNull("parent")) OutlinedButton(onClick = { model.navigate(ToolPage("服务器目录", "host", "/path-browser?path=${listing.text("parent").segment()}", json("attach" to attach))) }) { Text("上级目录") }
        if (!attach) Button(onClick = { confirm("收藏目录 ${listing.text("path")}？") {
            model.mutate("/working-dirs/favorites", "PUT", json("action" to "add", "path" to listing.text("path")))
        } }) { Text("收藏当前目录") }
        listing.rows("entries").filter { attach || it.text("type") == "dir" }.forEach { item ->
            ToolRow((if (item.text("type") == "dir") "目录 · " else "文件 · ") + item.text("name")) {
                if (item.text("type") == "dir") model.navigate(ToolPage(item.text("name"), "host", "/path-browser?path=${item.text("path").segment()}", json("attach" to attach)))
                else confirm("把 ${item.text("name")} 添加到当前草稿附件？") {
                    model.mutate("${state.conversationPath}/draft/files/from-host", "POST", json("paths" to listOf(item.text("path")).jsonArray()))
                }
            }
        }
        if (listing.optBoolean("truncated")) Text("目录内容已截断")
    }
}

@Composable
private fun SettingsScreen(model: ClientModel, form: (FormRequest) -> Unit, confirm: (String, () -> Unit) -> Unit) {
    val state = model.state
    val context = androidx.compose.ui.platform.LocalContext.current
    val version = remember { runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull().orEmpty() }
    ToolColumn {
        Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surface, modifier = Modifier.testTag("account-header")) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp).heightIn(min = 72.dp), verticalAlignment = Alignment.CenterVertically) {
                BrandMark(Modifier.size(44.dp))
                Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                    Text(state.session?.text("displayName").orEmpty().ifBlank { state.session?.text("username").orEmpty() },
                        maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, fontSize = 16.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
                    Text(runCatching { java.net.URI(state.server).host }.getOrNull().orEmpty().ifBlank { state.server },
                        Modifier.padding(top = 2.dp), maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                        fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        Text("外观与阅读", Modifier.padding(start = 4.dp, top = 8.dp), fontSize = 13.sp,
            fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
            Column {
                ChoiceField("外观", state.theme, listOf("system" to "跟随系统", "light" to "浅色", "dark" to "深色"),
                    Modifier.padding(horizontal = 16.dp)) { model.appearance(theme = it) }
                HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .5f))
                Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp).testTag("font-size-row")) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("聊天字号", Modifier.weight(1f), fontSize = 15.sp)
                        Text("${state.fontSize}", fontSize = 15.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold, color = MaterialTheme.colorScheme.primary)
                    }
                    Text("范围 12–24 · 应用于聊天正文与样文", Modifier.padding(top = 2.dp), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Slider(value = state.fontSize.toFloat(), onValueChange = { model.appearance(font = it.toInt()) }, valueRange = 12f..24f, steps = 11,
                        modifier = Modifier.padding(top = 6.dp).testTag("font-size-slider"))
                    Text("样文预览：任务交给 Codex，进度随时可查。", Modifier.padding(top = 6.dp), fontSize = state.fontSize.sp, maxLines = 2)
                }
            }
        }
        Text("任务与数据", Modifier.padding(start = 4.dp, top = 8.dp), fontSize = 13.sp,
            fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
            Column {
                listOf(Triple("预设指令", "presets", "/preset-prompts"), Triple("工作目录", "directories", "/working-dirs"),
                    Triple("任务分类", "categories", "/task-categories"), Triple("API 统计与费率", "billing", "/billing?days=30"),
                    Triple("已归档任务", "archived", "/conversations/archived"), Triple("导入历史会话", "import", "/conversations/importable-sessions")
                ).forEachIndexed { index, (title, kind, path) ->
                    if (index > 0) HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .35f))
                    ToolRow(title) { model.navigate(ToolPage(title, kind, path)) }
                }
                if (state.session?.optBoolean("providerManagementEnabled") == true) {
                    HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .35f))
                    ToolRow("API 源与模型") { model.navigate(ToolPage("API 源与模型", "providers", "/providers")) }
                } else {
                    HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .35f))
                    ToolRow("启用 API 源管理", "遵守服务器能力与权限检查") { model.mutate("/user-settings/provider-management", "PUT", json("enabled" to true)) }
                }
            }
        }
        Text("账户与安全", Modifier.padding(start = 4.dp, top = 8.dp), fontSize = 13.sp,
            fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
            Column {
                ToolRow("本地浏览缓存", "加密保存近期任务，打开时先展示缓存再更新") {
                    confirm("清理当前账号的任务浏览缓存？未发送草稿、登录状态和服务器数据不会删除。") { model.clearCache() }
                }
                HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .35f))
                ToolRow("账户与密码") {
                    val fields = mutableListOf(FormField("currentPassword", "当前密码", kind = "secret", required = true), FormField("newPassword", "新密码（不修改则留空）", kind = "secret"))
                    if (state.session?.optBoolean("canChangeUsername") == true) fields.add(FormField("newUsername", "用户名", state.session.text("username")))
                    form(FormRequest("更新账户", fields, "密码只用于此请求，不保存在客户端。") { model.mutate("/auth/account", "PUT", it) })
                }
                HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .35f))
                ToolRow("退出登录") { confirm("退出当前账号？未同步草稿会先尝试保存；任务继续在服务器执行。") { model.logout() } }
                HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .35f))
                ToolRow("更换服务器") { confirm("注销并更换服务器？服务器上的任务与数据不会删除。") { model.changeServer() } }
            }
        }
        Text("Codex Native${if (version.isNotBlank()) " · $version" else ""}\n原生对话 · 项目任务 · 本地缓存", Modifier.fillMaxWidth().padding(vertical = 12.dp), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
    }
}

@Composable
private fun PresetsScreen(model: ClientModel, data: JSONObject, form: (FormRequest) -> Unit, confirm: (String, () -> Unit) -> Unit) {
    fun edit(preset: JSONObject?) {
        form(FormRequest(if (preset == null) "创建预设" else "编辑预设", listOf(
            FormField("name", "名称", preset?.text("name").orEmpty(), required = true),
            FormField("content", "指令内容", preset?.text("content").orEmpty(), "multiline", true),
            FormField("defaultEnabled", "新任务默认启用", (preset?.optBoolean("defaultEnabled") ?: false).toString(), "bool"),
        )) { model.mutate("/preset-prompts" + if (preset != null) "/${preset.text("id").segment()}" else "", if (preset == null) "POST" else "PUT", it) })
    }
    ToolColumn {
        Button(onClick = { edit(null) }) { Text("创建预设") }
        data.rows("presetPrompts").forEachIndexed { index, preset ->
            ToolRow(preset.text("name"), preset.text("content")) { edit(preset) }
            FlowRow {
                TextButton(onClick = { model.mutate("/preset-prompts/${preset.text("id").segment()}", "PUT", json("position" to (index - 1).coerceAtLeast(0))) }) { Text("上移") }
                TextButton(onClick = { confirm("删除预设 ${preset.text("name")}？") { model.mutate("/preset-prompts/${preset.text("id").segment()}", "DELETE") } }) { Text("删除") }
            }
        }
    }
}

@Composable
private fun ProvidersScreen(model: ClientModel, data: JSONObject, form: (FormRequest) -> Unit, confirm: (String, () -> Unit) -> Unit) {
    fun edit(provider: JSONObject?) {
        val fields = listOf(FormField("name", "名称", provider?.text("name").orEmpty(), required = true),
            FormField("baseUrl", "API Base URL", provider?.text("baseUrl").orEmpty()),
            FormField("apiKey", "API Key（留空保持不变）", kind = "secret"),
            FormField("wireApi", "接口协议：responses / chat / anthropic", provider?.text("wireApi") ?: "responses"),
            FormField("modelsFile", "服务端模型文件（可选）", provider?.text("modelsFile").orEmpty()),
            FormField("autoReviewModelOverride", "Review 模型覆盖（可选）", provider?.text("autoReviewModelOverride").orEmpty()),
            FormField("requiresOpenaiAuth", "使用服务端已配置的官方认证", (provider?.optBoolean("requiresOpenaiAuth") ?: false).toString(), "bool"),
            FormField("enabled", "启用", (provider?.optBoolean("enabled") ?: true).toString(), "bool"))
        form(FormRequest(if (provider == null) "新增 API 源" else "编辑 API 源", fields,
            "API Key 仅提交至当前服务器，不在客户端持久保存；官方认证仍由服务器配置。") {
            model.mutate("/providers" + if (provider == null) "" else "/${provider.text("id").segment()}", if (provider == null) "POST" else "PUT", it)
        })
    }
    ToolColumn {
        FlowRow {
            Button(onClick = { edit(null) }) { Text("新增 API 源") }
            TextButton(onClick = { confirm("从服务器配置导入 API 源？") { model.mutate("/providers/import-config") } }) { Text("导入配置") }
        }
        data.rows("providers").forEach { provider ->
            ToolRow(provider.text("name"), "${if (provider.optBoolean("enabled")) "已启用" else "已停用"} · ${provider.text("baseUrl")}") { edit(provider) }
            FlowRow {
                TextButton(onClick = { model.navigate(ToolPage(provider.text("name") + " · 模型", "models", "/providers", json("providerId" to provider.text("id")))) }) { Text("管理模型") }
                TextButton(onClick = { model.mutate("/providers/${provider.text("id").segment()}/import-models") }) { Text("导入模型") }
                TextButton(onClick = { confirm("删除 API 源 ${provider.text("name")} 及其模型配置？") { model.mutate("/providers/${provider.text("id").segment()}", "DELETE") } }) { Text("删除") }
            }
        }
    }
}

@Composable
private fun ModelsScreen(model: ClientModel, data: JSONObject, form: (FormRequest) -> Unit, confirm: (String, () -> Unit) -> Unit) {
    val provider = model.state.page?.args?.text("providerId").orEmpty()
    fun edit(item: JSONObject?) {
        val fields = mutableListOf<FormField>()
        if (item == null) fields.add(FormField("modelId", "模型 ID", required = true))
        fields.addAll(listOf(FormField("displayName", "显示名称", item?.text("displayName").orEmpty()),
            FormField("description", "描述", item?.text("description").orEmpty(), "multiline"),
            FormField("reasoningEfforts", "思考强度（逗号分隔）", item?.strings("reasoningEfforts")?.joinToString(",") ?: "low,medium,high", "lines"),
            FormField("inputModalities", "输入类型（逗号分隔）", item?.strings("inputModalities")?.joinToString(",") ?: "text,image", "lines"),
            FormField("modelContextWindow", "上下文窗口", item?.text("modelContextWindow").orEmpty(), "int"),
            FormField("autoCompactTokenLimit", "自动压缩阈值", item?.text("autoCompactTokenLimit").orEmpty(), "int"),
            FormField("priority", "排序优先级", item?.text("priority") ?: "0", "int"),
            FormField("visible", "可见", (item?.optBoolean("visible") ?: true).toString(), "bool")))
        form(FormRequest(if (item == null) "新增模型" else "编辑模型", fields) {
            model.mutate("/providers/${provider.segment()}/models" + if (item == null) "" else "/${item.text("id").segment()}", if (item == null) "POST" else "PUT", it)
        })
    }
    ToolColumn {
        Button(onClick = { edit(null) }) { Text("新增模型") }
        data.rows("models").filter { it.text("providerId") == provider }.forEach { item ->
            ToolRow(item.text("displayName"), item.text("modelId")) { edit(item) }
            TextButton(onClick = { confirm("删除模型 ${item.text("modelId")}？") { model.mutate("/providers/${provider.segment()}/models/${item.text("id").segment()}", "DELETE") } }) { Text("删除模型") }
        }
    }
}

@Composable
private fun BillingScreen(model: ClientModel, data: JSONObject, form: (FormRequest) -> Unit, confirm: (String, () -> Unit) -> Unit) {
    ToolColumn {
        val summary = data.objectValue("summary")
        Text("${summary.text("estimatedCost", "0")} ${summary.text("currency")}", style = MaterialTheme.typography.headlineMedium)
        Text("估算费用 · ${summary.text("calls", "0")} 次调用 · ${summary.text("unpricedCalls", "0")} 次未定价")
        Text("输入 ${summary.text("inputTokens", "0")} · 输出 ${summary.text("outputTokens", "0")} · 缓存命中 ${summary.text("cacheHitRate", "0")}", fontSize = 12.sp)
        ChoiceField("时间范围", data.text("rangeDays", "30"), listOf("7" to "7 天", "30" to "30 天", "90" to "90 天")) { model.navigate(ToolPage("API 统计", "billing", "/billing?days=$it")) }
        data.rows("byModel").forEach { item ->
            Text("${item.text("providerName")} / ${item.text("modelId")}", style = MaterialTheme.typography.titleSmall)
            Text("${item.text("calls")} 次 · ${item.text("estimatedCost", "未定价")} ${item.text("currency")}", fontSize = 13.sp)
        }
        FlowRow {
            OutlinedButton(onClick = { confirm("清除历史费率记录并按当前费率重算历史统计？") { model.mutate("/billing/recalculate?days=${data.optInt("rangeDays", 30)}") } }) { Text("重算历史") }
            TextButton(onClick = { confirm("从 API 源同步远程价格？") { model.mutate("/billing/sync-pricing") } }) { Text("同步价格") }
        }
        Text("模型费率（每百万 token）", style = MaterialTheme.typography.titleMedium)
        data.rows("models").forEach { item ->
            ToolRow("${item.text("providerName")} / ${item.text("displayName")}") {
                val rule = data.rows("rules").find { it.text("provider_id") == item.text("providerId") && it.text("model_id") == item.text("modelId") } ?: JSONObject()
                val fields = listOf(FormField("inputPerMillion", "输入", rule.text("input_per_million", "0"), "number", true),
                    FormField("cacheReadPerMillion", "缓存读取", rule.text("cached_input_per_million", "0"), "number", true),
                    FormField("cacheWritePerMillion", "缓存写入", rule.text("cache_write_per_million", "0"), "number", true),
                    FormField("outputPerMillion", "输出", rule.text("output_per_million", "0"), "number", true),
                    FormField("currency", "币种", rule.text("currency", "USD")),
                    FormField("peakEnabled", "启用高峰费率", (rule.optInt("peak_enabled") == 1).toString(), "bool"),
                    FormField("peakInputPerMillion", "高峰输入", rule.text("peak_input_per_million"), "number"),
                    FormField("peakCacheReadPerMillion", "高峰缓存读取", rule.text("peak_cached_input_per_million"), "number"),
                    FormField("peakCacheWritePerMillion", "高峰缓存写入", rule.text("peak_cache_write_per_million"), "number"),
                    FormField("peakOutputPerMillion", "高峰输出", rule.text("peak_output_per_million"), "number"),
                    FormField("peakStart", "高峰开始 HH:mm", minuteTime(rule.optInt("peak_start_minute", 540))),
                    FormField("peakEnd", "高峰结束 HH:mm", minuteTime(rule.optInt("peak_end_minute", 1080))),
                    FormField("peakWeekdays", "星期 1–7，逗号分隔", rule.text("peak_weekdays", "1,2,3,4,5").removeSurrounding("[", "]"), "numbers"),
                    FormField("timezone", "IANA 时区", rule.text("timezone", "UTC")))
                form(FormRequest("费率设置", fields, "更改定价不会自动重算已有账单。") {
                    model.mutate("/billing/pricing-rules/${item.text("providerId").segment()}/${item.text("modelId").segment()}", "PUT", it)
                })
            }
        }
    }
}

private fun minuteTime(minutes: Int) = "%02d:%02d".format(minutes / 60, minutes % 60)

@Composable
private fun CategoriesScreen(model: ClientModel, data: JSONObject, form: (FormRequest) -> Unit, confirm: (String, () -> Unit) -> Unit) {
    val settings = data.objectValue("settings")
    ToolColumn {
        Button(onClick = { form(FormRequest("新建分类", listOf(FormField("name", "分类名称", required = true))) { model.mutate("/task-categories/custom", "POST", it) }) }) { Text("新建分类") }
        data class Group(val key: String, val name: String, val id: String?, val dirs: List<String>)
        val groups = listOf(Group("auto:standalone", "独立任务", null, emptyList())) +
            settings.rows("customCategories").map { Group("custom:${it.text("id")}", it.text("name"), it.text("id"), it.strings("assignedDirs")) } +
            model.state.conversations.map { it.text("working_dir") }.filter { it.isNotBlank() }.distinct()
                .filter { dir -> settings.rows("customCategories").none { dir in it.strings("assignedDirs") } }
                .map { Group("auto:dir:${it.segment()}", it.substringAfterLast('/'), null, listOf(it)) }
        groups.sortedBy { if (it.key in settings.strings("pinned")) 0 else 1 }.forEach { group ->
            ToolRow(group.name, group.dirs.joinToString("\n")) {
                model.navigate(ToolPage(group.name, "category-tasks", "/task-categories", json("key" to group.key, "dirs" to group.dirs.jsonArray())))
            }
            FlowRow {
                TextButton(onClick = { val pinned = settings.strings("pinned"); model.mutate("/task-categories/pins", "PUT",
                    json("keys" to (if (group.key in pinned) pinned - group.key else pinned + group.key).jsonArray())) }) { Text(if (group.key in settings.strings("pinned")) "取消置顶" else "置顶") }
                TextButton(onClick = { val hidden = settings.strings("hidden"); model.mutate("/task-categories/hidden", "PUT",
                    json("keys" to (if (group.key in hidden) hidden - group.key else hidden + group.key).jsonArray())) }) { Text(if (group.key in settings.strings("hidden")) "取消隐藏" else "隐藏") }
                if (group.id != null) {
                    TextButton(onClick = { form(FormRequest("重命名分类", listOf(FormField("name", "名称", group.name, required = true))) { model.mutate("/task-categories/custom/${group.id.segment()}", "PATCH", it) }) }) { Text("重命名") }
                    TextButton(onClick = { form(FormRequest("分配工作目录", listOf(FormField("dir", "绝对路径", required = true))) { model.mutate("/task-categories/dirs", "PUT", it.changed("categoryId" to group.id)) }) }) { Text("添加目录") }
                    group.dirs.forEach { dir -> TextButton(onClick = { model.mutate("/task-categories/dirs", "PUT", json("dir" to dir, "categoryId" to null)) }) { Text("移出 ${dir.substringAfterLast('/')}") } }
                    TextButton(onClick = { confirm("删除分类（保留任务）？") { model.mutate("/task-categories/custom/${group.id.segment()}", "DELETE") } }) { Text("删除") }
                }
            }
        }
        Text("隐藏只影响分类快捷入口，不删除任务；全部列表仍可搜索所有任务。", style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun CategoryTasks(model: ClientModel, page: ToolPage) {
    val key = page.args.text("key")
    val dirs = page.args.strings("dirs")
    val order = model.state.pageData?.objectValue("settings")?.objectValue("conversationOrders")?.strings(key).orEmpty()
    val tasks = model.state.conversations.filter { if (key == "auto:standalone") it.text("working_dir").isEmpty() else it.text("working_dir") in dirs }
        .sortedBy { order.indexOf(it.text("id")).let { index -> if (index == -1) -1 else index } }
    ToolColumn { tasks.forEach { task ->
        ToolRow(task.text("title")) { model.openConversation(task.text("id")) }
        TextButton(onClick = {
            val ids = tasks.map { it.text("id") }.toMutableList()
            val position = ids.indexOf(task.text("id"))
            if (position > 0) java.util.Collections.swap(ids, position, position - 1)
            model.mutate("/task-categories/conversation-order", "PUT", json("categoryKey" to key, "conversationIds" to ids.jsonArray()))
        }) { Text("上移") }
    } }
}

@Composable
private fun ImportScreen(model: ClientModel, data: JSONObject) {
    var selected by remember { mutableStateOf(emptySet<String>()) }
    ToolColumn {
        Text("从服务器已有 Codex 会话导入，不读取手机本地会话。")
        data.rows("sessions").forEach { session ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(session.text("threadId") in selected, onCheckedChange = { selected = if (it) selected + session.text("threadId") else selected - session.text("threadId") })
                Column(Modifier.weight(1f)) { Text(session.text("title")); Text(session.text("cwd"), fontSize = 12.sp) }
            }
        }
        Button(onClick = { model.mutate("/conversations/import-sessions", "POST", json("threadIds" to selected.toList().jsonArray())); selected = emptySet() }, enabled = selected.isNotEmpty() && !model.state.busy) { Text("导入 ${selected.size} 个会话") }
    }
}
