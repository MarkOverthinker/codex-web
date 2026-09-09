package app.codexweb.mobile

import org.junit.Assert.*
import org.junit.Test

class TaskGroupsTest {
    private val tasks = listOf(
        json("id" to "one", "title" to "代码检查", "working_dir" to "/repo/app", "status" to "running"),
        json("id" to "two", "title" to "整理项目", "working_dir" to "/repo/app", "latest_job_status" to "completed"),
        json("id" to "three", "title" to "文档", "working_dir" to "/repo/docs"),
        json("id" to "four", "title" to "独立任务", "working_dir" to null)
    )

    @Test fun projectsUseCustomLabelsAndPersistedTaskOrder() {
        val settings = json("customCategories" to listOf(json("id" to "custom", "name" to "客户端", "assignedDirs" to listOf("/repo/app").jsonArray())).jsonArray(),
            "pinned" to listOf("custom:custom").jsonArray(), "conversationOrders" to json("custom:custom" to listOf("two").jsonArray()))
        val groups = taskGroups(NativeState(conversations = tasks, categorySettings = settings), false, "")
        assertEquals("客户端", groups.first().title)
        assertEquals(listOf("two", "one"), groups.first().tasks.map { it.text("id") })
        assertEquals(3, groups.size)
    }

    @Test fun favoritesHiddenCategoriesAndSearchMatchWebMeaning() {
        val state = NativeState(conversations = tasks, workingDirs = json("favorites" to listOf(json("path" to "/repo/app", "label" to "主项目")).jsonArray()),
            categorySettings = json("hidden" to listOf("auto:standalone").jsonArray()))
        assertEquals("主项目", taskGroups(state, false, "主项目").single().title)
        assertEquals(2, taskGroups(state, false, "").size)
        assertEquals("two", taskGroups(state, false, "整理").single().tasks.single().text("id"))
    }

    @Test fun idleDoesNotFalselyMeanSuccessfulCompletion() {
        assertEquals("未运行 / 状态未知", taskStatus(json("status" to "idle")))
        assertEquals("已完成", taskStatus(tasks[1]))
        assertEquals("需关注", taskStatus(json("latest_job_status" to "failed")))
        assertEquals("排队中", taskStatus(json("latest_job_status" to "completed", "has_pending_work" to 1)))
        assertEquals("进行中", taskStatus(json("status" to "running", "has_pending_work" to 1)))
        assertEquals(listOf("进行中", "已完成", "未运行 / 状态未知"), taskGroups(NativeState(conversations = tasks), true, "").map { it.title })
    }
}
