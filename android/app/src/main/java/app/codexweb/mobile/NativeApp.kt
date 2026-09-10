@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package app.codexweb.mobile

import android.graphics.Typeface
import android.widget.TextView
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import io.noties.markwon.Markwon
import io.noties.markwon.ext.latex.JLatexMathPlugin
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin
import io.noties.markwon.ext.tables.TablePlugin
import io.noties.markwon.AbstractMarkwonPlugin
import io.noties.markwon.MarkwonConfiguration
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import org.json.JSONObject

private val LightColors = lightColorScheme(primary = Color(0xff354381), onPrimary = Color.White,
    secondary = Color(0xff48569d), background = Color(0xfffafbff), surface = Color.White,
    onSurface = Color(0xff0f1120), onBackground = Color(0xff0f1120), onSurfaceVariant = Color(0xff575760),
    surfaceContainer = Color(0xffeef0f8), surfaceContainerLow = Color(0xfff6f7fb), surfaceContainerHigh = Color(0xffe9ecf5),
    outlineVariant = Color(0xffdfe2ec), secondaryContainer = Color(0xffeef0f8), onSecondaryContainer = Color(0xff354381))
private val DarkColors = darkColorScheme(primary = Color(0xffaeb9f5), onPrimary = Color(0xff181c34),
    secondary = Color(0xffb4bde6), background = Color(0xff17181c), surface = Color(0xff1d1e25),
    onSurface = Color(0xffe2e3e8), onBackground = Color(0xffe2e3e8), onSurfaceVariant = Color(0xffa4a7b5),
    surfaceContainer = Color(0xff272b40), surfaceContainerLow = Color(0xff1d1e25), surfaceContainerHigh = Color(0xff303448),
    outlineVariant = Color(0xff40434d), secondaryContainer = Color(0xff2c324d), onSecondaryContainer = Color(0xffd8defb))

data class FileRequest(val path: String, val name: String, val mime: String = "application/octet-stream")

