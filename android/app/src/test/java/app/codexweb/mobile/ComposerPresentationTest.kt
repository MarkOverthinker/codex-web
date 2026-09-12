package app.codexweb.mobile

import org.junit.Assert.*
import org.junit.Test

class ComposerPresentationTest {
    private val draft = Composer(content = "继续分析")
    private val ready = NativeState(composer = draft)
    private val running = ready.copy(detail = json("activeJob" to json("id" to "job", "status" to "running")))

    @Test fun idleComposerOffersSendingWithoutPromisingImmediateExecution() {
        val presentation = composerPresentation(ready)
        assertEquals(ComposerStatus.Ready, presentation.status)
        assertEquals("发送", presentation.sendLabel)
        assertEquals("发送消息；任务状态变化时也可能排队。", presentation.hint)
        assertTrue(presentation.sendEnabled)
        assertTrue(presentation.inputEnabled)
        assertEquals("发送。${presentation.hint}", presentation.sendContentDescription)
        assertEquals("语音输入", presentation.voiceContentDescription)
    }

    @Test fun activeJobOffersQueueIntentWithoutGuaranteeingAdmission() {
        val presentation = composerPresentation(running)
        assertEquals(ComposerStatus.Queue, presentation.status)
        assertEquals("加入队列", presentation.sendLabel)
        assertEquals("任务运行中；是否入队以服务器接收时的状态为准。", presentation.hint)
        assertTrue(presentation.sendEnabled)
        assertTrue(presentation.inputEnabled)
        assertEquals("加入队列。${presentation.hint}", presentation.sendContentDescription)
        assertEquals(ComposerStatus.Ready, composerPresentation(running.copy(detail = json("activeJob" to null))).status)
    }

    @Test fun sendingLocksInputAndNeverClaimsTheMessageIsAlreadyQueued() {
        val presentation = composerPresentation(running.copy(busy = true, operation = "send"))
        assertEquals(ComposerStatus.Sending, presentation.status)
        assertEquals("发送中", presentation.sendLabel)
        assertEquals("正在提交，请勿重复发送；结果以服务器确认为准。", presentation.hint)
        assertFalse(presentation.sendEnabled)
        assertFalse(presentation.inputEnabled)
        assertEquals("发送中，不可用。${presentation.hint}", presentation.sendContentDescription)
        assertEquals("语音输入", presentation.voiceContentDescription)
    }

    @Test fun transcriptionKeepsTheExistingTypingExceptionButCannotSend() {
        val presentation = composerPresentation(running.copy(busy = true, operation = "voice"))
        assertEquals(ComposerStatus.Transcribing, presentation.status)
        assertEquals("发送", presentation.sendLabel)
        assertEquals("语音正在转写；完成后请确认文字再发送，不会自动发送。", presentation.hint)
        assertFalse(presentation.sendEnabled)
        assertTrue(presentation.inputEnabled)
        assertEquals("发送，不可用。${presentation.hint}", presentation.sendContentDescription)
        assertEquals("正在转写，完成后请确认文字再发送", presentation.voiceContentDescription)
    }

    @Test fun recordingDescribesStopAndTranscribeRatherThanStopAndSend() {
        val presentation = composerPresentation(running, recording = true)
        assertEquals(ComposerStatus.Recording, presentation.status)
        assertEquals("发送", presentation.sendLabel)
        assertEquals("正在录音；结束录音后转写，确认文字后再发送。", presentation.hint)
        assertFalse(presentation.sendEnabled)
        assertTrue(presentation.inputEnabled)
        assertEquals("结束录音并转写，不会自动发送", presentation.voiceContentDescription)
        assertEquals(ComposerStatus.Queue, composerPresentation(running, recording = false).status)
    }

    @Test fun cachedDetailPreventsSendingWithoutChangingLocalDraftEditing() {
        val presentation = composerPresentation(running.copy(detailFromCache = true))
        assertEquals(ComposerStatus.Cached, presentation.status)
        assertEquals("发送", presentation.sendLabel)
        assertEquals("正在查看本机缓存；请联网刷新后发送，不会离线执行。", presentation.hint)
        assertFalse(presentation.sendEnabled)
        assertTrue(presentation.inputEnabled)
        assertEquals("发送，不可用。${presentation.hint}", presentation.sendContentDescription)
    }

