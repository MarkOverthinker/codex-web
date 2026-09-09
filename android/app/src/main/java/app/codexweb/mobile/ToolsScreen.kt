@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package app.codexweb.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
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
        "review" -> ReviewScreen(model, data, openForm)
        "patch" -> ToolColumn { if (data.optBoolean("truncated")) Text("差异已截断", color = MaterialTheme.colorScheme.error); CodeBlock(data.text("patch")) }
        "side" -> ToolColumn {
            Text("线程独占一个页面，与主任务互不挤占。", style = MaterialTheme.typography.bodyMedium)
            Button(onClick = { model.createSide("${state.conversationPath}/side-chats") }, enabled = !state.busy) { Text("新建侧边线程") }
            OutlinedButton(onClick = { model.createSide("${state.conversationPath}/side-chat/context") }, enabled = !state.busy) { Text("携带主任务上下文") }
            data.rows("sideChats").forEach { item -> val conversation = item.objectValue("conversation")
                ToolRow(conversation.text("title"), conversation.text("updated_at")) { model.openSide(conversation.text("id")) }
                TextButton(onClick = { confirm("将这个侧边线程提升为独立主任务？") { model.mutate("/side-chats/${conversation.text("id").segment()}/promote") } }) { Text("提升为主任务") }
            }
            if (data.rows("sideChats").isEmpty() && !state.pageLoading) Text("还没有侧边线程")
        }
        "directories" -> DirectoriesScreen(model, data, openForm, confirm)
        "host" -> HostScreen(model, data, confirm)
        "settings" -> SettingsScreen(model, openForm, confirm)
        "presets" -> PresetsScreen(model, data, openForm, confirm)
        "providers" -> ProvidersScreen(model, data, openForm, confirm)
        "models" -> ModelsScreen(model, data, openForm, confirm)
        "billing" -> BillingScreen(model, data, openForm, confirm)
        "categories" -> CategoriesScreen(model, data, openForm, confirm)
        "category-tasks" -> CategoryTasks(model, page)
        "archived" -> ToolColumn {
            if (data.rows("conversations").isEmpty()) Text("没有已归档任务")
            data.rows("conversations").forEach { item ->
                ToolRow(item.text("title"), "恢复后返回任务列表查看") { model.mutate("/conversations/${item.text("id").segment()}/restore") }
            }
        }
        "import" -> ImportScreen(model, data)
        else -> EmptyState("未识别的页面", "请返回任务列表重试。")
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
    ToolColumn {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            data.rows("roots").forEach { root -> AssistChip(onClick = {
                model.navigate(ToolPage(root.text("label"), "files", "${state.conversationPath}/file-tree?root=${root.text("id").segment()}&path="))
            }, enabled = root.optBoolean("available"), label = { Text(root.text("label")) }) }
        }
        if (listing != null) {
            val root = listing.text("rootId")
            Text(listing.text("path").ifBlank { "/" }, fontSize = 12.sp)
            if (!listing.isNull("parentPath")) TextButton(onClick = {
                model.navigate(ToolPage("文件", "files", "${state.conversationPath}/file-tree?root=${root.segment()}&path=${listing.text("parentPath").segment()}"))
            }) { Text("上级目录") }
            listing.rows("entries").forEach { entry ->
                ToolRow((if (entry.text("type") == "dir") "目录 · " else "") + entry.text("name"), entry.text("display_path")) {
                    val query = "root=${root.segment()}&path=${entry.text("path").segment()}"
                    if (entry.text("type") == "dir") model.navigate(ToolPage(entry.text("name"), "files", "${state.conversationPath}/file-tree?$query"))
                    else model.navigate(ToolPage(entry.text("name"), "preview", "", json("downloadPath" to "${state.conversationPath}/file-tree/file?$query", "mime" to entry.text("mime_type"))))
                }
            }
            if (listing.optBoolean("truncated")) Text("目录内容已截断，使用更具体的子目录。")
            if (listing.rows("entries").isEmpty()) Text("目录为空")
        }
        if (listing == null) {
            Text("结果文件", style = MaterialTheme.typography.titleMedium)
            state.detail?.rows("outputFiles").orEmpty().forEach { file -> FileChip(file) { model.previewFile(file) } }
            OutlinedButton(onClick = { model.navigate(ToolPage("服务器文件", "host", "/path-browser", json("attach" to true))) }) { Text("从服务器添加附件") }
        }
    }
}

@Composable
private fun ReviewScreen(model: ClientModel, data: JSONObject, form: (FormRequest) -> Unit) {
    val state = model.state
    val scope = state.page?.args?.text("scope", "working") ?: "working"
    ToolColumn {
        Text("${data.text("branch")} · ${data.text("comparison")}")
        ChoiceField("范围", scope, listOf("working" to "工作区", "staged" to "暂存区", "branch" to "分支对比")) { value ->
            model.navigate(ToolPage("代码 Review", "review", "${state.conversationPath}/review?scope=$value", json("scope" to value)))
        }
        if (scope == "branch") ChoiceField("基准分支", data.text("base"), data.strings("bases").map { it to it }) { base ->
            model.navigate(ToolPage("代码 Review", "review", "${state.conversationPath}/review?scope=branch&base=${base.segment()}", json("scope" to "branch")))
        }
        data.rows("files").forEach { file ->
            ToolRow(file.text("path"), "${file.text("status")} · +${file.text("additions", "0")} / -${file.text("deletions", "0")}") {
                model.navigate(ToolPage(file.text("path"), "patch", "${state.conversationPath}/review?scope=$scope&base=${data.text("base").segment()}&file=${file.text("path").segment()}"))
            }
        }
        if (data.rows("files").isEmpty() && !state.pageLoading) Text("没有差异文件")
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
                ChoiceField("外观", state.theme, listOf("system" to "跟随系统", "light" to "浅色", "dark" to "深色")) { model.appearance(theme = it) }
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
