package app.codexweb.mobile

import org.junit.Assert.*
import org.junit.Test

class ReviewFilterTest {
    @Test fun filtersExposeTheFiveRequestedLabels() {
        assertEquals(listOf("全部", "新增", "修改", "删除", "其他"), ReviewFilter.entries.map { it.label })
    }

    @Test fun allPreservesLoadedOrderObjectIdentityAndDuplicates() {
        val first = json("path" to "z.kt", "status" to "M", "additions" to 12, "deletions" to null)
        val second = json("path" to "a.kt", "status" to "?")
        val files = listOf(first, second, first)
        val before = files.map { it.toString() }
        val result = filterReviewFiles(files)
        assertEquals(files, result)
        result.forEachIndexed { index, file -> assertSame(files[index], file) }
        assertEquals(before, files.map { it.toString() })
    }

    @Test fun pathQueriesTrimWhitespaceAndIgnoreCase() {
        val match = json("path" to "SRC/App.KT", "status" to "M")
        val files = listOf(match, json("path" to "src/other.kt", "status" to "A"))
        assertEquals(listOf(match), filterReviewFiles(files, " \t\nsRc/aPp.kT\r\n "))
        assertEquals(listOf(match), filterReviewFiles(files, "\u3000APP\u00a0"))
        assertEquals("SRC/App.KT", match.text("path"))
    }

    @Test fun blankQueriesKeepEmptyMissingAndNullPaths() {
        val files = listOf(
            json("path" to "", "status" to "A"),
            json("path" to "   ", "status" to "M"),
            json("path" to null, "status" to "D"),
            json("status" to "?"),
            json("path" to "src/app.kt", "status" to "R"),
        )
        listOf("", " \t\r\n", "\u3000\u00a0").forEach { query ->
            assertEquals(files, filterReviewFiles(files, query))
            assertEquals(listOf(files[0], files[3]), filterReviewFiles(files, query, ReviewFilter.Added))
        }
    }

    @Test fun nonEmptyQueriesOnlyMatchThePathNotStatusOrOtherMetadata() {
        val match = json("path" to "src/M.kt", "status" to "D")
        val files = listOf(
            json("path" to "", "status" to "M"),
            json("path" to null, "status" to "M"),
            json("status" to "M"),
            json("path" to "other.kt", "status" to "M", "previousPath" to "M.kt"),
            match,
        )
        assertEquals(listOf(match), filterReviewFiles(files, "m"))
        assertTrue(filterReviewFiles(files, "null").isEmpty())
        assertTrue(filterReviewFiles(files, "m", ReviewFilter.Modified).isEmpty())
    }

    @Test fun unicodePathsSupportLiteralTextAndNonAsciiCaseMatching() {
        val chinese = json("path" to "文档/设计 方案.md", "status" to "A")
        val accented = json("path" to "资料/CAFÉ.kt", "status" to "M")
        val cyrillic = json("path" to "src/ПРИМЕР.kt", "status" to "D")
        val emoji = json("path" to "设计/🚀.md", "status" to "?")
        val files = listOf(chinese, accented, cyrillic, emoji)
        assertEquals(listOf(chinese), filterReviewFiles(files, " 设计 方案 "))
        assertEquals(listOf(accented), filterReviewFiles(files, "café"))
        assertEquals(listOf(cyrillic), filterReviewFiles(files, "пример"))
        assertEquals(listOf(emoji), filterReviewFiles(files, "🚀"))
    }

    @Test fun pathQueriesAreLiteralSubstringsNotPatterns() {
        val literal = json("path" to "src/[draft]*?.kt", "status" to "M")
        val files = listOf(literal, json("path" to "src/draft.kt", "status" to "A"))
        assertEquals(listOf(literal), filterReviewFiles(files, "[draft]*?"))
        assertTrue(filterReviewFiles(files, ".*\\.kt").isEmpty())
    }

    @Test fun pathAndCategoryFiltersCombineWithAndForEveryCategory() {
        val files = listOf("src", "docs").flatMap { directory ->
            listOf("A", "?", "M", "D", "R").map { status ->
                json("path" to "$directory/$status.kt", "status" to status)
            }
        }
        val expectations = mapOf(
            ReviewFilter.All to files.take(5),
            ReviewFilter.Added to listOf(files[0], files[1]),
            ReviewFilter.Modified to listOf(files[2]),
            ReviewFilter.Deleted to listOf(files[3]),
            ReviewFilter.Other to listOf(files[4]),
        )
        expectations.forEach { (filter, expected) ->
            assertEquals(filter.label, expected, filterReviewFiles(files, " SRC/ ", filter))
        }
    }