    @Test fun uncertainSendRequiresCheckingMessagesAndQueueBeforeSendingOrEditing() {
        val presentation = composerPresentation(running.copy(sendUncertain = true))
        assertEquals(ComposerStatus.Uncertain, presentation.status)
        assertEquals("发送", presentation.sendLabel)
        assertEquals("上次发送结果未确认；请先刷新核对消息和队列，勿重复发送。", presentation.hint)
        assertFalse(presentation.sendEnabled)
        assertFalse(presentation.inputEnabled)
        assertEquals("发送，不可用。${presentation.hint}", presentation.sendContentDescription)
    }

    @Test fun emptyWhitespaceQuotesAndReferencesAreNotSendableContent() {
        val emptyDrafts = listOf(
            Composer(),
            Composer(content = " \n\t\u3000"),
            Composer(quote = "仅引用"),
            Composer(source = json("messageId" to "source")),
            Composer(content = " \t", quote = "引用", source = json("messageId" to "source")),
        )
        for (composer in emptyDrafts) {
            for (base in listOf(ready, running)) {
                val presentation = composerPresentation(base.copy(composer = composer))
                assertEquals(ComposerStatus.Empty, presentation.status)
                assertEquals("发送", presentation.sendLabel)
                assertEquals("请输入文字或添加附件；仅有引用不能发送。", presentation.hint)
                assertFalse(presentation.sendEnabled)
                assertTrue(presentation.inputEnabled)
                assertEquals("发送，不可用。${presentation.hint}", presentation.sendContentDescription)
            }
        }
    }

    @Test fun attachmentsOnlyRemainSendableAndUseCurrentJobForQueueIntent() {
        val attachmentDraft = Composer(content = " \t", files = listOf(json("id" to "file")))
        val idle = composerPresentation(ready.copy(composer = attachmentDraft))
        val queued = composerPresentation(running.copy(composer = attachmentDraft))
        assertEquals(ComposerStatus.Ready, idle.status)
        assertEquals(ComposerStatus.Queue, queued.status)
        assertTrue(idle.sendEnabled)
        assertTrue(queued.sendEnabled)
    }

    @Test fun connectingUploadingAndOtherBusyOperationsHaveDistinctReasons() {
        val cases = listOf(
            Triple(ready.copy(connecting = true), ComposerStatus.Connecting, "正在连接，请连接完成后再发送。"),
            Triple(ready.copy(busy = true, operation = "upload"), ComposerStatus.Uploading, "附件正在上传，请上传完成后再发送。"),
            Triple(ready.copy(busy = true, operation = "request"), ComposerStatus.Busy, "当前操作尚未结束，请完成后再发送。"),
            Triple(ready.copy(busy = true), ComposerStatus.Busy, "当前操作尚未结束，请完成后再发送。"),
        )
        for ((state, status, hint) in cases) {
            val presentation = composerPresentation(state)
            assertEquals(status, presentation.status)
            assertEquals(hint, presentation.hint)
            assertEquals("发送", presentation.sendLabel)
            assertFalse(presentation.sendEnabled)
            assertFalse(presentation.inputEnabled)
            assertEquals("发送，不可用。$hint", presentation.sendContentDescription)
            assertEquals("语音输入", presentation.voiceContentDescription)
        }
    }

    @Test fun safetyBlockersTakePriorityOverActivityAndEmptyContent() {
        val combined = running.copy(composer = Composer(), sendUncertain = true, detailFromCache = true,
            connecting = true, busy = true, operation = "send")
        assertEquals(ComposerStatus.Uncertain, composerPresentation(combined, recording = true).status)
        val cached = combined.copy(sendUncertain = false)
        assertEquals(ComposerStatus.Cached, composerPresentation(cached, recording = true).status)
        val connecting = cached.copy(detailFromCache = false)
        assertEquals(ComposerStatus.Connecting, composerPresentation(connecting, recording = true).status)
        val sending = connecting.copy(connecting = false)
        assertEquals(ComposerStatus.Sending, composerPresentation(sending, recording = true).status)
        assertEquals(ComposerStatus.Transcribing, composerPresentation(sending.copy(operation = "voice"), recording = true).status)
        assertEquals(ComposerStatus.Uploading, composerPresentation(sending.copy(operation = "upload"), recording = true).status)
        assertEquals(ComposerStatus.Busy, composerPresentation(sending.copy(operation = "request"), recording = true).status)
        val recording = sending.copy(busy = false, operation = null)
        assertEquals(ComposerStatus.Recording, composerPresentation(recording, recording = true).status)
        assertEquals(ComposerStatus.Empty, composerPresentation(recording).status)
    }

