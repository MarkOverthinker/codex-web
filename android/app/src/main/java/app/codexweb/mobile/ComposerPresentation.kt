package app.codexweb.mobile

enum class ComposerStatus {
    Ready, Queue, Sending, Recording, Transcribing, Cached, Uncertain, Empty, Connecting, Uploading, Busy
}

data class ComposerPresentation(
    val status: ComposerStatus,
    val statusText: String?,
    val activeJobLabel: String?,
    val sendLabel: String,
    val hint: String,
    val sendEnabled: Boolean,
    val inputEnabled: Boolean,
    val voiceContentDescription: String,
) {
    val sendContentDescription: String
        get() = if (sendEnabled) "$sendLabel。$hint" else "$sendLabel，不可用。$hint"
}

fun composerPresentation(state: NativeState, recording: Boolean = false): ComposerPresentation {
    val hasContent = state.composer.content.isNotBlank() || state.composer.files.isNotEmpty()
    val activeJobLabel = state.activeJob?.let { job -> when (job.text("status")) {
        "queued" -> "任务排队中"
        "running" -> "任务运行中"
        else -> "任务状态待更新"
    } }
    val status = when {
        state.sendUncertain -> ComposerStatus.Uncertain
        state.detailFromCache -> ComposerStatus.Cached
        state.connecting -> ComposerStatus.Connecting
        state.busy -> when (state.operation) {
            "send" -> ComposerStatus.Sending
            "voice" -> ComposerStatus.Transcribing
            "upload" -> ComposerStatus.Uploading
            else -> ComposerStatus.Busy
        }
        recording -> ComposerStatus.Recording
        !hasContent -> ComposerStatus.Empty
        state.activeJob != null -> ComposerStatus.Queue
        else -> ComposerStatus.Ready
    }
    val hint = when (status) {
        ComposerStatus.Ready -> "发送消息；任务状态变化时也可能排队。"
        ComposerStatus.Queue -> "$activeJobLabel；是否入队以服务器接收时的状态为准。"
        ComposerStatus.Sending -> "正在提交，请勿重复发送；结果以服务器确认为准。"
        ComposerStatus.Recording -> "正在录音；结束录音后转写，确认文字后再发送。"
        ComposerStatus.Transcribing -> "语音正在转写；完成后请确认文字再发送，不会自动发送。"
        ComposerStatus.Cached -> "正在查看本机缓存；请联网刷新后发送，不会离线执行。"
        ComposerStatus.Uncertain -> "上次发送结果未确认；请先刷新核对消息和队列，勿重复发送。"
        ComposerStatus.Empty -> "请输入文字或添加附件；仅有引用不能发送。"
        ComposerStatus.Connecting -> "正在连接，请连接完成后再发送。"
        ComposerStatus.Uploading -> "附件正在上传，请上传完成后再发送。"
        ComposerStatus.Busy -> "当前操作尚未结束，请完成后再发送。"
    }
    val statusText = when (status) {
        ComposerStatus.Ready, ComposerStatus.Empty, ComposerStatus.Queue, ComposerStatus.Uncertain -> null
        ComposerStatus.Sending -> "发送中"
        ComposerStatus.Recording -> "录音中 · 结束后转写"
        ComposerStatus.Transcribing -> "转写中 · 请稍候"
        ComposerStatus.Cached -> "本机缓存 · 联网刷新后发送"
        ComposerStatus.Connecting -> "连接中"
        ComposerStatus.Uploading -> "附件上传中"
        ComposerStatus.Busy -> if (state.operation == "refresh") null else "正在处理"
    }

    val sendLabel = when (status) {
        ComposerStatus.Queue -> "加入队列"
        ComposerStatus.Sending -> "发送中"
        else -> "发送"
    }
    val voiceContentDescription = when {
        state.busy && state.operation == "voice" -> "正在转写，完成后请确认文字再发送"
        recording -> "结束录音并转写，不会自动发送"
        else -> "语音输入"
    }
    return ComposerPresentation(
        status = status,
        sendLabel = sendLabel,
        statusText = statusText,
        activeJobLabel = activeJobLabel,
        hint = hint,
        sendEnabled = status == ComposerStatus.Ready || status == ComposerStatus.Queue,
        inputEnabled = !state.connecting && (!state.busy || state.operation == "voice") && !state.sendUncertain,
        voiceContentDescription = voiceContentDescription,
    )
}

internal data class MessageTailLayout(
    val itemCount: Int,
    val viewportEnd: Int,
    val afterPadding: Int,
    val lastIndex: Int,
    val lastOffset: Int,
    val lastSize: Int,
    val canScrollForward: Boolean,
) {
    val remainingScroll: Int get() = (lastOffset + lastSize + afterPadding - viewportEnd).coerceAtLeast(0)

    fun isSettledAfter(previous: MessageTailLayout?): Boolean =
        itemCount > 0 && lastIndex == itemCount - 1 && !canScrollForward && this == previous
}

internal data class MessageScrollObservation(
    val firstIndex: Int,
    val firstOffset: Int,
    val itemCount: Int,
    val atEnd: Boolean,
    val userScrolling: Boolean = false,
    val scrollingToLatest: Boolean = false,
) {
    fun followAfter(previous: MessageScrollObservation?, following: Boolean): Boolean {
        if (previous == null || scrollingToLatest) return following
        val positionChanged = itemCount == previous.itemCount &&
            (firstIndex != previous.firstIndex || firstOffset != previous.firstOffset)
        return if (userScrolling || previous.userScrolling || positionChanged) atEnd else following
    }
}

internal fun MessageTailLayout.shouldCompensate(
    previousAttempt: MessageTailLayout?,
    viewportHeight: Int,
    following: Boolean,
    activeInScene: Boolean,
    observation: MessageScrollObservation,
): Boolean = activeInScene && following && viewportHeight > 0 && itemCount > 0 &&
    lastIndex in 0 until itemCount && canScrollForward && !observation.userScrolling &&
    !observation.scrollingToLatest && this != previousAttempt
