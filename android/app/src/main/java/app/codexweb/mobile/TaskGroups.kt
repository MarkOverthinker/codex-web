package app.codexweb.mobile

import org.json.JSONObject

data class TaskGroup(val key: String, val title: String, val detail: String, val tasks: List<JSONObject>)

fun taskStatus(task: JSONObject): String = when {
    task.text("status") == "running" -> "进行中"
    task.optInt("has_pending_work") > 0 || task.text("latest_job_status") == "queued" -> "排队中"
    task.text("latest_job_status") == "completed" -> "已完成"
    task.text("latest_job_status") in listOf("failed", "cancelled", "interrupted") -> "需关注"
    else -> "未运行 / 状态未知"
}

fun jobStatusLabel(status: String): String = when (status) {
    "running" -> "运行中"
    "queued" -> "排队中"
    "completed" -> "已完成"
    "failed", "cancelled", "interrupted" -> "需关注"
    else -> status.ifBlank { "未知" }
}

fun reasoningLabel(value: String): String = when (value) {
    "minimal" -> "极简"
    "low" -> "低"
    "medium" -> "中"
    "high" -> "高"
    "xhigh" -> "超高"
    else -> value.ifBlank { "默认" }
}

fun taskGroups(state: NativeState, byStatus: Boolean, query: String): List<TaskGroup> {
    val custom = state.categorySettings.rows("customCategories")
    val favorites = state.workingDirs.rows("favorites")
    val groups = state.conversations.groupBy { task ->
        val dir = task.text("working_dir")
        if (byStatus) taskStatus(task)
        else if (dir.isBlank()) "auto:standalone"
        else custom.lastOrNull { dir in it.strings("assignedDirs") }?.let { "custom:${it.text("id")}" } ?: "auto:dir:${dir.segment()}"
    }.map { (key, tasks) ->
        val dir = tasks.first().text("working_dir")
        val category = custom.find { "custom:${it.text("id")}" == key }
        val name = when {
            byStatus -> key
            category != null -> category.text("name")
            dir.isBlank() -> "独立工作区"
            else -> favorites.find { it.text("path") == dir }?.text("label").orEmpty().ifBlank { dir.trimEnd('/').substringAfterLast('/') }
        }
        val filtered = tasks.filter { name.contains(query, true) || it.text("title").contains(query, true) || it.text("working_dir").contains(query, true) }
        val order = state.categorySettings.objectValue("conversationOrders").strings(key)
        TaskGroup(key, name, if (category != null && category.strings("assignedDirs").size > 1) "${category.strings("assignedDirs").size} 个项目目录" else dir,
            if (byStatus) filtered else filtered.sortedBy { order.indexOf(it.text("id")).takeIf { position -> position >= 0 } ?: Int.MAX_VALUE })
    }.filter { it.tasks.isNotEmpty() && (byStatus || it.key !in state.categorySettings.strings("hidden")) }
    val pinned = state.categorySettings.strings("pinned")
    val states = listOf("进行中", "排队中", "已完成", "需关注", "未运行 / 状态未知")
    return if (byStatus) groups.sortedBy { states.indexOf(it.key) }
    else groups.sortedWith(compareBy<TaskGroup> { pinned.indexOf(it.key).takeIf { position -> position >= 0 } ?: Int.MAX_VALUE }
        .thenByDescending { it.tasks.maxOfOrNull { task -> task.text("updated_at") }.orEmpty() })
}