    @Test fun pendingPromptsPreviousJobsAndConnectionTextDoNotInventAnActiveJob() {
        val state = ready.copy(connection = "执行中", detail = json("activeJob" to null,
            "latestJob" to json("id" to "previous", "status" to "running"),
            "pendingPrompts" to listOf(json("id" to "pending")).jsonArray(),
            "editingPrompt" to json("id" to "editing")))
        val presentation = composerPresentation(state)
        assertEquals(ComposerStatus.Ready, presentation.status)
        assertEquals("发送", presentation.sendLabel)
        assertTrue(presentation.sendEnabled)
    }

    @Test fun staleOperationNamesWithoutBusyDoNotClaimWorkIsInProgress() {
        for (operation in listOf("send", "voice", "upload", "request")) {
            val state = ready.copy(operation = operation)
            val presentation = composerPresentation(state)
            assertEquals(ComposerStatus.Ready, presentation.status)
            assertTrue(presentation.sendEnabled)
            assertTrue(presentation.inputEnabled)
            assertEquals("语音输入", presentation.voiceContentDescription)
            assertEquals(ComposerStatus.Recording, composerPresentation(state, recording = true).status)
        }
    }

    @Test fun unrelatedErrorsAndDraftStatusDoNotInventSendUncertaintyOrCacheMode() {
        val presentation = composerPresentation(ready.copy(error = "读取文件失败", connection = "连接中断",
            draftStatus = "发送未完成，请检查后重试"))
        assertEquals(composerPresentation(ready), presentation)
        assertTrue(presentation.sendEnabled)
        assertTrue(presentation.inputEnabled)
    }

    @Test fun allFlagCombinationsPreserveSendGuardsAndTheExistingEditorPolicy() {
        val operations = listOf(null, "send", "voice", "upload", "request", "other")
        val drafts = listOf(Composer(), Composer(content = " \n\t"), Composer(quote = "引用"),
            Composer(source = json("messageId" to "source")), draft,
            Composer(files = listOf(json("id" to "file"))),
            Composer(content = " \t", quote = "引用", files = listOf(json("id" to "file"))))
        for (flags in 0 until 64) {
            val recording = (flags and 16) != 0
            for (operation in operations) {
                for (composer in drafts) {
                    val state = ready.copy(busy = (flags and 1) != 0, connecting = (flags and 2) != 0,
                        detailFromCache = (flags and 4) != 0, sendUncertain = (flags and 8) != 0,
                        detail = if ((flags and 32) != 0) running.detail else null,
                        composer = composer, operation = operation)
                    val presentation = composerPresentation(state, recording)
                    val context = "flags=$flags operation=$operation composer=$composer"
                    val canSend = !state.busy && !state.connecting && !state.sendUncertain &&
                        !state.detailFromCache && !recording && (composer.content.isNotBlank() || composer.files.isNotEmpty())
                    val canEdit = !state.connecting && (!state.busy || operation == "voice") && !state.sendUncertain
                    assertEquals(context, canSend, presentation.sendEnabled)
                    assertEquals(context, canEdit, presentation.inputEnabled)
                    assertEquals(context, !canSend, presentation.sendContentDescription.contains("不可用"))
                    if (canSend) {
                        assertEquals(context, if (state.activeJob == null) ComposerStatus.Ready else ComposerStatus.Queue,
                            presentation.status)
                    }
                }
            }
        }
    }

    @Test fun presentationIsDeterministicAndLeavesDraftAndServerDataUntouched() {
        val composer = Composer(content = " 保留空格 ", quote = "引用内容", source = json("messageId" to "source"),
            files = listOf(json("id" to "file", "original_name" to "note.txt")), dirty = true, revision = 42)
        val state = running.copy(composer = composer, draftStatus = "未同步", uncertainRevision = 41)
        val before = state.toString()
        val presentation = composerPresentation(state)
        assertEquals(presentation, composerPresentation(state))
        assertEquals(before, state.toString())
        assertSame(composer, state.composer)
        assertEquals(42L, state.composer.revision)
        assertEquals(41L, state.uncertainRevision)
        assertEquals("未同步", state.draftStatus)
    }