@Composable
fun CodexApp(model: ClientModel, pickFiles: () -> Unit = {}, download: (FileRequest) -> Unit = {},
             voice: () -> Unit = {}, recording: Boolean = false, openLink: (String) -> Unit = {}) {
    val state = model.state
    val dark = state.theme == "dark" || state.theme == "system" && isSystemInDarkTheme()
    val activity = androidx.activity.compose.LocalActivity.current
    SideEffect {
        activity?.let {
            androidx.core.view.WindowCompat.getInsetsController(it.window, it.window.decorView).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
        }
    }
    MaterialTheme(colorScheme = if (dark) DarkColors else LightColors) {
        Surface(Modifier.fillMaxSize()) {
            if (!state.authenticated) {
                LoginScreen(state, model::connect)
            } else {
                key("${state.server}:${state.session?.text("username")}") {
                    var sheet by remember { mutableStateOf<String?>(null) }
                    var edit by remember { mutableStateOf<Pair<JSONObject, Boolean>?>(null) }
                    var editSubmitting by remember { mutableStateOf(false) }
                    var confirm by remember { mutableStateOf<Pair<String, () -> Unit>?>(null) }
                    LaunchedEffect(state.busy, editSubmitting) {
                        if (editSubmitting && !state.busy) {
                            if (state.error == null) edit = null
                            editSubmitting = false
                        }
                    }
                    val chatStates = rememberSaveableStateHolder()
                    val profilePage = remember { ToolPage("我的", "settings", "") }
                    val queuePage = remember { ToolPage("任务与队列", "queue", "") }
                    ChatFirstShell(model, sheet != null || edit != null || confirm != null, tools = { sheet = "tools" }, composer = {
                        ComposerBar(state, model, { model.withConversation { sheet = "options" } },
                            { model.withConversation(pickFiles) }, { if (recording) voice() else model.withConversation(voice) }, recording, { sheet = "queue" })
                    }) {
                        when {
                            state.page != null -> ToolsScreen(model, download, { prompt -> edit = prompt to true }, { message, action -> confirm = message to action })
                            state.homeTab == HomeTab.Profile -> ToolsScreen(model, download, { prompt -> edit = prompt to true }, { message, action -> confirm = message to action }, profilePage)
                            state.homeTab == HomeTab.Workspace -> WorkspaceHome(model) { sheet = "queue" }
                            state.selectedId == null -> WelcomeChat(model)
                            else -> chatStates.SaveableStateProvider("chat:${state.server}:${state.session?.text("username")}:${state.selectedId}") {
                                ChatScreen(state, model, download, openLink, { prompt -> edit = prompt to false },
                                    { message, action -> confirm = message to action }, { sheet = "queue" })
                            }
                        }
                    }
                    if (sheet == "queue") ModalBottomSheet(onDismissRequest = { sheet = null }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
                        Column(Modifier.fillMaxWidth().fillMaxHeight(.85f).testTag("queue-sheet")) {
                            Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text("任务与队列", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                                IconButton(onClick = { sheet = null }) { Icon(Icons.Outlined.Close, "关闭队列") }
                            }
                            ToolsScreen(model, download, { prompt -> sheet = null; edit = prompt to true }, { message, action -> confirm = message to action }, queuePage)
                        }
                    }
                    if (sheet == "tools" || sheet == "options") ModalBottomSheet(onDismissRequest = { sheet = null }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
                        if (sheet == "options") OptionsSheet(model) { sheet = null }
                        else Column(Modifier.fillMaxWidth().navigationBarsPadding().verticalScroll(rememberScrollState())) {
                            Text("任务工具", Modifier.padding(20.dp), style = MaterialTheme.typography.titleLarge)
                            listOf(
                                Triple("任务与队列", "queue", ""), Triple("文件", "files", "${state.conversationPath}/file-tree"),
                                Triple("代码 Review", "review", "${state.conversationPath}/review?scope=working"),
                                Triple("侧边线程", "side", "${state.conversationPath}/side-chats"),
                                Triple("工作目录", "directories", "/working-dirs"), Triple("API 统计", "billing", "/billing?days=30"),
                            ).forEach { (title, kind, path) ->
                                ToolRow(title, onClick = { if (kind == "queue") sheet = "queue" else { sheet = null; model.navigate(ToolPage(title, kind, path)) } })
                            }
                            ToolRow("重命名", onClick = { sheet = "rename" })
                            ToolRow("归档任务", onClick = { sheet = null; confirm = "归档这个任务？服务器会保留历史，可在设置中恢复。" to { model.archiveOrDelete(false) } })
                            ToolRow("删除任务", danger = true, onClick = { sheet = null; confirm = "永久删除这个任务及其消息和附件？此操作不可撤销。" to { model.archiveOrDelete(true) } })
                            Spacer(Modifier.height(20.dp))
                        }
                    }
                    if (sheet == "rename") NativeForm("重命名任务", listOf(FormField("title", "任务名称", state.conversation.text("title"))),
                        onDismiss = { sheet = null }) { payload -> sheet = null; model.mutate(state.conversationPath, "PATCH", payload) }
                    edit?.let { (prompt, pending) ->
                        var removed by remember(prompt.text("id")) { mutableStateOf(emptyList<String>()) }
                        var newFiles by remember(prompt.text("id")) { mutableStateOf(emptyList<UploadPart>()) }
                        val context = LocalContext.current
                        val editorPicker = androidx.activity.compose.rememberLauncherForActivityResult(
                            androidx.activity.result.contract.ActivityResultContracts.OpenMultipleDocuments()
                        ) { uris ->
                            if (prompt.rows("files").size - removed.size + newFiles.size + uris.size > 12) model.note("一条指令最多 12 个附件")
                            else newFiles = newFiles + uris.map { nativeUpload(context, it) }
                        }
                        NativeForm(if (pending) "编辑队列指令" else "编辑并重新执行", listOf(FormField("message", "指令", prompt.text("content"), "multiline")),
                            busy = state.busy,
                            explanation = if (pending) "已暂停此条队列。保存后恢复排队；取消编辑会恢复原指令。" else "服务器将按原有编辑重发规则处理后续消息，请确认内容。",
                            extra = { prompt.rows("files").forEach { file ->
                                val id = file.text("id")
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Checkbox(checked = id !in removed, onCheckedChange = { checked -> removed = if (checked) removed - id else removed + id })
                                    Text(file.text("original_name"), Modifier.weight(1f))
                                }
                            }
                                newFiles.forEachIndexed { index, file -> Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text("新附件 · ${file.name}", Modifier.weight(1f))
                                    IconButton(onClick = { newFiles = newFiles.filterIndexed { position, _ -> position != index } }, enabled = !state.busy) { Icon(Icons.Outlined.Close, "移除新附件") }
                                } }
                                OutlinedButton(onClick = { editorPicker.launch(arrayOf("*/*")) }, enabled = !state.busy) { Text("添加新附件") }
                            }, onDismiss = {
                                edit = null
                                if (pending) model.mutate("${state.conversationPath}/pending-prompts/${prompt.text("id").segment()}/restore")
                            }) { value -> editSubmitting = true; model.editPrompt(prompt, value.text("message"), pending, removed, newFiles) }
                    }
                    confirm?.let { (message, action) ->
                        AlertDialog(onDismissRequest = { confirm = null }, title = { Text("确认操作") }, text = { Text(message) },
                            confirmButton = { TextButton(onClick = { confirm = null; action() }) { Text("确认") } },
                            dismissButton = { TextButton(onClick = { confirm = null }) { Text("取消") } })
                    }
                }
            }
            state.error?.let { message -> AlertDialog(onDismissRequest = model::dismissError, title = { Text("操作未完成") },
                text = { SelectionContainer { Text(message) } }, confirmButton = { TextButton(onClick = model::dismissError) { Text("知道了") } }) }
        }
    }
}

