package app.codexweb.mobile

import org.json.JSONObject

enum class ReviewFilter(val label: String) {
    All("全部"),
    Added("新增"),
    Modified("修改"),
    Deleted("删除"),
    Other("其他"),
}

fun reviewFileCategory(status: String): ReviewFilter = when (status.trim()) {
    "A", "AM", "?", "??" -> ReviewFilter.Added
    "M", "MM" -> ReviewFilter.Modified
    "D", "AD", "MD" -> ReviewFilter.Deleted
    else -> ReviewFilter.Other
}

fun filterReviewFiles(
    files: List<JSONObject>,
    query: String = "",
    filter: ReviewFilter = ReviewFilter.All,
): List<JSONObject> {
    val pathQuery = query.trim()
    return files.filter { file ->
        file.text("path").contains(pathQuery, ignoreCase = true) &&
            (filter == ReviewFilter.All || reviewFileCategory(file.text("status")) == filter)
    }
}
