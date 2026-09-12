@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package app.codexweb.mobile

import androidx.activity.compose.BackHandler
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.CornerSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONObject

val BrandAmber = Color(0xfff0aa3c)

@Composable
fun BrandMark(modifier: Modifier = Modifier) {
    Surface(modifier.size(38.dp), shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.tertiaryContainer, contentColor = MaterialTheme.colorScheme.onTertiaryContainer) {
        Box(contentAlignment = Alignment.Center) { Icon(Icons.Outlined.Terminal, null, Modifier.size(24.dp)) }
    }
}

@Composable
fun ChatFirstShell(model: ClientModel, modalOpen: Boolean, tools: () -> Unit,
                   composer: @Composable () -> Unit, content: @Composable () -> Unit) {
    val state = model.state
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current
    val keyboardVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    val child = state.page != null
    val titleHeight = with(LocalDensity.current) {
        MaterialTheme.typography.titleLarge.lineHeight.toDp() +
            if (!child && state.homeTab == HomeTab.Chat) MaterialTheme.typography.labelMedium.lineHeight.toDp() else 0.dp
    }
    val closeDrawer = { scope.launch { drawer.close() }; Unit }
    LaunchedEffect(drawer.targetValue) {
        if (drawer.targetValue == DrawerValue.Open) { keyboard?.hide(); focus.clearFocus() }
    }
    BackHandler(enabled = !modalOpen && (drawer.isOpen || child || state.homeTab != HomeTab.Chat || state.parentAvailable)) {
        when {
            drawer.isOpen -> closeDrawer()
            child || state.parentAvailable && state.homeTab == HomeTab.Chat -> model.back()
            else -> model.selectTab(HomeTab.Chat)
        }
    }
    ModalNavigationDrawer(drawerState = drawer, gesturesEnabled = !modalOpen && !child,
        scrimColor = MaterialTheme.colorScheme.scrim.copy(alpha = .42f),
        drawerContent = {
            ModalDrawerSheet(modifier = Modifier.width((LocalConfiguration.current.screenWidthDp * .88f).coerceAtMost(380f).dp).testTag("task-drawer"),
                drawerContainerColor = MaterialTheme.colorScheme.surfaceContainerLow,
                drawerShape = MaterialTheme.shapes.extraLarge.copy(topStart = CornerSize(0.dp), bottomStart = CornerSize(0.dp))) {
                TaskDrawer(model, closeDrawer)
            }
        }) {
        Scaffold(modifier = Modifier.imePadding().testTag("mobile-shell"), containerColor = MaterialTheme.colorScheme.background,
            topBar = {
                TopAppBar(title = {
                    Column {
                        Text(state.page?.title ?: if (state.homeTab == HomeTab.Chat) state.conversation.text("title", "新对话") else state.homeTab.title,
                            maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleLarge)
                        if (!child && state.homeTab == HomeTab.Chat) Text(
                            if (state.detailFromCache) state.connection else state.conversation.text("working_dir").trimEnd('/').substringAfterLast('/').ifBlank { "你的 AI 工作台" },
                            maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }, navigationIcon = {
                    IconButton(onClick = { if (child || state.parentAvailable && state.homeTab == HomeTab.Chat) model.back() else scope.launch { drawer.open() } }) {
                        Icon(if (child || state.parentAvailable && state.homeTab == HomeTab.Chat) Icons.AutoMirrored.Outlined.ArrowBack else Icons.Outlined.Menu,
                            if (child || state.parentAvailable && state.homeTab == HomeTab.Chat) "返回" else "打开任务列表")
                    }
                }, actions = {
                    if (child || state.detailFromCache) IconButton(onClick = model::refresh, enabled = !state.busy) {
                        if (state.operation == "refresh") CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        else Icon(Icons.Outlined.Refresh, "刷新")
                    }
                    if (!child && state.homeTab == HomeTab.Chat) {
                        IconButton(onClick = model::startNewChat, enabled = !state.busy) {
                            if (state.operation == "new" || state.operation == "open") CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                            else Icon(Icons.Outlined.Edit, "新建对话")
                        }
                        IconButton(onClick = tools, enabled = state.selectedId != null) { Icon(Icons.Outlined.MoreHoriz, "任务工具") }
                    }
                }, expandedHeight = maxOf(64.dp, titleHeight + 16.dp),
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background))
            }, bottomBar = {
                Column(Modifier.navigationBarsPadding()) {
                    if (!child && state.homeTab == HomeTab.Chat) composer()
                    if (!child && !keyboardVisible) {
                        Row(Modifier.widthIn(max = 480.dp).fillMaxWidth().align(Alignment.CenterHorizontally)
                            .padding(horizontal = 16.dp).selectableGroup().testTag("bottom-navigation"),
                            verticalAlignment = Alignment.CenterVertically) {
                            HomeTab.entries.forEach { tab -> BottomNavItem(tab, state.homeTab == tab, Modifier.weight(1f)) { keyboard?.hide(); focus.clearFocus(); model.selectTab(tab) } }
                        }
                    }
                }
            }) { padding ->
            Column(Modifier.padding(padding).consumeWindowInsets(padding).fillMaxSize()) {
                Box(Modifier.weight(1f).fillMaxWidth()) { content() }
                state.notice?.let { notice ->
                    Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = MaterialTheme.shapes.small, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
                        Row(Modifier.fillMaxWidth().padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(notice, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
                            IconButton(onClick = model::dismissError) { Icon(Icons.Outlined.Close, "关闭提示") }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun BottomNavItem(tab: HomeTab, selected: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val icon = when (tab) {
        HomeTab.Chat -> if (selected) Icons.Filled.ChatBubble else Icons.Outlined.ChatBubbleOutline
        HomeTab.Workspace -> if (selected) Icons.Filled.GridView else Icons.Outlined.GridView
        HomeTab.Profile -> if (selected) Icons.Filled.Person else Icons.Outlined.PersonOutline
    }
    val foreground by animateColorAsState(if (selected) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant, tween(180), label = "navigation-content")
    Box(modifier.height(48.dp).selectable(selected = selected, role = Role.Tab, onClick = onClick,
        interactionSource = remember { MutableInteractionSource() }, indication = ripple(bounded = false, radius = 24.dp)).testTag("tab-${tab.name}"),
        contentAlignment = Alignment.Center) {
        Icon(icon, tab.title, Modifier.size(24.dp), tint = foreground)
    }
}

@Composable
private fun TaskStatusBadge(task: JSONObject) {
    val label = taskStatus(task)
    Row(Modifier.padding(top = 3.dp), verticalAlignment = Alignment.CenterVertically) {
        when (label) {
            "进行中" -> CircularProgressIndicator(Modifier.size(18.dp).testTag("task-progress"), strokeWidth = 2.dp)
            "排队中" -> Icon(Icons.Outlined.Schedule, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.primary)
            "需关注" -> Icon(Icons.Outlined.Warning, null, Modifier.size(15.dp), tint = MaterialTheme.colorScheme.error)
            "已完成" -> Icon(Icons.Outlined.CheckCircle, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            else -> Icon(Icons.Outlined.RadioButtonUnchecked, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(label, Modifier.padding(start = 5.dp), style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis,
            color = if (label == "需关注") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            fontWeight = if (label == "需关注") FontWeight.SemiBold else FontWeight.Normal)
    }
}

@Composable
private fun TaskDrawer(model: ClientModel, close: () -> Unit) {
    val state = model.state
    var search by rememberSaveable { mutableStateOf("") }
    var byStatus by rememberSaveable { mutableStateOf(false) }
    var project by rememberSaveable { mutableStateOf("") }
    var projectMenu by remember { mutableStateOf(false) }
    var expanded by rememberSaveable { mutableStateOf(emptyList<String>()) }
    var collapsed by rememberSaveable { mutableStateOf(emptyList<String>()) }
    val projects = taskGroups(state, false, "")
    val selectedProject = projects.find { it.key == project }
    val scoped = if (byStatus && selectedProject != null) state.copy(conversations = selectedProject.tasks) else state
    val groups = taskGroups(scoped, byStatus, search)
    Column(Modifier.fillMaxSize().testTag("drawer-content")) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            BrandMark()
            Text("任务", Modifier.weight(1f).padding(start = 12.dp), style = MaterialTheme.typography.titleLarge)
            IconButton(onClick = close) { Icon(Icons.Outlined.Close, "关闭任务列表") }
        }
        Button(onClick = { model.startNewChat(); close() }, enabled = !state.busy,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).heightIn(min = 48.dp), shape = MaterialTheme.shapes.medium) {
            Icon(Icons.Outlined.Add, null, Modifier.size(20.dp)); Text("新建对话", Modifier.padding(start = 10.dp))
        }
        OutlinedTextField(search, { search = it }, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp).testTag("task-search"),
            placeholder = { Text("搜索任务或项目", style = MaterialTheme.typography.bodyMedium) }, leadingIcon = { Icon(Icons.Outlined.Search, null, Modifier.size(20.dp)) },
            singleLine = true, shape = MaterialTheme.shapes.medium)
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = !byStatus, onClick = { byStatus = false }, label = { Text("按项目") }, modifier = Modifier.weight(1f), leadingIcon = { Icon(Icons.Outlined.FolderOpen, null, Modifier.size(17.dp)) })
            FilterChip(selected = byStatus, onClick = { byStatus = true }, label = { Text("按状态") }, modifier = Modifier.weight(1f), leadingIcon = { Icon(Icons.Outlined.Tune, null, Modifier.size(17.dp)) })
        }
        if (byStatus) Box(Modifier.padding(horizontal = 16.dp)) {
            TextButton(onClick = { projectMenu = true }) { Text(selectedProject?.title ?: "全部项目", maxLines = 1); Icon(Icons.Outlined.ExpandMore, null) }
            DropdownMenu(expanded = projectMenu, onDismissRequest = { projectMenu = false }) {
                DropdownMenuItem(text = { Text("全部项目") }, onClick = { project = ""; projectMenu = false })
                projects.forEach { item -> DropdownMenuItem(text = { Text(item.title) }, onClick = { project = item.key; projectMenu = false }) }
            }
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth().testTag("task-list"), contentPadding = PaddingValues(horizontal = 10.dp, vertical = 8.dp)) {
            if (groups.isEmpty()) item { Text(if (search.isBlank()) "暂无任务，开始一段新对话。" else "没有匹配的任务", Modifier.padding(18.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            groups.forEach { group ->
                val expandKey = "${if (byStatus) "status" else "project"}:${group.key}"
                val all = expandKey in expanded || search.isNotBlank()
                val isCollapsed = expandKey in collapsed && search.isBlank()
                item(key = "header:${group.key}") {
                    Row(Modifier.fillMaxWidth().testTag("group-$expandKey")
                        .clickable(enabled = search.isBlank(), role = Role.Button, onClickLabel = if (isCollapsed) "展开分类" else "折叠分类") {
                            collapsed = if (isCollapsed) collapsed - expandKey else collapsed + expandKey
                        }.heightIn(min = 48.dp).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(if (byStatus) Icons.Outlined.RadioButtonChecked else Icons.Outlined.FolderOpen, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.primary)
                        Text(group.title, Modifier.weight(1f).padding(horizontal = 8.dp), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleSmall)
                        Text(group.tasks.size.toString(), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Icon(if (isCollapsed) Icons.Outlined.ExpandMore else Icons.Outlined.ExpandLess,
                            if (isCollapsed) "展开分类" else "折叠分类", Modifier.padding(start = 8.dp).size(18.dp))
                    }
                }
                items(if (isCollapsed) emptyList() else if (all) group.tasks else group.tasks.take(4), key = { "${group.key}:${it.text("id")}" }) { task ->
                    val selected = task.text("id") == state.selectedId
                    Surface(onClick = { model.openConversation(task.text("id")); close() }, enabled = !state.busy,
                        color = if (selected) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent,
                        shape = MaterialTheme.shapes.small, modifier = Modifier.fillMaxWidth().testTag("task-${task.text("id")}")) {
                        Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(task.text("title", "新任务"), maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal)
                                TaskStatusBadge(task)
                            }
                            if (task.optInt("has_unread_result") > 0) Box(Modifier.padding(start = 8.dp).size(7.dp).background(MaterialTheme.colorScheme.tertiary, CircleShape))
                        }
                    }
                }
                if (!isCollapsed && group.tasks.size > 4 && search.isBlank()) item(key = "expand:${group.key}") {
                    TextButton(onClick = { expanded = if (all) expanded - expandKey else expanded + expandKey }, modifier = Modifier.fillMaxWidth().testTag("expand-${group.key}")) {
                        Text(if (all) "仅显示前 4 个任务" else "展开其余 ${group.tasks.size - 4} 个任务", style = MaterialTheme.typography.labelMedium)
                        Icon(if (all) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, null, Modifier.size(16.dp))
                    }
                }
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { close(); model.navigate(ToolPage("任务分类", "categories", "/task-categories")) }) { Icon(Icons.Outlined.Tune, null, Modifier.size(18.dp)); Text("管理分类", Modifier.padding(start = 8.dp), style = MaterialTheme.typography.labelMedium) }
            Spacer(Modifier.weight(1f))
            IconButton(onClick = model::refresh, enabled = !state.busy) {
                if (state.operation == "refresh") CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) else Icon(Icons.Outlined.Refresh, "刷新任务列表")
            }
        }
    }
}

internal fun canUseWelcomeSuggestion(state: NativeState, recording: Boolean = false): Boolean =
    state.authenticated && state.selectedId == null && !state.connecting && !state.busy &&
        !state.sendUncertain && !state.detailFromCache && !recording &&
        state.composer.content.isEmpty() && state.composer.quote.isEmpty() &&
        state.composer.source == null && state.composer.files.isEmpty()

@Composable
fun WelcomeChat(model: ClientModel, recording: Boolean = false) {
    WelcomeSuggestions(model.state, recording) { prompt ->
        if (canUseWelcomeSuggestion(model.state, recording)) model.changeText(prompt)
    }
}

@Composable
internal fun WelcomeSuggestions(state: NativeState, recording: Boolean = false, onSuggestion: (String) -> Unit) {
    val enabled = canUseWelcomeSuggestion(state, recording)
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 28.dp, vertical = 24.dp)
        .testTag("welcome-chat"), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        BrandMark(Modifier.size(46.dp))
        Text("今天想完成什么？", Modifier.padding(top = 20.dp), style = MaterialTheme.typography.titleLarge)
        Text("从一个问题开始，把任务交给 Codex。", Modifier.padding(top = 10.dp, bottom = 22.dp),
            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            listOf("检查代码" to "请检查当前项目的代码，", "整理文件" to "请帮我整理当前项目的文件，", "继续工作" to "请先查看项目进度，再继续完成任务。").forEach { (label, prompt) ->
                SuggestionChip(onClick = { if (canUseWelcomeSuggestion(state, recording)) onSuggestion(prompt) },
                    label = { Text(label, style = MaterialTheme.typography.labelLarge) }, enabled = enabled,
                    modifier = Modifier.heightIn(min = 48.dp))
            }
        }
    }
}

@Composable
fun WorkspaceHome(model: ClientModel, queue: () -> Unit) {
    val state = model.state
    val task = state.selectedId?.let { selectedId ->
        state.conversation.takeIf { it.text("id") == selectedId }
            ?: state.conversations.firstOrNull { it.text("id") == selectedId }
    }
    data class WorkspaceTool(val title: String, val purpose: String, val tag: String, val open: () -> Unit)
    val taskTools = if (state.selectedId == null) emptyList() else listOf(
        WorkspaceTool("任务与队列", "查看执行过程、调整排队指令", "workspace-queue", queue),
        WorkspaceTool("项目文件", "浏览当前任务产物与项目目录", "workspace-files") {
            model.navigate(ToolPage("项目文件", "files", "${state.conversationPath}/file-tree"))
        },
        WorkspaceTool("代码 Review", "查看工作区、暂存区或分支差异", "workspace-review") {
            model.navigate(ToolPage("代码 Review", "review", "${state.conversationPath}/review?scope=working"))
        },
        WorkspaceTool("侧边线程", "查看或创建当前任务的辅助对话", "workspace-side") {
            model.navigate(ToolPage("侧边线程", "side", "${state.conversationPath}/side-chats"))
        },
    )
    val globalTools = listOf(
        WorkspaceTool("工作目录", "管理账号的目录收藏与默认项目设置", "workspace-directories") {
            model.navigate(ToolPage("工作目录", "directories", "/working-dirs"))
        },
        WorkspaceTool("API 统计", "查看账号用量、费用与模型统计", "workspace-billing") {
            model.navigate(ToolPage("API 统计", "billing", "/billing?days=30"))
        },
    )
    ToolColumn {
        Surface(modifier = Modifier.fillMaxWidth().testTag("workspace-context"), shape = MaterialTheme.shapes.medium,
            color = MaterialTheme.colorScheme.surfaceContainerLow) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("当前任务", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (state.selectedId == null) {
                    Text("尚未选择任务", style = MaterialTheme.typography.titleMedium, modifier = Modifier.testTag("workspace-no-task"))
                    Text("返回对话选择已有任务后，可查看文件、Review 和队列。", style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Button(onClick = { model.selectTab(HomeTab.Chat) }, modifier = Modifier.heightIn(min = 48.dp).testTag("workspace-back-to-chat")) {
                        Text("返回对话")
                    }
                } else {
                    Text(task?.text("title").orEmpty().ifBlank { if (task == null) "任务信息暂不可用" else "未命名任务" },
                        style = MaterialTheme.typography.titleMedium, modifier = Modifier.testTag("workspace-task-title"))
                    Text(task?.let(::taskStatus) ?: "状态暂不可用", style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("workspace-task-status"))
                    Text("工作目录", style = MaterialTheme.typography.labelLarge)
                    Text(task?.text("working_dir").orEmpty().ifBlank { "目录信息暂不可用" },
                        style = MaterialTheme.typography.bodyMedium, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                        modifier = Modifier.testTag("workspace-task-directory"))
                    if (state.detailFromCache) Text("缓存只读：任务信息可能不是最新状态", style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.tertiary)
                }
            }
        }
        listOf("任务工具" to taskTools, "全局管理" to globalTools).forEach { (title, tools) ->
            if (tools.isNotEmpty()) {
                Text(title, style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(top = 4.dp).testTag(if (title == "任务工具") "workspace-task-tools" else "workspace-global-tools"))
                OutlinedCard(shape = MaterialTheme.shapes.medium,
                    colors = CardDefaults.outlinedCardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                    tools.forEachIndexed { index, tool ->
                        if (index > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        ListItem(modifier = Modifier.clickable(onClick = tool.open).heightIn(min = 56.dp).testTag(tool.tag),
                            headlineContent = { Text(tool.title, style = MaterialTheme.typography.titleSmall) },
                            supportingContent = { Text(tool.purpose, style = MaterialTheme.typography.bodyMedium) },
                            trailingContent = { Icon(Icons.Outlined.ChevronRight, null) })
                    }
                }
            }
        }
    }
}