    @Test fun queuedJobsNeverClaimTheyAreRunningOrGuaranteeQueueAdmission() {
        val state = ready.copy(detail = json("activeJob" to json("id" to "queued-job", "status" to "queued")))
        val presentation = composerPresentation(state)
        assertEquals(ComposerStatus.Queue, presentation.status)
        assertEquals("任务排队中", presentation.activeJobLabel)
        assertEquals("加入队列", presentation.sendLabel)
        assertEquals("任务排队中；是否入队以服务器接收时的状态为准。", presentation.hint)
        assertEquals("加入队列。${presentation.hint}", presentation.sendContentDescription)
        assertFalse(presentation.sendContentDescription.contains("运行"))
        assertTrue(presentation.sendEnabled)
        assertTrue(presentation.inputEnabled)
    }

    @Test fun missingOrUnexpectedActiveJobStatusDoesNotClaimItIsRunning() {
        for (jobStatus in listOf(null, "", "failed", "completed", "starting")) {
            val presentation = composerPresentation(ready.copy(detail = json("activeJob" to json("id" to "job", "status" to jobStatus))))
            assertEquals("任务状态待更新", presentation.activeJobLabel)
            assertEquals(ComposerStatus.Queue, presentation.status)
            assertFalse(presentation.hint.contains("运行"))
            assertFalse(presentation.hint.contains("任务排队中"))
            assertTrue(presentation.hint.contains("以服务器接收时的状态为准"))
        }
        assertNull(composerPresentation(ready).activeJobLabel)
        assertEquals("任务运行中", composerPresentation(running).activeJobLabel)
    }

    @Test fun normalStatesKeepDetailedGuidanceOutOfTheVisibleStatusLine() {
        val states = listOf(ready, NativeState(), running, running.copy(composer = Composer()),
            ready.copy(detail = json("activeJob" to json("id" to "job", "status" to "queued"))))
        for (state in states) {
            val presentation = composerPresentation(state)
            assertNull(presentation.statusText)
            assertTrue(presentation.hint.isNotBlank())
            assertTrue(presentation.sendContentDescription.contains(presentation.hint))
        }
        assertNull(composerPresentation(ready.copy(sendUncertain = true)).statusText)
    }

    @Test fun temporaryBlockersExposeShortStatusTextWithoutDroppingDetailedSemantics() {
        val states = listOf(
            ready.copy(busy = true, operation = "send") to "发送中",
            ready.copy(busy = true, operation = "voice") to "转写中 · 请稍候",
            ready.copy(busy = true, operation = "upload") to "附件上传中",
            ready.copy(busy = true, operation = "request") to "正在处理",
            ready.copy(detailFromCache = true) to "本机缓存 · 联网刷新后发送",
            ready.copy(connecting = true) to "连接中",
        )
        for ((state, shortText) in states) {
            val presentation = composerPresentation(state)
            assertEquals(shortText, presentation.statusText)
            assertFalse(presentation.sendEnabled)
            assertTrue(presentation.hint.length > shortText.length)
            assertTrue(presentation.sendContentDescription.contains("不可用"))
            assertTrue(presentation.sendContentDescription.contains(presentation.hint))
        }
        assertEquals("录音中 · 结束后转写", composerPresentation(ready, recording = true).statusText)
    }

    @Test fun messageTailRequiresActualEndAndStableGeometry() {
        val atEnd = MessageTailLayout(2, 600, 20, 1, -820, 1400, canScrollForward = false)
        assertFalse(atEnd.isSettledAfter(null))
        assertTrue(atEnd.isSettledAfter(atEnd.copy()))
        val stillScrollable = atEnd.copy(canScrollForward = true)
        assertFalse(stillScrollable.isSettledAfter(stillScrollable.copy()))
        assertFalse(atEnd.isSettledAfter(stillScrollable))
    }

    @Test fun lateMarkdownHeightChangesRequireAnotherEndCheck() {
        val beforeRemeasure = MessageTailLayout(2, 600, 20, 1, -820, 1400, canScrollForward = false)
        val afterRemeasure = beforeRemeasure.copy(lastSize = 1600, canScrollForward = true)
        val corrected = afterRemeasure.copy(lastOffset = -1020, canScrollForward = false)
        assertTrue(beforeRemeasure.isSettledAfter(beforeRemeasure))
        assertFalse(afterRemeasure.isSettledAfter(beforeRemeasure))
        assertEquals(200, afterRemeasure.remainingScroll)
        assertFalse(corrected.isSettledAfter(afterRemeasure))
        assertTrue(corrected.isSettledAfter(corrected.copy()))
        assertEquals(0, corrected.remainingScroll)
    }