    @Test fun singleAndBlankColumnStatusesUseTheSameCategories() {
        val expectations = mapOf(
            ReviewFilter.Added to listOf("A", "A ", " A", "?", "??"),
            ReviewFilter.Modified to listOf("M", "M ", " M"),
            ReviewFilter.Deleted to listOf("D", "D ", " D"),
        )
        expectations.forEach { (category, statuses) ->
            statuses.forEach { status -> assertEquals(status, category, reviewFileCategory(status)) }
        }
    }

    @Test fun doubleColumnDeletionWinsOverAdditionAndAdditionOverModification() {
        val expectations = mapOf(
            "AM" to ReviewFilter.Added,
            "AD" to ReviewFilter.Deleted,
            "MD" to ReviewFilter.Deleted,
            "MM" to ReviewFilter.Modified,
        )
        expectations.forEach { (status, category) ->
            val files = listOf(json("path" to "file.kt", "status" to status))
            assertEquals(status, category, reviewFileCategory(status))
            ReviewFilter.entries.forEach { filter ->
                val expected = if (filter == ReviewFilter.All || filter == category) files else emptyList()
                assertEquals("$status / $filter", expected, filterReviewFiles(files, filter = filter))
            }
        }
    }

    @Test fun renamesCopiesTypeChangesAndConflictsStayOtherRegardlessOfKnownLetters() {
        val statuses = listOf(
            "R", "R ", " R", "R100", "R087", "RM", "RD", "RT",
            "C", "C100", "CM", "CD", "T", " T", "T ", "TM", "MT",
            "U", "UU", "AA", "DD", "AU", "UA", "DU", "UD",
        )
        val files = statuses.map { status -> json("path" to "$status.kt", "status" to status) }
        statuses.forEach { status -> assertEquals(status, ReviewFilter.Other, reviewFileCategory(status)) }
        assertEquals(files, filterReviewFiles(files, filter = ReviewFilter.Other))
        listOf(ReviewFilter.Added, ReviewFilter.Modified, ReviewFilter.Deleted).forEach { filter ->
            assertTrue(filter.label, filterReviewFiles(files, filter = filter).isEmpty())
        }
    }

    @Test fun unknownMalformedMissingAndNullStatusesRemainVisibleAsOther() {
        val statuses = listOf("", "  ", "X", "B", "!", "!!", "m", "modified", "A?", "MA", "DM", "AMD", "MZ")
        val files = statuses.map { status -> json("path" to "unknown/$status.kt", "status" to status) } +
            listOf(json("path" to "unknown/missing.kt"), json("path" to "unknown/null.kt", "status" to null))
        assertEquals(files, filterReviewFiles(files, " UNKNOWN/ "))
        assertEquals(files, filterReviewFiles(files, " UNKNOWN/ ", ReviewFilter.Other))
        listOf(ReviewFilter.Added, ReviewFilter.Modified, ReviewFilter.Deleted).forEach { filter ->
            assertTrue(filter.label, filterReviewFiles(files, filter = filter).isEmpty())
        }
    }

    @Test fun filteringNeverMutatesTheLoadedJsonOrItsSummaryInputs() {
        val files = mutableListOf(
            json("path" to "z.kt", "status" to "M", "additions" to 4, "deletions" to 2),
            json("path" to "a.kt", "status" to "?", "additions" to null, "deletions" to null),
            json("path" to "last.kt", "status" to "M", "extra" to json("keep" to true)),
        )
        val originalReferences = files.toList()
        val originalJson = files.map { it.toString() }
        val result = filterReviewFiles(files, ".KT", ReviewFilter.Modified)
        assertEquals(listOf(files[0], files[2]), result)
        assertSame(files[0], result[0])
        assertSame(files[2], result[1])
        assertEquals(originalReferences, files)
        assertEquals(originalJson, files.map { it.toString() })
        assertEquals(4, files[0].getInt("additions"))
        assertTrue(files[1].isNull("additions"))
        assertEquals(originalReferences, filterReviewFiles(files))
    }

    @Test fun emptyInputsAndNoMatchesReturnEmptyResults() {
        ReviewFilter.entries.forEach { filter ->
            assertTrue(filterReviewFiles(emptyList(), filter = filter).isEmpty())
            assertTrue(filterReviewFiles(emptyList(), "src", filter).isEmpty())
            assertTrue(filterReviewFiles(listOf(json("path" to "src/a.kt", "status" to "A")), "missing", filter).isEmpty())
        }
    }
}