@Composable
private fun LoginScreen(state: NativeState, connect: (String, String?, String?) -> Unit) {
    var server by rememberSaveable(state.server) { mutableStateOf(state.server) }
    var username by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 28.dp),
        verticalArrangement = Arrangement.Center) {
        Spacer(Modifier.height(40.dp))
        BrandMark(Modifier.size(48.dp))
        Spacer(Modifier.height(24.dp))
        Text("把专注留给任务", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
        Text("Codex · 独立安卓客户端", Modifier.padding(top = 8.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(32.dp))
        OutlinedTextField(server, { server = it }, label = { Text("HTTPS 服务地址") }, placeholder = { Text("https://example.org/codex-web/") },
            modifier = Modifier.fillMaxWidth().testTag("server"), singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(username, { username = it }, label = { Text("用户名") }, modifier = Modifier.fillMaxWidth().testTag("username"), singleLine = true)
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(password, { password = it }, label = { Text("密码") }, modifier = Modifier.fillMaxWidth().testTag("password"), singleLine = true,
            visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
        Spacer(Modifier.height(24.dp))
        Button(onClick = { val secret = password; password = ""; connect(server, username.trim(), secret) },
            enabled = server.isNotBlank() && username.isNotBlank() && password.isNotBlank() && !state.connecting,
            modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("login")) {
            if (state.connecting) CircularProgressIndicator(Modifier.padding(end = 10.dp).size(18.dp), strokeWidth = 2.dp)
            Text(if (state.connecting) "连接中…" else "连接并登录")
        }
        Text("复用你的 codex-web 服务与账户。任务在服务器执行，客户端不内置 Codex CLI，也不是 OpenAI 官方产品。",
            Modifier.padding(vertical = 24.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun ChatScreen(state: NativeState, model: ClientModel, download: (FileRequest) -> Unit, openLink: (String) -> Unit,
                       edit: (JSONObject) -> Unit, confirm: (String, () -> Unit) -> Unit, queue: () -> Unit) {
    val messages = state.detail?.rows("messages").orEmpty()
    val scroll = rememberLazyListState()
    val clipboard = LocalClipboardManager.current
    var positioned by rememberSaveable { mutableStateOf(false) }
    var previousMessage by rememberSaveable { mutableStateOf(messages.lastOrNull()?.text("id")) }
    val scope = rememberCoroutineScope()
    val nearBottom by remember { derivedStateOf { !scroll.canScrollForward || scroll.layoutInfo.visibleItemsInfo.lastOrNull()?.let {
        it.index == scroll.layoutInfo.totalItemsCount - 1 && it.offset + it.size <= scroll.layoutInfo.viewportEndOffset + 120
    } == true } }
    LaunchedEffect(state.selectedId) {
        if (positioned) return@LaunchedEffect
        val count = snapshotFlow { scroll.layoutInfo.totalItemsCount }.first { it > 0 }
        scroll.scrollToItem(count - 1)
        positioned = true
    }
    LaunchedEffect(messages.lastOrNull()?.text("id")) {
        val latest = messages.lastOrNull()?.text("id")
        if (previousMessage != latest && nearBottom && scroll.layoutInfo.totalItemsCount > 0) scroll.animateScrollToItem(scroll.layoutInfo.totalItemsCount - 1)
        previousMessage = latest
    }
    Box(Modifier.fillMaxSize()) {
    if (messages.isEmpty() && state.activeJob == null) {
        EmptyState("有什么需要一起完成？", "描述目标、补充文件，然后开始。\n运行过程与队列不会挤占聊天。")
    } else LazyColumn(state = scroll, modifier = Modifier.fillMaxSize().testTag("messages"), contentPadding = PaddingValues(18.dp, 12.dp, 18.dp, 20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)) {
        if (state.detail?.objectValue("messagePage")?.optBoolean("hasMore") == true) item {
            TextButton(onClick = model::loadOlder, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("加载更早消息") }
        }
        items(messages, key = { it.text("id") }) { message ->
            val user = message.text("role") == "user"
            var menu by remember { mutableStateOf(false) }
            Column(Modifier.fillMaxWidth().testTag("message-${message.text("id")}"), horizontalAlignment = if (user) Alignment.End else Alignment.Start) {
                Surface(color = if (user) MaterialTheme.colorScheme.primary else Color.Transparent,
                    contentColor = if (user) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.fillMaxWidth(if (user) .9f else 1f), shape = RoundedCornerShape(18.dp)) {
                    Column(Modifier.padding(if (user) 14.dp else 0.dp).widthIn(max = 680.dp)) {
                        if (message.text("quote_excerpt").isNotBlank()) Text("引用 · ${message.text("quote_excerpt")}", maxLines = 3,
                            overflow = TextOverflow.Ellipsis, color = LocalContentColor.current.copy(alpha = .75f), fontSize = 13.sp, modifier = Modifier.padding(bottom = 8.dp))
                        message.optJSONObject("source_reference")?.let { source -> Text("关联上下文 · ${source.text("sourceConversationTitle", "来源任务")}", fontSize = 12.sp) }
                        MarkdownText(message.text("content"), state.fontSize, openLink,
                            quote = { excerpt -> model.quote(message, excerpt) }, side = { excerpt ->
                                model.createSide("${state.conversationPath}/side-chat/reference", json("sourceMessageId" to message.text("id"), "excerpt" to excerpt))
                            })
                        message.rows("files").forEach { file -> FileChip(file) { model.previewFile(file) } }
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(if (user) "你" else if (message.text("role") == "system") "系统" else "Codex", fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Box {
                        IconButton(onClick = { menu = true }, modifier = Modifier.size(48.dp)) { Icon(Icons.Outlined.MoreHoriz, "消息操作", Modifier.size(18.dp)) }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(text = { Text("复制") }, onClick = { menu = false; clipboard.setText(AnnotatedString(message.text("content"))); model.note("已复制") })
                            DropdownMenuItem(text = { Text("引用") }, onClick = { menu = false; model.quote(message) })
                            if (message.optBoolean("can_edit")) DropdownMenuItem(text = { Text("编辑重发") }, onClick = { menu = false; edit(message) })
                            DropdownMenuItem(text = { Text("引用到侧边线程") }, onClick = {
                                menu = false; model.createSide("${state.conversationPath}/side-chat/reference", json("sourceMessageId" to message.text("id"), "excerpt" to message.text("content")))
                            })
                            if (message.optBoolean("can_fork")) DropdownMenuItem(text = { Text("从此处 Fork") }, onClick = {
                                menu = false; confirm("从这条消息建立独立侧边线程，保留原任务？") {
                                    model.createSide("${state.conversationPath}/side-chats/fork", json("sourceMessageId" to message.text("id")))
                                }
                            })
                            DropdownMenuItem(text = { Text("引用并新建主任务") }, onClick = {
                                menu = false; model.createSide("/conversations/from-source", json("sourceConversationId" to state.selectedId,
                                    "sourceMessageId" to message.text("id"), "excerpt" to message.text("content")))
                            })
                        }
                    }
                }
            }
        }
        if (state.activeJob != null) item {
            OutlinedCard(onClick = queue) {
                Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Column { Text("任务${if (state.activeJob?.text("status") == "queued") "排队中" else "运行中"}")
                        Text(state.detail?.rows("jobEvents")?.lastOrNull()?.text("label").orEmpty().ifBlank { "点此查看过程、队列和停止操作" },
                            fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                }
            }
        }
    }
    if (!nearBottom && messages.isNotEmpty()) SmallFloatingActionButton(onClick = { scope.launch { scroll.animateScrollToItem(scroll.layoutInfo.totalItemsCount - 1) } },
        modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp), containerColor = MaterialTheme.colorScheme.surface, contentColor = MaterialTheme.colorScheme.primary) {
        Icon(Icons.Outlined.ArrowDownward, "回到最新消息")
    }
    }
}

@Composable
fun MarkdownText(content: String, size: Int, openLink: (String) -> Unit = {}, quote: ((String) -> Unit)? = null, side: ((String) -> Unit)? = null) {
    val context = LocalContext.current
    val color = LocalContentColor.current.toArgb()
    val link = rememberUpdatedState(openLink)
    val onQuote = rememberUpdatedState(quote)
    val onSide = rememberUpdatedState(side)
    val markwon = remember(context, size, color) {
        Markwon.builder(context).usePlugin(TablePlugin.create(context)).usePlugin(StrikethroughPlugin.create())
            .usePlugin(JLatexMathPlugin.create(size * context.resources.displayMetrics.scaledDensity))
            .usePlugin(object : AbstractMarkwonPlugin() {
                override fun configureConfiguration(builder: MarkwonConfiguration.Builder) {
                    builder.linkResolver { _, destination -> link.value(destination) }
                }
            }).build()
    }
    AndroidView(factory = { TextView(it).apply {
        setTextIsSelectable(true)
        setLineSpacing(0f, 1.22f)
        val textView = this
        customSelectionActionModeCallback = object : android.view.ActionMode.Callback {
            override fun onCreateActionMode(mode: android.view.ActionMode, menu: android.view.Menu): Boolean {
                if (onQuote.value != null) menu.add(0, 701, 10, "引用选中内容")
                if (onSide.value != null) menu.add(0, 702, 11, "侧边提问")
                return true
            }
            override fun onPrepareActionMode(mode: android.view.ActionMode, menu: android.view.Menu) = false
            override fun onDestroyActionMode(mode: android.view.ActionMode) {}
            override fun onActionItemClicked(mode: android.view.ActionMode, item: android.view.MenuItem): Boolean {
                if (item.itemId !in listOf(701, 702)) return false
                val start = minOf(textView.selectionStart, textView.selectionEnd).coerceAtLeast(0)
                val end = maxOf(textView.selectionStart, textView.selectionEnd).coerceAtMost(textView.text.length)
                if (end > start) {
                    val excerpt = textView.text.substring(start, end)
                    if (item.itemId == 701) onQuote.value?.invoke(excerpt) else onSide.value?.invoke(excerpt)
                }
                mode.finish()
                return true
            }
        }
    } }, modifier = Modifier.fillMaxWidth(), update = { view ->
        view.textSize = size.toFloat()
        view.setTextColor(color)
        val key = "$size:$color:$content"
        if (view.tag != key) {
            runCatching { markwon.setMarkdown(view, content) }.onFailure { view.text = content }
            view.tag = key
        }
    })
}

@Composable
private fun ComposerBar(state: NativeState, model: ClientModel, options: () -> Unit, pickFiles: () -> Unit, voice: () -> Unit, recording: Boolean, queue: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)) {
            if (state.sendUncertain) {
                var resolve by remember { mutableStateOf(false) }
                TextButton(onClick = { resolve = true }, modifier = Modifier.fillMaxWidth()) { Text("上次发送待核对 · 点击处理") }
                if (resolve) AlertDialog(onDismissRequest = { resolve = false }, title = { Text("先核对消息和队列") },
                    text = { Text("网络中断不代表发送失败。确认服务器是否已收到后再选择，避免重复执行。") },
                    confirmButton = { TextButton(onClick = { resolve = false; model.resolveUncertainSend(true) }) { Text("已收到，清除本机副本") } },
                    dismissButton = { TextButton(onClick = { resolve = false; model.resolveUncertainSend(false) }) { Text("未收到，保留以便重发") } })
            }
            if (state.composer.quote.isNotBlank() || state.composer.source != null) Row(verticalAlignment = Alignment.CenterVertically) {
                Text("引用 · ${state.composer.quote.ifBlank { "关联上下文" }}", Modifier.weight(1f).padding(start = 8.dp), maxLines = 2, fontSize = 12.sp, overflow = TextOverflow.Ellipsis)
                IconButton(onClick = model::clearQuote, enabled = !state.busy) { Icon(Icons.Outlined.Close, "取消引用") }
            }
            if (state.composer.files.isNotEmpty()) androidx.compose.foundation.lazy.LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.composer.files, key = { it.text("id") }) { file ->
                    InputChip(selected = true, onClick = { model.previewFile(file) }, label = { Text(file.text("original_name"), maxLines = 1, modifier = Modifier.widthIn(max = 160.dp)) },
                        trailingIcon = { IconButton(onClick = { model.removeAttachment(file.text("id")) }, modifier = Modifier.size(48.dp), enabled = !state.busy) { Icon(Icons.Outlined.Close, "移除附件") } })
                }
            }
            val pending = state.detail?.rows("pendingPrompts").orEmpty().size
            if (pending > 0 || state.editingPrompt != null || state.activeJob != null) TextButton(
                onClick = queue, modifier = Modifier.fillMaxWidth().testTag("queue-hint"), contentPadding = PaddingValues(horizontal = 12.dp)) {
                Icon(Icons.Outlined.Queue, null, Modifier.size(16.dp))
                Text("${if (state.activeJob != null) "执行中 · " else ""}队列 $pending${if (state.editingPrompt != null) " · 暂停编辑" else ""}",
                    Modifier.weight(1f).padding(horizontal = 8.dp), fontSize = 12.sp, textAlign = androidx.compose.ui.text.style.TextAlign.Start)
                Icon(Icons.Outlined.ExpandLess, "展开队列", Modifier.size(18.dp))
            }
            Surface(shape = RoundedCornerShape(24.dp), color = MaterialTheme.colorScheme.surface,
                border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)) {
            Column(Modifier.padding(horizontal = 6.dp, vertical = 4.dp)) {
            TextField(value = state.composer.content, onValueChange = model::changeText,
                modifier = Modifier.fillMaxWidth().heightIn(max = 160.dp).testTag("composer"), enabled = !state.connecting && (!state.busy || state.operation == "voice") && !state.sendUncertain,
                placeholder = { Text(if (recording) "正在聆听…" else "给 Agent 发消息…", fontSize = 15.sp) }, maxLines = 5,
                colors = TextFieldDefaults.colors(focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
                    disabledContainerColor = Color.Transparent, focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, disabledIndicatorColor = Color.Transparent))
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = pickFiles, enabled = !state.busy && !recording && !state.detailFromCache) {
                    if (state.operation == "upload") CircularProgressIndicator(Modifier.size(22.dp).testTag("upload-progress"), strokeWidth = 2.dp)
                    else Icon(Icons.Outlined.Add, "添加附件")
                }
                TextButton(onClick = options, modifier = Modifier.weight(1f), contentPadding = PaddingValues(4.dp)) {
                    val selected = state.detail?.objectValue("agentSelection") ?: state.options.objectValue("selection")
                    val label = state.options.rows("models").find { it.text("id") == selected.text("model") }?.text("label") ?: selected.text("model")
                    Text(label.ifBlank { "模型与选项" }, maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 12.sp)
                    Icon(Icons.Outlined.ExpandMore, null, Modifier.size(16.dp))
                }
                if (state.session?.optBoolean("voiceEnabled") == true) IconButton(onClick = voice, enabled = !state.busy && !state.detailFromCache) {
                    if (state.operation == "voice") CircularProgressIndicator(Modifier.size(22.dp).testTag("voice-progress"), strokeWidth = 2.dp)
                    else Icon(if (recording) Icons.Outlined.StopCircle else Icons.Outlined.Mic, if (recording) "结束录音并转写" else "语音输入",
                        tint = if (recording) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
                }
                FilledIconButton(onClick = model::send, enabled = !state.busy && !recording && !state.sendUncertain && !state.detailFromCache && (state.composer.content.isNotBlank() || state.composer.files.isNotEmpty()),
                    modifier = Modifier.size(48.dp).testTag("send")) {
                    if (state.operation == "send") CircularProgressIndicator(Modifier.size(20.dp).testTag("send-progress"), strokeWidth = 2.dp)
                    else Icon(Icons.Outlined.ArrowUpward, "发送")
                }
            }
            }
            }
            if (state.draftStatus.isNotBlank()) Text(state.draftStatus, fontSize = 10.sp,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 3.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun OptionsSheet(model: ClientModel, close: () -> Unit = {}) {
    val state = model.state
    val selection = state.detail?.objectValue("agentSelection") ?: state.options.objectValue("selection")
    Column(Modifier.fillMaxWidth().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("任务选项", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
            IconButton(onClick = close, enabled = !state.busy) { Icon(Icons.Outlined.Close, "关闭选项") }
        }
        ChoiceField("模型 / API 源", selection.text("model"), state.options.rows("models").map { it.text("id") to "${it.text("providerName")} · ${it.text("label")}" }) { id ->
            val modelOption = state.options.rows("models").find { it.text("id") == id } ?: return@ChoiceField
            val efforts = modelOption.strings("reasoningEfforts")
            model.updateSelection(selection.changed("model" to id, "provider" to modelOption.text("provider").ifBlank { null },
                "reasoningEffort" to selection.text("reasoningEffort").takeIf { it in efforts }.orEmpty().ifBlank { efforts.firstOrNull() ?: "medium" }))
        }
        val efforts = state.options.rows("models").find { it.text("id") == selection.text("model") }?.strings("reasoningEfforts")
            ?: state.options.rows("reasoningEfforts").map { it.text("id") }
        ChoiceField("思考强度", selection.text("reasoningEffort"), efforts.map { it to reasoningLabel(it) }) { model.updateSelection(selection.changed("reasoningEffort" to it)) }
        var permission by remember { mutableStateOf<String?>(null) }
        ChoiceField("文件与执行权限", selection.text("sandbox", "workspace-write"), state.options.rows("sandboxModes").map { it.text("id") to it.text("label") }) {
            if (it == "danger-full-access") permission = it else model.updateSelection(selection.changed("sandbox" to it))
        }
        if (permission != null) AlertDialog(onDismissRequest = { permission = null }, title = { Text("启用完全访问？") },
            text = { Text("这会扩大服务器端任务的文件和命令访问权限。仅在明确需要时启用。") },
            confirmButton = { TextButton(onClick = { model.updateSelection(selection.changed("sandbox" to permission)); permission = null }) { Text("确认启用") } },
            dismissButton = { TextButton(onClick = { permission = null }) { Text("取消") } })
        if (state.session?.optBoolean("voiceEnabled") == true) ChoiceField("语音转写模型", state.voiceModel,
            state.session.rows("voiceModels").map { it.text("id") to it.text("label") }) { model.voiceModel(it) }
        HorizontalDivider(Modifier.padding(top = 10.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .5f))
        Text("预设指令", Modifier.padding(top = 14.dp), style = MaterialTheme.typography.titleMedium)
        val enabled = state.detail?.strings("enabledPresetPromptIds").orEmpty()
        state.presets.forEach { preset ->
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = preset.text("id") in enabled, enabled = !state.busy, onCheckedChange = { checked ->
                    val ids = if (checked) enabled + preset.text("id") else enabled - preset.text("id")
                    model.mutate("${state.conversationPath}/preset-prompts", "PUT", json("presetPromptIds" to ids.jsonArray()))
                })
                Text(preset.text("name"), Modifier.weight(1f))
            }
        }
        if (state.presets.isEmpty()) Text("暂无预设；可在设置中创建。", fontSize = 13.sp)
        Spacer(Modifier.height(20.dp))
    }
}

@Composable
fun ToolRow(title: String, description: String = "", danger: Boolean = false, onClick: () -> Unit) {
    ListItem(modifier = Modifier.clickable(onClick = onClick).heightIn(min = 56.dp),
        headlineContent = { Text(title, color = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface) },
        supportingContent = if (description.isBlank()) null else ({ Text(description, maxLines = 3, overflow = TextOverflow.Ellipsis) }),
        trailingContent = { Icon(Icons.Outlined.ChevronRight, null) })
}

@Composable
fun EmptyState(title: String, description: String, action: String? = null, onClick: () -> Unit = {}) {
    Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(Icons.Outlined.Terminal, null, Modifier.size(40.dp), tint = MaterialTheme.colorScheme.primary)
        Text(title, Modifier.padding(top = 18.dp), style = MaterialTheme.typography.titleLarge)
        Text(description, Modifier.padding(vertical = 12.dp), style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        if (action != null) Button(onClick = onClick) { Text(action) }
    }
}

@Composable
fun FileChip(file: JSONObject, onClick: () -> Unit) {
    AssistChip(onClick = onClick, label = { Text(file.text("original_name", file.text("name")), maxLines = 1, overflow = TextOverflow.Ellipsis) },
        leadingIcon = { Icon(Icons.Outlined.AttachFile, null, Modifier.size(18.dp)) })
}

fun ClientModel.previewFile(file: JSONObject) = navigate(ToolPage(file.text("original_name"), "preview", "",
    json("downloadPath" to "/files/${file.text("id").segment()}", "mime" to file.text("mime_type"), "fileId" to file.text("id"))))