    @Test fun removingLatestFooterChangesViewportAndInvalidatesSettlement() {
        val withFooter = MessageTailLayout(2, 544, 20, 1, -876, 1400, canScrollForward = false)
        val withoutFooter = withFooter.copy(viewportEnd = 600, lastOffset = -820)
        assertFalse(withoutFooter.isSettledAfter(withFooter))
        assertTrue(withoutFooter.isSettledAfter(withoutFooter.copy()))
        assertFalse(withoutFooter.copy(afterPadding = 24).isSettledAfter(withoutFooter))
    }

    @Test fun newLastItemAndEmptyLayoutsCannotReuseOldTailSettlement() {
        val atEnd = MessageTailLayout(2, 600, 20, 1, -820, 1400, canScrollForward = false)
        val appended = atEnd.copy(itemCount = 3, lastIndex = 2, lastOffset = 380, lastSize = 200)
        assertFalse(appended.isSettledAfter(atEnd))
        assertTrue(appended.isSettledAfter(appended.copy()))
        val incomplete = appended.copy(lastIndex = 1)
        assertFalse(incomplete.isSettledAfter(incomplete.copy()))
        val empty = atEnd.copy(itemCount = 0, lastIndex = -1, lastSize = 0)
        assertFalse(empty.isSettledAfter(empty.copy()))
    }

    @Test fun tallMessageRemainderIncludesBottomPadding() {
        val tall = MessageTailLayout(2, 600, 20, 1, 0, 1400, canScrollForward = true)
        assertEquals(820, tall.remainingScroll)
        val corrected = tall.copy(lastOffset = -820, canScrollForward = false)
        assertEquals(0, corrected.remainingScroll)
        assertTrue(corrected.isSettledAfter(corrected.copy()))
        assertEquals(0, corrected.copy(lastSize = 200).remainingScroll)
    }

    @Test fun refreshUsesExistingHeaderFeedbackWithoutAddingComposerHeight() {
        val presentation = composerPresentation(ready.copy(busy = true, operation = "refresh"))
        assertEquals(ComposerStatus.Busy, presentation.status)
        assertNull(presentation.statusText)
        assertFalse(presentation.sendEnabled)
        assertFalse(presentation.inputEnabled)
        assertEquals("当前操作尚未结束，请完成后再发送。", presentation.hint)
    }

    @Test fun viewportChangesAloneDoNotCancelFollowingIntent() {
        val atEnd = MessageScrollObservation(10, 400, 12, atEnd = true)
        val reducedViewport = atEnd.copy(atEnd = false)
        assertTrue(reducedViewport.followAfter(atEnd, following = true))
        val appended = reducedViewport.copy(itemCount = 13)
        assertTrue(appended.followAfter(reducedViewport, following = true))
        assertTrue(appended.copy(itemCount = 14).followAfter(appended, following = true))
    }

    @Test fun userScrollingAwayDisablesFollowingAndReturningToEndEnablesIt() {
        val atEnd = MessageScrollObservation(10, 400, 12, atEnd = true)
        val dragging = atEnd.copy(firstOffset = 100, atEnd = false, userScrolling = true)
        assertFalse(dragging.followAfter(atEnd, following = true))
        val history = dragging.copy(userScrolling = false)
        assertFalse(history.followAfter(dragging, following = false))
        val backAtEnd = atEnd.copy(userScrolling = true)
        assertTrue(backAtEnd.followAfter(history, following = false))
        assertTrue(atEnd.followAfter(backAtEnd, following = true))
    }

    @Test fun explicitPositionChangesWorkWithoutAnIntermediateDragSample() {
        val atEnd = MessageScrollObservation(10, 400, 12, atEnd = true)
        val history = atEnd.copy(firstIndex = 0, firstOffset = 0, atEnd = false)
        assertFalse(history.followAfter(atEnd, following = true))
        assertTrue(atEnd.followAfter(history, following = false))
    }

    @Test fun automaticTailScrollingDoesNotCountAsLeavingTheEnd() {
        val atEnd = MessageScrollObservation(10, 400, 12, atEnd = true)
        val moving = atEnd.copy(firstOffset = 0, atEnd = false, scrollingToLatest = true)
        assertTrue(moving.followAfter(atEnd, following = true))
        assertTrue(atEnd.followAfter(moving, following = true))
    }

    @Test fun historyIntentSurvivesLayoutChangesNewItemsAndRestoration() {
        val history = MessageScrollObservation(0, 0, 12, atEnd = false)
        val appended = history.copy(itemCount = 13)
        assertFalse(appended.followAfter(history, following = false))
        assertFalse(appended.followAfter(null, following = false))
        assertFalse(appended.copy(atEnd = true).followAfter(appended, following = false))
    }

    @Test fun lateNativeRemeasureAfterSettlementCanCompensateWithoutANewMessage() {
        val settled = MessageTailLayout(12, 600, 20, 11, -820, 1400, canScrollForward = false)
        val lateLayout = settled.copy(lastSize = 1600, canScrollForward = true)
        val before = MessageScrollObservation(11, 820, 12, atEnd = true)
        val after = before.copy(atEnd = false)
        assertTrue(settled.isSettledAfter(settled))
        val following = after.followAfter(before, following = true)
        assertTrue(following)
        assertTrue(lateLayout.shouldCompensate(null, 600, following, true, after))
    }

    @Test fun imeViewportResizeCanCompensateWithoutChangingTheMessageCount() {
        val settled = MessageTailLayout(12, 600, 20, 11, -820, 1400, canScrollForward = false)
        val resized = settled.copy(viewportEnd = 480, canScrollForward = true)
        val observation = MessageScrollObservation(11, 820, 12, atEnd = false)
        assertEquals(120, resized.remainingScroll)
        assertTrue(resized.shouldCompensate(null, 480, true, true, observation))
    }

    @Test fun restoredSceneDoesNotCompensateUntilItActivelyMovesToLatest() {
        val layout = MessageTailLayout(12, 480, 20, 11, -820, 1400, canScrollForward = true)
        val observation = MessageScrollObservation(11, 820, 12, atEnd = false)
        assertFalse(layout.shouldCompensate(null, 480, true, false, observation))
        assertTrue(layout.shouldCompensate(null, 480, true, true, observation))
    }

    @Test fun historyIntentAndUserOrOwnedScrollingPreventLayoutCompensation() {
        val layout = MessageTailLayout(12, 480, 20, 11, -820, 1400, canScrollForward = true)
        val atEnd = MessageScrollObservation(11, 820, 12, atEnd = true)
        val history = atEnd.copy(firstIndex = 0, firstOffset = 0, atEnd = false)
        val following = history.followAfter(atEnd, following = true)
        assertFalse(following)
        assertFalse(layout.shouldCompensate(null, 480, following, true, history))
        assertFalse(layout.shouldCompensate(null, 480, true, true, history.copy(userScrolling = true)))
        assertFalse(layout.shouldCompensate(null, 480, true, true, history.copy(scrollingToLatest = true)))
    }

    @Test fun emptyAndZeroHeightLayoutsNeverStartCompensation() {
        val layout = MessageTailLayout(12, 480, 20, 11, -820, 1400, canScrollForward = true)
        val observation = MessageScrollObservation(11, 820, 12, atEnd = false)
        assertFalse(layout.shouldCompensate(null, 0, true, true, observation))
        assertFalse(layout.shouldCompensate(null, -1, true, true, observation))
        assertFalse(layout.copy(itemCount = 0).shouldCompensate(null, 480, true, true, observation))
        assertFalse(layout.copy(lastIndex = -1).shouldCompensate(null, 480, true, true, observation))
        assertFalse(layout.copy(lastIndex = 12).shouldCompensate(null, 480, true, true, observation))
    }

    @Test fun unchangedNoProgressGeometryDoesNotRetryButNewLayoutCan() {
        val attempted = MessageTailLayout(12, 480, 20, 11, -820, 1400, canScrollForward = true)
        val observation = MessageScrollObservation(11, 820, 12, atEnd = false)
        assertFalse(attempted.shouldCompensate(attempted.copy(), 480, true, true, observation))
        assertTrue(attempted.copy(lastSize = 1600).shouldCompensate(attempted, 480, true, true, observation))
        assertTrue(attempted.copy(viewportEnd = 440).shouldCompensate(attempted, 440, true, true, observation))
        assertFalse(attempted.copy(canScrollForward = false).shouldCompensate(null, 480, true, true, observation))
    }
}
